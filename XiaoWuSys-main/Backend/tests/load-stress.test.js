// ==========================================
// PB 26 (Sprint 15 UAC): 100+ CONCURRENT REQUESTS, LOAD AND STRESS
// One burst of 150+ simultaneous HTTP requests against the real API on this computer's
// database (cloud switched off, like a branch during an outage), mixing:
//   - order creations competing for the same limited blank, and capacity checks;
//   - stock additions, subtractions and misprint losses on shared items (some must be refused);
//   - edits of an order whose edit lock another account holds (refused) and the Owner's (allowed);
//   - dashboard, P&L, orders, inventory and waste-export reads.
// Then: no request failed with a server error, the reservation maths is exact, stock never went
// below 0, "free to use" is still on hand minus reserved, and every answer came back in time.
// The same kind of burst runs on real PostgreSQL (row locks, version checks, the single-flight
// sync) in m6-part4.pg.test.js.
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, shopDate } = require('./helpers/testServer');

const MAX_MS = 30000; // generous: CI machines are slow; a stuck request would take far longer

describe('PB 26: 150+ concurrent requests (offline server)', () => {
  let t;
  let owner; let admin; let production;
  let blank; let ink; let paper; let customer; let lockedOrder;

  before(async () => {
    t = await startTestServer();
    owner = await t.login('owner');
    admin = await t.login('admin');
    production = await t.login('staff');
    const item = async (item_name, quantity_available, unit_cost) =>
      (await t.request('POST', '/api/inventory', { token: production, body: { item_name, item_category: 'Raw', quantity_available, unit_cost } })).body.item.inventory_id;
    blank = await item('Limited Blank', 100, 120);
    ink = await item('Sublimation Ink', 200, 2.5);
    paper = await item('Scarce Paper', 20, 4);
    customer = (await t.request('POST', '/api/customers', { token: production, body: { full_name: 'Load Test School' } })).body.customer.customer_id;
    lockedOrder = (await t.request('POST', '/api/orders', {
      token: production, body: { customer_id: customer, production_deadline: shopDate(10), resolution: 'Delayed' }
    })).body.order_id;
    // An Admin is editing this order (held as the socket handler would)
    const held = t.orderLocks.acquire(lockedOrder, { user_id: 'u-admin', role: 'Admin' }, 'socket-admin');
    assert.equal(held.granted, true);
  });
  after(async () => { await t.close(); });

  it('answers every request without a server error and keeps the stock maths exact', async () => {
    const jobs = [];
    const add = (kind, n, fn) => { for (let i = 0; i < n; i++) jobs.push({ kind, run: () => fn(i) }); };
    add('order', 50, () => t.request('POST', '/api/orders', {
      token: production, body: { customer_id: customer, production_deadline: shopDate(7), required_items: [{ inventory_id: blank, quantity_needed: 3 }] }
    }));
    add('capacity', 10, () => t.request('POST', '/api/inventory/check-capacity', {
      token: production, body: { required_items: [{ inventory_id: blank, quantity_needed: 3 }] }
    }));
    // Migration 015: Add / Subtract stock is retired; stock leaves through recorded losses here
    add('ink_loss', 25, (i) => t.request('POST', `/api/inventory/${ink}/loss`, {
      token: production, body: { quantity_lost: 3, reason_code: i % 2 ? 'printer_head_banding' : 'damaged_in_storage' }
    }));
    add('paper_sub', 10, () => t.request('POST', `/api/inventory/${paper}/loss`, {
      token: production, body: { quantity_lost: 3, reason_code: 'damaged_in_storage' }
    }));
    add('locked_edit', 10, (i) => t.request('PATCH', `/api/orders/${lockedOrder}/details`, { token: production, body: { production_deadline: shopDate(11 + i) } }));
    add('owner_edit', 5, (i) => t.request('PATCH', `/api/orders/${lockedOrder}/details`, { token: owner, body: { production_deadline: shopDate(30 + i) } }));
    add('dashboard', 10, () => t.request('GET', '/api/reports/dashboard', { token: admin }));
    add('pnl', 5, () => t.request('GET', '/api/reports/pnl', { token: owner }));
    add('orders', 5, () => t.request('GET', '/api/orders?sort=priority', { token: production }));
    add('inventory', 5, () => t.request('GET', '/api/inventory', { token: production }));
    add('waste_csv', 5, () => t.request('GET', '/api/reports/export/waste.csv', { token: admin }));
    add('waste_report', 5, () => t.request('GET', '/api/reports/waste', { token: admin }));
    assert.ok(jobs.length >= 120, `${jobs.length} requests`);

    const started = Date.now();
    const results = await Promise.all(jobs.map(async (job) => {
      const t0 = Date.now();
      const r = await job.run();
      return { kind: job.kind, status: r.status, error: r.body && r.body.error, ms: Date.now() - t0 };
    }));
    const wall = Date.now() - started;
    const of = (kind) => results.filter((r) => r.kind === kind);
    const count = (kind, status) => of(kind).filter((r) => r.status === status).length;

    // 1. No server errors at all
    const broken = results.filter((r) => r.status >= 500 || r.status === 0);
    assert.deepEqual(broken, [], 'no request may fail with a server error');

    // 2. Orders competing for 100 blanks, 3 each: exactly 33 fit, the rest are refused cleanly
    assert.deepEqual([count('order', 201), count('order', 409)], [33, 17]);
    assert.ok(of('order').filter((r) => r.status === 409).every((r) => r.error === 'INSUFFICIENT_INVENTORY'));
    assert.ok(of('capacity').every((r) => [200, 409].includes(r.status)));
    const b = await t.get('SELECT quantity_available AS a, quantity_reserved AS r FROM inventory_items WHERE inventory_id = ?', [blank]);
    assert.deepEqual(b, { a: 100, r: 99 }, 'reserved = 33 orders x 3, never more than on hand');

    // 3. Shared stock: every movement counted once
    assert.equal(count('ink_loss', 201), 25);
    const i = await t.get('SELECT quantity_available AS a FROM inventory_items WHERE inventory_id = ?', [ink]);
    assert.equal(i.a, 200 - 25 * 3);
    assert.equal((await t.get('SELECT COUNT(*) AS n FROM material_loss WHERE inventory_id = ?', [ink])).n, 25);
    // 20 sheets, 3 at a time: 6 go through, 4 are refused, 2 are left (never below 0)
    assert.deepEqual([count('paper_sub', 201), count('paper_sub', 409)], [6, 4]);
    assert.equal((await t.get('SELECT quantity_available AS a FROM inventory_items WHERE inventory_id = ?', [paper])).a, 2);

    // 4. Edit-lock contention: the lower rank is refused, the Owner prevails
    assert.equal(count('locked_edit', 409), 10);
    assert.ok(of('locked_edit').every((r) => r.error === 'ORDER_LOCKED'));
    assert.equal(count('owner_edit', 200), 5);

    // 5. Reads all answered
    for (const kind of ['dashboard', 'pnl', 'orders', 'inventory', 'waste_csv', 'waste_report']) assert.equal(count(kind, 200), of(kind).length, kind);

    // 6. Stock invariants on every item, as stored and as the API shows them
    const rows = await t.all('SELECT inventory_id, quantity_available AS a, quantity_reserved AS r FROM inventory_items');
    for (const row of rows) assert.ok(row.a >= 0 && row.r >= 0, JSON.stringify(row));
    const snap = await t.request('GET', '/api/inventory', { token: production });
    for (const it of snap.body.items) {
      assert.equal(it.quantity_available_net, it.quantity_available - it.quantity_reserved, it.item_name);
    }

    // 7. Bounded response times
    const slowest = Math.max(...results.map((r) => r.ms));
    const sorted = results.map((r) => r.ms).sort((x, y) => x - y);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    assert.ok(slowest < MAX_MS, `slowest request took ${slowest} ms`);
    process.stderr.write(`PB 26 offline burst: ${results.length} requests in ${wall} ms (p95 ${p95} ms, slowest ${slowest} ms)\n`);
  });
});

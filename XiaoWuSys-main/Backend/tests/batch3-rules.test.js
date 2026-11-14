// Batch 3 rules that need no cloud: catalog capabilities and server-computed catalog figures,
// the optional Pressing step (PB 14), deadline urgency flags and the priority sort (PB 16),
// rank rules (PB 5), the live order events, and the rebuild of an older offline cache.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { startTestServer, shopDate, fixtures } = require('./helpers/testServer');
const { rolesWith, can, capabilitiesFor, outranks, rankOf } = require('../services/domain/permissions');
const {
  STATUS_TRANSITIONS, EDITABLE_STATUSES, QUOTE_FROZEN_STATUSES, allowedActions, deadlineFlag, deadlineWindows, canTransition
} = require('../services/domain/orderLifecycle');
const { withAvailability } = require('../services/inventorySnapshot');
const { createOrderEvents } = require('../services/orderEvents');
const { upgradeLocalOrderStatusCheck } = require('../services/localSchema');
const { PRODUCTION_STATUSES } = require('../utils/validation');

describe('Batch 3 rules (no database)', () => {
  it('gives the catalog its own capabilities', () => {
    assert.deepEqual(rolesWith('edit_inventory'), ['Owner', 'Admin', 'Production']);
    assert.deepEqual(rolesWith('purge_inventory'), ['Owner', 'Admin']);
    assert.ok(can('Production', 'edit_inventory') && !can('Production', 'purge_inventory'));
    assert.ok(!can('Staff', 'edit_inventory'));
    assert.deepEqual(capabilitiesFor('Staff'), ['view_orders'], 'Staff still only looks');
  });

  it('ranks Owner over Admin over Production over Staff, and nobody over an equal', () => {
    assert.ok(outranks('Owner', 'Admin') && outranks('Admin', 'Production') && outranks('Production', 'Staff'));
    assert.ok(!outranks('Admin', 'Admin') && !outranks('Admin', 'Owner') && !outranks('Staff', 'Production'));
    assert.equal(rankOf('Intern'), 0, 'an unknown role ranks below everyone');
    assert.ok(!outranks(undefined, null), 'two unknown editors are equal: nobody wins automatically');
  });

  it('works out the stock value of an item on the server', () => {
    const item = withAvailability({ quantity_available: 3, quantity_reserved: 1, minimum_threshold: 2, unit_cost: 33.35 });
    assert.deepEqual([item.stock_value, item.quantity_available_net, item.stock_status], [100.05, 2, 'low_stock']);
  });

  it('makes Pressing an optional step between Printing and Completed', () => {
    assert.deepEqual(STATUS_TRANSITIONS.Printing, ['Pressing', 'Completed', 'Cancelled']);
    assert.deepEqual(STATUS_TRANSITIONS.Pressing, ['Completed', 'Cancelled']);
    assert.ok(canTransition('Printing', 'Completed'), 'tarpaulins and stickers skip pressing');
    assert.ok(!canTransition('Approved', 'Pressing') && !canTransition('Pressing', 'Printing'));
    assert.ok(PRODUCTION_STATUSES.includes('Pressing') && EDITABLE_STATUSES.includes('Pressing') && QUOTE_FROZEN_STATUSES.includes('Pressing'));
    assert.deepEqual(allowedActions({ production_status: 'Pressing' }, 'Production').statuses, ['Completed'], 'no Cancel for Production');
    assert.deepEqual(allowedActions({ production_status: 'Pressing' }, 'Owner').statuses, ['Completed', 'Cancelled']);
    assert.equal(allowedActions({ production_status: 'Pressing' }, 'Owner').edit_quote, false);
  });

  it('flags deadlines by shop-time calendar days', () => {
    // 2026-11-14 18:30 UTC is already 02:30 on Nov 15 in Manila
    const now = new Date('2026-11-14T18:30:00Z');
    assert.deepEqual(deadlineWindows(now), { today: '2026-11-15', urgent_until: '2026-11-16', warning_until: '2026-11-18' });
    const flag = (day, status = 'Printing') => deadlineFlag({ production_deadline: `${day}T00:00:00`, production_status: status }, now);
    assert.equal(flag('2026-11-14'), 'overdue');
    assert.equal(flag('2026-11-15'), 'urgent_24h', 'due today');
    assert.equal(flag('2026-11-16'), 'urgent_24h', 'due tomorrow');
    assert.equal(flag('2026-11-17'), 'warning_72h');
    assert.equal(flag('2026-11-18'), 'warning_72h');
    assert.equal(flag('2026-11-19'), 'normal');
    assert.equal(flag('2026-11-14', 'Completed'), null, 'a finished order is never overdue');
    assert.equal(flag('2026-11-14', 'Cancelled'), null);
    assert.equal(deadlineFlag(null), null);
  });

  it('sends each order change once, and an override notice only to the replaced account', () => {
    const emitted = [];
    const socket = (user_id) => ({ data: { user: { user_id } }, emit: (event, body) => emitted.push({ to: user_id, event, body }) });
    const io = {
      emit: (event, body) => emitted.push({ to: 'everyone', event, body }),
      sockets: { sockets: new Map([['a', socket('u-admin')], ['b', socket('u-admin')], ['c', socket('u-owner')]]) }
    };
    const events = createOrderEvents({ io });
    const order = { order_id: 'o-1', tracking_no: 'XM-2026-0001', production_status: 'Pressing', version: 'v1', total_quote_amount: 999 };
    events.notifyUpdated(order);
    events.notifyUpdated(order); // the same change again, from the cloud NOTIFY
    events.notifyUpdated({ ...order, version: 'v2' });
    assert.deepEqual(emitted.map((e) => [e.to, e.event, e.body.version]), [['everyone', 'order_updated', 'v1'], ['everyone', 'order_updated', 'v2']]);
    assert.deepEqual(emitted[0].body, { order_id: 'o-1', tracking_no: 'XM-2026-0001', production_status: 'Pressing', version: 'v1' },
      'no money or other fields in the event');

    emitted.length = 0;
    const told = events.notifyOverridden({ user_id: 'u-admin', order_id: 'o-1', tracking_no: 'XM-2026-0001', overridden_by_role: 'Owner' });
    assert.equal(told, 2, 'both screens of that account');
    assert.ok(emitted.every((e) => e.to === 'u-admin' && e.event === 'order_overridden'));
    assert.deepEqual(emitted[0].body, { order_id: 'o-1', tracking_no: 'XM-2026-0001', overridden_by_role: 'Owner' });
  });
});

describe('Older offline cache: Pressing is allowed after the rebuild', () => {
  let dir;
  const open = (file) => new Promise((resolve, reject) => { const db = new sqlite3.Database(file, (e) => (e ? reject(e) : resolve(db))); });
  const run = (db, sql) => new Promise((resolve, reject) => db.run(sql, (e) => (e ? reject(e) : resolve())));
  const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (e, rows) => (e ? reject(e) : resolve(rows))));

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-upgrade-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('rebuilds the order table once and loses no rows', async () => {
    const file = path.join(dir, 'old_cache.db');
    let db = await open(file);
    // A cache from before migration 010: the status list has no 'Pressing'
    await run(db, `CREATE TABLE order_profiles (
      order_id TEXT PRIMARY KEY, customer_id TEXT, production_deadline DATETIME NOT NULL,
      production_status TEXT DEFAULT 'Pending' CHECK (production_status IN ('Pending', 'Approved', 'Printing', 'Completed', 'Delayed', 'Cancelled')),
      total_quote_amount REAL DEFAULT 0.00, sync_status TEXT DEFAULT 'synced', last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await run(db, 'ALTER TABLE order_profiles ADD COLUMN dirty_fields TEXT');
    await run(db, `INSERT INTO order_profiles (order_id, production_deadline, production_status, sync_status, dirty_fields)
                   VALUES ('o-synced', '2026-12-01', 'Printing', 'synced', NULL), ('o-offline', '2026-12-02', 'Pending', 'pending_update', '["production_deadline"]')`);
    await assert.rejects(run(db, "UPDATE order_profiles SET production_status = 'Pressing' WHERE order_id = 'o-synced'"), /CHECK/);
    await new Promise((r) => db.close(r));

    assert.equal(await upgradeLocalOrderStatusCheck(file), true);
    assert.equal(await upgradeLocalOrderStatusCheck(file), false, 'nothing to do the second time');

    db = await open(file);
    await run(db, "UPDATE order_profiles SET production_status = 'Pressing' WHERE order_id = 'o-synced'");
    assert.deepEqual(await all(db, 'SELECT order_id, production_status, sync_status, dirty_fields FROM order_profiles ORDER BY order_id'), [
      { order_id: 'o-offline', production_status: 'Pending', sync_status: 'pending_update', dirty_fields: '["production_deadline"]' },
      { order_id: 'o-synced', production_status: 'Pressing', sync_status: 'synced', dirty_fields: null }
    ]);
    await assert.rejects(run(db, "UPDATE order_profiles SET production_status = 'Ironing' WHERE order_id = 'o-synced'"), /CHECK/);
    await new Promise((r) => db.close(r));
  });
});

describe('Batch 3 on the offline server (API)', () => {
  let t;
  const items = {};
  let customerId;
  const orderIds = {};

  const createOrder = async (days, extra = {}) => {
    const r = await t.request('POST', '/api/orders', {
      token: t.tokens.production,
      body: { customer_id: customerId, production_deadline: shopDate(days), required_items: [{ inventory_id: items['Custom Shirt'], quantity_needed: 1 }], ...extra }
    });
    assert.equal(r.status, 201, r.text);
    return r.body;
  };

  before(async () => {
    t = await startTestServer();
    await Promise.all(['owner', 'admin', 'production', 'staff'].map((u) => t.login(u)));
    for (const it of fixtures.ITEMS) {
      const r = await t.request('POST', '/api/inventory', { token: t.tokens.production, body: it });
      items[it.item_name] = r.body.item.inventory_id;
    }
    const c = await t.request('POST', '/api/customers', { token: t.tokens.production, body: fixtures.CUSTOMERS[0] });
    customerId = c.body.customer.customer_id;
  });
  after(async () => { await t.close(); });

  it('tells each account its catalog capabilities, and the routes follow them', async () => {
    const caps = async (username) =>
      (await t.request('POST', '/api/auth/login', { body: { username, password: fixtures.PASSWORD } })).body.capabilities;
    const [admin, production, staff] = await Promise.all([caps('admin'), caps('production'), caps('staff')]);
    assert.ok(admin.includes('edit_inventory') && admin.includes('purge_inventory'));
    assert.ok(production.includes('edit_inventory') && !production.includes('purge_inventory'));
    assert.ok(!staff.includes('edit_inventory') && !staff.includes('purge_inventory'));

    const add = await t.request('POST', '/api/inventory', { token: t.tokens.staff, body: { item_name: 'Ballpen', item_category: 'Office' } });
    assert.deepEqual([add.status, add.body.error], [403, 'FORBIDDEN']);
    const purge = await t.request('DELETE', `/api/inventory/${items['Vinyl Sticker Paper']}/permanent`, { token: t.tokens.production });
    assert.deepEqual([purge.status, purge.body.error], [403, 'FORBIDDEN'], 'Production may edit but not purge');
    const empty = await t.request('POST', '/api/inventory/recycle-bin/empty', { token: t.tokens.production });
    assert.equal(empty.status, 403);
    const adminPurge = await t.request('DELETE', `/api/inventory/${items['Vinyl Sticker Paper']}/permanent`, { token: t.tokens.admin });
    assert.notEqual(adminPurge.status, 403, 'the Admin passes the role check');
    assert.equal((await t.get('SELECT COUNT(*) AS n FROM inventory_items WHERE item_name = ?', ['Vinyl Sticker Paper'])).n, 1);
  });

  it('sends the stock value of every item and the units on hand', async () => {
    const r = await t.request('GET', '/api/inventory', { token: t.tokens.staff });
    assert.equal(r.status, 200);
    const shirt = r.body.items.find((i) => i.item_name === 'Custom Shirt');
    assert.equal(shirt.stock_value, 57150, '381 x 150');
    assert.equal(r.body.items.find((i) => i.item_name === 'Sublimation Ink (Cyan)').stock_value, 0);
    const units = fixtures.ITEMS.reduce((sum, i) => sum + i.quantity_available, 0);
    assert.equal(r.body.summary.total_units, units);
    assert.equal(r.body.summary.stock_value, Math.round(r.body.items.reduce((s, i) => s + i.stock_value * 100, 0)) / 100);
  });

  it('flags each order and can list the most urgent first', async () => {
    orderIds.far = (await createOrder(30)).order_id;
    orderIds.soon = (await createOrder(3)).order_id;
    const today = await createOrder(0);
    orderIds.today = today.order_id;
    assert.equal(today.order.deadline_flag, 'urgent_24h', 'the answer to a new order carries the flag');
    orderIds.late = (await createOrder(10)).order_id;
    orderIds.lateButDone = (await createOrder(11)).order_id;
    await t.run('UPDATE order_profiles SET production_deadline = ? WHERE order_id = ?', [`${shopDate(-2)}T00:00:00`, orderIds.late]);
    await t.run("UPDATE order_profiles SET production_deadline = ?, production_status = 'Completed' WHERE order_id = ?",
      [`${shopDate(-5)}T00:00:00`, orderIds.lateButDone]);

    const list = await t.request('GET', '/api/orders?sort=priority', { token: t.tokens.staff });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual([list.body.sort, list.body.dir], ['priority', 'asc']);
    assert.deepEqual(list.body.orders.map((o) => [o.order_id, o.deadline_flag]), [
      [orderIds.late, 'overdue'], [orderIds.today, 'urgent_24h'], [orderIds.soon, 'warning_72h'], [orderIds.far, 'normal'],
      [orderIds.lateButDone, null]
    ]);
    const reversed = await t.request('GET', '/api/orders?sort=priority&dir=desc', { token: t.tokens.staff });
    assert.equal(reversed.body.orders[0].order_id, orderIds.lateButDone);

    const detail = await t.request('GET', `/api/orders/${orderIds.late}`, { token: t.tokens.staff });
    assert.equal(detail.body.order.deadline_flag, 'overdue');
    assert.deepEqual(detail.body.status_history, [], 'no status change yet');
    assert.equal((await t.request('GET', '/api/orders?sort=urgency', { token: t.tokens.staff })).status, 400);
  });

  it('shows the same flags on the dashboard and counts Pressing', async () => {
    const r = await t.request('GET', '/api/reports/dashboard', { token: t.tokens.staff });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.orders.overdue.map((o) => [o.order_id, o.deadline_flag]), [[orderIds.late, 'overdue']]);
    assert.ok(r.body.orders.due_this_week.some((o) => o.order_id === orderIds.today && o.deadline_flag === 'urgent_24h'));
    assert.equal(r.body.orders.by_status.Pressing, 0);
  });

  it('records who edited an order offline, so the sync can settle a clash by rank', async () => {
    const before = t.orderEvents.updated.length;
    const r = await t.request('PATCH', `/api/orders/${orderIds.far}/details`, { token: t.tokens.admin, body: { production_deadline: shopDate(40) } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.source, r.body.overridden, r.body.order.last_edited_by, r.body.order.last_edited_role, r.body.order.deadline_flag],
      ['local', false, 'u-admin', 'Admin', 'normal']);
    assert.equal(t.orderEvents.updated.length, before + 1, 'the other screens are told');
    assert.equal(t.orderEvents.updated.at(-1).order_id, orderIds.far);

    const design = await t.request('PATCH', `/api/orders/${orderIds.far}/design`, {
      token: t.tokens.production, body: { design_drive_link: 'https://drive.google.com/file/d/abc123/view' }
    });
    assert.equal(design.status, 200, design.text);
    const row = await t.get('SELECT last_edited_by, last_edited_role FROM order_profiles WHERE order_id = ?', [orderIds.far]);
    assert.deepEqual(row, { last_edited_by: 'u-production', last_edited_role: 'Production' });

    // The editor comes from the login token, never from the request
    const forged = await t.request('PATCH', `/api/orders/${orderIds.soon}/details`, {
      token: t.tokens.production, body: { production_deadline: shopDate(8), last_edited_role: 'Owner', last_edited_by: 'u-owner' }
    });
    assert.equal(forged.status, 200, forged.text);
    assert.equal(forged.body.order.last_edited_role, 'Production');
  });

  it('refuses an override flag that is not true or false', async () => {
    const details = await t.request('PATCH', `/api/orders/${orderIds.far}/details`, { token: t.tokens.owner, body: { production_deadline: shopDate(41), override: 'yes' } });
    assert.deepEqual([details.status, details.body.error], [400, 'VALIDATION_FAILED']);
    const design = await t.request('PATCH', `/api/orders/${orderIds.far}/design`, {
      token: t.tokens.owner, body: { design_drive_link: 'https://drive.google.com/file/d/abc123/view', override: 1 }
    });
    assert.deepEqual([design.status, design.body.error], [400, 'VALIDATION_FAILED']);
  });

  it('accepts Pressing as a status but still needs the cloud to move stock-holding orders', async () => {
    const r = await t.request('PATCH', `/api/orders/${orderIds.far}/status`, { token: t.tokens.production, body: { status: 'Pressing' } });
    assert.deepEqual([r.status, r.body.error], [503, 'STATUS_CHANGE_REQUIRES_CLOUD']);
    const bad = await t.request('PATCH', `/api/orders/${orderIds.far}/status`, { token: t.tokens.production, body: { status: 'Ironing' } });
    assert.equal(bad.status, 400);
    assert.equal((await t.request('GET', '/api/orders?status=Pressing', { token: t.tokens.staff })).status, 200);
  });

  it('lets only an Owner or Admin see and settle sync conflicts, and only with the cloud', async () => {
    await t.run("UPDATE order_profiles SET sync_conflict = 'changed online too', tracking_no = 'XM-2026-0009' WHERE order_id = ?", [orderIds.far]);
    const url = `/api/sync/conflicts/order_profiles/${orderIds.far}/resolve`;
    for (const who of ['production', 'staff']) {
      assert.equal((await t.request('GET', '/api/sync/conflicts', { token: t.tokens[who] })).status, 403, who);
      assert.equal((await t.request('POST', url, { token: t.tokens[who], body: { keep: 'cloud' } })).status, 403, who);
    }
    assert.equal((await t.request('POST', url, { body: { keep: 'cloud' } })).status, 401);

    const list = await t.request('GET', '/api/sync/conflicts', { token: t.tokens.admin });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.conflicts.length, 1);
    const [c] = list.body.conflicts;
    assert.deepEqual([c.table, c.id, c.title, c.keep_local_blocked_reason], ['order_profiles', orderIds.far, 'Order XM-2026-0009', null]);
    assert.deepEqual([...c.changed].sort(), ['Design link', 'Production deadline'], 'plain names, and never the editor columns');
    assert.equal((await t.request('GET', '/api/sync/status', { token: t.tokens.staff })).body.conflicts, 1);

    const bad = await t.request('POST', url, { token: t.tokens.admin, body: { keep: 'mine' } });
    assert.deepEqual([bad.status, bad.body.error], [400, 'VALIDATION_FAILED']);
    const table = await t.request('POST', `/api/sync/conflicts/users/${orderIds.far}/resolve`, { token: t.tokens.admin, body: { keep: 'cloud' } });
    assert.equal(table.status, 400, 'accounts are never settled here');
    const none = await t.request('POST', `/api/sync/conflicts/order_profiles/${orderIds.soon}/resolve`, { token: t.tokens.admin, body: { keep: 'cloud' } });
    assert.deepEqual([none.status, none.body.error], [404, 'CONFLICT_NOT_FOUND']);

    const offline = await t.request('POST', url, { token: t.tokens.owner, body: { keep: 'local' } });
    assert.deepEqual([offline.status, offline.body.error], [503, 'CLOUD_UNREACHABLE']);
    assert.ok((await t.get('SELECT sync_conflict FROM order_profiles WHERE order_id = ?', [orderIds.far])).sync_conflict, 'still waiting');
  });
});

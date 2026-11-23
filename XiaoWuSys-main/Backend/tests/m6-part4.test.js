// Batch M6 part 4 on this computer's database (cloud switched off, like `npm run demo`):
// archived orders and customers are hidden, read-only and refuse new orders (PB 23, D2), the
// archive routes need the cloud, and an older cache is upgraded for migration 013. The cloud
// paths run on real PostgreSQL in m6-part4.pg.test.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTestServer, openDb, shopDate } = require('./helpers/testServer');
const { createLocalSchema } = require('../services/localSchema');
const { ensureLocalSyncColumns } = require('../utils/localSync');
const { SYNC_TABLES } = require('../services/sync');
const { sqliteRun, sqliteAll } = require('../services/records');

describe('M6 part 4 offline: archived orders and customers', () => {
  let t;
  let owner; let admin; let production; let staff;
  let customer; let quiet; let orderId; let openId;

  before(async () => {
    t = await startTestServer();
    owner = await t.login('owner');
    admin = await t.login('admin');
    production = await t.login('staff');
    staff = await t.login('production');
    customer = (await t.request('POST', '/api/customers', { token: production, body: { full_name: 'Agdao NHS' } })).body.customer.customer_id;
    quiet = (await t.request('POST', '/api/customers', { token: production, body: { full_name: 'Old Client' } })).body.customer.customer_id;
    const make = async (who) => (await t.request('POST', '/api/orders', {
      token: owner, body: { customer_id: who, production_deadline: shopDate(9), resolution: 'Delayed', total_quote_amount: 1000 }
    })).body.order_id;
    orderId = await make(customer);
    openId = await make(customer);
    // As the cloud would have it after a sync: a completed order, archived by the Owner
    await t.run("UPDATE order_profiles SET production_status = 'Completed', sync_status = 'synced', archived_at = '2026-11-01 02:00:00', archived_by = 'u-owner' WHERE order_id = ?", [orderId]);
    await t.run("UPDATE customers SET sync_status = 'synced', archived_at = '2026-11-01 02:00:00', archived_by = 'u-admin' WHERE customer_id = ?", [quiet]);
  });
  after(async () => { await t.close(); });

  it('hides archived orders unless asked for them', async () => {
    const list = await t.request('GET', '/api/orders', { token: staff });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.orders.map((o) => o.order_id), [openId]);
    assert.equal(list.body.include_archived, false);
    const all = await t.request('GET', '/api/orders?include_archived=true', { token: staff });
    assert.deepEqual(all.body.orders.map((o) => o.order_id).sort(), [orderId, openId].sort());
    assert.equal(all.body.orders.find((o) => o.order_id === orderId).archived_at, '2026-11-01T02:00:00');
    // "Show archived" in the Orders tab: archived orders ONLY
    const only = await t.request('GET', '/api/orders?include_archived=only', { token: staff });
    assert.equal(only.status, 200, only.text);
    assert.deepEqual(only.body.orders.map((o) => o.order_id), [orderId]);
    assert.equal(only.body.archived_only, true);
    assert.equal((await t.request('GET', '/api/orders?include_archived=maybe', { token: staff })).status, 400);
  });

  it('keeps an archived order readable but refuses every change', async () => {
    const detail = await t.request('GET', `/api/orders/${orderId}`, { token: owner });
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual([detail.body.allowed_actions.restore_order, detail.body.allowed_actions.record_payment, detail.body.allowed_actions.archive_order],
      [true, false, false]);
    assert.match(detail.body.allowed_actions.payment_blocked_reason, /archived/);
    const attempts = [
      ['POST', `/api/orders/${orderId}/payments`, { amount: 10, payment_type: 'Cash' }],
      ['PATCH', `/api/orders/${orderId}/details`, { production_deadline: shopDate(20) }],
      ['PATCH', `/api/orders/${orderId}/design`, { design_drive_link: 'https://drive.google.com/file/d/abc' }],
      ['POST', `/api/orders/${orderId}/items`, { product_type: 'Mug', quantity: 1 }],
      ['PATCH', `/api/orders/${orderId}/status`, { status: 'Cancelled' }],
      ['POST', `/api/orders/${orderId}/quote`, { dry_run: true }],
      ['POST', `/api/orders/${orderId}/approve`, { expected_version: 'x' }],
      ['POST', `/api/orders/${orderId}/payments/p-1/void`, { reason: 'x' }]
    ];
    for (const [method, url, body] of attempts) {
      const r = await t.request(method, url, { token: owner, body });
      assert.deepEqual([r.status, r.body.error], [409, 'RECORD_ARCHIVED'], `${method} ${url}`);
      assert.equal(r.body.message, 'This order is archived. Restore it first if you need to change it.');
    }
    assert.equal((await t.get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [orderId])).n, 0);
  });

  it('hides archived customers and refuses them new orders', async () => {
    const list = await t.request('GET', '/api/customers', { token: production });
    assert.ok(!list.body.customers.some((c) => c.customer_id === quiet));
    const all = await t.request('GET', '/api/customers?include_archived=true', { token: production });
    assert.equal(all.body.customers.find((c) => c.customer_id === quiet).archived_by, 'u-admin');
    // "Show archived" lists the archived ones alone; the default list is the active ones alone
    const only = await t.request('GET', '/api/customers?include_archived=only', { token: production });
    assert.equal(only.status, 200, only.text);
    assert.ok(only.body.customers.length > 0 && only.body.customers.every((c) => c.archived_at), 'archived clients only');
    assert.ok(only.body.customers.some((c) => c.customer_id === quiet));
    assert.ok(list.body.customers.every((c) => !c.archived_at));
    assert.equal(only.body.customers.length + list.body.customers.length, all.body.customers.length);
    const suppliersOnly = await t.request('GET', '/api/suppliers?include_archived=only', { token: production });
    assert.equal(suppliersOnly.status, 200, suppliersOnly.text);
    assert.ok(suppliersOnly.body.suppliers.every((x) => x.archived_at));
    assert.equal((await t.request('GET', '/api/customers?include_archived=maybe', { token: production })).status, 400);
    const r = await t.request('POST', '/api/orders', { token: production, body: { customer_id: quiet, production_deadline: shopDate(5), resolution: 'Delayed' } });
    assert.deepEqual([r.status, r.body.error], [409, 'RECORD_ARCHIVED']);
    assert.match(r.body.message, /customer is archived/);
  });

  it('keeps archiving for the Owner and Admin, online only', async () => {
    for (const token of [production, staff]) {
      assert.equal((await t.request('POST', `/api/orders/${orderId}/restore`, { token })).status, 403);
      assert.equal((await t.request('POST', `/api/customers/${quiet}/restore`, { token })).status, 403);
    }
    for (const [url, token] of [[`/api/orders/${orderId}/restore`, owner], [`/api/orders/${openId}/archive`, admin], [`/api/customers/${quiet}/restore`, admin]]) {
      const r = await t.request('POST', url, { token });
      assert.deepEqual([r.status, r.body.error], [503, 'ARCHIVE_REQUIRES_CLOUD'], url);
    }
    assert.equal((await t.request('POST', '/api/orders/nope/archive', { token: owner })).status, 404);
    assert.equal((await t.request('POST', '/api/customers/nope/archive', { token: owner })).status, 404);
  });

  it('upgrades an older offline cache for migration 013 without losing rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-013-'));
    const db = await openDb(path.join(dir, 'old.db'));
    try {
      await sqliteRun(db, `CREATE TABLE customers (customer_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, contact_number TEXT, platform_source TEXT,
        sync_status TEXT DEFAULT 'synced', last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      await sqliteRun(db, `CREATE TABLE order_items (line_item_id TEXT PRIMARY KEY, order_id TEXT, inventory_id TEXT, product_type TEXT NOT NULL,
        quantity INTEGER NOT NULL, size TEXT, custom_name TEXT, custom_number TEXT, price REAL DEFAULT 0.00,
        sync_status TEXT DEFAULT 'synced', last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      await sqliteRun(db, "INSERT INTO customers (customer_id, full_name) VALUES ('c-1', 'Agdao NHS')");
      await sqliteRun(db, "INSERT INTO order_items (line_item_id, order_id, product_type, quantity) VALUES ('l-1', 'o-1', 'Shirt', 3)");
      await createLocalSchema(db);
      await ensureLocalSyncColumns(db, SYNC_TABLES.map((s) => s.table), { log: () => {} });
      assert.deepEqual(await sqliteAll(db, 'SELECT full_name, archived_at, archived_by FROM customers'), [{ full_name: 'Agdao NHS', archived_at: null, archived_by: null }]);
      assert.deepEqual(await sqliteAll(db, 'SELECT quantity, unit_cost FROM order_items'), [{ quantity: 3, unit_cost: null }]);
      const cols = (await sqliteAll(db, 'PRAGMA table_info(order_consumables_log)')).map((c) => c.name);
      assert.ok(cols.includes('unit_cost'));
    } finally {
      await new Promise((resolve) => db.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

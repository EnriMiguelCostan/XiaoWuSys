// Batch M6, part 2 on this computer's database (cloud switched off, like `npm run demo`):
// selling prices in the catalog, the jersey-roster import, the Owner's hand-typed quote with its
// audit row, the quote / usage-rate routes that need the cloud, and an older cache being
// upgraded for migration 011. The cloud paths run on real PostgreSQL in m6-part2.pg.test.js.
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

describe('M6 part 2 offline: selling price, roster import, typed quote, cloud-only routes', () => {
  let t;
  let owner; let admin; let production; let staff;
  let shirt; let ink; let customer;

  before(async () => {
    t = await startTestServer();
    owner = await t.login('owner');
    admin = await t.login('admin');
    production = await t.login('production');
    staff = await t.login('staff');
    customer = (await t.request('POST', '/api/customers', { token: production, body: { full_name: 'Agdao NHS', contact_number: '09391234567' } })).body.customer.customer_id;
  });
  after(async () => { await t.close(); });

  it('keeps a selling price per piece next to the cost', async () => {
    const made = await t.request('POST', '/api/inventory', {
      token: production,
      body: { item_name: 'Jersey Blank', item_category: 'Apparel', quantity_available: 40, unit_cost: 120, selling_price: 250 }
    });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.body.item.unit_cost, made.body.item.selling_price], [120, 250]);
    shirt = made.body.item.inventory_id;
    ink = (await t.request('POST', '/api/inventory', { token: production, body: { item_name: 'Ink', item_category: 'Consumable', quantity_available: 9, unit: 'ml' } })).body.item;
    assert.equal(ink.selling_price, 0, 'consumables need no selling price');

    const edited = await t.request('PATCH', `/api/inventory/${shirt}`, { token: admin, body: { selling_price: 260.5 } });
    assert.deepEqual([edited.status, edited.body.changed, edited.body.item.selling_price], [200, ['selling_price'], 260.5]);
    for (const bad of [-1, '250', 1.005]) {
      const r = await t.request('PATCH', `/api/inventory/${shirt}`, { token: admin, body: { selling_price: bad } });
      assert.equal(r.status, 400, String(bad));
      assert.match(r.body.message, /^Selling price /);
    }
    const trail = await t.get("SELECT details FROM inventory_audit_log WHERE inventory_id = ? AND action = 'edited'", [shirt]);
    assert.deepEqual(JSON.parse(trail.details), { before: { selling_price: 250 }, after: { selling_price: 260.5 } });
  });

  let orderId;
  it('imports a jersey roster in one go, all rows or none', async () => {
    // Delayed: nothing reserved, so linked rows can be added offline
    const created = await t.request('POST', '/api/orders', {
      token: production, body: { customer_id: customer, production_deadline: shopDate(12), resolution: 'Delayed' }
    });
    assert.equal(created.status, 201, created.text);
    orderId = created.body.order_id;

    const roster = [
      { product_type: 'Jersey Blank', quantity: 1, size: 'M', custom_name: 'DELA CRUZ', custom_number: '7', inventory_id: shirt },
      { product_type: 'Jersey Blank', quantity: 1, size: 'L', custom_name: 'SANTOS', custom_number: '23', inventory_id: shirt },
      { product_type: 'Jersey Blank', quantity: 2, size: 'XL', inventory_id: shirt }
    ];
    const r = await t.request('POST', `/api/orders/${orderId}/items/bulk`, { token: production, body: { items: roster } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.source, 'local');
    assert.deepEqual(r.body.items.map((i) => [i.custom_name, i.custom_number, i.size, i.quantity]),
      [['DELA CRUZ', '7', 'M', 1], ['SANTOS', '23', 'L', 1], [null, null, 'XL', 2]], 'in the order they were sent');
    assert.ok(r.body.items.every((i) => i.sync_status === 'pending_insert'));

    const before = (await t.get('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [orderId])).n;
    const bad = await t.request('POST', `/api/orders/${orderId}/items/bulk`, {
      token: production, body: { items: [roster[0], { ...roster[1], quantity: 0 }, { ...roster[2], product_type: '' }] }
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.details.map((d) => d.field), ['items[1].quantity', 'items[2].product_type']);
    assert.equal(bad.body.message, 'Row 2: Quantity must be at least 1.');
    const gone = await t.request('POST', `/api/orders/${orderId}/items/bulk`, {
      token: production, body: { items: [roster[0], { ...roster[1], inventory_id: 'no-such-item' }] }
    });
    assert.deepEqual([gone.status, gone.body.error, gone.body.missing_inventory_ids], [404, 'INVENTORY_ITEM_NOT_FOUND', ['no-such-item']]);
    assert.equal((await t.get('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [orderId])).n, before, 'a refused import adds nothing');

    const tooMany = await t.request('POST', `/api/orders/${orderId}/items/bulk`, {
      token: production, body: { items: Array.from({ length: 501 }, () => ({ product_type: 'Jersey', quantity: 1 })) }
    });
    assert.deepEqual([tooMany.status, tooMany.body.details[0].field], [400, 'items']);
    assert.equal((await t.request('POST', `/api/orders/${orderId}/items/bulk`, { token: production, body: { items: [] } })).status, 400);
    assert.equal((await t.request('POST', `/api/orders/${orderId}/items/bulk`, { token: staff, body: { items: roster } })).status, 403);
  });

  it('needs the cloud to import stock-linked rows into an order that holds its stock', async () => {
    const reserved = await t.request('POST', '/api/orders', {
      token: production,
      body: { customer_id: customer, production_deadline: shopDate(12), required_items: [{ inventory_id: shirt, quantity_needed: 2 }] }
    });
    assert.equal(reserved.status, 201, reserved.text);
    const r = await t.request('POST', `/api/orders/${reserved.body.order_id}/items/bulk`, {
      token: production, body: { items: [{ product_type: 'Jersey Blank', quantity: 1, inventory_id: shirt }] }
    });
    assert.deepEqual([r.status, r.body.error], [503, 'ITEM_RESERVATION_REQUIRES_CLOUD']);
    const unlinked = await t.request('POST', `/api/orders/${reserved.body.order_id}/items/bulk`, {
      token: production, body: { items: [{ product_type: 'Name print', quantity: 1, custom_name: 'REYES' }] }
    });
    assert.equal(unlinked.status, 201, 'rows with no stock link reserve nothing, so they may be added');

    const cancelled = await t.request('POST', '/api/orders', {
      token: production, body: { customer_id: customer, production_deadline: shopDate(12), resolution: 'Cancelled' }
    });
    const closed = await t.request('POST', `/api/orders/${cancelled.body.order_id}/items/bulk`, {
      token: production, body: { items: [{ product_type: 'Jersey', quantity: 1 }] }
    });
    assert.deepEqual([closed.status, closed.body.error], [409, 'ORDER_CLOSED']);
  });

  it('turns a typed quote into its own subtotal and records it in the audit trail', async () => {
    const r = await t.request('PATCH', `/api/orders/${orderId}/details`, { token: owner, body: { total_quote_amount: 1200 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.changed, ['total_quote_amount'], 'the breakdown columns follow but are not reported as changed');
    const row = await t.get('SELECT subtotal_amount, discount_amount, discount_reason, dirty_fields FROM order_profiles WHERE order_id = ?', [orderId]);
    assert.deepEqual([row.subtotal_amount, row.discount_amount, row.discount_reason], [1200, 0, null]);
    assert.ok(['total_quote_amount', 'subtotal_amount', 'discount_amount', 'discount_reason'].every((f) => JSON.parse(row.dirty_fields).includes(f)),
      'pushed together when the sync runs');
    const audit = await t.all("SELECT action, details, performed_by, performed_role, sync_status FROM audit_log WHERE entity_id = ?", [orderId]);
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].action, audit[0].performed_by, audit[0].performed_role, audit[0].sync_status],
      ['quote_overridden', 'u-owner', 'Owner', 'pending_insert']);
    const details = JSON.parse(audit[0].details);
    assert.deepEqual([details.before.total_quote_amount, details.after.total_quote_amount, details.after.subtotal_amount], [0, 1200, 1200]);

    const deadlineOnly = await t.request('PATCH', `/api/orders/${orderId}/details`, { token: production, body: { production_deadline: shopDate(14) } });
    assert.equal(deadlineOnly.status, 200, deadlineOnly.text);
    assert.equal((await t.all('SELECT 1 FROM audit_log WHERE entity_id = ?', [orderId])).length, 1, 'only quote changes are audited here');

    const detail = await t.request('GET', `/api/orders/${orderId}`, { token: staff });
    assert.deepEqual(detail.body.quote, {
      has_quote: true, subtotal_amount: 1200, discount_amount: 0, discount_reason: null, total_quote_amount: 1200,
      lines: null // typed by hand: the items carry no prices, so the quotation shows totals only
    });
    assert.deepEqual(detail.body.consumables_deducted, []);
    assert.deepEqual([detail.body.allowed_actions.generate_quote, detail.body.allowed_actions.print_quote], [false, true]);
    const mine = await t.request('GET', `/api/orders/${orderId}`, { token: owner });
    assert.deepEqual([mine.body.allowed_actions.generate_quote, mine.body.allowed_actions.apply_discount], [true, true]);
  });

  it('keeps calculated quotes and usage-rate changes for the Owner / editors, online only', async () => {
    for (const token of [admin, production, staff]) {
      assert.equal((await t.request('POST', `/api/orders/${orderId}/quote`, { token, body: { dry_run: true } })).status, 403);
    }
    const offline = await t.request('POST', `/api/orders/${orderId}/quote`, { token: owner, body: {} });
    assert.deepEqual([offline.status, offline.body.error], [503, 'QUOTE_REQUIRES_CLOUD']);
    const both = await t.request('POST', `/api/orders/${orderId}/quote`, { token: owner, body: { discount_amount: 10, discount_percent: 5 } });
    assert.equal(both.status, 400, 'checked before anything else');
    const pct = await t.request('POST', `/api/orders/${orderId}/quote`, { token: owner, body: { discount_percent: 101 } });
    assert.deepEqual([pct.status, pct.body.details[0].field], [400, 'discount_percent']);

    const read = await t.request('GET', `/api/inventory/${shirt}/consumable-rates`, { token: staff });
    assert.equal(read.status, 200, read.text);
    assert.deepEqual([read.body.source, read.body.rates, read.body.triggers, read.body.can_edit], ['local', [], ['Pressing', 'Completed'], false]);
    assert.ok(read.body.consumable_options.some((o) => o.inventory_id === ink.inventory_id));
    assert.ok(!read.body.consumable_options.some((o) => o.inventory_id === shirt), 'a blank never uses itself up');

    const body = { rates: [{ consumable_inventory_id: ink.inventory_id, quantity_per_piece: 0.25 }] };
    assert.equal((await t.request('PUT', `/api/inventory/${shirt}/consumable-rates`, { token: staff, body })).status, 403);
    const offline2 = await t.request('PUT', `/api/inventory/${shirt}/consumable-rates`, { token: production, body });
    assert.deepEqual([offline2.status, offline2.body.error], [503, 'RATES_REQUIRE_CLOUD']);
    assert.equal((await t.get('SELECT COUNT(*) AS n FROM consumable_rates')).n, 0);
    const bad = await t.request('PUT', `/api/inventory/${shirt}/consumable-rates`, { token: production, body: { rates: [{ consumable_inventory_id: shirt, quantity_per_piece: 1 }] } });
    assert.deepEqual([bad.status, bad.body.message], [400, 'Row 1: an item cannot use itself up.']);
  });

  it('upgrades an older offline cache for migration 011 without losing rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-011-'));
    const db = await openDb(path.join(dir, 'old.db'));
    try {
      // The shape of these tables before migration 011
      await sqliteRun(db, `CREATE TABLE inventory_items (inventory_id TEXT PRIMARY KEY, item_name TEXT NOT NULL, item_category TEXT NOT NULL,
        quantity_available INTEGER NOT NULL DEFAULT 0, quantity_reserved INTEGER NOT NULL DEFAULT 0, minimum_threshold INTEGER NOT NULL DEFAULT 0,
        unit_cost REAL NOT NULL, sync_status TEXT DEFAULT 'synced', last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      await sqliteRun(db, `CREATE TABLE order_profiles (order_id TEXT PRIMARY KEY, customer_id TEXT, date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
        production_deadline DATETIME NOT NULL, production_status TEXT DEFAULT 'Pending', design_drive_link TEXT, total_quote_amount REAL DEFAULT 0.00,
        sync_status TEXT DEFAULT 'synced', last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      await sqliteRun(db, "INSERT INTO inventory_items (inventory_id, item_name, item_category, unit_cost) VALUES ('i-1', 'Shirt', 'Apparel', 150)");
      await sqliteRun(db, "INSERT INTO order_profiles (order_id, production_deadline, total_quote_amount) VALUES ('o-1', '2030-01-01', 800)");
      await createLocalSchema(db);
      await ensureLocalSyncColumns(db, SYNC_TABLES.map((s) => s.table), { log: () => {} });
      const [item] = await sqliteAll(db, 'SELECT selling_price FROM inventory_items');
      const [order] = await sqliteAll(db, 'SELECT total_quote_amount, subtotal_amount, discount_amount, discount_reason FROM order_profiles');
      assert.deepEqual(item, { selling_price: 0 });
      assert.deepEqual(order, { total_quote_amount: 800, subtotal_amount: 0, discount_amount: 0, discount_reason: null });
      const tables = (await sqliteAll(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
      assert.ok(tables.includes('consumable_rates') && tables.includes('order_consumables_log'));
    } finally {
      await new Promise((resolve) => db.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

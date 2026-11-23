// ==========================================
// BATCH M6 PART 4 ON A REAL POSTGRESQL DATABASE (migration 013: PB 23 archiving, PB 22 cost
// history, PB 26 load and stress)
// Runs only when TEST_DATABASE_URL is set (CI starts a throw-away PostgreSQL for it). The
// database is WIPED first: localhost or a database whose name contains "test" only, never Neon.
//
// Checks: 013 applies to an existing shop database without moving any row's version and is safe
// to run twice; only closed orders and customers without open orders can be archived, archived
// records are hidden and refuse changes until restored (with audit rows), an archive and a new
// order for the same customer at the same moment never both succeed; completing an order and
// taking consumables keep the unit cost of that moment, so a later catalog cost change does not
// move the P&L; 120+ simultaneous requests keep the reservation maths exact, let exactly one of
// many edits with the same version through, and never fail with a server error; and a burst of
// offline rows synced by many simultaneous "Sync now" presses is pushed exactly once.
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgTarget, resetDatabase, startPgTestServer, readMigration } = require('./helpers/pgTestServer');
const { shopDate } = require('./helpers/testServer');
const { sqliteAll, sqliteGet, sqliteRun } = require('../services/records');

const { url, skip } = pgTarget();
const FILE = '013_archive_and_historical_cogs.sql';

describe('M6 part 4 on real PostgreSQL: archiving, cost history, load and stress', { skip }, () => {
  let pool;
  let server;
  let owner; let admin; let production;

  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  const audits = async (id) => (await pool.query('SELECT action, performed_role FROM audit_log WHERE entity_id = $1 ORDER BY created_at, audit_id', [id])).rows;
  const insertOrder = async (id, status, { customer = 'c-1', quote = 0, lines = [], reserved = false } = {}) => {
    await pool.query(
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount, stock_reserved)
       VALUES ($1, $2, $3, $4, $5, $6)`, [id, customer, `${shopDate(20)} 00:00:00`, status, quote, reserved]);
    let n = 0;
    for (const [inventory_id, quantity] of lines) {
      await pool.query('INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity) VALUES ($1, $2, $3, $4, $5)',
        [`${id}-l${++n}`, id, inventory_id, 'Item', quantity]);
      if (reserved) await pool.query('UPDATE inventory_items SET quantity_reserved = quantity_reserved + $2 WHERE inventory_id = $1', [inventory_id, quantity]);
    }
  };
  const call = (method, path, token, body) => server.request(method, path, { token, body });

  before(async () => {
    const { Pool } = require('pg'); // only needed when this suite runs
    pool = new Pool({ connectionString: url, max: 20 });
    await resetDatabase(pool, { before: '013' });
    await pool.query(`INSERT INTO users (user_id, username, password_hash, role) VALUES
      ('u-owner', 'owner', 'x', 'Owner'), ('u-admin', 'admin', 'x', 'Admin'),
      ('u-production', 'staff', 'x', 'Staff'), ('u-staff', 'production', 'x', 'Production')`);
    await pool.query("INSERT INTO customers (customer_id, full_name) VALUES ('c-1', 'Agdao NHS'), ('c-2', 'Old Client'), ('c-3', 'Race Client')");
    for (const [id, name, qty, cost] of [['i-shirt', 'Jersey Blank', 500, 120], ['i-ink', 'Sublimation Ink', 1000, 2.5], ['i-blank', 'Limited Blank', 100, 50], ['i-paper', 'Scarce Paper', 30, 4]]) {
      await pool.query(`INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, unit_cost)
                        VALUES ($1, $2, 'Raw', $3, $4)`, [id, name, qty, cost]);
    }
    await insertOrder('o-old', 'Completed', { quote: 500, lines: [['i-shirt', 2]] });
  });
  after(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('applies migration 013 without touching existing rows, and running it again changes nothing', async () => {
    const versions = async () => one(`SELECT (SELECT last_modified::text FROM order_profiles WHERE order_id = 'o-old') AS o,
      (SELECT last_modified::text FROM customers WHERE customer_id = 'c-1') AS c,
      (SELECT last_modified::text FROM order_items WHERE line_item_id = 'o-old-l1') AS i`);
    const before = await versions();
    const { applyPendingMigrations } = require('../services/migrations');
    assert.ok((await applyPendingMigrations(pool, { log: () => {} })).applied.includes(FILE));
    assert.deepEqual((await applyPendingMigrations(pool, { log: () => {} })).applied, []);
    await pool.query(readMigration(FILE));
    assert.deepEqual(await versions(), before, 'no backfill');
    assert.deepEqual(await one("SELECT archived_at, archived_by FROM order_profiles WHERE order_id = 'o-old'"), { archived_at: null, archived_by: null });
    assert.equal((await one("SELECT unit_cost FROM order_items WHERE line_item_id = 'o-old-l1'")).unit_cost, null);
    const idx = await pool.query("SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_order_profiles_active', 'idx_customers_active') ORDER BY indexname");
    assert.deepEqual(idx.rows.map((r) => r.indexname), ['idx_customers_active', 'idx_order_profiles_active']);
    await assert.rejects(pool.query("UPDATE order_items SET unit_cost = -1 WHERE line_item_id = 'o-old-l1'"), { code: '23514' });
    const { checkCloudSchema } = require('../services/schemaCheck');
    const schema = await checkCloudSchema(pool);
    assert.deepEqual([schema.ok, schema.missing, schema.missingTriggers], [true, [], []]);

    server = await startPgTestServer(pool);
    owner = server.tokenFor('u-owner', 'Owner');
    admin = server.tokenFor('u-admin', 'Admin');
    production = server.tokenFor('u-production', 'Staff');
  });

  it('keeps the unit cost of the moment an order is completed and its consumables are taken', async () => {
    await pool.query(`INSERT INTO consumable_rates (rate_id, product_inventory_id, consumable_inventory_id, quantity_per_piece, trigger_status)
                      VALUES ('r-1', 'i-shirt', 'i-ink', 2, 'Pressing')`);
    await insertOrder('o-cost', 'Printing', { quote: 3000, lines: [['i-shirt', 5]], reserved: true });
    const pnlBefore = (await call('GET', '/api/reports/pnl', owner)).body;
    // Migration 015: nothing has been paid, so only the Owner may hand it over, and must say so
    const refused = await call('PATCH', '/api/orders/o-cost/status', production, { status: 'Completed' });
    assert.deepEqual([refused.status, refused.body.error, refused.body.can_complete_with_balance], [409, 'COMPLETION_REQUIREMENTS_NOT_MET', false]);
    assert.equal((await call('PATCH', '/api/orders/o-cost/status', production, { status: 'Completed', allow_unpaid: true })).status, 403);
    const done = await call('PATCH', '/api/orders/o-cost/status', owner, { status: 'Completed', allow_unpaid: true });
    assert.equal(done.status, 200, done.text);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM order_deliveries WHERE order_id = 'o-cost'")).n, 1, 'the hand-over of all 5 pieces is recorded');
    assert.equal((await one("SELECT unit_cost::text AS c FROM order_items WHERE order_id = 'o-cost'")).c, '120.00');
    assert.equal((await one("SELECT unit_cost::text AS c, quantity_deducted FROM order_consumables_log WHERE order_id = 'o-cost'")).c, '2.50');
    const pnlAfter = (await call('GET', '/api/reports/pnl', owner)).body;
    assert.equal(pnlAfter.cogs_blanks - pnlBefore.cogs_blanks, 600, '5 blanks at 120');
    assert.equal(pnlAfter.cogs_consumables - pnlBefore.cogs_consumables, 25, '10 ml of ink at 2.50');

    // The catalog cost goes up later: this month's P&L must not move
    await pool.query("UPDATE inventory_items SET unit_cost = 999 WHERE inventory_id IN ('i-shirt', 'i-ink')");
    const pnlLater = (await call('GET', '/api/reports/pnl', owner)).body;
    assert.deepEqual([pnlLater.cogs_blanks, pnlLater.cogs_consumables], [pnlAfter.cogs_blanks, pnlAfter.cogs_consumables]);
    await pool.query("UPDATE inventory_items SET unit_cost = 120 WHERE inventory_id = 'i-shirt'");
    await pool.query("UPDATE inventory_items SET unit_cost = 2.5 WHERE inventory_id = 'i-ink'");
  });

  it('archives only closed orders, hides them, refuses changes, and restores them, with audit rows', async () => {
    await insertOrder('o-open', 'Pending', { quote: 800 });
    const open = await call('POST', '/api/orders/o-open/archive', admin);
    assert.deepEqual([open.status, open.body.error, open.body.message], [409, 'ORDER_STILL_OPEN', 'Only completed or cancelled orders can be archived.']);
    assert.equal((await call('POST', '/api/orders/o-cost/archive', production)).status, 403);

    // A branch keeps its customers cached, so the archived order's copy can be refreshed here
    await sqliteRun(server.localDb, "INSERT INTO customers (customer_id, full_name, sync_status) VALUES ('c-1', 'Agdao NHS', 'synced')");
    const done = await call('POST', '/api/orders/o-cost/archive', admin);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.order.archived_by, 'u-admin');
    assert.deepEqual([done.body.allowed_actions.restore_order, done.body.allowed_actions.record_payment], [true, false]);
    assert.deepEqual((await call('POST', '/api/orders/o-cost/archive', admin)).body.error, 'ALREADY_ARCHIVED');
    assert.ok((await sqliteGet(server.localDb, "SELECT archived_at FROM order_profiles WHERE order_id = 'o-cost'")).archived_at, 'this computer follows at once');

    const list = await call('GET', '/api/orders', production);
    assert.ok(!list.body.orders.some((o) => o.order_id === 'o-cost'));
    assert.ok((await call('GET', '/api/orders?include_archived=true', production)).body.orders.some((o) => o.order_id === 'o-cost'));
    const pay = await call('POST', '/api/orders/o-cost/payments', production, { amount: 100, payment_type: 'Cash' });
    assert.deepEqual([pay.status, pay.body.error], [409, 'RECORD_ARCHIVED']);

    const back = await call('POST', '/api/orders/o-cost/restore', owner);
    assert.equal(back.status, 200, back.text);
    assert.equal(back.body.order.archived_at, null);
    assert.equal((await call('POST', '/api/orders/o-cost/payments', production, { amount: 100, payment_type: 'Cash' })).status, 201);
    assert.deepEqual((await audits('o-cost')).map((a) => [a.action, a.performed_role]),
      [['completed_with_balance', 'Owner'], ['order_archived', 'Admin'], ['order_restored', 'Owner']]);
  });

  it('archives a customer only without open orders, and then refuses them new orders', async () => {
    await insertOrder('o-c2', 'Delayed', { customer: 'c-2' });
    const busy = await call('POST', '/api/customers/c-2/archive', owner);
    assert.deepEqual([busy.status, busy.body.error, busy.body.open_orders], [409, 'ORDER_STILL_OPEN', 1]);
    assert.equal((await call('PATCH', '/api/orders/o-c2/status', owner, { status: 'Cancelled', cancellation_reason: 'Moved away' })).status, 200);
    const done = await call('POST', '/api/customers/c-2/archive', owner);
    assert.equal(done.status, 200, done.text);
    assert.ok(!(await call('GET', '/api/customers', production)).body.customers.some((c) => c.customer_id === 'c-2'));
    const refused = await call('POST', '/api/orders', production, { customer_id: 'c-2', production_deadline: shopDate(5), resolution: 'Delayed' });
    assert.deepEqual([refused.status, refused.body.error], [409, 'RECORD_ARCHIVED']);
    assert.equal((await call('POST', '/api/customers/c-2/restore', admin)).status, 200);
    assert.equal((await call('POST', '/api/orders', production, { customer_id: 'c-2', production_deadline: shopDate(5), resolution: 'Delayed' })).status, 201);
    assert.deepEqual((await audits('c-2')).map((a) => a.action), ['customer_archived', 'customer_restored']);
  });

  it('never lets an archive and a new order for the same customer both succeed', async () => {
    for (let round = 0; round < 5; round++) {
      const [archive, order] = await Promise.all([
        call('POST', '/api/customers/c-3/archive', admin),
        call('POST', '/api/orders', production, { customer_id: 'c-3', production_deadline: shopDate(5), resolution: 'Delayed' })
      ]);
      const outcome = [archive.status, order.status];
      assert.ok(JSON.stringify(outcome) === '[200,409]' || JSON.stringify(outcome) === '[409,201]', JSON.stringify(outcome));
      // Reset for the next round: close the new order, restore the customer
      if (order.status === 201) await pool.query("UPDATE order_profiles SET production_status = 'Cancelled' WHERE order_id = $1", [order.body.order_id]);
      if (archive.status === 200) await call('POST', '/api/customers/c-3/restore', admin);
    }
  });

  it('survives 120+ simultaneous requests with exact stock maths and no server errors', async () => {
    await insertOrder('o-edit', 'Pending', { quote: 0 });
    const version = (await call('GET', '/api/orders/o-edit', owner)).body.order.version;
    const jobs = [];
    const add = (kind, n, fn) => { for (let i = 0; i < n; i++) jobs.push({ kind, run: () => fn(i) }); };
    add('order', 60, () => call('POST', '/api/orders', production, { customer_id: 'c-1', production_deadline: shopDate(7), required_items: [{ inventory_id: 'i-blank', quantity_needed: 3 }] }));
    add('edit', 20, (i) => call('PATCH', '/api/orders/o-edit/details', production, { production_deadline: shopDate(30 + i), expected_version: version }));
    add('paper', 15, () => call('POST', '/api/inventory/i-paper/adjust', production, { action: 'subtract', quantity: 3 }));
    add('add', 5, () => call('POST', '/api/inventory/i-paper/adjust', production, { action: 'add', quantity: 1 }));
    add('loss', 10, (i) => call('POST', '/api/inventory/i-ink/loss', production, { quantity_lost: 2, reason_code: i % 2 ? 'damaged_in_storage' : 'supplier_defect' }));
    add('read', 6, () => call('GET', '/api/reports/dashboard', admin));
    add('pnl', 4, () => call('GET', '/api/reports/pnl', owner));
    add('capacity', 5, () => call('POST', '/api/inventory/check-capacity', production, { required_items: [{ inventory_id: 'i-blank', quantity_needed: 1 }] }));
    assert.ok(jobs.length >= 120);

    const results = await Promise.all(jobs.map(async (j) => {
      const t0 = Date.now();
      const r = await j.run();
      return { kind: j.kind, status: r.status, error: r.body && r.body.error, ms: Date.now() - t0 };
    }));
    const of = (k) => results.filter((r) => r.kind === k);
    const count = (k, s) => of(k).filter((r) => r.status === s).length;
    assert.deepEqual(results.filter((r) => r.status >= 500), [], 'no server errors');
    assert.deepEqual([count('order', 201), count('order', 409)], [33, 27], '100 blanks, 3 each');
    assert.deepEqual(await one("SELECT quantity_available AS a, quantity_reserved AS r FROM inventory_items WHERE inventory_id = 'i-blank'"), { a: 100, r: 99 });
    assert.deepEqual([count('edit', 200), count('edit', 409)], [1, 19], 'exactly one edit with that version lands');
    assert.ok(of('edit').filter((r) => r.status === 409).every((r) => r.error === 'EDIT_CONFLICT'));
    const paper = await one("SELECT quantity_available AS a FROM inventory_items WHERE inventory_id = 'i-paper'");
    assert.equal(paper.a, 30 + count('add', 200) - 3 * count('paper', 200));
    assert.ok(paper.a >= 0);
    assert.equal(count('loss', 201), 10);
    assert.equal(count('read', 200) + count('pnl', 200), 10);
    const bad = await one('SELECT COUNT(*)::int AS n FROM inventory_items WHERE quantity_available < 0 OR quantity_reserved < 0');
    assert.equal(bad.n, 0);
    assert.ok(Math.max(...results.map((r) => r.ms)) < 30000);
  });

  it('pushes an offline burst exactly once, however many people press "Sync now" at the same moment', async () => {
    const syncing = await startPgTestServer(pool, { realSync: true });
    try {
      await pool.query("INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount) VALUES ('o-sync', 'c-1', '2030-01-01', 'Pending', 99999)");
      await sqliteRun(syncing.localDb, "INSERT INTO customers (customer_id, full_name, sync_status) VALUES ('c-1', 'Agdao NHS', 'synced')");
      await sqliteRun(syncing.localDb, `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount, sync_status)
                                        VALUES ('o-sync', 'c-1', '2030-01-01', 'Pending', 99999, 'synced')`);
      for (let i = 0; i < 40; i++) {
        await sqliteRun(syncing.localDb, "INSERT INTO customers (customer_id, full_name, sync_status) VALUES (?, ?, 'pending_insert')", [`c-burst-${i}`, `Walk-in ${i}`]);
      }
      for (let i = 0; i < 20; i++) {
        await sqliteRun(syncing.localDb, `INSERT INTO payments (payment_id, order_id, amount, payment_type, received_by, payment_date, sync_status)
                                          VALUES (?, 'o-sync', 10, 'Cash', 'u-production', '2026-11-15 01:00:00', 'pending_insert')`, [`p-burst-${i}`]);
      }
      const token = syncing.tokenFor('u-production', 'Staff');
      const presses = await Promise.all(Array.from({ length: 15 }, () => syncing.request('POST', '/api/sync', { token })));
      assert.deepEqual(presses.map((r) => r.status), Array(15).fill(200), presses.map((r) => r.text).join('\n'));
      assert.ok(presses.filter((r) => r.body.summary.joined).length >= 1, 'later presses join the run in progress');
      assert.equal((await one("SELECT COUNT(*)::int AS n FROM customers WHERE customer_id LIKE 'c-burst-%'")).n, 40);
      const pays = await one("SELECT COUNT(*)::int AS n, COUNT(DISTINCT receipt_no)::int AS d FROM payments WHERE payment_id LIKE 'p-burst-%'");
      assert.deepEqual(pays, { n: 20, d: 20 }, 'each payment once, each with its own receipt number');
      const left = await sqliteAll(syncing.localDb, "SELECT 1 FROM customers WHERE sync_status <> 'synced' UNION ALL SELECT 1 FROM payments WHERE sync_status <> 'synced'");
      assert.equal(left.length, 0);
    } finally {
      await syncing.close();
    }
  });
});

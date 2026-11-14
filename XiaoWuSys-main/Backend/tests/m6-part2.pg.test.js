// ==========================================
// BATCH M6 PART 2 ON A REAL POSTGRESQL DATABASE (migration 011: PB 15, PB 11 / PB 12, PB 7)
// Runs only when TEST_DATABASE_URL is set (CI starts a throw-away PostgreSQL for it). The
// database is WIPED first: localhost or a database whose name contains "test" only, never Neon.
//
// Checks: 011 applies to an existing shop database without moving any order's version and is
// safe to run twice; its CHECKs, UNIQUE keys and append-only trigger hold; usage rates are set
// per blank; leaving Printing takes the consumables exactly once (also under two requests at
// the same moment), never below 0 (a shortfall is recorded, the change still goes through), and
// a failure later in the same transaction leaves no trace; the volume quote and the Owner's
// discount are saved with their audit row; a typed quote is audited; and a roster import
// reserves stock for an order that holds its stock, or adds nothing.
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgTarget, resetDatabase, startPgTestServer, readMigration } = require('./helpers/pgTestServer');
const { shopDate } = require('./helpers/testServer');
const { sqliteAll, sqliteRun } = require('../services/records');

const { url, skip } = pgTarget();
const FILE = '011_consumables_quotes_and_discounts.sql';

describe('M6 part 2 on real PostgreSQL: consumables, quotes, discounts, roster import', { skip }, () => {
  let pool;
  let server;
  let owner; let admin; let production; let staff;

  const ITEMS = [
    // id, name, category, on hand, unit
    ['i-shirt-s', 'Jersey Blank S', 'Apparel', 200, 'pcs'],
    ['i-shirt-l', 'Jersey Blank L', 'Apparel', 200, 'pcs'],
    ['i-ink', 'Sublimation Ink', 'Consumable', 100, 'ml'],
    ['i-paper', 'Transfer Paper', 'Consumable', 50, 'sheet'],
    ['i-thread', 'Thread', 'Consumable', 10, 'cone']
  ];
  const stockOf = async (id) => (await pool.query('SELECT quantity_available AS a, quantity_reserved AS r FROM inventory_items WHERE inventory_id = $1', [id])).rows[0];
  const setStock = (id, n) => pool.query('UPDATE inventory_items SET quantity_available = $2 WHERE inventory_id = $1', [id, n]);
  const logOf = async (orderId) => (await pool.query(
    `SELECT trigger_status, consumable_inventory_id, quantity_deducted, shortfall FROM order_consumables_log
      WHERE order_id = $1 ORDER BY deducted_at, trigger_status, consumable_inventory_id`, [orderId])).rows;
  const trailOf = async (orderId) => (await pool.query(
    `SELECT inventory_id, action, details, performed_role FROM inventory_audit_log
      WHERE details LIKE '%consumable_deducted%' AND details LIKE $1 ORDER BY created_at, inventory_id`, [`%${orderId}%`]))
    .rows.map((r) => ({ ...r, details: JSON.parse(r.details) }));
  const audits = async (id) => (await pool.query(
    'SELECT action, details, performed_by, performed_role FROM audit_log WHERE entity_id = $1 ORDER BY created_at, audit_id', [id]))
    .rows.map((r) => ({ ...r, details: JSON.parse(r.details) }));
  const insertOrder = async (id, status, lines, { quote = 0 } = {}) => {
    await pool.query(
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount)
       VALUES ($1, 'c-1', $2, $3, $4)`, [id, `${shopDate(20)} 00:00:00`, status, quote]);
    let n = 0;
    for (const [inventory_id, quantity, product_type = 'Jersey'] of lines) {
      await pool.query(`INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity) VALUES ($1, $2, $3, $4, $5)`,
        [`${id}-l${++n}`, id, inventory_id, product_type, quantity]);
    }
  };
  const setStatus = (id, status, token = production) => server.request('PATCH', `/api/orders/${id}/status`, { token, body: { status } });
  const quote = (id, body = {}, token = owner) => server.request('POST', `/api/orders/${id}/quote`, { token, body });

  before(async () => {
    const { Pool } = require('pg'); // only needed when this suite runs
    pool = new Pool({ connectionString: url, max: 8 });
    // An existing shop database: everything up to 010, with stock and a priced order already in it
    await resetDatabase(pool, { before: '011' });
    await pool.query(`INSERT INTO users (user_id, username, password_hash, role) VALUES
      ('u-owner', 'owner', 'x', 'Owner'), ('u-admin', 'admin', 'x', 'Admin'),
      ('u-production', 'production', 'x', 'Production'), ('u-staff', 'staff', 'x', 'Staff')`);
    await pool.query("INSERT INTO customers (customer_id, full_name) VALUES ('c-1', 'Agdao NHS')");
    for (const [id, name, category, qty, unit] of ITEMS) {
      await pool.query(`INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, unit_cost, unit)
                        VALUES ($1, $2, $3, $4, 10, $5)`, [id, name, category, qty, unit]);
    }
    await pool.query(`INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount)
                      VALUES ('o-old', 'c-1', '2030-12-31 00:00:00', 'Pending', 750)`);
  });
  after(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('applies migration 011 without touching existing orders, and running it again changes nothing', async () => {
    const versionBefore = (await pool.query("SELECT last_modified::text AS v FROM order_profiles WHERE order_id = 'o-old'")).rows[0].v;
    const { applyPendingMigrations } = require('../services/migrations');
    const first = await applyPendingMigrations(pool, { log: () => {} });
    assert.ok(first.applied.includes(FILE), JSON.stringify(first.applied));
    assert.deepEqual((await applyPendingMigrations(pool, { log: () => {} })).applied, []);
    await pool.query(readMigration(FILE)); // pasted again by hand
    await pool.query(readMigration(FILE));

    const old = (await pool.query(
      "SELECT last_modified::text AS v, total_quote_amount::text AS q, subtotal_amount::text AS s, discount_amount::text AS d FROM order_profiles WHERE order_id = 'o-old'")).rows[0];
    assert.deepEqual(old, { v: versionBefore, q: '750.00', s: '0.00', d: '0.00' }, 'no backfill: offline edits waiting to sync keep their baseline');
    assert.equal((await pool.query("SELECT selling_price::text AS p FROM inventory_items WHERE inventory_id = 'i-ink'")).rows[0].p, '0.00');
    const checks = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('inventory_items_selling_price_check', 'order_profiles_quote_breakdown_check') ORDER BY conname`);
    assert.deepEqual(checks.rows.map((r) => [r.conname, r.convalidated]),
      [['inventory_items_selling_price_check', true], ['order_profiles_quote_breakdown_check', true]]);
    const triggers = await pool.query(
      "SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_consumable_rates_last_modified', 'trg_order_consumables_log_append_only') ORDER BY tgname");
    assert.equal(triggers.rowCount, 2);
    const { checkCloudSchema } = require('../services/schemaCheck');
    const schema = await checkCloudSchema(pool);
    assert.deepEqual([schema.ok, schema.missing, schema.missingTriggers], [true, [], []]);
  });

  it('guards the new tables in the database itself', async () => {
    const rate = (id, consumable, qty, trigger = 'Pressing') => pool.query(
      `INSERT INTO consumable_rates (rate_id, product_inventory_id, consumable_inventory_id, quantity_per_piece, trigger_status)
       VALUES ($1, 'i-shirt-s', $2, $3, $4)`, [id, consumable, qty, trigger]);
    await assert.rejects(rate('r-x1', 'i-ink', 0), { code: '23514' });
    await assert.rejects(rate('r-x2', 'i-ink', 1, 'Printing'), { code: '23514' });
    await assert.rejects(rate('r-x3', 'i-shirt-s', 1), { code: '23514' }, 'a blank cannot use itself up');
    await assert.rejects(rate('r-x4', 'i-nothing', 1), { code: '23503' });
    await rate('r-x5', 'i-ink', 0.25);
    await assert.rejects(rate('r-x6', 'i-ink', 0.5), { code: '23505' }, 'one rate per blank, consumable and step');
    await assert.rejects(pool.query("UPDATE inventory_items SET selling_price = -1 WHERE inventory_id = 'i-ink'"), { code: '23514' });
    await assert.rejects(pool.query("UPDATE order_profiles SET discount_amount = -5 WHERE order_id = 'o-old'"), { code: '23514' });

    await pool.query(`INSERT INTO order_consumables_log (log_id, order_id, trigger_status, consumable_inventory_id, quantity_deducted)
                      VALUES ('lg-x', 'o-old', 'Pressing', 'i-ink', 3)`);
    await assert.rejects(pool.query(`INSERT INTO order_consumables_log (log_id, order_id, trigger_status, consumable_inventory_id, quantity_deducted)
                      VALUES ('lg-y', 'o-old', 'Pressing', 'i-ink', 3)`), { code: '23505' }, 'the exactly-once key');
    await assert.rejects(pool.query("UPDATE order_consumables_log SET quantity_deducted = 0 WHERE log_id = 'lg-x'"), /order_consumables_log is append-only/);
    await assert.rejects(pool.query("DELETE FROM order_consumables_log WHERE log_id = 'lg-x'"), /order_consumables_log is append-only/);
    // Clean slate for the API tests (the trigger is lifted only for this cleanup)
    await pool.query('ALTER TABLE order_consumables_log DISABLE TRIGGER trg_order_consumables_log_append_only');
    await pool.query("DELETE FROM order_consumables_log WHERE log_id = 'lg-x'");
    await pool.query('ALTER TABLE order_consumables_log ENABLE TRIGGER trg_order_consumables_log_append_only');
    await pool.query("DELETE FROM consumable_rates WHERE rate_id = 'r-x5'");
  });

  it('sets the usage rates of a blank, replacing its list, with a trail entry', async () => {
    server = await startPgTestServer(pool);
    owner = server.tokenFor('u-owner', 'Owner');
    admin = server.tokenFor('u-admin', 'Admin');
    production = server.tokenFor('u-production', 'Production');
    staff = server.tokenFor('u-staff', 'Staff');
    const put = (id, rates, token = production) => server.request('PUT', `/api/inventory/${id}/consumable-rates`, { token, body: { rates } });

    let r = await put('i-shirt-s', [
      { consumable_inventory_id: 'i-ink', quantity_per_piece: 0.5 },
      { consumable_inventory_id: 'i-paper', quantity_per_piece: 1 }
    ]);
    assert.equal(r.status, 200, r.text);
    r = await put('i-shirt-s', [
      { consumable_inventory_id: 'i-ink', quantity_per_piece: 0.25 },
      { consumable_inventory_id: 'i-paper', quantity_per_piece: 1 },
      { consumable_inventory_id: 'i-thread', quantity_per_piece: 0.1, trigger_status: 'Completed' }
    ]);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.rates.map((x) => [x.consumable_name, x.quantity_per_piece, x.trigger_status]),
      [['Sublimation Ink', 0.25, 'Pressing'], ['Transfer Paper', 1, 'Pressing'], ['Thread', 0.1, 'Completed']]);
    assert.equal((await put('i-shirt-l', [
      { consumable_inventory_id: 'i-ink', quantity_per_piece: 0.3 }, { consumable_inventory_id: 'i-paper', quantity_per_piece: 1 }
    ], admin)).status, 200);

    const refused = await put('i-shirt-s', [{ consumable_inventory_id: 'i-gone', quantity_per_piece: 1 }]);
    assert.deepEqual([refused.status, refused.body.missing_inventory_ids], [404, ['i-gone']]);
    assert.equal((await put('i-shirt-s', [], staff)).status, 403);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM consumable_rates WHERE product_inventory_id = 'i-shirt-s'")).rows[0].n, 3,
      'a refused change keeps the list');

    const trail = (await pool.query(
      "SELECT details FROM inventory_audit_log WHERE inventory_id = 'i-shirt-s' AND details LIKE '%consumable_rates%' ORDER BY created_at")).rows
      .map((x) => JSON.parse(x.details));
    assert.equal(trail.length, 2);
    assert.deepEqual(trail[1].before.map((x) => x.quantity_per_piece).sort(), [0.5, 1]);
    assert.equal(trail[1].after.length, 3);

    const shown = await server.request('GET', '/api/inventory/i-shirt-s/consumable-rates', { token: staff });
    assert.deepEqual([shown.status, shown.body.source, shown.body.rates.length, shown.body.can_edit], [200, 'cloud', 3, false]);
    const local = await sqliteAll(server.localDb, "SELECT consumable_inventory_id FROM consumable_rates WHERE product_inventory_id = 'i-shirt-s' ORDER BY 1");
    assert.deepEqual(local.map((x) => x.consumable_inventory_id), ['i-ink', 'i-paper', 'i-thread'], 'this computer has the new list for offline reading');

    // An item that exists only on this computer cannot get rates until it syncs
    await sqliteRun(server.localDb, `INSERT INTO inventory_items (inventory_id, item_name, item_category, unit_cost, sync_status)
                                     VALUES ('i-local', 'Local Blank', 'Apparel', 1, 'pending_insert')`);
    const notSynced = await put('i-local', []);
    assert.deepEqual([notSynced.status, notSynced.body.error], [409, 'ITEM_NOT_SYNCED']);
  });

  it('takes the Pressing consumables once when pressing starts, and the Completed ones at the end', async () => {
    await insertOrder('o-press', 'Printing', [['i-shirt-s', 10], ['i-shirt-l', 5], [null, 3, 'Name print']]);
    const pushesBefore = server.pushes.length;
    const pressing = await setStatus('o-press', 'Pressing');
    assert.equal(pressing.status, 200, pressing.text);
    assert.deepEqual(pressing.body.consumables_deducted.map((c) => [c.item_name, c.trigger_status, c.needed, c.quantity_deducted, c.shortfall]), [
      ['Sublimation Ink', 'Pressing', 4, 4, 0], // 10 x 0.25 + 5 x 0.3
      ['Transfer Paper', 'Pressing', 15, 15, 0]
    ]);
    assert.match(pressing.body.message, /Consumables used: 4 ml Sublimation Ink, 15 sheet Transfer Paper\./);
    assert.deepEqual([(await stockOf('i-ink')).a, (await stockOf('i-paper')).a, (await stockOf('i-thread')).a], [96, 35, 10]);
    const pushed = server.pushes.slice(pushesBefore);
    assert.deepEqual(pushed.map((p) => [p.ids, p.reason]), [[['i-ink', 'i-paper'], 'order_pressing']], 'the low-stock warning hears about the consumables');

    const retry = await setStatus('o-press', 'Pressing');
    assert.equal(retry.status, 409, 'a repeated request is refused by the lifecycle');
    assert.deepEqual([(await stockOf('i-ink')).a, (await stockOf('i-paper')).a], [96, 35], 'and takes nothing');

    const done = await setStatus('o-press', 'Completed', admin);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(done.body.consumables_deducted.map((c) => [c.item_name, c.trigger_status, c.quantity_deducted]), [['Thread', 'Completed', 1]],
      'the Pressing consumables are not taken a second time');
    assert.deepEqual([(await stockOf('i-ink')).a, (await stockOf('i-paper')).a, (await stockOf('i-thread')).a], [96, 35, 9]);
    assert.deepEqual(await logOf('o-press'), [
      { trigger_status: 'Pressing', consumable_inventory_id: 'i-ink', quantity_deducted: 4, shortfall: 0 },
      { trigger_status: 'Pressing', consumable_inventory_id: 'i-paper', quantity_deducted: 15, shortfall: 0 },
      { trigger_status: 'Completed', consumable_inventory_id: 'i-thread', quantity_deducted: 1, shortfall: 0 }
    ]);
    const trail = await trailOf('o-press');
    assert.deepEqual(trail.map((x) => [x.inventory_id, x.action, x.details.trigger_status, x.details.quantity_before, x.details.quantity_after, x.performed_role]), [
      ['i-ink', 'stock_subtracted', 'Pressing', 100, 96, 'Production'],
      ['i-paper', 'stock_subtracted', 'Pressing', 50, 35, 'Production'],
      ['i-thread', 'stock_subtracted', 'Completed', 10, 9, 'Admin']
    ]);

    const detail = await server.request('GET', '/api/orders/o-press', { token: staff });
    assert.deepEqual(detail.body.consumables_deducted.map((c) => [c.item_name, c.unit, c.quantity_deducted]),
      [['Sublimation Ink', 'ml', 4], ['Transfer Paper', 'sheet', 15], ['Thread', 'cone', 1]]);
    assert.match(detail.body.consumables_deducted[0].deducted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('takes both kinds at once when an order skips Pressing', async () => {
    await insertOrder('o-skip', 'Printing', [['i-shirt-s', 20]]);
    const r = await setStatus('o-skip', 'Completed');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.consumables_deducted.map((c) => [c.trigger_status, c.consumable_inventory_id, c.quantity_deducted]),
      [['Pressing', 'i-ink', 5], ['Pressing', 'i-paper', 20], ['Completed', 'i-thread', 2]]);
    await insertOrder('o-cancel', 'Printing', [['i-shirt-s', 20]]);
    assert.equal((await setStatus('o-cancel', 'Cancelled', owner)).body.consumables_deducted.length, 0, 'a cancelled order uses nothing');
  });

  it('never blocks the change on an estimate: stock stops at 0 and the shortfall is recorded', async () => {
    await setStock('i-paper', 3);
    await insertOrder('o-short', 'Printing', [['i-shirt-l', 10]]);
    const r = await setStatus('o-short', 'Pressing');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.order.production_status, 'Pressing');
    const paper = r.body.consumables_deducted.find((c) => c.consumable_inventory_id === 'i-paper');
    assert.deepEqual([paper.needed, paper.quantity_deducted, paper.shortfall], [10, 3, 7]);
    assert.match(r.body.message, /Not enough on hand for Transfer Paper \(short by 7\): the stock is now 0\./);
    assert.equal((await stockOf('i-paper')).a, 0);
    const audited = (await trailOf('o-short')).find((x) => x.inventory_id === 'i-paper');
    assert.deepEqual([audited.details.needed, audited.details.quantity_deducted, audited.details.shortfall], [10, 3, 7]);
    const catalog = await server.request('GET', '/api/inventory', { token: staff });
    assert.equal(catalog.body.items.find((i) => i.inventory_id === 'i-paper').stock_status, 'out_of_stock', 'PB 17 warning shows it');

    // Nothing on hand at all: still recorded once, so a later step never takes it again
    await insertOrder('o-empty', 'Printing', [['i-shirt-l', 2]]);
    const empty = await setStatus('o-empty', 'Pressing');
    const none = empty.body.consumables_deducted.find((c) => c.consumable_inventory_id === 'i-paper');
    assert.deepEqual([empty.status, none.quantity_deducted, none.shortfall], [200, 0, 2]);
    assert.deepEqual((await logOf('o-empty')).find((l) => l.consumable_inventory_id === 'i-paper'),
      { trigger_status: 'Pressing', consumable_inventory_id: 'i-paper', quantity_deducted: 0, shortfall: 2 });
    await setStock('i-paper', 50);
  });

  it('leaves no trace when the same transaction fails after the deduction', async () => {
    await insertOrder('o-fail', 'Printing', [['i-shirt-s', 8]]);
    const before = [await stockOf('i-ink'), await stockOf('i-paper')];
    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$
                      BEGIN RAISE EXCEPTION 'history write failed (test)'; END; $$`);
    await pool.query(`CREATE TRIGGER trg_test_fail_history BEFORE INSERT ON order_status_history
                      FOR EACH ROW EXECUTE FUNCTION test_fail_history()`);
    try {
      const r = await setStatus('o-fail', 'Pressing');
      assert.ok(r.status >= 500, r.text);
    } finally {
      await pool.query('DROP TRIGGER trg_test_fail_history ON order_status_history');
      await pool.query('DROP FUNCTION test_fail_history()');
    }
    assert.deepEqual([await stockOf('i-ink'), await stockOf('i-paper')], before, 'no stock taken');
    assert.deepEqual(await logOf('o-fail'), [], 'nothing marked as taken');
    assert.deepEqual(await trailOf('o-fail'), [], 'no trail rows');
    assert.equal((await pool.query("SELECT production_status FROM order_profiles WHERE order_id = 'o-fail'")).rows[0].production_status, 'Printing');
    // ...and the real change afterwards takes them exactly once
    assert.equal((await setStatus('o-fail', 'Pressing')).status, 200);
    assert.equal((await logOf('o-fail')).length, 2);
  });

  it('takes the consumables once when two screens start pressing at the same moment', async () => {
    await insertOrder('o-race', 'Printing', [['i-shirt-s', 12]]);
    const inkBefore = (await stockOf('i-ink')).a;
    const results = await Promise.all([setStatus('o-race', 'Pressing'), setStatus('o-race', 'Pressing', admin)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await stockOf('i-ink')).a, inkBefore - 3, '12 x 0.25 once');
    assert.equal((await logOf('o-race')).length, 2);
  });

  it('works out the volume quote, saves it with the Owner’s discount, and records both', async () => {
    await pool.query("UPDATE inventory_items SET selling_price = 200 WHERE inventory_id = 'i-shirt-s'");
    await pool.query("UPDATE inventory_items SET selling_price = 220 WHERE inventory_id = 'i-shirt-l'");
    await insertOrder('o-quote', 'Pending', [['i-shirt-s', 30], ['i-shirt-l', 30]]);

    const preview = await quote('o-quote', { dry_run: true });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual([preview.body.dry_run, preview.body.calculation.tier.percent_off, preview.body.calculation.subtotal_amount], [true, 5, 11970]);
    assert.deepEqual(preview.body.calculation.lines.map((l) => [l.unit_price, l.line_total]), [[190, 5700], [209, 6270]]);
    const untouched = (await pool.query("SELECT subtotal_amount::text AS s, total_quote_amount::text AS t FROM order_profiles WHERE order_id = 'o-quote'")).rows[0];
    assert.deepEqual(untouched, { s: '0.00', t: '0.00' }, 'a preview saves nothing');
    assert.deepEqual(await audits('o-quote'), []);

    assert.equal((await quote('o-quote', { discount_percent: 10 })).status, 400, 'a discount needs a reason');
    const tooMuch = await quote('o-quote', { discount_amount: 20000, discount_reason: 'x' });
    assert.deepEqual([tooMuch.status, tooMuch.body.error], [422, 'DISCOUNT_TOO_LARGE']);
    for (const token of [admin, production, staff]) assert.equal((await quote('o-quote', {}, token)).status, 403);

    const saved = await quote('o-quote', { discount_percent: 10, discount_reason: 'Loyal school customer' });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.quote, {
      has_quote: true, subtotal_amount: 11970, discount_amount: 1197, discount_reason: 'Loyal school customer', total_quote_amount: 10773
    });
    assert.equal(saved.body.message, 'Quote saved: ₱10,773.00 after a ₱1,197.00 discount.');
    const prices = (await pool.query("SELECT price::text AS p FROM order_items WHERE order_id = 'o-quote' ORDER BY line_item_id")).rows.map((r) => r.p);
    assert.deepEqual(prices, ['190.00', '209.00'], 'each item keeps its unit price');
    let trail = await audits('o-quote');
    assert.equal(trail.length, 1);
    assert.deepEqual([trail[0].action, trail[0].performed_by, trail[0].performed_role], ['discount_applied', 'u-owner', 'Owner']);
    assert.deepEqual([trail[0].details.before.total_quote_amount, trail[0].details.after.total_quote_amount, trail[0].details.discount_percent, trail[0].details.tier.percent_off],
      [0, 10773, 10, 5]);
    assert.deepEqual(server.orderEvents.updated.at(-1).order_id, 'o-quote', 'every screen hears about the new price');

    // More pieces: the 10% tier, and the discount amount is kept
    const added = await server.request('POST', '/api/orders/o-quote/items/bulk', {
      token: production, body: { items: [{ product_type: 'Jersey', quantity: 40, inventory_id: 'i-shirt-s', size: 'S' }] }
    });
    assert.equal(added.status, 201, added.text);
    const repriced = await quote('o-quote', {});
    assert.deepEqual([repriced.body.calculation.tier.percent_off, repriced.body.calculation.subtotal_amount, repriced.body.quote.discount_amount,
      repriced.body.quote.total_quote_amount], [10, 30 * 180 + 30 * 198 + 40 * 180, 1197, 18540 - 1197]);
    const removed = await quote('o-quote', { discount_amount: 0 });
    assert.deepEqual([removed.body.quote.discount_amount, removed.body.quote.discount_reason, removed.body.quote.total_quote_amount], [0, null, 18540]);
    trail = await audits('o-quote');
    assert.deepEqual(trail.map((a) => a.action), ['discount_applied', 'discount_applied', 'quote_generated']);

    const stale = await quote('o-quote', { expected_version: '2000-01-01T00:00:00.000000' });
    assert.deepEqual([stale.status, stale.body.error, stale.body.can_override], [409, 'EDIT_CONFLICT', false]);

    await insertOrder('o-unpriced', 'Pending', [['i-shirt-s', 2], ['i-ink', 1, 'Ink refill']]);
    const unpriced = await quote('o-unpriced', {});
    assert.deepEqual([unpriced.status, unpriced.body.error, unpriced.body.inventory_ids], [422, 'SELLING_PRICE_MISSING', ['i-ink']]);
    assert.match(unpriced.body.message, /Sublimation Ink/);

    await pool.query("UPDATE order_profiles SET production_status = 'Approved' WHERE order_id = 'o-quote'");
    const frozen = await quote('o-quote', { discount_amount: 10, discount_reason: 'late request' });
    assert.deepEqual([frozen.status, frozen.body.error], [409, 'QUOTE_LOCKED']);
    const detail = await server.request('GET', '/api/orders/o-quote', { token: owner });
    assert.deepEqual([detail.body.quote.total_quote_amount, detail.body.allowed_actions.generate_quote, detail.body.allowed_actions.print_quote], [18540, false, true]);
    assert.deepEqual(detail.body.quote.lines.map((l) => [l.quantity, l.unit_price, l.line_total]).sort((a, b) => a[2] - b[2]),
      [[30, 180, 5400], [30, 198, 5940], [40, 180, 7200]], 'the quotation lines add up to the subtotal');
  });

  it('audits a quote the Owner types in by hand, in the same transaction', async () => {
    await insertOrder('o-typed', 'Pending', [['i-shirt-s', 3]]);
    const r = await server.request('PATCH', '/api/orders/o-typed/details', { token: owner, body: { total_quote_amount: 999.5 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.source, r.body.changed], ['cloud', ['total_quote_amount']]);
    const row = (await pool.query("SELECT subtotal_amount::text AS s, discount_amount::text AS d, total_quote_amount::text AS t FROM order_profiles WHERE order_id = 'o-typed'")).rows[0];
    assert.deepEqual(row, { s: '999.50', d: '0.00', t: '999.50' });
    const trail = await audits('o-typed');
    assert.deepEqual(trail.map((a) => [a.action, a.performed_role, a.details.before.total_quote_amount, a.details.after.total_quote_amount]),
      [['quote_overridden', 'Owner', 0, 999.5]]);

    const stale = await server.request('PATCH', '/api/orders/o-typed/details', {
      token: owner, body: { total_quote_amount: 100, expected_version: '2000-01-01T00:00:00.000000' }
    });
    assert.equal(stale.status, 409);
    assert.equal((await audits('o-typed')).length, 1, 'a refused change writes no audit row');
  });

  it('imports a roster into an order that holds its stock: reserved together, or nothing added', async () => {
    const created = await server.request('POST', '/api/orders', {
      token: production, body: { customer_id: 'c-1', production_deadline: shopDate(9), required_items: [{ inventory_id: 'i-shirt-l', quantity_needed: 2 }] }
    });
    assert.equal(created.status, 201, created.text);
    const id = created.body.order_id;
    const reservedBefore = (await stockOf('i-shirt-l')).r;
    const pushesBefore = server.pushes.length;
    const roster = ['REYES', 'SANTOS', 'CRUZ'].map((name, i) => ({ product_type: 'Jersey Blank L', quantity: 1, size: 'L', custom_name: name, custom_number: String(i + 1), inventory_id: 'i-shirt-l' }));
    const r = await server.request('POST', `/api/orders/${id}/items/bulk`, { token: production, body: { items: roster } });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.source, r.body.stock_reserved, r.body.items.map((i) => i.custom_name)], ['cloud', true, ['REYES', 'SANTOS', 'CRUZ']]);
    assert.equal((await stockOf('i-shirt-l')).r, reservedBefore + 3);
    assert.deepEqual(server.pushes.slice(pushesBefore).map((p) => p.ids), [['i-shirt-l']]);

    const free = (await stockOf('i-shirt-l')).a - (await stockOf('i-shirt-l')).r;
    const short = await server.request('POST', `/api/orders/${id}/items/bulk`, {
      token: production, body: { items: [{ product_type: 'Jersey Blank L', quantity: 1, inventory_id: 'i-shirt-l' }, { product_type: 'Jersey Blank L', quantity: free, inventory_id: 'i-shirt-l' }] }
    });
    assert.deepEqual([short.status, short.body.error, short.body.shortages[0].shortfall], [409, 'INSUFFICIENT_INVENTORY', 1]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1', [id])).rows[0].n, 4, 'nothing added');
    assert.equal((await stockOf('i-shirt-l')).r, reservedBefore + 3, 'nothing reserved');
  });
});

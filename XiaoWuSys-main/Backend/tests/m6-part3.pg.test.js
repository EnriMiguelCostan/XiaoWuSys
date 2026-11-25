// ==========================================
// BATCH M6 PART 3 ON A REAL POSTGRESQL DATABASE (migration 012: PB 18 / 19 / 20 / 22 / 23)
// Runs only when TEST_DATABASE_URL is set (CI starts a throw-away PostgreSQL for it). The
// database is WIPED first: localhost or a database whose name contains "test" only, never Neon.
//
// Checks: 012 applies to an existing shop database without moving any row's version and is safe
// to run twice; its CHECKs, the one-void-per-payment index and the overhead table hold; a
// misprint on an order stores its step and cause, leaves the reservation alone and warns when
// no free stock is left; losses during printing / pressing within an hour (also two at the same
// moment) become 'Machine Failure', earlier ones included; an item far above the others is a
// statistical anomaly; a cancel saves its reason with an audit row; a payment void is a negative
// reversing entry with its own receipt number, once (also under two requests at the same
// moment), guarded by the downpayment; overheads are recorded and removed by the Owner with a
// trail; and the P&L adds it all up for the Owner.
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgTarget, resetDatabase, startPgTestServer, readMigration } = require('./helpers/pgTestServer');
const { shopDate } = require('./helpers/testServer');
const { sqliteAll } = require('../services/records');

const { url, skip } = pgTarget();
const FILE = '012_waste_diagnostics_voids_and_pnl.sql';

describe('M6 part 3 on real PostgreSQL: waste diagnostics, voids, overheads, P&L', { skip }, () => {
  let pool;
  let server;
  let owner; let admin; let production;

  const ITEMS = [
    // id, name, on hand, unit cost
    ['i-shirt', 'Jersey Blank', 10, 120],
    ['i-cap', 'Cap', 50, 80],
    ['i-mug', 'Mug', 50, 60],
    ['i-pen', 'Pen', 50, 10],
    ['i-bag', 'Tote Bag', 50, 40],
    ['i-ink', 'Sublimation Ink', 100, 2.5]
  ];
  const audits = async (id) => (await pool.query(
    'SELECT action, details, performed_by, performed_role FROM audit_log WHERE entity_id = $1 ORDER BY created_at, audit_id', [id]))
    .rows.map((r) => ({ ...r, details: JSON.parse(r.details) }));
  const insertOrder = async (id, status, { quote = 0, reserved = false, lines = [] } = {}) => {
    await pool.query(
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount, stock_reserved)
       VALUES ($1, 'c-1', $2, $3, $4, $5)`, [id, `${shopDate(20)} 00:00:00`, status, quote, reserved]);
    let n = 0;
    for (const [inventory_id, quantity] of lines) {
      await pool.query('INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity) VALUES ($1, $2, $3, $4, $5)',
        [`${id}-l${++n}`, id, inventory_id, 'Item', quantity]);
      if (reserved) await pool.query('UPDATE inventory_items SET quantity_reserved = quantity_reserved + $2 WHERE inventory_id = $1', [inventory_id, quantity]);
    }
  };
  const loss = (id, body, token = production) => server.request('POST', `/api/inventory/${id}/loss`, { token, body });
  const voidPay = (orderId, paymentId, body, token = owner) =>
    server.request('POST', `/api/orders/${orderId}/payments/${paymentId}/void`, { token, body });

  before(async () => {
    const { Pool } = require('pg'); // only needed when this suite runs
    pool = new Pool({ connectionString: url, max: 8 });
    // An existing shop database: everything up to 011, with a loss and a payment already in it
    await resetDatabase(pool, { before: '012' });
    await pool.query(`INSERT INTO users (user_id, username, password_hash, role) VALUES
      ('u-owner', 'owner', 'x', 'Owner'), ('u-admin', 'admin', 'x', 'Admin'),
      ('u-production', 'staff', 'x', 'Staff'), ('u-staff', 'production', 'x', 'Production')`);
    await pool.query("INSERT INTO customers (customer_id, full_name) VALUES ('c-1', 'Agdao NHS')");
    for (const [id, name, qty, cost] of ITEMS) {
      await pool.query(`INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, unit_cost)
                        VALUES ($1, $2, 'Apparel', $3, $4)`, [id, name, qty, cost]);
    }
    await insertOrder('o-old', 'Completed', { quote: 500 });
    await pool.query("INSERT INTO payments (payment_id, order_id, amount, payment_type) VALUES ('p-old', 'o-old', 500, 'Cash')");
    await pool.query(`INSERT INTO material_loss (loss_id, inventory_id, quantity_lost, loss_reason, financial_cost, date_recorded)
                      VALUES ('l-old', 'i-bag', 1, 'Torn', 40, '2020-01-01 00:00:00')`);
  });
  after(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('applies migration 012 without touching existing rows, and running it again changes nothing', async () => {
    const versions = async () => (await pool.query(`SELECT
      (SELECT last_modified::text FROM order_profiles WHERE order_id = 'o-old') AS o,
      (SELECT last_modified::text FROM payments WHERE payment_id = 'p-old') AS p,
      (SELECT last_modified::text FROM material_loss WHERE loss_id = 'l-old') AS l`)).rows[0];
    const before = await versions();
    const { applyPendingMigrations } = require('../services/migrations');
    const first = await applyPendingMigrations(pool, { log: () => {} });
    assert.ok(first.applied.includes(FILE), JSON.stringify(first.applied));
    assert.deepEqual((await applyPendingMigrations(pool, { log: () => {} })).applied, []);
    await pool.query(readMigration(FILE)); // pasted again by hand
    assert.deepEqual(await versions(), before, 'no backfill: offline edits waiting to sync keep their baseline');

    const old = (await pool.query("SELECT reason_code, loss_category, production_stage, is_statistical_anomaly FROM material_loss WHERE loss_id = 'l-old'")).rows[0];
    assert.deepEqual(old, { reason_code: null, loss_category: null, production_stage: null, is_statistical_anomaly: false });
    const checks = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('material_loss_reason_code_check', 'material_loss_category_check', 'payments_void_shape_check') ORDER BY conname`);
    assert.deepEqual(checks.rows.map((r) => [r.conname, r.convalidated]),
      [['material_loss_category_check', true], ['material_loss_reason_code_check', true], ['payments_void_shape_check', true]]);
    const { checkCloudSchema } = require('../services/schemaCheck');
    const schema = await checkCloudSchema(pool);
    assert.deepEqual([schema.ok, schema.missing, schema.missingTriggers], [true, [], []]);
  });

  it('guards the new columns and tables in the database itself', async () => {
    const lossRow = (id, code, category) => pool.query(
      `INSERT INTO material_loss (loss_id, inventory_id, quantity_lost, loss_reason, reason_code, loss_category, date_recorded)
       VALUES ($1, 'i-bag', 1, 'x', $2, $3, '2020-01-01')`, [id, code, category]);
    await assert.rejects(lossRow('l-x1', 'gremlins', null), { code: '23514' });
    await assert.rejects(lossRow('l-x2', null, 'Bad Luck'), { code: '23514' });
    const pay = (id, amount, voids, reason) => pool.query(
      `INSERT INTO payments (payment_id, order_id, amount, payment_type, voids_payment_id, void_reason) VALUES ($1, 'o-old', $2, 'Cash', $3, $4)`,
      [id, amount, voids, reason]);
    await assert.rejects(pay('v-x1', 500, 'p-old', 'Refund'), { code: '23514' }, 'a void is negative');
    await assert.rejects(pay('v-x2', -500, 'p-old', '  '), { code: '23514' }, 'a void gives a reason');
    await assert.rejects(pay('v-x3', -500, 'v-x3', 'x'), { code: '23514' }, 'never voids itself');
    await assert.rejects(pay('v-x4', -500, 'p-nothing', 'x'), { code: '23503' });
    await pay('v-ok', -500, 'p-old', 'Refund');
    await assert.rejects(pay('v-x5', -500, 'p-old', 'Again'), { code: '23505' }, 'one void per payment');
    await assert.rejects(pool.query("DELETE FROM payments WHERE payment_id = 'p-old'"), { code: '23503' }, 'a voided payment is never deleted');
    assert.match((await pool.query("SELECT receipt_no FROM payments WHERE payment_id = 'v-ok'")).rows[0].receipt_no, /^AR-\d{4}-\d{4,}$/,
      'the reversal gets its own receipt number');
    await assert.rejects(pool.query(
      `INSERT INTO overhead_expenses (expense_id, expense_date, category, description, amount) VALUES ('e-x', '2026-01-01', 'Rent', 'x', 0)`),
    { code: '23514' });
    await pool.query("DELETE FROM payments WHERE payment_id = 'v-ok'");
  });

  it('logs a misprint against an order in production: its step, its cause, the reservation untouched, a warning', async () => {
    server = await startPgTestServer(pool);
    owner = server.tokenFor('u-owner', 'Owner');
    admin = server.tokenFor('u-admin', 'Admin');
    production = server.tokenFor('u-production', 'Staff');
    await insertOrder('o-print', 'Printing', { quote: 3000, reserved: true, lines: [['i-shirt', 8]] });

    const r = await loss('i-shirt', { quantity_lost: 2, reason_code: 'misprint_alignment', order_id: 'o-print' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.source, 'cloud');
    assert.deepEqual([r.body.loss.production_stage, r.body.loss.loss_category, r.body.loss.loss_reason, r.body.diagnosis.rule],
      ['Printing', 'Human Error', 'Misprint / alignment error', 'reason_code']);
    assert.deepEqual([r.body.item.quantity_available, r.body.item.quantity_reserved], [8, 8], 'D1: general stock, reservation untouched');
    assert.equal(r.body.replacement_warning.code, 'REPLACEMENT_STOCK_DEPLETED');
    const row = (await pool.query("SELECT financial_cost::text AS c, reason_code FROM material_loss WHERE loss_id = $1", [r.body.loss.loss_id])).rows[0];
    assert.deepEqual(row, { c: '240.00', reason_code: 'misprint_alignment' });
    const trail = (await pool.query("SELECT details FROM inventory_audit_log WHERE inventory_id = 'i-shirt' AND action = 'stock_subtracted'")).rows;
    assert.deepEqual(JSON.parse(trail[0].details).loss_category, 'Human Error');
  });

  let firstLoss;
  it('turns machine-step losses within the hour into a machine failure, the earlier one included', async () => {
    firstLoss = (await pool.query("SELECT loss_id FROM material_loss WHERE order_id = 'o-print'")).rows[0].loss_id;
    await insertOrder('o-press', 'Pressing', { quote: 1000 });
    const r = await loss('i-cap', { quantity_lost: 1, reason_code: 'heat_press_scorch', order_id: 'o-press' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.loss.loss_category, r.body.diagnosis.rule, r.body.diagnosis.cluster_with, r.body.diagnosis.escalated],
      ['Machine Failure', 'machine_cluster', [firstLoss], [firstLoss]]);
    assert.equal((await pool.query('SELECT loss_category FROM material_loss WHERE loss_id = $1', [firstLoss])).rows[0].loss_category, 'Machine Failure');

    const detail = await server.request('GET', '/api/orders/o-print', { token: owner });
    assert.deepEqual(detail.body.material_losses.map((l) => [l.item_name, l.quantity_lost, l.category_label, l.reason_label]),
      [['Jersey Blank', 2, 'Machine Failure', 'Misprint / alignment error']]);
  });

  it('sees two losses at the same moment as a cluster (diagnoses are taken one at a time)', async () => {
    await pool.query("UPDATE material_loss SET date_recorded = '2020-01-02' WHERE order_id IN ('o-print', 'o-press')"); // out of the window
    // Hold the diagnosis lock, so both requests are inside their transactions at the same time
    const holder = await pool.connect();
    let a; let b;
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('xiaowusys:material_loss_diagnosis'))");
      const both = Promise.all([
        loss('i-mug', { quantity_lost: 1, reason_code: 'printer_head_banding', order_id: 'o-print' }),
        loss('i-pen', { quantity_lost: 1, reason_code: 'misprint_alignment', order_id: 'o-press' })
      ]);
      let settled = false;
      both.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(settled, false, 'each diagnosis waits for the one before it');
      await holder.query('COMMIT');
      [a, b] = await both;
    } finally {
      holder.release();
    }
    assert.deepEqual([a.status, b.status], [201, 201], a.text + b.text);
    const rows = (await pool.query("SELECT loss_category FROM material_loss WHERE inventory_id IN ('i-mug', 'i-pen') ORDER BY inventory_id")).rows;
    assert.deepEqual(rows.map((x) => x.loss_category), ['Machine Failure', 'Machine Failure']);
    // The first to commit is diagnosed from its reason; the second finds it and re-marks it
    assert.deepEqual([a.body.diagnosis.rule, b.body.diagnosis.rule].sort(), ['machine_cluster', 'reason_code']);
    assert.equal([a, b].find((x) => x.body.diagnosis.rule === 'machine_cluster').body.diagnosis.escalated.length <= 1, true);
  });

  it('flags an item whose losses stand far above the other items as a statistical anomaly', async () => {
    // Totals now: shirt 2, cap 1, mug 1, pen 1, bag 1 -> 12 tote bags lost is far above the rest
    const r = await loss('i-bag', { quantity_lost: 11, reason_code: 'damaged_in_storage' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.loss.is_statistical_anomaly, r.body.loss.loss_category, r.body.diagnosis.rule], [true, 'Product Defect', 'statistical']);
    const dash = await server.request('GET', '/api/reports/dashboard', { token: admin });
    assert.deepEqual(dash.body.waste.anomalies.map((x) => x.item_name), ['Tote Bag']);
    assert.equal(dash.body.waste.costs_visible, true);
  });

  it('saves the cancellation reason with an audit row that lists the released stock', async () => {
    const r = await server.request('PATCH', '/api/orders/o-print/status', {
      token: owner, body: { status: 'Cancelled', cancellation_reason: 'Customer changed the design' }
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.order.cancellation_reason, 'Customer changed the design');
    const [audit] = (await audits('o-print')).filter((a) => a.action === 'order_voided');
    assert.deepEqual([audit.performed_role, audit.details.from_status, audit.details.reason], ['Owner', 'Printing', 'Customer changed the design']);
    assert.deepEqual(audit.details.released, [{ inventory_id: 'i-shirt', item_name: 'Jersey Blank', quantity: 8 }]);
    assert.equal((await pool.query("SELECT quantity_reserved FROM inventory_items WHERE inventory_id = 'i-shirt'")).rows[0].quantity_reserved, 0);

    // Older screens send no reason: still cancelled, still audited
    await insertOrder('o-quiet', 'Pending');
    const quiet = await server.request('PATCH', '/api/orders/o-quiet/status', { token: owner, body: { status: 'Cancelled' } });
    assert.equal(quiet.status, 200, quiet.text);
    assert.deepEqual((await audits('o-quiet')).map((a) => [a.action, a.details.reason]), [['order_voided', null]]);
  });

  it('voids a payment with a negative reversing entry, once, guarding the downpayment', async () => {
    await insertOrder('o-pay', 'Approved', { quote: 1000 });
    const pay = async (amount) => (await server.request('POST', '/api/orders/o-pay/payments', { token: production, body: { amount, payment_type: 'GCash', payer_name: 'Juan Dela Cruz', reference_no: '1004 123 456789' } })).body.payment;
    const first = await pay(600);
    const second = await pay(100);

    const blocked = await voidPay('o-pay', first.payment_id, { reason: 'Wrong account' });
    assert.deepEqual([blocked.status, blocked.body.error, blocked.body.required, blocked.body.paid_after], [409, 'VOID_BREAKS_DOWNPAYMENT', 500, 100]);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM payments WHERE order_id = 'o-pay'")).rows[0].n, 2, 'nothing written');
    const small = await voidPay('o-pay', second.payment_id, { reason: 'Duplicate entry' });
    assert.equal(small.status, 201, 'leaves 600: the 500 downpayment still holds');
    assert.deepEqual([small.body.payment.amount, small.body.payment.payment_type, small.body.payment.is_void, small.body.payment.voids_receipt_no],
      [-100, 'GCash', true, second.receipt_no]);
    assert.match(small.body.payment.receipt_no, /^AR-/);
    assert.equal(small.body.payment.received_by, 'u-owner');
    assert.match(small.body.message, new RegExp(`${second.receipt_no} was voided`));
    assert.deepEqual([small.body.totals.total_paid, small.body.totals.remaining], [600, 400]);

    const confirmed = await voidPay('o-pay', first.payment_id, { reason: 'Wrong account', confirm_break_downpayment: true });
    assert.equal(confirmed.status, 201, confirmed.text);
    assert.deepEqual([confirmed.body.totals.total_paid, confirmed.body.totals.payment_status], [0, 'Unpaid']);
    const [audit] = (await audits(first.payment_id));
    assert.deepEqual([audit.action, audit.performed_role, audit.details.reason, audit.details.amount, audit.details.confirmed_below_downpayment],
      ['payment_voided', 'Owner', 'Wrong account', 600, true]);

    const again = await voidPay('o-pay', first.payment_id, { reason: 'Again' });
    assert.deepEqual([again.status, again.body.error], [409, 'PAYMENT_ALREADY_VOIDED']);
    const reversal = await voidPay('o-pay', confirmed.body.payment.payment_id, { reason: 'Undo' });
    assert.deepEqual([reversal.status, reversal.body.error], [409, 'PAYMENT_NOT_VOIDABLE']);
    const elsewhere = await voidPay('o-old', second.payment_id, { reason: 'x' });
    assert.deepEqual([elsewhere.status, elsewhere.body.error], [404, 'PAYMENT_NOT_FOUND']);
    assert.equal((await voidPay('o-pay', second.payment_id, { reason: 'x' }, admin)).status, 403);

    const detail = await server.request('GET', '/api/orders/o-pay', { token: owner });
    const byId = new Map(detail.body.payments.map((p) => [p.payment_id, p]));
    assert.deepEqual([byId.get(first.payment_id).voided, byId.get(first.payment_id).can_void], [true, false]);
    assert.equal(detail.body.allowed_actions.void_payment, true);
    assert.equal(detail.body.allowed_actions.record_payment, true, 'the voided balance can be paid again');
  });

  it('lets only one of two simultaneous voids of the same payment through', async () => {
    await insertOrder('o-race', 'Completed', { quote: 800 });
    await pool.query("INSERT INTO payments (payment_id, order_id, amount, payment_type) VALUES ('p-race', 'o-race', 800, 'Cash')");
    const results = await Promise.all([voidPay('o-race', 'p-race', { reason: 'Refund A' }), voidPay('o-race', 'p-race', { reason: 'Refund B' })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409).body.error, 'PAYMENT_ALREADY_VOIDED');
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM payments WHERE voids_payment_id = 'p-race'")).rows[0].n, 1);
  });

  it('records overheads in the cloud, and lets the Owner remove one with a trail', async () => {
    const add = await server.request('POST', '/api/reports/overheads', {
      token: admin, body: { expense_date: '2026-03-05', category: 'Rent', description: 'March rent', amount: 8000 }
    });
    assert.equal(add.status, 201, add.text);
    assert.equal(add.body.source, 'cloud');
    const spare = await server.request('POST', '/api/reports/overheads', {
      token: owner, body: { expense_date: '2026-03-09', category: 'Other', description: 'Typo entry', amount: 99 }
    });
    const id = spare.body.expense.expense_id;
    assert.equal((await server.request('DELETE', `/api/reports/overheads/${id}`, { token: admin })).status, 403);
    const del = await server.request('DELETE', `/api/reports/overheads/${id}`, { token: owner });
    assert.equal(del.status, 200, del.text);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM overhead_expenses WHERE expense_id = $1', [id])).rows[0].n, 0);
    assert.deepEqual((await audits(id)).map((a) => [a.action, a.performed_role]), [['overhead_recorded', 'Owner'], ['overhead_deleted', 'Owner']]);
    assert.equal((await sqliteAll(server.localDb, 'SELECT 1 FROM overhead_expenses WHERE expense_id = ?', [id])).length, 0);
    assert.equal((await server.request('DELETE', `/api/reports/overheads/${id}`, { token: owner })).status, 404);
    const list = await server.request('GET', '/api/reports/overheads?from=2026-03-01&to=2026-03-31', { token: owner });
    assert.deepEqual([list.body.total, list.body.expenses[0].can_delete], [8000, true]);
  });

  it('adds up the true-cost P&L for a period, for the Owner only', async () => {
    // March 2026 (shop time). Server timestamps are UTC: 2026-02-28 16:00 UTC is March 1 in Manila.
    await insertOrder('o-m1', 'Completed', { quote: 2000, lines: [['i-shirt', 5], ['i-cap', 2]] });
    await pool.query("UPDATE order_profiles SET date_created = '2026-03-02 01:00:00', discount_amount = 150 WHERE order_id = 'o-m1'");
    await pool.query(`INSERT INTO order_status_history (history_id, order_id, from_status, to_status, changed_at)
                      VALUES ('h-m1', 'o-m1', 'Printing', 'Completed', '2026-03-20 03:00:00')`);
    await pool.query(`INSERT INTO payments (payment_id, order_id, amount, payment_type, payment_date) VALUES
      ('p-m1', 'o-m1', 1000, 'Cash', '2026-02-28 16:00:00'), ('p-m2', 'o-m1', 1000.10, 'GCash', '2026-03-31 15:59:00'),
      ('p-m3', 'o-m1', 999, 'Cash', '2026-03-31 16:00:00')`);
    await pool.query(`INSERT INTO payments (payment_id, order_id, amount, payment_type, payment_date, voids_payment_id, void_reason)
                      VALUES ('p-m4', 'o-m1', -1000.10, 'GCash', '2026-03-31 15:59:30', 'p-m2', 'Bounced')`);
    await pool.query(`INSERT INTO order_consumables_log (log_id, order_id, trigger_status, consumable_inventory_id, quantity_deducted, deducted_at)
                      VALUES ('cl-m1', 'o-m1', 'Pressing', 'i-ink', 7, '2026-03-19 00:00:00')`);
    await pool.query(`INSERT INTO material_loss (loss_id, inventory_id, quantity_lost, loss_reason, financial_cost, loss_category, date_recorded)
                      VALUES ('l-m1', 'i-cap', 1, 'Scorch', 80, 'Machine Failure', '2026-03-10 00:00:00')`);

    for (const token of [admin, production]) assert.equal((await server.request('GET', '/api/reports/pnl', { token })).status, 403);
    const r = await server.request('GET', '/api/reports/pnl?from=2026-03-01&to=2026-03-31', { token: owner });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.source, 'cloud');
    assert.deepEqual({
      gross: r.body.gross_income, voids: r.body.voids_in_period, discounts: r.body.discounts_given, blanks: r.body.cogs_blanks,
      consumables: r.body.cogs_consumables, waste: r.body.waste_cost, overheads: r.body.overhead_cost, expenses: r.body.total_expenses,
      net: r.body.net_profit, profitable: r.body.profitable
    }, {
      gross: 1000, voids: 1000.1, discounts: 150, blanks: 5 * 120 + 2 * 80, consumables: 17.5, waste: 80, overheads: 8000,
      expenses: 760 + 17.5 + 80 + 8000, net: 1000 - 8857.5, profitable: false
    });
    assert.deepEqual(r.body.overhead_by_category, [{ category: 'Rent', amount: 8000 }]);
    assert.deepEqual(r.body.counts, { payments: 3, orders_completed: 1, losses: 1 });

    const csv = await server.request('GET', '/api/reports/export/pnl.csv?from=2026-03-01&to=2026-03-31', { token: owner });
    assert.equal(csv.status, 200);
    assert.ok(csv.text.includes('Cost of goods,Blanks used (completed orders),760'));
    assert.ok(csv.text.includes('Total,Net loss,-7857.5'));
  });
  it('cancels a Ready order through the shop\'s fault and a half-printed one, recording the made pieces as waste (migration 017 / 018)', async () => {
    const cap = async () => (await pool.query("SELECT quantity_available AS a, quantity_reserved AS r FROM inventory_items WHERE inventory_id = 'i-cap'")).rows[0];
    const before = await cap();
    await insertOrder('o-ready', 'Ready', { quote: 600, reserved: true, lines: [['i-cap', 3]] });
    const ready = await server.request('PATCH', '/api/orders/o-ready/status', {
      token: admin, body: { status: 'Cancelled', shop_fault: true, cancellation_reason: 'Wrong color printed' }
    });
    assert.equal(ready.status, 200, ready.text);
    assert.deepEqual([ready.body.cancel_terms.fee, ready.body.cancel_terms.shop_fault, ready.body.order.cancel_shop_fault], [0, true, true]);
    assert.deepEqual(ready.body.wasted.map((w) => [w.inventory_id, w.quantity]), [['i-cap', 3]]);

    await insertOrder('o-half', 'Printing', { quote: 1000, reserved: true, lines: [['i-cap', 4]] });
    const half = await server.request('PATCH', '/api/orders/o-half/status', {
      token: owner, body: { status: 'Cancelled', cancellation_reason: 'Client cancelled', printed: [{ line_item_id: 'o-half-l1', quantity: 1 }] }
    });
    assert.equal(half.status, 200, half.text);
    assert.deepEqual([half.body.order.cancellation_fee, half.body.order.cancelled_stage], [500, 'Printing'], 'the 50% downpayment');

    const losses = (await pool.query(
      "SELECT order_id, quantity_lost, reason_code, production_stage FROM material_loss WHERE order_id IN ('o-ready', 'o-half') ORDER BY order_id")).rows;
    assert.deepEqual(losses.map((l) => [l.order_id, l.quantity_lost, l.reason_code, l.production_stage]),
      [['o-half', 1, 'cancelled_after_printing', 'Cancelled'], ['o-ready', 3, 'cancelled_after_printing', 'Cancelled']]);
    const after = await cap();
    assert.deepEqual([after.a, after.r], [before.a - 4, before.r], 'made pieces leave the stock; the rest is free again');
  });
});

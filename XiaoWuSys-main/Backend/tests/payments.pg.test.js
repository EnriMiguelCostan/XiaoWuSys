// ==========================================
// PAYMENTS ON A REAL POSTGRESQL DATABASE (PB 21, migration 008)
// Runs only when TEST_DATABASE_URL is set (CI starts a throw-away PostgreSQL for it). The
// database is WIPED first: localhost or a database whose name contains "test" only, never Neon.
//
// Checks: migration 008 applies and is safe to run twice; existing payments are numbered
// AR-YYYY-NNNN oldest first per shop-time year; a rolled-back payment leaves no gap and a
// number never changes; two payments sent at the same moment through the real route never
// add up to more than the balance; and the start-up schema check finds the new trigger.
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgTarget, resetDatabase, startPgTestServer, readMigration } = require('./helpers/pgTestServer');

const { url, skip } = pgTarget();

describe('Payments and receipt numbers on real PostgreSQL', { skip }, () => {
  let pool;
  let server;
  let production;

  const insertPayment = (client, id, paidAt, { amount = 100, order = 'o-legacy', legacy = false, receiver = null } = {}) => client.query(
    legacy
      ? `INSERT INTO payments (payment_id, order_id, amount, payment_type, payment_date) VALUES ($1, $2, $3, 'Cash', $4)`
      : `INSERT INTO payments (payment_id, order_id, amount, payment_type, payment_date, received_by)
         VALUES ($1, $2, $3, 'Cash', $4, $5) RETURNING receipt_no`,
    legacy ? [id, order, amount, paidAt] : [id, order, amount, paidAt, receiver]);
  const numbers = async () => Object.fromEntries((await pool.query(
    'SELECT payment_id, receipt_no FROM payments ORDER BY payment_id')).rows.map((r) => [r.payment_id, r.receipt_no]));
  const insertOrder = (id, quote, status = 'Pending') => pool.query(
    `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount)
     VALUES ($1, 'c-1', '2030-12-31 00:00:00', $2, $3)`, [id, status, quote]);
  const pay = (orderId, amount, token = production) =>
    server.request('POST', `/api/orders/${orderId}/payments`, { token, body: { amount, payment_type: 'Cash' } });

  before(async () => {
    const { Pool } = require('pg'); // only needed when this suite runs
    pool = new Pool({ connectionString: url, max: 8 });
    // An existing shop database: everything up to 007, with payments already in it
    await resetDatabase(pool, { before: '008' });
    await pool.query("INSERT INTO users (user_id, username, password_hash, role) VALUES ('u-owner', 'owner', 'x', 'Owner'), ('u-production', 'production', 'x', 'Production')");
    await pool.query("INSERT INTO customers (customer_id, full_name) VALUES ('c-1', 'Agdao NHS')");
    await insertOrder('o-legacy', 100000);
    // payment_date is UTC; the shop (Asia/Manila) is 8 hours ahead
    await insertPayment(pool, 'p-mar', '2026-03-01 00:00:00', { legacy: true });
    await insertPayment(pool, 'p-jan', '2026-01-15 00:00:00', { legacy: true });
    await insertPayment(pool, 'p-dec31', '2025-12-31 15:59:59', { legacy: true }); // 23:59:59 in Manila: still 2025
    await insertPayment(pool, 'p-newyear', '2025-12-31 16:00:00', { legacy: true }); // 00:00 Jan 1 in Manila: 2026
  });
  after(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('applies migration 008, and running it again changes nothing', async () => {
    const { applyPendingMigrations } = require('../services/migrations');
    const first = await applyPendingMigrations(pool, { log: () => {} });
    assert.ok(first.applied.includes('008_payments_receipts.sql'), JSON.stringify(first.applied));
    const snapshot = await numbers();
    assert.deepEqual((await applyPendingMigrations(pool, { log: () => {} })).applied, []);
    await pool.query(readMigration('008_payments_receipts.sql')); // pasted again by hand
    assert.deepEqual(await numbers(), snapshot);
  });

  it('numbers existing payments oldest first, per shop-time year', async () => {
    assert.deepEqual(await numbers(), {
      'p-dec31': 'AR-2025-0001',
      'p-jan': 'AR-2026-0002',
      'p-mar': 'AR-2026-0003',
      'p-newyear': 'AR-2026-0001'
    });
    const legacy = await pool.query("SELECT received_by FROM payments WHERE payment_id = 'p-jan'");
    assert.equal(legacy.rows[0].received_by, null, 'older payments have no receiver ("Not recorded")');
  });

  it('gives a new payment the next number, replaces a typed one, and never changes it afterwards', async () => {
    assert.equal((await insertPayment(pool, 'p-jun', '2026-06-01 02:00:00', { receiver: 'u-production' })).rows[0].receipt_no, 'AR-2026-0004');
    const typed = await pool.query(
      `INSERT INTO payments (payment_id, order_id, amount, payment_type, payment_date, receipt_no)
       VALUES ('p-typed', 'o-legacy', 1, 'Cash', '2027-02-01 02:00:00', 'AR-1999-9999') RETURNING receipt_no`);
    assert.equal(typed.rows[0].receipt_no, 'AR-2027-0001', 'a number sent by a client is replaced');
    await pool.query("UPDATE payments SET receipt_no = 'AR-2026-9999', payment_type = 'GCash' WHERE payment_id = 'p-jun'");
    const r = await pool.query("SELECT receipt_no, payment_type FROM payments WHERE payment_id = 'p-jun'");
    assert.deepEqual([r.rows[0].receipt_no, r.rows[0].payment_type], ['AR-2026-0004', 'GCash']);
  });

  it('leaves no gap when saving a payment is rolled back', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertPayment(client, 'p-rolled-back', '2026-07-01 02:00:00');
      await client.query('ROLLBACK');
    } finally { client.release(); }
    assert.equal((await insertPayment(pool, 'p-after', '2026-07-01 03:00:00')).rows[0].receipt_no, 'AR-2026-0005');
  });

  it('only accepts a receiver that is a real account', async () => {
    await assert.rejects(insertPayment(pool, 'p-ghost', '2026-07-02 03:00:00', { receiver: 'ghost' }), { code: '23503' });
  });

  it('records a payment online with its receipt number, receiver and fresh totals', async () => {
    server = await startPgTestServer(pool);
    production = server.tokenFor('u-production', 'Production');
    await insertOrder('o-online', 1000);
    const r = await pay('o-online', 100);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.source, 'cloud');
    assert.match(r.body.payment.receipt_no, /^AR-\d{4}-\d{4}$/);
    assert.deepEqual([r.body.payment.received_by, r.body.payment.received_by_name], ['u-production', 'production']);
    assert.deepEqual([r.body.totals.payment_status, r.body.totals.remaining, r.body.totals.downpayment.paid_synced], ['Partial', 900, 100]);
    assert.deepEqual(r.body.warnings.map((w) => w.code), ['DOWNPAYMENT_SHORT']);

    const over = await pay('o-online', 900.01);
    assert.deepEqual([over.status, over.body.error, over.body.remaining], [409, 'PAYMENT_EXCEEDS_BALANCE', 900]);

    await insertOrder('o-cancelled', 500, 'Cancelled');
    assert.equal((await pay('o-cancelled', 1)).body.error, 'ORDER_CLOSED');
    await insertOrder('o-unpriced', 0);
    assert.equal((await pay('o-unpriced', 1)).status, 422);
    const done = await insertOrder('o-done', 300, 'Completed').then(() => pay('o-done', 300));
    assert.equal(done.status, 201, 'the final balance can be paid at pickup');
  });

  it('never lets two payments sent at the same moment add up to more than the balance', async () => {
    for (let round = 0; round < 3; round++) {
      const orderId = `o-race-${round}`;
      await insertOrder(orderId, 1000);
      // Hold the order row so both requests are waiting on it at the same time
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM order_profiles WHERE order_id = $1 FOR UPDATE', [orderId]);
        const both = Promise.all([pay(orderId, 600), pay(orderId, 600)]);
        await new Promise((r) => setTimeout(r, 300));
        await blocker.query('COMMIT');
        const results = await both;
        assert.deepEqual(results.map((x) => x.status).sort(), [201, 409], results.map((x) => x.text).join('\n'));
        const refused = results.find((x) => x.status === 409);
        assert.deepEqual([refused.body.error, refused.body.remaining], ['PAYMENT_EXCEEDS_BALANCE', 400]);
      } finally { blocker.release(); }
      const total = await pool.query('SELECT SUM(amount)::text AS s, COUNT(*)::int AS n FROM payments WHERE order_id = $1', [orderId]);
      assert.deepEqual([total.rows[0].s, total.rows[0].n], ['600.00', 1]);
    }
  });

  it('passes the start-up schema check, including the receipt-number trigger', async () => {
    const { checkCloudSchema } = require('../services/schemaCheck');
    const original = console.error;
    console.error = () => {};
    try {
      const result = await checkCloudSchema(pool);
      assert.deepEqual([result.ok, result.missing, result.missingTriggers], [true, [], []]);
    } finally { console.error = original; }
  });
});

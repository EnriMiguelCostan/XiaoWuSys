// ==========================================
// MIGRATIONS ON A REAL POSTGRESQL DATABASE
// Runs only when TEST_DATABASE_URL is set (CI starts a throw-away PostgreSQL for it).
// The database is WIPED first, so the URL must point at localhost or at a database whose
// name contains "test". Never point it at Neon.
//
//   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/xiaowusys_test npm test
//
// Checks: schema.sql + every migration apply cleanly and are safe to run twice; migration 007
// numbers orders XM-YYYY-NNNN per shop-time year (existing orders oldest first), never
// changes a number, leaves no gap after a rollback, never hands out the same number twice
// when two orders are saved at once; and the start-up schema check finds nothing missing.
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const url = process.env.TEST_DATABASE_URL;
const safeTarget = (() => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || /test/i.test(u.pathname);
  } catch { return false; }
})();
const skip = !url ? 'set TEST_DATABASE_URL to run the PostgreSQL migration tests'
  : !safeTarget ? 'refusing to wipe TEST_DATABASE_URL: use localhost or a database whose name contains "test"' : false;

const MIGRATIONS = path.resolve(__dirname, '..', 'migrations');
const read = (file) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
const migrationFiles = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

describe('Database migrations on real PostgreSQL', { skip }, () => {
  let pool;
  const insertOrder = (client, id, created) => client.query(
    `INSERT INTO order_profiles (order_id, customer_id, date_created, production_deadline, production_status)
     VALUES ($1, 'c-1', $2, '2027-12-31 00:00:00', 'Pending') RETURNING tracking_no`, [id, created]);
  const numbers = async () => Object.fromEntries((await pool.query(
    'SELECT order_id, tracking_no FROM order_profiles ORDER BY order_id')).rows.map((r) => [r.order_id, r.tracking_no]));

  before(async () => {
    const { Pool } = require('pg'); // only needed when this suite runs
    pool = new Pool({ connectionString: url, max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await pool.query(fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf8'));
    // An existing shop database: everything up to 006, with orders already in it
    for (const file of migrationFiles().filter((f) => f < '007')) await pool.query(read(file));
    await pool.query("INSERT INTO users (user_id, username, password_hash, role) VALUES ('u-owner', 'owner', 'x', 'Owner')");
    await pool.query("INSERT INTO customers (customer_id, full_name) VALUES ('c-1', 'Agdao NHS')");
    // date_created is UTC; the shop (Asia/Manila) is 8 hours ahead
    await insertOrder(pool, 'old-mar', '2026-03-01 00:00:00');
    await insertOrder(pool, 'old-jan', '2026-01-15 00:00:00');
    await insertOrder(pool, 'old-dec31', '2025-12-31 15:59:59'); // 23:59:59 in Manila: still 2025
    await insertOrder(pool, 'old-newyear', '2025-12-31 16:00:00'); // 00:00 Jan 1 in Manila: 2026
  });
  after(async () => { if (pool) await pool.end(); });

  it('applies every migration, and running them again changes nothing', async () => {
    const { applyPendingMigrations } = require('../services/migrations');
    const first = await applyPendingMigrations(pool, { log: () => {} });
    assert.ok(first.applied.includes('007_tracking_numbers_sessions.sql'), JSON.stringify(first.applied));
    const snapshot = await numbers();
    const second = await applyPendingMigrations(pool, { log: () => {} });
    assert.deepEqual(second.applied, []);
    await pool.query(read('007_tracking_numbers_sessions.sql')); // pasted again by hand
    assert.deepEqual(await numbers(), snapshot);
  });

  it('numbers existing orders oldest first, per shop-time year', async () => {
    assert.deepEqual(await numbers(), {
      'old-dec31': 'XM-2025-0001',
      'old-jan': 'XM-2026-0002',
      'old-mar': 'XM-2026-0003',
      'old-newyear': 'XM-2026-0001'
    });
  });

  it('gives a new order the next number and starts again at 0001 in January', async () => {
    assert.equal((await insertOrder(pool, 'new-jun', '2026-06-01 02:00:00')).rows[0].tracking_no, 'XM-2026-0004');
    assert.equal((await insertOrder(pool, 'new-2027', '2027-01-05 02:00:00')).rows[0].tracking_no, 'XM-2027-0001');
    const typed = await pool.query(
      `INSERT INTO order_profiles (order_id, customer_id, date_created, production_deadline, tracking_no)
       VALUES ('typed', 'c-1', '2030-02-01 02:00:00', '2030-12-31 00:00:00', 'XM-1999-9999') RETURNING tracking_no`);
    assert.equal(typed.rows[0].tracking_no, 'XM-2030-0001', 'a number sent by a client is replaced');
  });

  it('never changes a number once it is given', async () => {
    await pool.query("UPDATE order_profiles SET tracking_no = 'XM-2026-9999', production_status = 'Delayed' WHERE order_id = 'new-jun'");
    const r = await pool.query("SELECT tracking_no, production_status FROM order_profiles WHERE order_id = 'new-jun'");
    assert.deepEqual([r.rows[0].tracking_no, r.rows[0].production_status], ['XM-2026-0004', 'Delayed']);
  });

  it('leaves no gap when saving an order is rolled back', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertOrder(client, 'rolled-back', '2026-07-01 02:00:00');
      await client.query('ROLLBACK');
    } finally { client.release(); }
    assert.equal((await insertOrder(pool, 'after-rollback', '2026-07-01 03:00:00')).rows[0].tracking_no, 'XM-2026-0005');
  });

  it('gives two orders saved at the same moment different numbers', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const first = await insertOrder(a, 'same-time-a', '2026-08-01 02:00:00');
      const second = insertOrder(b, 'same-time-b', '2026-08-01 02:00:00'); // waits for a's counter lock
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      const got = await second;
      await b.query('COMMIT');
      assert.deepEqual([first.rows[0].tracking_no, got.rows[0].tracking_no], ['XM-2026-0006', 'XM-2026-0007']);
    } finally { a.release(); b.release(); }
  });

  it('stores per-device logouts with an automatic version', async () => {
    await pool.query("INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ('sid-1', 'u-owner', NOW() + INTERVAL '8 hours')");
    const before = (await pool.query("SELECT last_modified FROM revoked_sessions WHERE session_id = 'sid-1'")).rows[0].last_modified;
    await new Promise((r) => setTimeout(r, 20));
    await pool.query("UPDATE revoked_sessions SET revoked_at = revoked_at + INTERVAL '1 second' WHERE session_id = 'sid-1'");
    const afterRow = (await pool.query("SELECT last_modified FROM revoked_sessions WHERE session_id = 'sid-1'")).rows[0].last_modified;
    assert.ok(afterRow > before, 'the last_modified trigger is attached');
  });

  it('passes the start-up schema check', async () => {
    const { checkCloudSchema } = require('../services/schemaCheck');
    const original = console.error;
    console.error = () => {};
    try {
      const result = await checkCloudSchema(pool);
      assert.deepEqual([result.ok, result.missing, result.missingTriggers], [true, [], []]);
    } finally { console.error = original; }
  });
});

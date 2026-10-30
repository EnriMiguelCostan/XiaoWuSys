// ==========================================
// REAL POSTGRESQL TEST SERVER
// For tests that need real row locks and triggers. Runs only when TEST_DATABASE_URL is set
// (CI starts a throw-away PostgreSQL 16 for it). The database is WIPED, so the URL must point
// at localhost or at a database whose name contains "test". Never point it at Neon.
//
//   pgTarget()                 -> { url, skip }  (skip: false, or the reason the suite is skipped)
//   resetDatabase(pool, opts)  -> empty schema + schema.sql + migrations (all, or those before opts.before)
//   startPgTestServer(pool)    -> the real Express app on a random port, cloud = this pool,
//                                 with a throw-away SQLite cache and signed test tokens
// ==========================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-0123456789';

const BACKEND = path.resolve(__dirname, '..', '..');
const MIGRATIONS = path.join(BACKEND, 'migrations');

const pgTarget = () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { url, skip: 'set TEST_DATABASE_URL to run the PostgreSQL tests' };
  try {
    const u = new URL(url);
    const safe = ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || /test/i.test(u.pathname);
    return { url, skip: safe ? false : 'refusing to wipe TEST_DATABASE_URL: use localhost or a database whose name contains "test"' };
  } catch {
    return { url, skip: 'TEST_DATABASE_URL is not a valid URL' };
  }
};

const migrationFiles = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const readMigration = (file) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

const resetDatabase = async (pool, { before = null } = {}) => {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(path.join(BACKEND, 'schema.sql'), 'utf8'));
  for (const file of migrationFiles().filter((f) => before === null || f < before)) await pool.query(readMigration(file));
};

const startPgTestServer = async (pool) => {
  const { prepareDatabase } = require('./testServer');
  const { createApp } = require('../../app');
  const { createOrderLockManager } = require('../../services/orderLocks');
  const { listConflicts } = require('../../services/sync');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-pg-'));
  const dbPath = path.join(dir, 'cache.db');
  const localDb = await prepareDatabase(dbPath);
  const since = Date.now();
  const app = createApp({
    pgPool: pool, localDb, localDbPath: dbPath, orderLocks: createOrderLockManager(),
    inventoryEvents: { notifyChanged: () => {} },
    syncAndNotify: async () => ({ synced: 0, conflicts: [], failed: 0, requeued: 0, aborted: false, unresolved_conflicts: 0 }),
    listConflicts,
    cloudHealth: { state: () => 'reachable', since: () => since }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A login token like the one POST /api/auth/login issues
  const tokenFor = (user_id, role) => jwt.sign(
    { user_id, role, ims: Date.now(), sid: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const request = async (method, url, { body, token } = {}) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
  };

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => localDb.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { baseUrl, request, tokenFor, close, localDb };
};

module.exports = { pgTarget, resetDatabase, startPgTestServer, migrationFiles, readMigration };

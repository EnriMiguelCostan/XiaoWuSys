// ==========================================
// TEST SERVER
// Starts the real Express app (app.js) on a random port with:
//   - a brand-new SQLite database file in the OS temp folder (deleted afterwards)
//   - the cloud disabled, so every route takes its real offline path (no Neon, no network)
//   - the fixture accounts from fixtures/data.js already "synced" to this computer
// Tests then call the API over HTTP exactly like the browser does.
// ==========================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-0123456789';

const { createApp } = require('../../app');
const { createCloudDisabledPool } = require('../../services/cloudDisabledPool');
const { createLocalSchema, createLocalIndexes } = require('../../services/localSchema');
const { ensureLocalSyncColumns } = require('../../utils/localSync');
const { SYNC_TABLES, listConflicts } = require('../../services/sync');
const { createOrderLockManager } = require('../../services/orderLocks');
const { loadRevocations } = require('../../services/sessions');
const { sqliteRun, sqliteGet, sqliteAll } = require('../../services/records');
const fixtures = require('../fixtures/data');

const openDb = (file) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(db)));
});

// Creates the schema and the fixture accounts in a SQLite file
const prepareDatabase = async (file, { users = fixtures.USERS, password = fixtures.PASSWORD } = {}) => {
  const db = await openDb(file);
  await sqliteRun(db, 'PRAGMA foreign_keys = ON');
  await createLocalSchema(db);
  await ensureLocalSyncColumns(db, SYNC_TABLES.map((t) => t.table), { log: () => {} });
  await createLocalIndexes(db);
  const hash = await bcrypt.hash(password, 4); // low cost: tests stay fast
  for (const u of users) {
    await sqliteRun(db,
      `INSERT INTO users (user_id, username, password_hash, role, is_active, sync_status) VALUES (?, ?, ?, ?, ?, 'synced')`,
      [u.user_id, u.username, hash, u.role, u.is_active]);
  }
  return db;
};

// Offline-only mode, like `npm run demo`: the cloud is switched off
const disabledCloudHealth = () => {
  const since = Date.now();
  return { state: () => 'disabled', since: () => since };
};

// Options: dbPath (reuse a prepared SQLite file), pgPool (a scripted cloud), cloudHealth (stub)
const startTestServer = async ({ corsOrigins, dbPath: givenPath, pgPool: givenPool, cloudHealth } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-test-'));
  const dbPath = givenPath || path.join(dir, 'test_cache.db');
  const localDb = givenPath ? await openDb(dbPath) : await prepareDatabase(dbPath);
  if (givenPath) await sqliteRun(localDb, 'PRAGMA foreign_keys = ON');
  const pgPool = givenPool || createCloudDisabledPool();
  const pushes = [];
  const localWrites = [];
  const inventoryEvents = { notifyChanged: (ids, reason) => pushes.push({ ids, reason }) };

  const app = createApp({
    pgPool, localDb, localDbPath: dbPath, orderLocks: createOrderLockManager(), inventoryEvents,
    syncAndNotify: async () => ({ synced: 0, conflicts: [], failed: 0, requeued: 0, aborted: true }),
    listConflicts, corsOrigins,
    cloudHealth: cloudHealth || disabledCloudHealth(),
    onLocalWrite: () => localWrites.push(Date.now())
  });
  await loadRevocations({ pgPool, localDb });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Plain HTTP call -> { status, headers, body, text }
  const request = async (method, url, { body, token, headers = {} } = {}) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    // Decode by hand: res.text() would silently drop a UTF-8 BOM (checked by the CSV tests)
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* CSV or empty */ }
    return { status: res.status, headers: res.headers, body: parsed, text };
  };

  const tokens = {};
  const login = async (username, password = fixtures.PASSWORD) => {
    const r = await request('POST', '/api/auth/login', { body: { username, password } });
    if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${r.text}`);
    tokens[username] = r.body.token;
    return r.body.token;
  };

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => localDb.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return {
    baseUrl, request, login, tokens, close, pushes, localWrites, localDb, dbPath,
    get: (sql, p) => sqliteGet(localDb, sql, p),
    all: (sql, p) => sqliteAll(localDb, sql, p),
    run: (sql, p) => sqliteRun(localDb, sql, p)
  };
};

// 'YYYY-MM-DD' n days from today in the shop's time zone
const shopDate = (days = 0) => {
  const d = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(d);
};

module.exports = { startTestServer, prepareDatabase, openDb, shopDate, fixtures };

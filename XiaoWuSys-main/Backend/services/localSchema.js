// ==========================================
// LOCAL (SQLite) SCHEMA
// Creates the offline-cache tables. Runs automatically every time the server starts, so a
// fresh or deleted local_cache.db never causes "no such table" sync errors. Safe to run
// repeatedly (CREATE ... IF NOT EXISTS). Columns added later are back-filled on existing
// databases by ensureLocalSyncColumns() in utils/localSync.js.
// ==========================================

const sqlite3 = require('sqlite3');
const { PRODUCTION_STATUSES } = require('../utils/validation');

const SYNC_STATUS = `sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update'))`;
// Same allow-list as Neon (migration 005) and the API validator
const ORDER_STATUS_SQL = PRODUCTION_STATUSES.map((s) => `'${s}'`).join(', ');

const LOCAL_TABLES = [
  `CREATE TABLE IF NOT EXISTS inventory_items (
      inventory_id TEXT PRIMARY KEY,
      item_name TEXT NOT NULL,
      item_category TEXT NOT NULL,
      quantity_available INTEGER NOT NULL DEFAULT 0,
      quantity_reserved INTEGER NOT NULL DEFAULT 0,
      minimum_threshold INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'pcs',
      supplier TEXT,
      deleted_at TEXT,
      deleted_by TEXT,
      purged_at TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK (quantity_reserved >= 0 AND quantity_available >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Owner', 'Admin', 'Production', 'Staff')),
      is_active INTEGER NOT NULL DEFAULT 1,
      tokens_valid_after TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS customers (
      customer_id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      contact_number TEXT,
      platform_source TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS order_profiles (
      order_id TEXT PRIMARY KEY,
      customer_id TEXT REFERENCES customers(customer_id) ON DELETE RESTRICT,
      date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
      production_deadline DATETIME NOT NULL,
      production_status TEXT DEFAULT 'Pending' CHECK (production_status IN (${ORDER_STATUS_SQL})),
      design_drive_link TEXT,
      total_quote_amount REAL DEFAULT 0.00,
      stock_reserved INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT,
      approved_at TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS order_items (
      line_item_id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES order_profiles(order_id) ON DELETE CASCADE,
      inventory_id TEXT REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
      product_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      size TEXT,
      custom_name TEXT,
      custom_number TEXT,
      price REAL DEFAULT 0.00,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES order_profiles(order_id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      payment_type TEXT NOT NULL CHECK (payment_type IN ('Cash', 'GCash', 'Bank Transfer')),
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS material_loss (
      loss_id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES order_profiles(order_id) ON DELETE SET NULL,
      inventory_id TEXT REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
      quantity_lost INTEGER NOT NULL,
      loss_reason TEXT NOT NULL,
      date_recorded DATETIME DEFAULT CURRENT_TIMESTAMP,
      financial_cost REAL NOT NULL DEFAULT 0.00,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // Backend-only trace of every catalog change (never shown on the website). No foreign key,
  // so the trace survives even after an item is permanently deleted.
  `CREATE TABLE IF NOT EXISTS inventory_audit_log (
      audit_id TEXT PRIMARY KEY,
      inventory_id TEXT NOT NULL,
      action TEXT NOT NULL,
      item_name TEXT,
      details TEXT,
      performed_by TEXT,
      performed_role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_local_inventory_bin ON inventory_items (deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_local_audit_item ON inventory_audit_log (inventory_id, created_at)'
];

const run = (db, sql) => new Promise((resolve, reject) => db.run(sql, (err) => (err ? reject(err) : resolve())));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));

// Indexes on columns that an older local_cache.db may not have yet are created after
// ensureLocalSyncColumns() back-fills them, so they are retried there.
const createLocalSchema = async (db) => {
  for (const sql of LOCAL_TABLES) {
    try {
      await run(db, sql);
    } catch (err) {
      if (/^CREATE INDEX/.test(sql) && /no such column/i.test(err.message)) continue;
      throw err;
    }
  }
};

const createLocalIndexes = async (db) => {
  for (const sql of LOCAL_TABLES.filter((s) => s.startsWith('CREATE INDEX'))) await run(db, sql);
};

const listLocalTables = async (db) =>
  (await all(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);

// Sprint 11 / PB 13: a cache created before 'Approved' existed still has the old
// production_status CHECK, so copying an approved order from Neon would fail. SQLite cannot
// ALTER a CHECK, so the table is rebuilt once, keeping every row and column (including
// unsynced offline rows): the new definition is the stored one with only the status list
// replaced, and rows are copied with SELECT * (same column order).
// Runs on its own connection so PRAGMA foreign_keys = OFF (needed so DROP TABLE does not
// cascade into order_items / payments) never affects the server's shared connection.
// -> true if the table was rebuilt, false if nothing had to change
const upgradeLocalOrderStatusCheck = (dbPath) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(dbPath, async (openErr) => {
    if (openErr) return reject(openErr);
    db.configure('busyTimeout', 5000);
    const get = (sql) => new Promise((ok, fail) => db.get(sql, (err, row) => (err ? fail(err) : ok(row))));
    let began = false;
    try {
      const table = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'order_profiles'");
      const check = table && /production_status\s+IN\s*\([^)]*\)/i.exec(table.sql);
      if (!check || check[0].includes("'Approved'")) return resolve(false);

      const newSql = table.sql
        .replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?["`]?order_profiles["`]?/i, 'CREATE TABLE order_profiles__upgrade')
        .replace(check[0], `production_status IN (${ORDER_STATUS_SQL})`);
      if (!newSql.startsWith('CREATE TABLE order_profiles__upgrade')) {
        throw new Error('unrecognised order_profiles definition');
      }

      await run(db, 'PRAGMA foreign_keys = OFF'); // has no effect inside a transaction, so set first
      await run(db, 'BEGIN IMMEDIATE');
      began = true;
      await run(db, 'DROP TABLE IF EXISTS order_profiles__upgrade');
      await run(db, newSql);
      await run(db, 'INSERT INTO order_profiles__upgrade SELECT * FROM order_profiles');
      const [before, after] = await Promise.all([
        get('SELECT COUNT(*) AS n FROM order_profiles'), get('SELECT COUNT(*) AS n FROM order_profiles__upgrade')
      ]);
      if (before.n !== after.n) throw new Error(`row count mismatch (${before.n} vs ${after.n})`);
      await run(db, 'DROP TABLE order_profiles');
      await run(db, 'ALTER TABLE order_profiles__upgrade RENAME TO order_profiles');
      await run(db, 'COMMIT');
      console.log(`🛠  Local order_profiles upgraded for the 'Approved' status (${after.n} row(s) kept)`);
      resolve(true);
    } catch (err) {
      if (began) await run(db, 'ROLLBACK').catch(() => {});
      reject(new Error(`Could not upgrade local order_profiles: ${err.message}`));
    } finally {
      db.close();
    }
  });
});

module.exports = { createLocalSchema, createLocalIndexes, listLocalTables, upgradeLocalOrderStatusCheck };

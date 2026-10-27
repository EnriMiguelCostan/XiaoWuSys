// ==========================================
// LOCAL (SQLite) SCHEMA
// Creates the offline-cache tables. Runs automatically every time the server starts, so a
// fresh or deleted local_cache.db never causes "no such table" sync errors. Safe to run
// repeatedly (CREATE ... IF NOT EXISTS). Columns added later are back-filled on existing
// databases by ensureLocalSyncColumns() in utils/localSync.js.
// ==========================================

const SYNC_STATUS = `sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update'))`;

const LOCAL_TABLES = [
  `CREATE TABLE IF NOT EXISTS inventory_items (
      inventory_id TEXT PRIMARY KEY,
      item_name TEXT NOT NULL,
      item_category TEXT NOT NULL,
      quantity_available INTEGER NOT NULL DEFAULT 0,
      quantity_reserved INTEGER NOT NULL DEFAULT 0,
      minimum_threshold INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT,
      purged_at TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Owner', 'Admin', 'Production', 'Staff')),
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
      production_status TEXT DEFAULT 'Pending' CHECK (production_status IN ('Pending', 'Printing', 'Completed', 'Delayed', 'Cancelled')),
      design_drive_link TEXT,
      total_quote_amount REAL DEFAULT 0.00,
      stock_reserved INTEGER NOT NULL DEFAULT 0,
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

module.exports = { createLocalSchema, createLocalIndexes, listLocalTables };

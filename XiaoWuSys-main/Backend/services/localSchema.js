// ==========================================
// LOCAL (SQLite) SCHEMA
// Creates the offline-cache tables. Runs automatically every time the server starts, so a
// fresh or deleted local_cache.db never causes "no such table" sync errors. Safe to run
// repeatedly (CREATE ... IF NOT EXISTS). Columns added later are back-filled on existing
// databases by ensureLocalSyncColumns() in utils/localSync.js.
// ==========================================

const sqlite3 = require('sqlite3');
const { PRODUCTION_STATUSES, PAYMENT_TYPES } = require('../utils/validation');

const SYNC_STATUS = `sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update'))`;
// Same allow-list as Neon (migration 005) and the API validator
const ORDER_STATUS_SQL = PRODUCTION_STATUSES.map((s) => `'${s}'`).join(', ');
// Same payment methods as Neon (migration 015) and the API validator
const PAYMENT_TYPE_SQL = PAYMENT_TYPES.map((s) => `'${s}'`).join(', ');

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
      selling_price REAL NOT NULL DEFAULT 0,
      supplier_id TEXT,
      has_sizes INTEGER DEFAULT 0,
      requires_pressing INTEGER DEFAULT 0,
      print_pricing TEXT NOT NULL DEFAULT 'included',
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
      removed_at TEXT,
      removed_by TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS customers (
      customer_id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      contact_number TEXT,
      platform_source TEXT,
      archived_at TEXT,
      archived_by TEXT,
      customer_type TEXT DEFAULT 'Individual',
      contact_person TEXT,
      email TEXT,
      address TEXT,
      social_media TEXT,
      notes TEXT,
      contact_person_number TEXT,
      contact_person_email TEXT,
      contact_person_social TEXT,
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
      tracking_no TEXT,
      last_edited_by TEXT,
      last_edited_role TEXT,
      subtotal_amount REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      discount_reason TEXT,
      cancellation_reason TEXT,
      archived_at TEXT,
      archived_by TEXT,
      order_description TEXT,
      labor_amount REAL DEFAULT 0,
      incidental_amount REAL DEFAULT 0,
      adjustment_amount REAL DEFAULT 0,
      adjustment_reason TEXT,
      branch_id TEXT,
      cancellation_fee REAL,
      cancelled_stage TEXT,
      cancel_shop_fault INTEGER NOT NULL DEFAULT 0,
      client_delay_reason TEXT,
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
      unit_cost REAL,
      qty_printed INTEGER NOT NULL DEFAULT 0,
      qty_pressed INTEGER NOT NULL DEFAULT 0,
      print_areas TEXT,
      added_after_approval INTEGER NOT NULL DEFAULT 0,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES order_profiles(order_id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      payment_type TEXT NOT NULL CHECK (payment_type IN (${PAYMENT_TYPE_SQL})),
      received_by TEXT,
      receipt_no TEXT,
      voids_payment_id TEXT,
      void_reason TEXT,
      payer_name TEXT,
      reference_no TEXT,
      bank_name TEXT,
      account_name TEXT,
      cheque_no TEXT,
      cheque_date TEXT,
      payment_notes TEXT,
      is_refund INTEGER DEFAULT 0,
      refund_reason TEXT,
      verified_by TEXT,
      verified_at TEXT,
      recorded_at TEXT,
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
      reason_code TEXT,
      loss_category TEXT,
      production_stage TEXT,
      is_statistical_anomaly INTEGER DEFAULT 0,
      loss_batch_id TEXT,
      print_detail_id TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // PB 22 overheads (migration 012): recorded online or offline (pushed insert-only), deleted
  // by the Owner online only; rows deleted in the cloud are removed here too (prune).
  `CREATE TABLE IF NOT EXISTS overhead_expenses (
      expense_id TEXT PRIMARY KEY,
      expense_date DATETIME NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      recorded_by TEXT,
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
  // Sessions ended with "Log out" on one device (migration 007). Rows written while offline
  // are pending_insert and pushed by the sync; no foreign key, like the audit trail.
  `CREATE TABLE IF NOT EXISTS revoked_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // General audit trail (migration 009). Written in the cloud; mirrored here so a row saved
  // offline can be pushed (insert-only) like the inventory trail. No foreign key.
  `CREATE TABLE IF NOT EXISTS audit_log (
      audit_id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      performed_by TEXT,
      performed_role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // Status timeline (migration 010). Status changes need the cloud, so rows are only ever
  // copied down, for reading offline. No foreign key, like the cloud table.
  `CREATE TABLE IF NOT EXISTS order_status_history (
      history_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_by TEXT,
      changed_role TEXT,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // PB 15 usage rates and deductions (migration 011). Both are written in the cloud only and
  // copied down for reading offline. No foreign keys: the cache may drop an inventory row that
  // a rate still names until the next refresh removes the rate too.
  `CREATE TABLE IF NOT EXISTS consumable_rates (
      rate_id TEXT PRIMARY KEY,
      product_inventory_id TEXT NOT NULL,
      consumable_inventory_id TEXT NOT NULL,
      quantity_per_piece REAL NOT NULL,
      trigger_status TEXT NOT NULL DEFAULT 'Pressing',
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS order_consumables_log (
      log_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      trigger_status TEXT NOT NULL,
      consumable_inventory_id TEXT NOT NULL,
      quantity_deducted INTEGER NOT NULL,
      shortfall INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL,
      deducted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // Migration 015: supplier profiles (edited online only, copied down so an item can name its
  // supplier offline), print details (added offline too, pushed insert-only) and deliveries
  // (recorded online only, copied down for reading). No foreign keys, like the other caches.
  `CREATE TABLE IF NOT EXISTS suppliers (
      supplier_id TEXT PRIMARY KEY,
      supplier_name TEXT NOT NULL,
      contact_person TEXT,
      contact_number TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      archived_at TEXT,
      archived_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      dirty_fields TEXT,
      cloud_last_modified TEXT,
      sync_conflict TEXT,
      sync_error TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS order_print_details (
      print_detail_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      line_item_id TEXT,
      print_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      size TEXT,
      custom_name TEXT,
      custom_number TEXT,
      notes TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      dirty_fields TEXT,
      cloud_last_modified TEXT,
      sync_conflict TEXT,
      sync_error TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS order_deliveries (
      delivery_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      batch_no INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      delivered_at DATETIME NOT NULL,
      method TEXT NOT NULL DEFAULT 'Pick-up',
      received_by_name TEXT,
      notes TEXT,
      recorded_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      plan_id TEXT,
      dirty_fields TEXT,
      cloud_last_modified TEXT,
      sync_conflict TEXT,
      sync_error TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // Migration 016: a client's other branches, and delivery batches planned ahead. Both are
  // changed online only and copied down for reading offline (like order_deliveries).
  `CREATE TABLE IF NOT EXISTS customer_branches (
      branch_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      address TEXT,
      contact_person TEXT,
      contact_number TEXT,
      email TEXT,
      notes TEXT,
      archived_at TEXT,
      archived_by TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      dirty_fields TEXT,
      cloud_last_modified TEXT,
      sync_conflict TEXT,
      sync_error TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS order_delivery_plans (
      plan_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      batch_no INTEGER NOT NULL,
      planned_quantity INTEGER NOT NULL,
      planned_date TEXT,
      ready_at TEXT,
      ready_by TEXT,
      notes TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      dirty_fields TEXT,
      cloud_last_modified TEXT,
      sync_conflict TEXT,
      sync_error TEXT,
      ${SYNC_STATUS},
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_local_customer_branches_customer ON customer_branches (customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_delivery_plans_order ON order_delivery_plans (order_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_print_details_order ON order_print_details (order_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_deliveries_order ON order_deliveries (order_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_status_history_order ON order_status_history (order_id, changed_at)',
  'CREATE INDEX IF NOT EXISTS idx_local_consumable_rates_product ON consumable_rates (product_inventory_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_consumables_log_order ON order_consumables_log (order_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_inventory_bin ON inventory_items (deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_local_audit_item ON inventory_audit_log (inventory_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_local_order_tracking ON order_profiles (tracking_no)',
  'CREATE INDEX IF NOT EXISTS idx_local_payments_order ON payments (order_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_material_loss_order ON material_loss (order_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_overheads_date ON overhead_expenses (expense_date)'
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

// Sprint 11 / PB 13 and PB 14: a cache created before 'Approved' (migration 005) or 'Pressing'
// (migration 010) existed still has the old production_status CHECK, so copying such an
// order from Neon would fail. SQLite cannot
// ALTER a CHECK, so the table is rebuilt once, keeping every row and column (including
// unsynced offline rows): the new definition is the stored one with only the status list
// replaced, and rows are copied with SELECT * (same column order).
// Runs on its own connection so PRAGMA foreign_keys = OFF (needed so DROP TABLE does not
// cascade into order_items / payments) never affects the server's shared connection.
// -> true if the table was rebuilt, false if nothing had to change
// Migration 015 uses the same rebuild for payments.payment_type (Maya, PayPal, cheque, card...).
const upgradeLocalCheck = (dbPath, { table: name, column, values, sqlList, what }) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(dbPath, async (openErr) => {
    if (openErr) return reject(openErr);
    db.configure('busyTimeout', 5000);
    const get = (sql) => new Promise((ok, fail) => db.get(sql, (err, row) => (err ? fail(err) : ok(row))));
    const temp = `${name}__upgrade`;
    let began = false;
    try {
      const table = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${name}'`);
      const check = table && new RegExp(`${column}\\s+IN\\s*\\([^)]*\\)`, 'i').exec(table.sql);
      if (!check || values.every((s) => check[0].includes(`'${s}'`))) return resolve(false);

      const newSql = table.sql
        .replace(new RegExp(`CREATE TABLE\\s+(IF NOT EXISTS\\s+)?["\`]?${name}["\`]?`, 'i'), `CREATE TABLE ${temp}`)
        .replace(check[0], `${column} IN (${sqlList})`);
      if (!newSql.startsWith(`CREATE TABLE ${temp}`)) {
        throw new Error(`unrecognised ${name} definition`);
      }

      await run(db, 'PRAGMA foreign_keys = OFF'); // has no effect inside a transaction, so set first
      await run(db, 'BEGIN IMMEDIATE');
      began = true;
      await run(db, `DROP TABLE IF EXISTS ${temp}`);
      await run(db, newSql);
      await run(db, `INSERT INTO ${temp} SELECT * FROM ${name}`);
      const [before, after] = await Promise.all([
        get(`SELECT COUNT(*) AS n FROM ${name}`), get(`SELECT COUNT(*) AS n FROM ${temp}`)
      ]);
      if (before.n !== after.n) throw new Error(`row count mismatch (${before.n} vs ${after.n})`);
      await run(db, `DROP TABLE ${name}`);
      await run(db, `ALTER TABLE ${temp} RENAME TO ${name}`);
      await run(db, 'COMMIT');
      console.log(`🛠  Local ${name} upgraded for the current ${what} (${after.n} row(s) kept)`);
      resolve(true);
    } catch (err) {
      if (began) await run(db, 'ROLLBACK').catch(() => {});
      reject(new Error(`Could not upgrade local ${name}: ${err.message}`));
    } finally {
      db.close();
    }
  });
});

const upgradeLocalOrderStatusCheck = (dbPath) => upgradeLocalCheck(dbPath, {
  table: 'order_profiles', column: 'production_status', values: PRODUCTION_STATUSES, sqlList: ORDER_STATUS_SQL, what: 'order statuses'
});
const upgradeLocalPaymentTypeCheck = (dbPath) => upgradeLocalCheck(dbPath, {
  table: 'payments', column: 'payment_type', values: PAYMENT_TYPES, sqlList: PAYMENT_TYPE_SQL, what: 'payment methods'
});

// Migration 015: print lines used to be order_items without stock. In the cloud the migration
// moved them to order_print_details (same ids); this computer's copy follows once, so an older
// cache never shows them as materials, and a line typed offline before the upgrade is pushed as
// a print detail. Safe to run on every start (nothing left to move the second time).
// -> number of lines moved
const upgradeLocalPrintDetails = async (db) => {
  const legacy = await all(db, "SELECT COUNT(*) AS n FROM order_items WHERE inventory_id IS NULL AND order_id IS NOT NULL");
  if (!legacy[0] || Number(legacy[0].n) === 0) return 0;
  await run(db, `INSERT OR IGNORE INTO order_print_details
      (print_detail_id, order_id, print_type, quantity, size, custom_name, custom_number, created_at, sync_status, last_modified)
    SELECT line_item_id, order_id, substr(COALESCE(NULLIF(trim(product_type), ''), 'Print'), 1, 100), MAX(quantity, 1),
           size, custom_name, custom_number, last_modified,
           CASE WHEN sync_status = 'pending_insert' THEN 'pending_insert' ELSE 'synced' END, last_modified
      FROM order_items WHERE inventory_id IS NULL AND order_id IS NOT NULL`);
  await run(db, 'DELETE FROM order_items WHERE inventory_id IS NULL AND order_id IS NOT NULL');
  console.log(`🛠  Moved ${legacy[0].n} print line(s) from the local materials to print details`);
  return Number(legacy[0].n);
};

module.exports = {
  createLocalSchema, createLocalIndexes, listLocalTables, upgradeLocalOrderStatusCheck, upgradeLocalPaymentTypeCheck,
  upgradeLocalPrintDetails
};

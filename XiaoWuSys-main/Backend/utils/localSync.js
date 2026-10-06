// ==========================================
// LOCAL (SQLite) SYNC BOOKKEEPING
// Helpers shared by the offline route fallbacks and services/sync.js.
// ==========================================

// Millisecond-precision timestamp. CURRENT_TIMESTAMP only has 1-second resolution,
// which would let two edits in the same second look "unchanged" to the H3 check.
const LOCAL_NOW = "strftime('%Y-%m-%d %H:%M:%f','now')";

// Version token format used for Neon last_modified (microsecond precision, text-safe)
const PG_VERSION_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US';

// Local-only columns used by the sync engine. They exist only in SQLite, never in Neon.
//   dirty_fields        JSON array of columns edited offline (C3: push only changed fields)
//   cloud_last_modified Neon last_modified this device last saw (C3: optimistic lock baseline)
//   sync_conflict       Set when the cloud row was changed by someone else (C3); blocks re-push
//   sync_error          Last non-connection error from Neon, for diagnosis
const LOCAL_SYNC_COLUMNS = ['dirty_fields', 'cloud_last_modified', 'sync_conflict', 'sync_error'];

// Table-specific local-only columns
//   material_loss.cloud_stock_delta  stock to subtract in Neon when this offline loss syncs (M9);
//                                    0 when the reduction is already baked into an offline-created item
const TABLE_EXTRA_COLUMNS = {
  material_loss: [['cloud_stock_delta', 'INTEGER']]
};

const all = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const run = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));

// Adds any missing bookkeeping columns. Safe to run on every start-up.
const ensureLocalSyncColumns = async (db, tables) => {
  for (const table of tables) {
    const existing = new Set((await all(db, `PRAGMA table_info(${table})`)).map((c) => c.name));
    if (existing.size === 0) {
      console.warn(`⚠️ Local table ${table} not found. Run "node initLocalDb.js" first.`);
      continue;
    }
    const columns = [...LOCAL_SYNC_COLUMNS.map((c) => [c, 'TEXT']), ...(TABLE_EXTRA_COLUMNS[table] || [])];
    for (const [column, type] of columns) {
      if (!existing.has(column)) {
        await run(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.log(`🛠️  Added local sync column ${table}.${column}`);
      }
    }
  }
};

// SQL fragment for an offline UPDATE: records which fields changed, keeps a row that was
// never pushed as pending_insert, and bumps last_modified so an in-flight sync notices (H3).
const offlineUpdateBookkeeping = (table, fields) => {
  const union = fields.map((f) => `SELECT '${f}'`).join(' UNION ');
  return `
    sync_status = CASE WHEN ${table}.sync_status = 'pending_insert' THEN 'pending_insert' ELSE 'pending_update' END,
    dirty_fields = (SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(COALESCE(${table}.dirty_fields, '[]')) UNION ${union}
    )),
    last_modified = ${LOCAL_NOW}`;
};

module.exports = {
  LOCAL_NOW,
  PG_VERSION_FORMAT,
  LOCAL_SYNC_COLUMNS,
  ensureLocalSyncColumns,
  offlineUpdateBookkeeping
};

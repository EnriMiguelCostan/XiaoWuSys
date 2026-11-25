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
//   inventory_items.deleted_at/deleted_by/purged_at  Recycle Bin (mirrors Neon, migration 004)
//   order_profiles.stock_reserved                    whether the order holds a stock reservation
//   inventory_items.unit/supplier, users.is_active/tokens_valid_after   mirror migration 006
//   order_profiles.approved_by/approved_at           job order approval (mirrors Neon, migration 005)
//   order_profiles.tracking_no                       order number from the cloud (migration 007)
//   payments.received_by / receipt_no                receiver, and receipt number from the cloud (migration 008)
//   order_profiles.last_edited_by / last_edited_role who last changed the order (migration 009)
//   inventory_items.selling_price                    price per piece before volume discounts (migration 011)
//   order_profiles.subtotal_amount / discount_amount / discount_reason   the quote's breakdown (migration 011)
//   material_loss.reason_code / loss_category / production_stage / is_statistical_anomaly   diagnostics (migration 012)
//   order_profiles.cancellation_reason, payments.voids_payment_id / void_reason   voids (migration 012)
//   order_profiles / customers .archived_at / archived_by   archiving (migration 013)
//   order_items / order_consumables_log .unit_cost   unit cost at the time, for the P&L (migration 013)
//   migration 015: inventory_items.supplier_id / has_sizes; order_profiles.order_description /
//     labor_amount / incidental_amount; payments: payer and method details, refunds, verification,
//     recorded_at; customers: client profile; material_loss.loss_batch_id (bulk waste)
//   migration 016: inventory_items.requires_pressing (T-shirts); customers: the contact person's own
//     number / email / social media; order_profiles.branch_id; order_deliveries.plan_id;
//     material_loss.print_detail_id (the print line a loss ruined)
//   migration 017: inventory_items.print_pricing; order_items progress / print areas / add-ons;
//     order_profiles cancellation fee, stage, shop fault and the client's delay reason
const TABLE_EXTRA_COLUMNS = {
  payments: [['received_by', 'TEXT'], ['receipt_no', 'TEXT'], ['voids_payment_id', 'TEXT'], ['void_reason', 'TEXT'],
             ['payer_name', 'TEXT'], ['reference_no', 'TEXT'], ['bank_name', 'TEXT'], ['account_name', 'TEXT'], ['cheque_no', 'TEXT'],
             ['cheque_date', 'TEXT'], ['payment_notes', 'TEXT'], ['is_refund', 'INTEGER DEFAULT 0'], ['refund_reason', 'TEXT'],
             ['verified_by', 'TEXT'], ['verified_at', 'TEXT'], ['recorded_at', 'TEXT']],
  material_loss: [['cloud_stock_delta', 'INTEGER'], ['reason_code', 'TEXT'], ['loss_category', 'TEXT'], ['production_stage', 'TEXT'],
                  ['is_statistical_anomaly', 'INTEGER DEFAULT 0'], ['loss_batch_id', 'TEXT'], ['print_detail_id', 'TEXT']],
  inventory_items: [['deleted_at', 'TEXT'], ['deleted_by', 'TEXT'], ['purged_at', 'TEXT'],
                    ['unit', "TEXT NOT NULL DEFAULT 'pcs'"], ['supplier', 'TEXT'], ['selling_price', 'REAL NOT NULL DEFAULT 0'],
                    ['supplier_id', 'TEXT'], ['has_sizes', 'INTEGER DEFAULT 0'], ['requires_pressing', 'INTEGER DEFAULT 0'],
                    ['print_pricing', "TEXT NOT NULL DEFAULT 'included'"]],
  users: [['is_active', 'INTEGER NOT NULL DEFAULT 1'], ['tokens_valid_after', 'TEXT'], ['removed_at', 'TEXT'], ['removed_by', 'TEXT']],
  order_profiles: [['stock_reserved', 'INTEGER NOT NULL DEFAULT 0'], ['approved_by', 'TEXT'], ['approved_at', 'TEXT'],
                   ['tracking_no', 'TEXT'], ['last_edited_by', 'TEXT'], ['last_edited_role', 'TEXT'],
                   ['subtotal_amount', 'REAL NOT NULL DEFAULT 0'], ['discount_amount', 'REAL NOT NULL DEFAULT 0'],
                   ['discount_reason', 'TEXT'], ['cancellation_reason', 'TEXT'], ['archived_at', 'TEXT'], ['archived_by', 'TEXT'],
                   ['order_description', 'TEXT'], ['labor_amount', 'REAL DEFAULT 0'], ['incidental_amount', 'REAL DEFAULT 0'],
                   ['adjustment_amount', 'REAL DEFAULT 0'], ['adjustment_reason', 'TEXT'], ['branch_id', 'TEXT'],
                   ['cancellation_fee', 'REAL'], ['cancelled_stage', 'TEXT'], ['cancel_shop_fault', 'INTEGER NOT NULL DEFAULT 0'],
                   ['client_delay_reason', 'TEXT']],
  customers: [['archived_at', 'TEXT'], ['archived_by', 'TEXT'], ['customer_type', "TEXT DEFAULT 'Individual'"],
              ['contact_person', 'TEXT'], ['email', 'TEXT'], ['address', 'TEXT'], ['social_media', 'TEXT'], ['notes', 'TEXT'],
              ['contact_person_number', 'TEXT'], ['contact_person_email', 'TEXT'], ['contact_person_social', 'TEXT']],
  order_deliveries: [['plan_id', 'TEXT']],
  order_items: [['unit_cost', 'REAL'], ['qty_printed', 'INTEGER NOT NULL DEFAULT 0'], ['qty_pressed', 'INTEGER NOT NULL DEFAULT 0'],
                ['print_areas', 'TEXT'], ['added_after_approval', 'INTEGER NOT NULL DEFAULT 0']],
  order_consumables_log: [['unit_cost', 'REAL']]
};

const all = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const run = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));

// Adds any missing bookkeeping columns. Safe to run on every start-up.
const ensureLocalSyncColumns = async (db, tables, { log = console.log } = {}) => {
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
        log(`🛠️  Added local sync column ${table}.${column}`);
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

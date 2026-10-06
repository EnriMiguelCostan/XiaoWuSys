// ==========================================
// OFFLINE -> CLOUD SYNC SERVICE
//  C2: syncs every offline-capable table, parents before children
//  H3: single-flight guard, and rows are only marked synced if last_modified is unchanged
//  C3: pending_update rows push ONLY their changed fields, and only if the Neon row still
//      has the last_modified this device saw (optimistic lock). Otherwise -> conflict.
//  H4/H5 support: refreshes parent tables from Neon so offline child writes pass SQLite FKs
// ==========================================
const { isConnectionError } = require('../utils/dbErrors');
const { PG_VERSION_FORMAT } = require('../utils/localSync');

// Order matters: children can only be inserted in Neon after their parent exists.
//   inventory_items, customers -> order_profiles -> order_items, payments, material_loss
const SYNC_TABLES = [
  {
    table: 'inventory_items',
    id: 'inventory_id',
    columns: ['inventory_id', 'item_name', 'item_category', 'quantity_available', 'quantity_reserved', 'minimum_threshold', 'unit_cost'],
    // M9: keep the locally reduced stock while an offline loss for this item is still unsynced
    refreshGuard: ` AND NOT EXISTS (SELECT 1 FROM material_loss ml
                      WHERE ml.inventory_id = excluded.inventory_id
                        AND ml.sync_status = 'pending_insert' AND ml.cloud_stock_delta > 0)`
  },
  {
    table: 'customers',
    id: 'customer_id',
    columns: ['customer_id', 'full_name', 'contact_number', 'platform_source']
  },
  {
    table: 'order_profiles',
    id: 'order_id',
    columns: ['order_id', 'customer_id', 'date_created', 'production_deadline', 'production_status', 'design_drive_link', 'total_quote_amount']
  },
  {
    table: 'order_items',
    id: 'line_item_id',
    columns: ['line_item_id', 'order_id', 'inventory_id', 'product_type', 'quantity', 'size', 'custom_name', 'custom_number', 'price']
  },
  {
    table: 'payments',
    id: 'payment_id',
    columns: ['payment_id', 'order_id', 'amount', 'payment_date', 'payment_type']
  },
  {
    table: 'material_loss',
    id: 'loss_id',
    columns: ['loss_id', 'order_id', 'inventory_id', 'quantity_lost', 'loss_reason', 'date_recorded', 'financial_cost']
  }
];

// Tables copied Neon -> SQLite (parents first) so offline writes satisfy foreign keys
// M10: children are refreshed too, so offline reads show the same items/payments/losses.
const REFRESH_TABLES = ['customers', 'inventory_items', 'order_profiles', 'order_items', 'payments', 'material_loss'];

const specFor = (table) => SYNC_TABLES.find((t) => t.table === table);
const updatableColumns = (spec) => spec.columns.filter((c) => c !== spec.id);
const versionExpr = `to_char(last_modified, '${PG_VERSION_FORMAT}')`;

// ---------- SQLite promise helpers ----------
const sqliteAll = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

const sqliteRun = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { return err ? reject(err) : resolve(this.changes); })
  );

// ---------- Local status transitions ----------

// H3: only mark synced if nobody edited the row while it was being pushed.
// Every local write bumps last_modified (ms precision), so an equal value proves no concurrent edit.
const markAsSynced = (localDb, spec, row, cloudVersion) =>
  sqliteRun(
    localDb,
    `UPDATE ${spec.table}
        SET sync_status = 'synced', dirty_fields = NULL, sync_error = NULL, cloud_last_modified = ?
      WHERE ${spec.id} = ? AND last_modified IS ?`,
    [cloudVersion, row[spec.id], row.last_modified]
  );

// The row changed mid-push. Keep it pending, but record the cloud version we just produced
// so the next cycle's optimistic check compares against OUR write, not a stale baseline.
// A pending_insert that now exists in Neon becomes a pending_update of its dirty fields.
const keepPendingAfterPush = (localDb, spec, row, cloudVersion) =>
  sqliteRun(
    localDb,
    `UPDATE ${spec.table}
        SET cloud_last_modified = ?,
            sync_status = CASE WHEN sync_status = 'pending_insert' THEN 'pending_update' ELSE sync_status END
      WHERE ${spec.id} = ?`,
    [cloudVersion, row[spec.id]]
  );

const markAsConflict = (localDb, spec, row, reason) =>
  sqliteRun(
    localDb,
    `UPDATE ${spec.table} SET sync_conflict = ? WHERE ${spec.id} = ? AND last_modified IS ?`,
    [reason, row[spec.id], row.last_modified]
  );

// JSON list of fields edited offline; falls back to every updatable column
const dirtyFieldsFor = (spec, row) => {
  const allowed = updatableColumns(spec);
  try {
    const parsed = JSON.parse(row.dirty_fields || '[]');
    const fields = allowed.filter((c) => parsed.includes(c));
    return fields.length > 0 ? fields : allowed;
  } catch {
    return allowed;
  }
};

// ---------- Push one row to Neon ----------

// M9: an offline material loss carries the stock it removed (cloud_stock_delta). The loss
// insert and the Neon stock reduction run in ONE transaction, and the reduction is only
// applied if the loss was actually inserted, so re-running sync never double-counts.
const pushMaterialLossInsert = async (pgPool, spec, row) => {
  const cols = spec.columns.filter((c) => row[c] !== undefined && row[c] !== null);
  const client = await pgPool.connect();
  let broken;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO ${spec.table} (${cols.join(', ')}, last_modified)
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, NOW())
       ON CONFLICT (${spec.id}) DO NOTHING
       RETURNING ${spec.id}`,
      cols.map((c) => row[c])
    );
    if (inserted.rowCount === 1) {
      const stock = await client.query(
        `UPDATE inventory_items
            SET quantity_available = GREATEST(quantity_available - $1::int, 0), last_modified = NOW()
          WHERE inventory_id = $2
          RETURNING quantity_available`,
        [Number(row.cloud_stock_delta), row.inventory_id]
      );
      if (stock.rowCount === 1 && stock.rows[0].quantity_available === 0) {
        console.warn(`⚠️ Offline loss ${row[spec.id]} took ${row.inventory_id} to 0 stock in the cloud; recount recommended.`);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    broken = err;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release(broken && isConnectionError(broken) ? broken : undefined);
  }
  const { rows } = await pgPool.query(
    `SELECT ${versionExpr} AS version FROM ${spec.table} WHERE ${spec.id} = $1`,
    [row[spec.id]]
  );
  return { outcome: 'synced', version: rows[0] ? rows[0].version : null };
};

const pushInsert = async (pgPool, spec, row) => {
  if (spec.table === 'material_loss' && Number(row.cloud_stock_delta) > 0) {
    return pushMaterialLossInsert(pgPool, spec, row);
  }

  const cols = spec.columns.filter((c) => row[c] !== undefined && row[c] !== null);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  // DO NOTHING: if the row already exists (e.g. the reply to an online insert was lost),
  // keep the cloud copy instead of overwriting it.
  await pgPool.query(
    `INSERT INTO ${spec.table} (${cols.join(', ')}, last_modified)
     VALUES (${placeholders}, NOW())
     ON CONFLICT (${spec.id}) DO NOTHING`,
    cols.map((c) => row[c])
  );

  const { rows } = await pgPool.query(
    `SELECT ${versionExpr} AS version FROM ${spec.table} WHERE ${spec.id} = $1`,
    [row[spec.id]]
  );
  return { outcome: 'synced', version: rows[0] ? rows[0].version : null };
};

const pushUpdate = async (pgPool, spec, row) => {
  const fields = dirtyFieldsFor(spec, row);
  const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const idParam = fields.length + 1;
  const baseParam = fields.length + 2;

  // C3: the update only lands if the Neon row still carries the version seen before editing.
  const result = await pgPool.query(
    `UPDATE ${spec.table}
        SET ${setClause}, last_modified = NOW()
      WHERE ${spec.id} = $${idParam}
        AND ($${baseParam}::text IS NULL OR ${versionExpr} = $${baseParam}::text)
      RETURNING ${versionExpr} AS version`,
    [...fields.map((f) => row[f]), row[spec.id], row.cloud_last_modified || null]
  );

  if (result.rowCount === 1) return { outcome: 'synced', version: result.rows[0].version };

  const current = await pgPool.query(
    `SELECT ${versionExpr} AS version FROM ${spec.table} WHERE ${spec.id} = $1`,
    [row[spec.id]]
  );
  if (current.rowCount === 0) {
    // Never reached the cloud (e.g. created offline, then edited): insert it instead
    return pushInsert(pgPool, spec, row);
  }
  return {
    outcome: 'conflict',
    reason: `Cloud record was modified by another user (cloud version ${current.rows[0].version}, ` +
            `local baseline ${row.cloud_last_modified || 'none'}). Fields not pushed: ${fields.join(', ')}.`
  };
};

// ---------- Neon -> SQLite refresh of parent tables ----------
const refreshTable = async (pgPool, localDb, spec) => {
  const cols = spec.columns;
  // ::text keeps timestamps/NUMERIC exact and avoids JS Date timezone shifts
  const { rows } = await pgPool.query(
    `SELECT ${cols.map((c) => `${c}::text AS ${c}`).join(', ')}, ${versionExpr} AS version FROM ${spec.table}`
  );

  const assignments = updatableColumns(spec).map((c) => `${c} = excluded.${c}`).join(', ');
  for (const row of rows) {
    // Rows with unsynced local edits or conflicts are never overwritten
    await sqliteRun(
      localDb,
      `INSERT INTO ${spec.table} (${cols.join(', ')}, cloud_last_modified, sync_status)
       VALUES (${cols.map(() => '?').join(', ')}, ?, 'synced')
       ON CONFLICT (${spec.id}) DO UPDATE
         SET ${assignments}, cloud_last_modified = excluded.cloud_last_modified
       WHERE ${spec.table}.sync_status = 'synced' AND ${spec.table}.sync_conflict IS NULL${spec.refreshGuard || ''}`,
      [...cols.map((c) => row[c]), row.version]
    );
  }
  return rows.length;
};

const refreshLocalCache = async (pgPool, localDb) => {
  for (const table of REFRESH_TABLES) {
    try {
      const count = await refreshTable(pgPool, localDb, specFor(table));
      console.log(`⬇️  Refreshed ${count} ${table} row(s) into local cache`);
    } catch (err) {
      if (isConnectionError(err)) throw err;
      console.error(`❌ Failed to refresh ${table} from cloud:`, err.message);
    }
  }
};

// ---------- Main sync run ----------
const runSync = async (pgPool, localDb) => {
  const summary = { synced: 0, conflicts: [], failed: 0, requeued: 0, aborted: false };
  console.log('🔄 Checking for offline data to sync...');

  for (const spec of SYNC_TABLES) {
    const pending = await sqliteAll(
      localDb,
      `SELECT * FROM ${spec.table}
        WHERE sync_status IN ('pending_insert', 'pending_update') AND sync_conflict IS NULL
        ORDER BY last_modified`
    );
    if (pending.length === 0) continue;
    console.log(`📦 ${spec.table}: ${pending.length} pending row(s)`);

    for (const row of pending) {
      try {
        const result = row.sync_status === 'pending_insert'
          ? await pushInsert(pgPool, spec, row)
          : await pushUpdate(pgPool, spec, row);

        if (result.outcome === 'conflict') {
          await markAsConflict(localDb, spec, row, result.reason);
          summary.conflicts.push({ table: spec.table, id: row[spec.id], reason: result.reason });
          console.warn(`⚠️ Conflict on ${spec.table} ${row[spec.id]}: ${result.reason}`);
          continue;
        }

        if ((await markAsSynced(localDb, spec, row, result.version)) === 1) {
          summary.synced++;
        } else {
          // H3: edited during the push; resend on the next cycle
          await keepPendingAfterPush(localDb, spec, row, result.version);
          summary.requeued++;
          console.log(`↻ ${spec.table} ${row[spec.id]} changed during sync; will resend next cycle`);
        }
      } catch (err) {
        if (isConnectionError(err)) {
          console.error('❌ Cloud unreachable mid-sync; stopping this cycle:', err.message);
          summary.aborted = true;
          return summary;
        }
        // Data error (constraint, bad value): keep pending, record why, continue with the rest
        summary.failed++;
        await sqliteRun(localDb, `UPDATE ${spec.table} SET sync_error = ? WHERE ${spec.id} = ?`, [err.message, row[spec.id]]);
        console.error(`❌ Failed to sync ${spec.table} ${row[spec.id]}:`, err.message);
      }
    }
  }

  await refreshLocalCache(pgPool, localDb);
  // Conflicts from earlier runs are skipped (not re-pushed) but still need a decision
  summary.unresolved_conflicts = (await listConflicts(localDb)).length;
  console.log(`✅ Sync finished: synced=${summary.synced} requeued=${summary.requeued} ` +
              `new_conflicts=${summary.conflicts.length} unresolved=${summary.unresolved_conflicts} failed=${summary.failed}`);
  return summary;
};

// ---------- Public API ----------
let syncInProgress = null; // H3: shared by the 5-minute timer and POST /api/sync

// Concurrent callers join the in-flight run instead of starting a second, overlapping one
const syncOfflineData = (pgPool, localDb) => {
  if (syncInProgress) {
    console.log('⏳ Sync already running; joining the in-progress run.');
    return syncInProgress.then((summary) => ({ ...summary, joined: true }));
  }
  syncInProgress = runSync(pgPool, localDb)
    .catch((err) => {
      if (isConnectionError(err)) {
        console.error('❌ Cloud unreachable during sync:', err.message);
        return { synced: 0, conflicts: [], failed: 0, requeued: 0, aborted: true };
      }
      console.error('❌ Critical Sync Error:', err.message);
      throw err;
    })
    .finally(() => {
      syncInProgress = null;
    });
  return syncInProgress;
};

const isSyncRunning = () => syncInProgress !== null;

// Rows that need a human decision (C3)
const listConflicts = async (localDb) => {
  const result = [];
  for (const spec of SYNC_TABLES) {
    const rows = await sqliteAll(
      localDb,
      `SELECT ${spec.id} AS id, sync_conflict AS reason, dirty_fields, last_modified
         FROM ${spec.table} WHERE sync_conflict IS NOT NULL`
    );
    rows.forEach((r) => result.push({ table: spec.table, ...r }));
  }
  return result;
};

module.exports = { syncOfflineData, isSyncRunning, listConflicts, SYNC_TABLES };

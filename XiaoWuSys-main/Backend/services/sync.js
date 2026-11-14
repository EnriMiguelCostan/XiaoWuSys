// ==========================================
// OFFLINE -> CLOUD SYNC SERVICE
//  C2: syncs every offline-capable table, parents before children
//  H3: single-flight guard, and rows are only marked synced if last_modified is unchanged
//  C3: pending_update rows push ONLY their changed fields, and only if the Neon row still
//      has the last_modified this device saw (optimistic lock). Otherwise -> conflict.
//  H4/H5 support: refreshes parent tables from Neon so offline child writes pass SQLite FKs
//  PB 5: an order edited offline AND online is settled by rank (Owner > Admin > Production >
//      Staff): the higher rank's change is kept and the other is recorded in audit_log. Equal
//      ranks (and every other table) stay flagged until an Owner / Admin picks a side with
//      POST /api/sync/conflicts/:table/:id/resolve.
// ==========================================
const { isConnectionError } = require('../utils/dbErrors');
const { PG_VERSION_FORMAT } = require('../utils/localSync');
const { labelOf } = require('../utils/validation');
const { outranks } = require('./domain/permissions');
const { CLOSED_STATUSES, QUOTE_FROZEN_STATUSES } = require('./domain/orderLifecycle');
const { withPgTransaction } = require('./records');
const { writeAudit } = require('./auditLog');

// Order matters: children can only be inserted in Neon after their parent exists.
//   inventory_items, customers -> order_profiles -> order_items, payments, material_loss
const SYNC_TABLES = [
  {
    // Accounts are only created/changed online; they are copied DOWN so users can log in
    // while the internet is down (password hashes only, never plain passwords).
    table: 'users',
    id: 'user_id',
    columns: ['user_id', 'username', 'password_hash', 'role', 'is_active', 'tokens_valid_after'],
    pullOnly: true
  },
  {
    // "Log out" on this computer while offline (migration 007): pushed insert-only, so the
    // other servers stop accepting that session too. Never refreshed back into the cache.
    table: 'revoked_sessions',
    id: 'session_id',
    columns: ['session_id', 'user_id', 'expires_at', 'revoked_at']
  },
  {
    table: 'inventory_items',
    id: 'inventory_id',
    columns: ['inventory_id', 'item_name', 'item_category', 'quantity_available', 'quantity_reserved', 'minimum_threshold', 'unit_cost',
              'unit', 'supplier', 'deleted_at', 'deleted_by', 'purged_at', 'selling_price'],
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
    // approved_by/approved_at are only ever set in Neon (approval is online-only). They are
    // listed so the refresh copies them into the cache; offline rows never have them set.
    // subtotal_amount / discount_amount / discount_reason (migration 011): the quote's breakdown
    columns: ['order_id', 'customer_id', 'date_created', 'production_deadline', 'production_status', 'design_drive_link', 'total_quote_amount',
              'stock_reserved', 'approved_by', 'approved_at', 'tracking_no', 'last_edited_by', 'last_edited_role',
              'subtotal_amount', 'discount_amount', 'discount_reason'],
    // Given by the cloud database (migration 007 trigger): never pushed, copied back after a push
    cloudOwned: ['tracking_no']
  },
  {
    table: 'order_items',
    id: 'line_item_id',
    columns: ['line_item_id', 'order_id', 'inventory_id', 'product_type', 'quantity', 'size', 'custom_name', 'custom_number', 'price']
  },
  {
    table: 'payments',
    id: 'payment_id',
    // D2: offline payments are pushed as they are, with no balance cap, so a payment is never
    // dropped. received_by is pushed; the receipt number is given by the cloud (migration 008).
    columns: ['payment_id', 'order_id', 'amount', 'payment_date', 'payment_type', 'received_by', 'receipt_no'],
    cloudOwned: ['receipt_no']
  },
  {
    table: 'material_loss',
    id: 'loss_id',
    columns: ['loss_id', 'order_id', 'inventory_id', 'quantity_lost', 'loss_reason', 'date_recorded', 'financial_cost']
  },
  {
    // Backend-only audit trail: pushed (insert-only) but never refreshed back into the cache
    table: 'inventory_audit_log',
    id: 'audit_id',
    columns: ['audit_id', 'inventory_id', 'action', 'item_name', 'details', 'performed_by', 'performed_role', 'created_at']
  },
  {
    // General audit trail (migration 009): pushed insert-only, never refreshed back
    table: 'audit_log',
    id: 'audit_id',
    columns: ['audit_id', 'entity', 'entity_id', 'action', 'details', 'performed_by', 'performed_role', 'created_at']
  },
  {
    // Status timeline (migration 010): status changes are online-only, so rows only travel down
    table: 'order_status_history',
    id: 'history_id',
    columns: ['history_id', 'order_id', 'from_status', 'to_status', 'changed_by', 'changed_role', 'changed_at'],
    pullOnly: true
  },
  {
    // PB 15 usage rates (migration 011): edited online only (PUT /api/inventory/:id/consumable-rates
    // needs the cloud), copied down for reading offline. Rows deleted in the cloud (a blank's
    // list replaced, or the item purged) are removed here too.
    table: 'consumable_rates',
    id: 'rate_id',
    columns: ['rate_id', 'product_inventory_id', 'consumable_inventory_id', 'quantity_per_piece', 'trigger_status'],
    pullOnly: true,
    prune: true
  },
  {
    // PB 15 deductions (migration 011): written with the status change, which needs the cloud,
    // so rows only travel down (the order detail shows them offline). Append-only in the cloud.
    table: 'order_consumables_log',
    id: 'log_id',
    columns: ['log_id', 'order_id', 'trigger_status', 'consumable_inventory_id', 'quantity_deducted', 'shortfall', 'deducted_at'],
    pullOnly: true
  }
];

// Tables copied Neon -> SQLite (parents first) so offline writes satisfy foreign keys
// M10: children are refreshed too, so offline reads show the same items/payments/losses.
const REFRESH_TABLES = ['users', 'customers', 'inventory_items', 'consumable_rates', 'order_profiles', 'order_items', 'payments',
  'material_loss', 'order_status_history', 'order_consumables_log'];

const specFor = (table) => SYNC_TABLES.find((t) => t.table === table);
const updatableColumns = (spec) => spec.columns.filter((c) => c !== spec.id);
const cloudOwnedColumns = (spec) => spec.cloudOwned || [];
// Columns this computer may send to Neon (cloud-owned values only ever travel down)
const pushColumns = (spec) => spec.columns.filter((c) => !cloudOwnedColumns(spec).includes(c));
const pushUpdatableColumns = (spec) => pushColumns(spec).filter((c) => c !== spec.id);
// Extra SELECT / RETURNING list for the cloud-owned values, e.g. ", tracking_no::text AS tracking_no"
const cloudOwnedSelect = (spec) => cloudOwnedColumns(spec).map((c) => `, ${c}::text AS ${c}`).join('');
const cloudValuesOf = (spec, row) => Object.fromEntries(cloudOwnedColumns(spec).map((c) => [c, row ? row[c] ?? null : null]));
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
// Cloud-owned values (e.g. the tracking number Neon just gave an offline order) are copied
// into the local row in the same statement, so the order shows its number straight away.
const cloudOwnedSet = (spec, cloud) => {
  const cols = cloudOwnedColumns(spec);
  return { sql: cols.map((c) => `, ${c} = ?`).join(''), params: cols.map((c) => (cloud ? cloud[c] ?? null : null)) };
};

const markAsSynced = (localDb, spec, row, cloudVersion, cloud = null) => {
  const extra = cloudOwnedSet(spec, cloud);
  return sqliteRun(
    localDb,
    `UPDATE ${spec.table}
        SET sync_status = 'synced', dirty_fields = NULL, sync_error = NULL, sync_conflict = NULL, cloud_last_modified = ?${extra.sql}
      WHERE ${spec.id} = ? AND last_modified IS ?`,
    [cloudVersion, ...extra.params, row[spec.id], row.last_modified]
  );
};

// The row changed mid-push. Keep it pending, but record the cloud version we just produced
// so the next cycle's optimistic check compares against OUR write, not a stale baseline.
// A pending_insert that now exists in Neon becomes a pending_update of its dirty fields.
const keepPendingAfterPush = (localDb, spec, row, cloudVersion, cloud = null) => {
  const extra = cloudOwnedSet(spec, cloud);
  return sqliteRun(
    localDb,
    `UPDATE ${spec.table}
        SET cloud_last_modified = ?${extra.sql}, sync_conflict = NULL,
            sync_status = CASE WHEN sync_status = 'pending_insert' THEN 'pending_update' ELSE sync_status END
      WHERE ${spec.id} = ?`,
    [cloudVersion, ...extra.params, row[spec.id]]
  );
};

const markAsConflict = (localDb, spec, row, reason) =>
  sqliteRun(
    localDb,
    `UPDATE ${spec.table} SET sync_conflict = ? WHERE ${spec.id} = ? AND last_modified IS ?`,
    [reason, row[spec.id], row.last_modified]
  );

// JSON list of fields edited offline; falls back to every updatable column
const dirtyFieldsFor = (spec, row) => {
  const allowed = pushUpdatableColumns(spec);
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

  const cols = pushColumns(spec).filter((c) => row[c] !== undefined && row[c] !== null);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  // Tables with cloud-owned values skip the INSERT when the row is already in Neon: a BEFORE
  // INSERT trigger (the tracking-number counter) runs even for a row that ON CONFLICT then
  // drops, so a re-sent order would use up a number. Sync is single-flight per server and
  // offline ids are unique per computer, so check-then-insert cannot race with itself.
  const alreadyThere = cloudOwnedColumns(spec).length > 0
    && (await pgPool.query(`SELECT 1 FROM ${spec.table} WHERE ${spec.id} = $1`, [row[spec.id]])).rowCount > 0;

  // DO NOTHING: if the row already exists (e.g. the reply to an online insert was lost),
  // keep the cloud copy instead of overwriting it.
  if (!alreadyThere) {
    await pgPool.query(
      `INSERT INTO ${spec.table} (${cols.join(', ')}, last_modified)
       VALUES (${placeholders}, NOW())
       ON CONFLICT (${spec.id}) DO NOTHING`,
      cols.map((c) => row[c])
    );
  }

  const { rows } = await pgPool.query(
    `SELECT ${versionExpr} AS version${cloudOwnedSelect(spec)} FROM ${spec.table} WHERE ${spec.id} = $1`,
    [row[spec.id]]
  );
  return { outcome: 'synced', version: rows[0] ? rows[0].version : null, cloud: cloudValuesOf(spec, rows[0]) };
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
      RETURNING ${versionExpr} AS version${cloudOwnedSelect(spec)}`,
    [...fields.map((f) => row[f]), row[spec.id], row.cloud_last_modified || null]
  );

  if (result.rowCount === 1) return { outcome: 'synced', version: result.rows[0].version, cloud: cloudValuesOf(spec, result.rows[0]) };

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

// ---------- PB 5: settling a conflict (by rank during sync, or by hand) ----------

// Who edited the row: travels with the change, but is not itself "a change" to argue about
const EDITOR_COLUMNS = ['last_edited_by', 'last_edited_role'];
// Absolute stock counts must never be forced over newer cloud counts (stock would go wrong
// for every branch). Such a conflict can only be settled by keeping the cloud version.
const NEVER_FORCED = { inventory_items: ['quantity_available', 'quantity_reserved'] };

// The fields the offline edit really changed (the editor columns left out)
const changedFieldsOf = (spec, row) => dirtyFieldsFor(spec, row).filter((f) => !EDITOR_COLUMNS.includes(f));
const pick = (source, fields) => Object.fromEntries(fields.map((f) => [f, source[f] === undefined ? null : source[f]]));
const sameMoney = (a, b) => Math.round(Number(a || 0) * 100) === Math.round(Number(b || 0) * 100);
const QUOTE_COLUMNS = ['total_quote_amount', 'subtotal_amount', 'discount_amount', 'discount_reason'];

// The cloud row as it is now: its version, the contested fields and (orders) what the rank
// and lifecycle rules need. null when the record is no longer in the cloud.
const readCloudRow = async (pgPool, spec, id, fields) => {
  const extra = spec.table === 'order_profiles' ? ['production_status', 'tracking_no', ...EDITOR_COLUMNS] : [];
  const cols = [...new Set([...fields, ...extra])];
  const { rows } = await pgPool.query(
    `SELECT ${versionExpr} AS version${cols.map((c) => `, ${c}::text AS ${c}`).join('')} FROM ${spec.table} WHERE ${spec.id} = $1`,
    [id]
  );
  return rows[0] || null;
};

// Why this computer's version may not replace the cloud's, in plain words (null = it may).
// The lifecycle rules of the online routes still hold: a closed order is not edited, and the
// quote stays frozen once the order is approved.
const keepLocalBlockedReason = (spec, row, cloud, fields) => {
  const stock = (NEVER_FORCED[spec.table] || []).filter((f) => fields.includes(f));
  if (stock.length > 0) {
    return 'Stock counts changed in both places, so this computer\u2019s count cannot replace the cloud\u2019s. '
      + 'Keep the cloud version, then correct the stock with Add or Subtract stock.';
  }
  if (spec.table === 'order_profiles' && cloud) {
    if (CLOSED_STATUSES.includes(cloud.production_status)) {
      return `This order is already ${cloud.production_status}, so it can no longer be changed.`;
    }
    // PB 11 / PB 12 (migration 011): the breakdown travels with the quote and freezes with it
    const quoteFields = QUOTE_COLUMNS.filter((f) => fields.includes(f));
    const quoteDiffers = quoteFields.some((f) => (f === 'discount_reason'
      ? (row[f] || null) !== (cloud[f] || null)
      : !sameMoney(row[f], cloud[f])));
    if (quoteFields.length > 0 && QUOTE_FROZEN_STATUSES.includes(cloud.production_status) && quoteDiffers) {
      return 'The quote cannot be changed after the job order was approved, because the downpayment was based on it.';
    }
  }
  return null;
};

// Writes this computer's fields over the cloud row, with its audit row, in ONE transaction.
// Only lands if the cloud row is still the one that was compared (cloud.version).
// -> the new cloud values ({ version, ...cloud-owned }), or null if the row changed again
const applyLocalOverCloud = (pgPool, spec, row, cloud, fields, { action, actor, editor, reason = null }) =>
  withPgTransaction(pgPool, async (client) => {
    const values = pick(row, fields);
    if (spec.table === 'order_profiles') {
      values.last_edited_by = editor && editor.user_id ? editor.user_id : null;
      values.last_edited_role = editor && editor.role ? editor.role : null;
    }
    const cols = Object.keys(values);
    const updated = await client.query(
      `UPDATE ${spec.table}
          SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, last_modified = NOW()
        WHERE ${spec.id} = $${cols.length + 1} AND ${versionExpr} = $${cols.length + 2}::text
        RETURNING ${versionExpr} AS version${cloudOwnedSelect(spec)}`,
      [...cols.map((c) => values[c]), row[spec.id], cloud.version]
    );
    if (updated.rowCount !== 1) return null;
    await writeAudit(client, {
      entity: spec.table,
      entity_id: row[spec.id],
      action,
      actor,
      details: {
        fields, reason,
        before: pick(cloud, fields), after: pick(row, fields),
        replaced_editor: spec.table === 'order_profiles' ? pick(cloud, EDITOR_COLUMNS) : undefined
      }
    });
    return updated.rows[0];
  });

// Drops this computer's edit and takes the cloud row. The discarded values are written to
// audit_log first, so they are never lost without a trace.
// -> true when the local row now carries the cloud version
const acceptCloudOverLocal = async (pgPool, localDb, spec, row, cloud, fields, { action, actor, reason = null }) => {
  await writeAudit(pgPool, {
    entity: spec.table,
    entity_id: row[spec.id],
    action,
    actor,
    details: {
      fields, reason,
      discarded: pick(row, fields), kept: pick(cloud, fields),
      discarded_editor: spec.table === 'order_profiles' ? pick(row, EDITOR_COLUMNS) : undefined
    }
  });
  const cleared = await sqliteRun(
    localDb,
    `UPDATE ${spec.table}
        SET sync_status = 'synced', dirty_fields = NULL, sync_error = NULL, sync_conflict = NULL, cloud_last_modified = NULL
      WHERE ${spec.id} = ? AND last_modified IS ?`,
    [row[spec.id], row.last_modified]
  );
  if (cleared !== 1) return false; // edited again meanwhile: the next sync looks at it afresh
  await refreshTable(pgPool, localDb, spec, [row[spec.id]]);
  return true;
};

// An order edited offline whose cloud copy changed too: the higher rank's change is kept.
//   offline editor outranks the cloud's last editor -> the offline fields are applied
//   the cloud's last editor outranks the offline one -> the cloud row is kept
//   equal ranks (or nobody recorded)                 -> null: stays flagged for a person
// -> { table, id, winner: 'local' | 'cloud', tracking_no, notify_user, by_role, version? } or null
const settleOrderConflictByRank = async (pgPool, localDb, spec, row) => {
  const fields = changedFieldsOf(spec, row);
  const cloud = await readCloudRow(pgPool, spec, row[spec.id], fields);
  if (!cloud) return null;
  const local = { user_id: row.last_edited_by || null, role: row.last_edited_role || null };
  const base = { table: spec.table, id: row[spec.id], tracking_no: cloud.tracking_no || null };

  if (outranks(local.role, cloud.last_edited_role)) {
    const blocked = keepLocalBlockedReason(spec, row, cloud, fields);
    if (!blocked) {
      const applied = await applyLocalOverCloud(pgPool, spec, row, cloud, fields, {
        action: 'offline_conflict_local_applied', actor: local, editor: local,
        reason: `Offline change by a ${local.role} replaced a change by ${cloud.last_edited_role || 'an unknown account'}.`
      });
      if (!applied) return null; // the cloud row changed again mid-way: flag it, decide next time
      return { ...base, winner: 'local', notify_user: cloud.last_edited_by || null, by_role: local.role,
               version: applied.version, cloud: cloudValuesOf(spec, applied) };
    }
    // Higher rank, but the order moved on (closed / quote frozen): the offline change cannot apply
    const kept = await acceptCloudOverLocal(pgPool, localDb, spec, row, cloud, fields, {
      action: 'offline_conflict_local_discarded', actor: local, reason: blocked
    });
    return kept ? { ...base, winner: 'cloud', notify_user: local.user_id, by_role: cloud.last_edited_role || null } : null;
  }
  if (outranks(cloud.last_edited_role, local.role)) {
    const kept = await acceptCloudOverLocal(pgPool, localDb, spec, row, cloud, fields, {
      action: 'offline_conflict_local_discarded', actor: local,
      reason: `A change by a ${cloud.last_edited_role} in the cloud outranks this offline change.`
    });
    return kept ? { ...base, winner: 'cloud', notify_user: local.user_id, by_role: cloud.last_edited_role } : null;
  }
  return null;
};

// ---------- Neon -> SQLite refresh of parent tables ----------
// ids: optional list to refresh only those rows (used by the real-time NOTIFY handler)
const refreshTable = async (pgPool, localDb, spec, ids = null) => {
  const cols = spec.columns;
  // ::text keeps timestamps/NUMERIC exact and avoids JS Date timezone shifts
  const { rows } = await pgPool.query(
    `SELECT ${cols.map((c) => `${c}::text AS ${c}`).join(', ')}, ${versionExpr} AS version FROM ${spec.table}` +
      (ids ? ` WHERE ${spec.id} = ANY($1::text[])` : ''),
    ids ? [ids] : []
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
       WHERE ${spec.table}.sync_status = 'synced' AND ${spec.table}.sync_conflict IS NULL
         AND ${spec.table}.cloud_last_modified IS NOT excluded.cloud_last_modified${spec.refreshGuard || ''}`,
      [...cols.map((c) => row[c]), row.version]
    );
  }
  return rows.length;
};

// Same as above, but returns how many local rows actually changed (new or newer version)
const refreshTableCounting = async (pgPool, localDb, spec) => {
  const before = await sqliteAll(localDb, `SELECT total_changes() AS n`);
  const rows = await refreshTable(pgPool, localDb, spec);
  const after = await sqliteAll(localDb, `SELECT total_changes() AS n`);
  return { rows, changed: after[0].n - before[0].n };
};

// Items permanently deleted in Neon (by any branch) are removed from this cache too, unless
// they still have unsynced local edits or local rows that reference them.
const pruneDeletedInventory = async (pgPool, localDb) => {
  const { rows } = await pgPool.query('SELECT inventory_id FROM inventory_items');
  return sqliteRun(
    localDb,
    `DELETE FROM inventory_items
      WHERE sync_status = 'synced' AND sync_conflict IS NULL
        AND inventory_id NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.inventory_id = inventory_items.inventory_id)
        AND NOT EXISTS (SELECT 1 FROM material_loss ml WHERE ml.inventory_id = inventory_items.inventory_id)`,
    [JSON.stringify(rows.map((r) => r.inventory_id))]
  );
};

// Pull-only tables whose rows can be deleted in the cloud (spec.prune): local copies of rows
// that are gone are removed, so this computer never applies a usage rate that no longer exists.
const prunePulledTable = async (pgPool, localDb, spec) => {
  const { rows } = await pgPool.query(`SELECT ${spec.id} AS id FROM ${spec.table}`);
  return sqliteRun(
    localDb,
    `DELETE FROM ${spec.table} WHERE sync_status = 'synced' AND ${spec.id} NOT IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(rows.map((r) => r.id))]
  );
};

const refreshLocalCache = async (pgPool, localDb, summary) => {
  for (const table of REFRESH_TABLES) {
    try {
      const spec = specFor(table);
      const { rows: count, changed } = await refreshTableCounting(pgPool, localDb, spec);
      if (spec.prune) await prunePulledTable(pgPool, localDb, spec);
      if (table === 'inventory_items') {
        const pruned = await pruneDeletedInventory(pgPool, localDb);
        if (changed > 0 || pruned > 0) summary.inventory_changed = true;
      }
      console.log(`⬇️  Refreshed ${count} ${table} row(s) into local cache (${changed} changed)`);
    } catch (err) {
      if (isConnectionError(err)) throw err;
      console.error(`❌ Failed to refresh ${table} from cloud:`, err.message);
    }
  }
};

// ---------- Main sync run ----------
const runSync = async (pgPool, localDb) => {
  // resolved: order conflicts settled by rank in this run (PB 5), for the "your change was replaced" notice
  const summary = { synced: 0, conflicts: [], resolved: [], failed: 0, requeued: 0, aborted: false, inventory_changed: false };
  console.log('🔄 Checking for offline data to sync...');

  for (const spec of SYNC_TABLES) {
    if (spec.pullOnly) continue;
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
        let result = row.sync_status === 'pending_insert'
          ? await pushInsert(pgPool, spec, row)
          : await pushUpdate(pgPool, spec, row);

        // PB 5: an order changed in both places is settled by rank where the ranks differ
        if (result.outcome === 'conflict' && spec.table === 'order_profiles') {
          const settled = await settleOrderConflictByRank(pgPool, localDb, spec, row);
          if (settled) {
            const { version, cloud, ...entry } = settled;
            summary.resolved.push(entry);
            console.log(`⚖️  Conflict on order ${row[spec.id]} settled by rank: the ${settled.winner} change was kept`);
            if (settled.winner === 'cloud') continue;
            result = { outcome: 'synced', version, cloud };
          }
        }

        if (result.outcome === 'conflict') {
          await markAsConflict(localDb, spec, row, result.reason);
          summary.conflicts.push({ table: spec.table, id: row[spec.id], reason: result.reason });
          console.warn(`⚠️ Conflict on ${spec.table} ${row[spec.id]}: ${result.reason}`);
          continue;
        }

        if (spec.table === 'inventory_items' || spec.table === 'material_loss') summary.inventory_changed = true;
        if ((await markAsSynced(localDb, spec, row, result.version, result.cloud)) === 1) {
          summary.synced++;
        } else {
          // H3: edited during the push; resend on the next cycle
          await keepPendingAfterPush(localDb, spec, row, result.version, result.cloud);
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

  await refreshLocalCache(pgPool, localDb, summary);
  // Conflicts from earlier runs are skipped (not re-pushed) but still need a decision
  summary.unresolved_conflicts = (await listConflicts(localDb)).length;
  console.log(`✅ Sync finished: synced=${summary.synced} requeued=${summary.requeued} ` +
              `new_conflicts=${summary.conflicts.length} unresolved=${summary.unresolved_conflicts} failed=${summary.failed}`);
  return summary;
};

// ---------- Public API ----------
let syncInProgress = null; // H3: shared by the 5-minute timer and POST /api/sync
// PB 4: outcome of the latest run, for GET /api/sync/status.
//   at      when the last run that reached the cloud finished (an aborted run is not a sync)
//   result  'ok' | 'conflicts' | 'aborted' for the latest run of any kind
const lastSync = { at: null, result: null };

const resultOf = (summary) => {
  if (summary.aborted) return 'aborted';
  return summary.conflicts.length > 0 || summary.unresolved_conflicts > 0 ? 'conflicts' : 'ok';
};

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
        return { synced: 0, conflicts: [], resolved: [], failed: 0, requeued: 0, aborted: true };
      }
      console.error('❌ Critical Sync Error:', err.message);
      throw err;
    })
    .then((summary) => {
      lastSync.result = resultOf(summary);
      if (!summary.aborted) lastSync.at = new Date().toISOString();
      return summary;
    })
    .finally(() => {
      syncInProgress = null;
    });
  return syncInProgress;
};

const getLastSync = () => ({ ...lastSync });

// Rows saved on this computer that still have to reach the cloud, per table (only tables
// with at least one). Rows held back by a conflict are counted in "conflicts" instead.
const countPending = async (localDb) => {
  const pending = {};
  for (const spec of SYNC_TABLES) {
    if (spec.pullOnly) continue;
    const [row] = await sqliteAll(
      localDb,
      `SELECT COUNT(*) AS n FROM ${spec.table}
        WHERE sync_status IN ('pending_insert', 'pending_update') AND sync_conflict IS NULL`
    );
    const n = Number(row ? row.n : 0);
    if (n > 0) pending[spec.table] = n;
  }
  return pending;
};

// Body of GET /api/sync/status and of the "sync_status" socket event (same shape).
// cloudHealth: services/cloudHealth.js (or a stub with state() / since()).
const buildSyncStatus = async ({ localDb, cloudHealth, conflicts = listConflicts }) => {
  const pending = await countPending(localDb);
  const since = cloudHealth && typeof cloudHealth.since === 'function' ? cloudHealth.since() : null;
  return {
    cloud: cloudHealth ? cloudHealth.state() : 'unknown',
    cloud_since: since ? new Date(since).toISOString() : null,
    last_sync_at: lastSync.at,
    last_sync_result: lastSync.result,
    syncing: syncInProgress !== null,
    pending,
    pending_total: Object.values(pending).reduce((a, b) => a + b, 0),
    conflicts: (await conflicts(localDb)).length
  };
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

// ---------- PB 5: conflicts as shown to (and settled by) an Owner / Admin ----------

// What a flagged record is called on screen: never a raw id
const CONFLICT_TITLES = {
  order_profiles: ['tracking_no', (v) => (v ? `Order ${v}` : 'An order saved on this computer')],
  inventory_items: ['item_name', (v) => (v ? `Catalog item \u201c${v}\u201d` : 'A catalog item')],
  customers: ['full_name', (v) => (v ? `Customer \u201c${v}\u201d` : 'A customer')],
  order_items: [null, () => 'A line of an order'],
  payments: [null, () => 'A payment'],
  material_loss: [null, () => 'A recorded loss']
};

// listConflicts() plus what the Conflicts screen needs to show and offer, in plain words:
//   title                     e.g. 'Order XM-2026-0123'
//   changed                   labels of what was changed on this computer, e.g. ['Production deadline']
//   keep_local_blocked_reason why "keep this computer's version" is not offered (null = it is)
const describeConflicts = async (localDb, list = listConflicts) => {
  const out = [];
  for (const conflict of await list(localDb)) {
    const spec = specFor(conflict.table);
    const [titleColumn, titleOf] = CONFLICT_TITLES[conflict.table] || [null, () => 'A saved change'];
    let titleValue = null;
    if (spec && titleColumn) {
      const [row] = await sqliteAll(localDb, `SELECT ${titleColumn} AS v FROM ${spec.table} WHERE ${spec.id} = ?`, [conflict.id]);
      titleValue = row ? row.v : null;
    }
    const fields = spec ? changedFieldsOf(spec, conflict) : [];
    out.push({
      table: conflict.table,
      id: conflict.id,
      title: titleOf(titleValue),
      changed: conflict.dirty_fields ? fields.map(labelOf) : [],
      keep_local_blocked_reason: spec ? keepLocalBlockedReason(spec, {}, null, conflict.dirty_fields ? fields : []) : null,
      last_modified: conflict.last_modified
    });
  }
  return out;
};

// Settles one flagged conflict by hand (Owner / Admin; the route checks the role).
//   keep 'cloud': this computer's change is dropped (recorded in audit_log) and the cloud row copied in
//   keep 'local': this computer's change replaces the cloud's (before / after in audit_log)
// Needs the cloud. -> { status, body } ready to send
const resolveConflict = async (pgPool, localDb, { table, id, keep, actor }) => {
  const spec = specFor(table);
  const notFound = {
    status: 404,
    body: { error: 'CONFLICT_NOT_FOUND', message: 'This conflict is no longer waiting. It may already have been settled. Refresh the list.' }
  };
  if (!spec || spec.pullOnly) return notFound;
  const [row] = await sqliteAll(localDb, `SELECT * FROM ${spec.table} WHERE ${spec.id} = ? AND sync_conflict IS NOT NULL`, [id]);
  if (!row) return notFound;

  const fields = changedFieldsOf(spec, row);
  try {
    const cloud = await readCloudRow(pgPool, spec, id, fields);
    if (!cloud) {
      return {
        status: 409,
        body: { error: 'CLOUD_RECORD_MISSING', message: 'This record is no longer in the cloud, so there is nothing to compare with. Ask the Owner to check it.' }
      };
    }
    let version = null;
    if (keep === 'local') {
      const blocked = keepLocalBlockedReason(spec, row, cloud, fields);
      if (blocked) return { status: 409, body: { error: 'KEEP_LOCAL_NOT_ALLOWED', message: blocked } };
      const applied = await applyLocalOverCloud(pgPool, spec, row, cloud, fields, {
        action: 'conflict_resolved_keep_local', actor, editor: actor
      });
      if (!applied) {
        return {
          status: 409,
          body: { error: 'EDIT_CONFLICT', message: 'The cloud record changed again just now. Refresh the list and choose again.' }
        };
      }
      version = applied.version;
      if ((await markAsSynced(localDb, spec, row, applied.version, cloudValuesOf(spec, applied))) !== 1) {
        await keepPendingAfterPush(localDb, spec, row, applied.version, cloudValuesOf(spec, applied));
      }
    } else {
      const kept = await acceptCloudOverLocal(pgPool, localDb, spec, row, cloud, fields, {
        action: 'conflict_resolved_keep_cloud', actor
      });
      if (!kept) {
        return {
          status: 409,
          body: { error: 'EDIT_CONFLICT', message: 'This record was changed on this computer just now. Refresh the list and choose again.' }
        };
      }
      version = cloud.version;
    }
    console.log(`⚖️  Conflict on ${spec.table} ${id} settled by ${actor && actor.user_id}: kept ${keep}`);
    return {
      status: 200,
      body: {
        message: keep === 'local'
          ? 'Kept this computer\u2019s version. It is now saved in the cloud.'
          : 'Kept the cloud version. The change made on this computer was dropped.',
        table: spec.table,
        id,
        kept: keep,
        // For the live "order_updated" push (orders only)
        order: spec.table === 'order_profiles'
          ? { order_id: id, tracking_no: cloud.tracking_no || null, production_status: cloud.production_status || null, version }
          : null,
        conflicts_remaining: (await listConflicts(localDb)).length
      }
    };
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    return {
      status: 503,
      body: err.commitUnknown
        ? { error: 'COMMIT_UNKNOWN', message: 'The connection dropped while saving. Refresh the list to see whether the conflict was settled.' }
        : { error: 'CLOUD_UNREACHABLE', message: 'Settling a conflict needs the cloud connection. Try again when online.' }
    };
  }
};

// Real-time: copy just these cloud rows into the local cache, so offline mode starts from
// current numbers instead of the last 5-minute refresh. Same guards as the full refresh.
const refreshLocalRows = (pgPool, localDb, table, ids) =>
  refreshTable(pgPool, localDb, specFor(table), ids);

module.exports = {
  syncOfflineData, isSyncRunning, listConflicts, describeConflicts, resolveConflict, refreshLocalRows, countPending,
  buildSyncStatus, getLastSync, SYNC_TABLES
};

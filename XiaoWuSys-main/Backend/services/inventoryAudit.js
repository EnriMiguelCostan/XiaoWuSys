// ==========================================
// INVENTORY AUDIT TRAIL (track / trace, backend only)
// One row per catalog change, written in the SAME transaction as the change itself, so a
// change can never happen without its trace. The website never reads this table; inspect
// it with `npm run audit-log` or the Neon SQL Editor. In Neon the table is append-only.
//   actions: created | edited | stock_added | stock_subtracted | deleted | restored | purged
// details is JSON: the full item snapshot, or before/after values for edits.
// ==========================================
const crypto = require('crypto');
const { LOCAL_NOW } = require('../utils/localSync');
const { sqliteRun } = require('./records');

const SNAPSHOT_FIELDS = ['inventory_id', 'item_name', 'item_category', 'quantity_available', 'quantity_reserved',
  'minimum_threshold', 'unit_cost', 'unit', 'supplier', 'deleted_at', 'deleted_by', 'version'];

const snapshotOf = (item) =>
  Object.fromEntries(SNAPSHOT_FIELDS.filter((f) => item && item[f] !== undefined).map((f) => [f, item[f]]));

const auditValues = (actor, inventory_id, action, item_name, details) => [
  crypto.randomUUID(), inventory_id, action, item_name || null,
  details === undefined || details === null ? null : JSON.stringify(details),
  actor && actor.user_id ? String(actor.user_id) : null,
  actor && actor.role ? String(actor.role) : null
];

const auditCloud = (client, actor, inventory_id, action, item_name, details) =>
  client.query(
    `INSERT INTO inventory_audit_log (audit_id, inventory_id, action, item_name, details, performed_by, performed_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    auditValues(actor, inventory_id, action, item_name, details)
  );

// Offline: queued as pending_insert and pushed to Neon by the normal sync
const auditLocal = (tx, actor, inventory_id, action, item_name, details) =>
  sqliteRun(
    tx,
    `INSERT INTO inventory_audit_log (audit_id, inventory_id, action, item_name, details, performed_by, performed_role,
                                      created_at, sync_status, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${LOCAL_NOW}, 'pending_insert', ${LOCAL_NOW})`,
    auditValues(actor, inventory_id, action, item_name, details)
  );

// Many rows in one statement (used when purging a batch from the Recycle Bin)
const auditCloudBulk = (client, actor, action, entries) => {
  if (entries.length === 0) return Promise.resolve();
  const cols = [[], [], [], [], [], [], []];
  for (const { inventory_id, item_name, details } of entries) {
    auditValues(actor, inventory_id, action, item_name, details).forEach((v, i) => cols[i].push(v));
  }
  return client.query(
    `INSERT INTO inventory_audit_log (audit_id, inventory_id, action, item_name, details, performed_by, performed_role)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])`,
    cols
  );
};

module.exports = { snapshotOf, auditCloud, auditLocal, auditCloudBulk };

// ==========================================
// GENERAL AUDIT TRAIL (migration 009)
// One row per decision that replaced or discarded someone's work, written in the SAME
// transaction as the change wherever there is one. In the cloud the table is append-only.
//   actions today (PB 5):
//     conflict_override                 an account replaced a lower-ranked account's change online
//     offline_conflict_local_applied    an offline change won by rank when it synced
//     offline_conflict_local_discarded  an offline change lost by rank when it synced
//     conflict_resolved_keep_local      an Owner / Admin kept this computer's version by hand
//     conflict_resolved_keep_cloud      an Owner / Admin kept the cloud version by hand
// details is JSON (before / after values). inventory_audit_log stays separate.
// ==========================================
const crypto = require('crypto');

// db: a pg client inside a transaction, or the pool for a single statement
// actor: { user_id, role } (from the login token, or the offline editor recorded on the row)
const writeAudit = (db, { entity, entity_id, action, details = null, actor = null }) =>
  db.query(
    `INSERT INTO audit_log (audit_id, entity, entity_id, action, details, performed_by, performed_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      crypto.randomUUID(), entity, String(entity_id), action,
      details === null || details === undefined ? null : JSON.stringify(details),
      actor && actor.user_id ? String(actor.user_id) : null,
      actor && actor.role ? String(actor.role) : null
    ]
  );

module.exports = { writeAudit };

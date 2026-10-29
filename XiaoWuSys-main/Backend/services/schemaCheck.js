// ==========================================
// STARTUP SCHEMA CHECK
// Compares the Neon columns the backend reads/writes against information_schema and
// prints ONE clear message instead of a stream of "column ... does not exist" errors.
// Never blocks startup; offline (Neon unreachable) it is skipped.
// ==========================================
const { ENTITIES } = require('./records');
const { isConnectionError } = require('../utils/dbErrors');

// Columns the backend uses that are not part of an API record shape
const EXTRA_COLUMNS = [
  'inventory_items.purged_at',
  'users.is_active', 'users.tokens_valid_after',
  ...['audit_id', 'inventory_id', 'action', 'item_name', 'details', 'performed_by', 'performed_role', 'created_at', 'last_modified']
    .map((c) => `inventory_audit_log.${c}`),
  ...['session_id', 'user_id', 'expires_at', 'revoked_at', 'last_modified'].map((c) => `revoked_sessions.${c}`) // migration 007
];
const EXPECTED_TRIGGERS = ['trg_order_profiles_last_modified', 'trg_inventory_items_notify', 'trg_order_profiles_assign_tracking_no'];

const checkCloudSchema = async (pgPool) => {
  const expected = [
    ...Object.entries(ENTITIES).flatMap(([table, spec]) =>
      [...Object.keys(spec.fields), 'last_modified'].map((column) => `${table}.${column}`)),
    ...EXTRA_COLUMNS
  ];
  const tables = [...new Set(expected.map((c) => c.split('.')[0]))];
  try {
    const { rows } = await pgPool.query(
      `SELECT table_name || '.' || column_name AS col
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [tables]
    );
    const present = new Set(rows.map((r) => r.col));
    const missing = expected.filter((c) => !present.has(c));
    const triggers = await pgPool.query('SELECT tgname FROM pg_trigger WHERE tgname = ANY($1::text[])', [EXPECTED_TRIGGERS]);
    const missingTriggers = EXPECTED_TRIGGERS.filter((t) => !triggers.rows.some((r) => r.tgname === t));

    if (missing.length === 0 && missingTriggers.length === 0) {
      console.log('✅ Cloud schema matches the backend');
      return { ok: true, missing, missingTriggers };
    }
    console.error(
      '❌ CLOUD SCHEMA IS OUT OF DATE. Run "npm run migrate" in Backend/ (or paste the files in ' +
      'migrations/ into the Neon SQL Editor, in order).\n' +
      (missing.length ? `   Missing columns: ${missing.join(', ')}\n` : '') +
      (missingTriggers.length ? `   Missing triggers: ${missingTriggers.join(', ')}` : '')
    );
    return { ok: false, missing, missingTriggers };
  } catch (err) {
    if (!isConnectionError(err)) console.error('⚠️ Could not verify cloud schema:', err.message);
    return { ok: null, missing: [], missingTriggers: [] };
  }
};

module.exports = { checkCloudSchema };

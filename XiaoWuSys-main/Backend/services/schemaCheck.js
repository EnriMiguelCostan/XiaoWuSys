// ==========================================
// STARTUP SCHEMA CHECK
// Compares the Neon columns the backend reads/writes against information_schema and
// prints ONE clear message instead of a stream of "column ... does not exist" errors.
// Never blocks startup; offline (Neon unreachable) it is skipped.
// ==========================================
const { ENTITIES } = require('./records');
const { isConnectionError } = require('../utils/dbErrors');

const checkCloudSchema = async (pgPool) => {
  const expected = Object.entries(ENTITIES).flatMap(([table, spec]) =>
    [...Object.keys(spec.fields), 'last_modified'].map((column) => `${table}.${column}`));
  try {
    const { rows } = await pgPool.query(
      `SELECT table_name || '.' || column_name AS col
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [Object.keys(ENTITIES)]
    );
    const present = new Set(rows.map((r) => r.col));
    const missing = expected.filter((c) => !present.has(c));
    const triggers = await pgPool.query(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_inventory_items_notify', 'trg_order_profiles_last_modified')`
    );
    const missingTriggers = ['trg_order_profiles_last_modified', 'trg_inventory_items_notify']
      .filter((t) => !triggers.rows.some((r) => r.tgname === t));

    if (missing.length === 0 && missingTriggers.length === 0) {
      console.log('✅ Cloud schema matches the backend');
      return { ok: true, missing, missingTriggers };
    }
    console.error(
      '❌ CLOUD SCHEMA IS OUT OF DATE. Run "npm run migrate" in Backend/ (or paste ' +
      'migrations/002_align_legacy_neon_schema.sql and 003_inventory_change_notify.sql into the Neon SQL Editor).\n' +
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

// ==========================================
// VIEW THE INVENTORY AUDIT TRAIL (backend only, never shown on the website)
//
//   npm run audit-log                          last 50 changes
//   npm run audit-log -- --limit 200
//   npm run audit-log -- --action deleted      only deletions (created|edited|stock_added|
//                                              stock_subtracted|deleted|restored|purged)
//   npm run audit-log -- --item "Custom Shirt" one item (name or inventory_id)
//   npm run audit-log -- --details             also print the saved JSON snapshot
//
// Reads Neon; if it is unreachable, reads the local cache (entries not yet synced included).
// To recover a permanently deleted item, copy the values from its 'purged' snapshot.
// ==========================================
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3');
const { isConnectionError } = require('../utils/dbErrors');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const limit = Math.min(Math.max(parseInt(arg('limit') || '50', 10) || 50, 1), 1000);
const action = arg('action') || null;
const item = arg('item') || null;
const showDetails = process.argv.includes('--details');

const SQL = (p) => `
  SELECT created_at, action, item_name, inventory_id, performed_by, performed_role, details
    FROM inventory_audit_log
   WHERE (${p(1)} IS NULL OR action = ${p(1)})
     AND (${p(2)} IS NULL OR inventory_id = ${p(2)} OR LOWER(item_name) = LOWER(${p(2)}))
   ORDER BY created_at DESC
   LIMIT ${limit}`;

const fromCloud = async () => {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL is not set'), { code: 'ENOTFOUND' });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
  try {
    const { rows } = await pool.query(SQL((n) => `$${n}::text`), [action, item]);
    return rows.map((r) => ({ ...r, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at }));
  } finally {
    await pool.end();
  }
};

const fromLocal = () => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(path.resolve(__dirname, '..', 'local_cache.db'), sqlite3.OPEN_READWRITE, (err) => {
    if (err) return reject(err);
    db.all(SQL((n) => `?${n}`), [action, item], (qErr, rows) => {
      db.close();
      return qErr ? reject(qErr) : resolve(rows);
    });
  });
});

(async () => {
  let rows;
  let source = 'cloud';
  try {
    rows = await fromCloud();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    console.warn(`⚠️ Cloud unreachable (${err.message}); reading the local cache.`);
    source = 'local';
    rows = await fromLocal();
  }
  console.log(`Inventory audit trail (${source}), newest first: ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`);
  console.table(rows.map(({ details, ...r }) => r));
  if (showDetails) rows.forEach((r) => console.log(`\n${r.created_at} ${r.action} ${r.item_name}\n${r.details || '(no details)'}`));
})().catch((err) => {
  console.error('✗ Could not read the audit trail:', err.message, '\n  Has migration 004 been applied? (start the server or run npm run migrate)');
  process.exit(1);
});

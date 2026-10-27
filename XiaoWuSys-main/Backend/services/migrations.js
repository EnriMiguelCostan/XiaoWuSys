// ==========================================
// NEON MIGRATION RUNNER (shared by `npm run migrate` and server start-up)
// Applies every migrations/*.sql file not yet recorded in schema_migrations, in filename
// order, each in its own transaction. A transaction-level advisory lock means two servers
// starting at the same time never apply the same file twice (works on Neon's pooler too).
// Every migration file is idempotent, so re-running one that was pasted by hand is safe.
// ==========================================
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const MIGRATION_LOCK_KEY = 74_201_004;

const listMigrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

const ensureMigrationsTable = (client) => client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

const appliedSet = async (client) =>
  new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));

// -> { applied: [...files applied now], pending: [...] }
const applyPendingMigrations = async (pool, { log = console.log } = {}) => {
  const client = await pool.connect();
  const appliedNow = [];
  try {
    await ensureMigrationsTable(client);
    const already = await appliedSet(client);
    for (const file of listMigrationFiles().filter((f) => !already.has(f))) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
        // Another server may have applied it while we waited for the lock
        const done = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
        if (done.rowCount === 0) {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
          appliedNow.push(file);
        }
        await client.query('COMMIT');
        if (done.rowCount === 0) log(`✅ Applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw Object.assign(new Error(`${file} failed and was rolled back: ${err.message}`), { code: err.code });
      }
    }
    return { applied: appliedNow };
  } finally {
    client.release();
  }
};

const migrationStatus = async (pool) => {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedSet(client);
    return listMigrationFiles().map((file) => ({ file, applied: applied.has(file) }));
  } finally {
    client.release();
  }
};

module.exports = { applyPendingMigrations, migrationStatus };

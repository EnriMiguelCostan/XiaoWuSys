// ==========================================
// NEON MIGRATION RUNNER
// Applies every migrations/*.sql file that has not been applied yet, in filename order,
// each inside its own transaction. Applied files are recorded in schema_migrations.
//
//   npm run migrate            apply pending migrations
//   npm run migrate -- --list  show applied / pending without changing anything
//
// Run schema.sql first on a brand-new database, then this.
// ==========================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const listOnly = process.argv.includes('--list');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set (check your .env).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // same settings as server.js (Neon)
});

(async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
    const pending = files.filter((f) => !applied.has(f));

    if (listOnly) {
      files.forEach((f) => console.log(`${applied.has(f) ? '✅ applied' : '⏳ pending'}  ${f}`));
      return;
    }
    if (pending.length === 0) {
      console.log('✅ Database is up to date. No migrations to apply.');
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✅ Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`${file} failed and was rolled back: ${err.message}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error(`❌ Migration error: ${err.message}`);
  process.exit(1);
});

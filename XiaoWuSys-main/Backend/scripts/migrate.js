// ==========================================
// NEON MIGRATION RUNNER
//   npm run migrate            apply pending migrations
//   npm run migrate -- --list  show applied / pending without changing anything
// The server also applies pending migrations on start-up (set AUTO_MIGRATE=false to disable).
// Run schema.sql first on a brand-new database, then this.
// ==========================================
require('dotenv').config();
const { Pool } = require('pg');
const { applyPendingMigrations, migrationStatus } = require('../services/migrations');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set (check your .env).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // same settings as server.js (Neon)
});

(async () => {
  try {
    if (process.argv.includes('--list')) {
      (await migrationStatus(pool)).forEach(({ file, applied }) =>
        console.log(`${applied ? '✅ applied' : '⏳ pending'}  ${file}`));
      return;
    }
    const { applied } = await applyPendingMigrations(pool);
    if (applied.length === 0) console.log('✅ Database is up to date. No migrations to apply.');
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(`❌ Migration error: ${err.message}`);
  process.exit(1);
});

// ==========================================
// DELETE THE DEACTIVATED ACCOUNTS
// Deletes every account that is deactivated (Accounts tab: Deactivated / removed) and hands
// everything they did (orders, payments, deliveries, status changes, stock documents, expenses,
// the audit trail, ...) to the ACTIVE accounts: same role where possible, otherwise a manager.
// Meant for the demo / defense copy: on the shop's real database it rewrites who did what.
//
//   npm run purge:deactivated                              shows what would change, changes nothing
//   npm run purge:deactivated -- --confirm <database>      does it (<database> = the name it shows)
//
// Option: --keep-local (see below). Stop the server on every computer first. Afterwards this
// computer's offline copy (local_cache.db) is deleted so it cannot bring the old accounts back;
// the server rebuilds it from the cloud on start. On every OTHER computer, stop the server and
// delete its Backend/local_cache.db too before starting it again.
// ==========================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { describePurge, purgeDeactivated } = require('./accounts/purge');
const { migrationStatus } = require('../services/migrations');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set (Backend/.env).');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const database = (await pool.query('SELECT current_database() AS db')).rows[0].db;
    const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch { return '(unknown host)'; } })();
    const pending = (await migrationStatus(pool)).filter((m) => !m.applied).map((m) => m.file);
    if (pending.length) {
      console.error(`❌ These migrations are not applied yet: ${pending.join(', ')}. Run "npm run migrate" first.`);
      process.exit(1);
    }

    const d = await describePurge(pool);
    console.log(`\nDatabase "${database}" on ${host}`);
    console.log(`Active accounts (kept): ${d.active.map((u) => `${u.username} (${u.role})`).join(', ') || 'none'}`);
    if (d.inactive.length === 0) {
      console.log('✅ There are no deactivated accounts. Nothing to do.\n');
      return;
    }
    if (d.active.length === 0) {
      console.error('❌ There is no active account to hand the records to. Activate one first.');
      process.exit(1);
    }
    console.log('\nDeactivated accounts to delete, and who takes over their records:');
    for (const p of d.plan) {
      const names = d.active.filter((a) => p.candidates.includes(a.user_id)).map((a) => a.username).join(', ');
      console.log(`   ${p.username} (${p.from_role})  ->  ${p.role}: ${names}`);
    }
    console.log('\nRecords that name them:');
    if (d.references.length === 0) console.log('   none');
    for (const r of d.references) console.log(`   ${r.table}.${r.column}: ${r.rows} row(s)`);
    if (d.auditAbout) console.log(`Audit entries about these accounts (deleted with them): ${d.auditAbout}`);

    if (arg('--confirm') !== database) {
      console.log('\nNothing was changed. This cannot be undone: make a Neon branch (backup) first,');
      console.log(`stop the server on every computer, then run:\n\n   npm run purge:deactivated -- --confirm ${database}\n`);
      return;
    }

    console.log('\n⏳ Handing the records over and deleting the accounts (one transaction)…');
    const result = await purgeDeactivated(pool, { log: (line) => console.log(line) });
    console.log(`\n✅ Done: ${result.deleted} account(s) deleted, ${result.updated} record(s) handed to active accounts.`);

    if (!process.argv.includes('--keep-local')) {
      const local = path.resolve(__dirname, '..', process.env.LOCAL_DB_PATH || 'local_cache.db');
      for (const file of [local, `${local}-wal`, `${local}-shm`]) if (fs.existsSync(file)) fs.rmSync(file);
      console.log(`🧹 Deleted this computer's offline copy (${path.basename(local)}); the server rebuilds it from the cloud on start.`);
    }
    console.log('   On every other computer: stop the server, delete Backend/local_cache.db, then start it again.\n');
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(`❌ ${err.message}\n   If the change had started, it was rolled back: the database is as it was.`);
  process.exit(1);
});

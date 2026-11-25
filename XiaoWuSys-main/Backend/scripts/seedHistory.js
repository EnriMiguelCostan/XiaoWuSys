// ==========================================
// DEMO / DEFENSE DATABASE: 2020 TO TODAY
// Replaces EVERYTHING in the cloud database except the accounts (users) with a believable
// history of the shop since January 2020: suppliers, catalog, clients and branches, 20-40
// orders a month with payments, deliveries, stock in / out / counts, waste and expenses.
//
// FOR A DEMO COPY ONLY. Never run it on the shop's real database: the real orders, payments
// and the audit trail are deleted and cannot be brought back. In Neon, make a branch first and
// point DATABASE_URL (Backend/.env) at that branch.
//
//   npm run seed:history                              shows what would be deleted, changes nothing
//   npm run seed:history -- --confirm <database>      does it (<database> = the name it shows)
//
// Options:  --seed <number>   another (still repeatable) history      --keep-local   see below
// Stop the server on every computer first. Afterwards this computer's offline copy
// (local_cache.db) is deleted, so it cannot send old offline changes back; it is rebuilt from
// the cloud when the server starts. On every OTHER computer, stop the server and delete its
// local_cache.db too before starting it again.
// ==========================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { generateHistory } = require('./history/generate');
const { loadHistory, describeDatabase, loadUsers } = require('./history/load');
const { migrationStatus } = require('../services/migrations');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set (Backend/.env). Point it at the demo copy (a Neon branch), not the shop database.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const { rows } = await pool.query('SELECT current_database() AS db');
    const database = rows[0].db;
    const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch { return '(unknown host)'; } })();

    const pending = (await migrationStatus(pool)).filter((m) => !m.applied).map((m) => m.file);
    if (pending.length) {
      console.error(`❌ These migrations are not applied yet: ${pending.join(', ')}. Run "npm run migrate" first.`);
      process.exit(1);
    }
    const users = await loadUsers(pool);
    if (users.length === 0) {
      console.error('❌ There are no accounts. Create the Owner first (npm run create-admin), then run this again.');
      process.exit(1);
    }

    const before = await describeDatabase(pool);
    console.log(`\nDatabase "${database}" on ${host}`);
    console.log(`Kept: ${users.length} account(s) (${[...new Set(users.map((u) => u.role))].join(', ')}).`);
    console.log('Deleted and replaced:');
    for (const t of before.tables.filter((x) => !x.kept && x.rows > 0)) console.log(`   ${t.table}: ${t.rows} row(s)`);

    if (arg('--confirm') !== database) {
      console.log(`\nNothing was changed. This deletes everything above for good. Make a Neon branch (backup) first,`);
      console.log(`stop the server on every computer, then run:\n\n   npm run seed:history -- --confirm ${database}\n`);
      return;
    }

    const seed = arg('--seed') ? Number(arg('--seed')) : undefined;
    console.log('\n⏳ Building the history from January 2020 to today…');
    const history = generateHistory({ users, now: new Date(), ...(Number.isFinite(seed) ? { seed } : {}) });
    console.log('⏳ Loading it (one transaction: nothing changes unless all of it succeeds)…');
    await loadHistory(pool, history, { log: (line) => console.log(line) });

    const s = history.summary;
    console.log(`\n✅ Done: ${s.orders} orders (${Object.entries(s.by_status).map(([k, v]) => `${v} ${k}`).join(', ')}),`);
    console.log(`   ${s.customers} clients, ${s.branches} branches, ${s.items} catalog items, ${s.suppliers} suppliers,`);
    console.log(`   ${s.payments} payments, ${s.stock_documents} stock documents, ${s.waste_records} waste records, ${s.overheads} expenses.`);

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
  console.error(`❌ ${err.message}\n   If the load had started, it was rolled back: the database is as it was.`);
  process.exit(1);
});

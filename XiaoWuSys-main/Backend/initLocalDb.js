// Creates the SQLite offline-cache tables by hand: node initLocalDb.js
// Not required any more: server.js runs the same schema automatically on every start-up.
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { createLocalSchema, listLocalTables } = require('./services/localSchema');

const dbPath = path.resolve(__dirname, 'local_cache.db');
const db = new sqlite3.Database(dbPath, async (err) => {
  if (err) {
    console.error('❌ Error connecting to SQLite:', err.message);
    process.exit(1);
  }
  console.log('✅ Connected to SQLite Local Cache.');
  try {
    await createLocalSchema(db);
    console.log(`🎉 SQLite schema ready: ${(await listLocalTables(db)).join(', ')}`);
  } catch (schemaErr) {
    console.error('❌ Could not create the local schema:', schemaErr.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
});

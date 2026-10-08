// ==========================================
// SEED: stock delivery of October 8, 2026
// Adds the delivered items to the catalog. Run from the Backend folder:
//
//   npm run seed-inventory
//
// Safe to run more than once: an item whose name already exists (case-insensitive) is
// skipped, never duplicated or re-counted. Change stock afterwards with the Catalog's
// +/- controls. unit_cost is 0 because the delivery note has no prices; edit it later.
// If Neon is unreachable, items go into the local SQLite cache as pending_insert and are
// pushed by the normal sync on the next server start / 5-minute cycle.
// ==========================================
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3');
const { isConnectionError } = require('../utils/dbErrors');
const { LOCAL_NOW } = require('../utils/localSync');

const ITEMS = [
  { item_name: 'Valiant Record Book Regular Notebook', item_category: 'Notebooks', quantity_available: 5, minimum_threshold: 2 },
  { item_name: 'Valiant Columnar Notebook', item_category: 'Notebooks', quantity_available: 3, minimum_threshold: 2 },
  { item_name: 'Quaff Sublimation Transfer Paper (pack)', item_category: 'Paper', quantity_available: 1, minimum_threshold: 2 },
  { item_name: 'Deli A4 Paper (pack)', item_category: 'Paper', quantity_available: 1, minimum_threshold: 2 },
  { item_name: 'B&E Oslo Drawing Paper (pack)', item_category: 'Paper', quantity_available: 9, minimum_threshold: 3 },
  { item_name: 'Sales Invoice Receipts (pack)', item_category: 'Forms & Receipts', quantity_available: 12, minimum_threshold: 3 },
  { item_name: 'Custom Shirt', item_category: 'Apparel', quantity_available: 381, minimum_threshold: 50 }
];

const seedCloud = async () => {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL is not set'), { code: 'ENOTFOUND' });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });
  try {
    for (const item of ITEMS) {
      const { rowCount } = await pool.query(
        `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost)
         SELECT $1::varchar, $2::varchar, $3::varchar, $4::int, $5::int, 0::numeric
          WHERE NOT EXISTS (SELECT 1 FROM inventory_items WHERE LOWER(item_name) = LOWER($2::varchar))`,
        [crypto.randomUUID(), item.item_name, item.item_category, item.quantity_available, item.minimum_threshold]
      );
      console.log(rowCount === 1
        ? `✅ Added ${item.item_name} (${item.quantity_available})`
        : `↷ Skipped ${item.item_name}: already in the catalog`);
    }
  } finally {
    await pool.end();
  }
};

const seedLocal = () => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(path.resolve(__dirname, '..', 'local_cache.db'), sqlite3.OPEN_READWRITE, async (openErr) => {
    if (openErr) return reject(new Error(`Local cache not found (run "node initLocalDb.js" first): ${openErr.message}`));
    const run = (sql, params) => new Promise((ok, fail) =>
      db.run(sql, params, function (err) { return err ? fail(err) : ok(this.changes); }));
    try {
      for (const item of ITEMS) {
        const changes = await run(
          `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost, sync_status, last_modified)
           SELECT ?, ?, ?, ?, ?, 0, 'pending_insert', ${LOCAL_NOW}
            WHERE NOT EXISTS (SELECT 1 FROM inventory_items WHERE LOWER(item_name) = LOWER(?))`,
          [crypto.randomUUID(), item.item_name, item.item_category, item.quantity_available, item.minimum_threshold, item.item_name]
        );
        console.log(changes === 1
          ? `✅ Saved locally ${item.item_name} (${item.quantity_available}); will sync when online`
          : `↷ Skipped ${item.item_name}: already in the local cache`);
      }
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      db.close();
    }
  });
});

(async () => {
  try {
    await seedCloud();
  } catch (err) {
    if (!isConnectionError(err)) {
      console.error('✗ Seeding failed:', err.message);
      process.exit(1);
    }
    console.warn(`⚠️ Cloud database unreachable (${err.message}). Saving to the local cache instead.`);
    try {
      await seedLocal();
    } catch (localErr) {
      console.error('✗ Seeding failed:', localErr.message);
      process.exit(1);
    }
  }
  console.log('🎉 Inventory seed finished. Open the Catalog (or press Refresh) to see the items.');
})();

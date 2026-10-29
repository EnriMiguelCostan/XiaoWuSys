// ==========================================
// DEMO DATABASE (no Neon account needed)
// Creates Backend/demo_cache.db filled with the printshop's items, customers, orders and
// payments, by running the real API in-process (so every business rule is applied).
//
//   npm run demo:seed            (re)create the demo database
//   npm run demo                 create it if missing, then start the server in demo mode
//
// Demo accounts (password for all: XiaoMei2026): owner, admin, production, staff
// The demo database is separate from local_cache.db and is NEVER synced to the cloud:
// the server refuses to start with a demo database while a cloud database is configured.
// ==========================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'demo-only-secret-change-me-0123456789abcdef';

const { createApp } = require('../app');
const { createCloudDisabledPool } = require('../services/cloudDisabledPool');
const { createLocalSchema, createLocalIndexes } = require('../services/localSchema');
const { ensureLocalSyncColumns } = require('../utils/localSync');
const { SYNC_TABLES, listConflicts } = require('../services/sync');
const { createOrderLockManager } = require('../services/orderLocks');
const { sqliteRun } = require('../services/records');
const { PASSWORD, USERS, ITEMS, CUSTOMERS } = require('../tests/fixtures/data');

const DEMO_FILE = path.resolve(__dirname, '..', 'demo_cache.db');
const ifMissing = process.argv.includes('--if-missing');

const shopDate = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86400000));

(async () => {
  if (ifMissing && fs.existsSync(DEMO_FILE)) {
    console.log('ℹ️  demo_cache.db already exists (run "npm run demo:seed" to rebuild it).');
    return;
  }
  for (const f of [DEMO_FILE, `${DEMO_FILE}-journal`]) if (fs.existsSync(f)) fs.unlinkSync(f);

  const db = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(DEMO_FILE, (err) => (err ? reject(err) : resolve(d)));
  });
  await sqliteRun(db, 'PRAGMA foreign_keys = ON');
  await createLocalSchema(db);
  await ensureLocalSyncColumns(db, SYNC_TABLES.map((t) => t.table), { log: () => {} });
  await createLocalIndexes(db);
  const hash = await bcrypt.hash(PASSWORD, 10);
  for (const u of USERS) {
    await sqliteRun(db,
      `INSERT INTO users (user_id, username, password_hash, role, is_active, sync_status) VALUES (?, ?, ?, ?, ?, 'synced')`,
      [u.user_id, u.username, hash, u.role, u.is_active]);
  }

  // Run the real API against the demo file, cloud disabled
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  const app = createApp({
    pgPool: createCloudDisabledPool(), localDb: db, localDbPath: DEMO_FILE, orderLocks: createOrderLockManager(),
    inventoryEvents: { notifyChanged() {} }, syncAndNotify: async () => ({ aborted: true, conflicts: [] }), listConflicts
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data.message || data.error}`);
    return data;
  };

  try {
    // The Owner, because only the Owner may put a price on an order (PB 2)
    token = (await call('POST', '/auth/login', { username: 'owner', password: PASSWORD })).token;
    const item = {};
    for (const it of ITEMS) item[it.item_name] = (await call('POST', '/inventory', it)).item.inventory_id;
    const cust = {};
    for (const c of CUSTOMERS) cust[c.full_name] = (await call('POST', '/customers', c)).customer.customer_id;

    // Orders: a school jersey order (half paid), a small notebook order (fully paid),
    // a halted order logged as Delayed, and a print-details example
    const school = await call('POST', '/orders', {
      customer_id: cust['Agdao National High School'], production_deadline: shopDate(5), total_quote_amount: 45000,
      required_items: [{ inventory_id: item['Custom Shirt'], quantity_needed: 300 }, { inventory_id: item['Quaff Sublimation Transfer Paper'], quantity_needed: 1 }]
    });
    await call('POST', `/orders/${school.order_id}/payments`, { amount: 22500, payment_type: 'Bank Transfer' });
    for (const [size, name, number] of [['M', 'DELA CRUZ', '7'], ['L', 'SANTOS', '10'], ['XL', 'REYES', '23']]) {
      await call('POST', `/orders/${school.order_id}/items`, { product_type: 'Jersey print', quantity: 1, size, custom_name: name, custom_number: number });
    }
    const notebooks = await call('POST', '/orders', {
      customer_id: cust['Maria Santos'], production_deadline: shopDate(2), total_quote_amount: 450,
      required_items: [{ inventory_id: item['Valiant Record Book Regular Notebook'], quantity_needed: 2 }]
    });
    await call('POST', `/orders/${notebooks.order_id}/payments`, { amount: 450, payment_type: 'GCash' });
    await call('POST', '/orders', {
      customer_id: cust['Juan Dela Cruz'], production_deadline: shopDate(21), total_quote_amount: 9000, resolution: 'Delayed',
      required_items: [{ inventory_id: item['Custom Shirt'], quantity_needed: 120 }]
    });
    const late = await call('POST', '/orders', {
      customer_id: cust['Juan Dela Cruz'], production_deadline: shopDate(1), total_quote_amount: 1200,
      required_items: [{ inventory_id: item['Vinyl Sticker Paper'], quantity_needed: 4 }]
    });
    // Demo only: make this order overdue so the dashboard shows the "Overdue" list
    await sqliteRun(db, 'UPDATE order_profiles SET production_deadline = ? WHERE order_id = ?', [`${shopDate(-2)}T00:00:00`, late.order_id]);
    await call('POST', `/inventory/${item['Deli A4 Paper']}/loss`, { quantity_lost: 1, loss_reason: 'Paper got wet' });
    // Demo only: in real use the cloud gives each order its XM-YYYY-NNNN number when it syncs.
    // The demo never syncs, so number the sample orders here to show what staff will see.
    const year = shopDate(0).slice(0, 4);
    const orders = await new Promise((resolve, reject) => db.all(
      'SELECT order_id FROM order_profiles ORDER BY date_created, rowid', (err, rows) => (err ? reject(err) : resolve(rows))));
    for (let i = 0; i < orders.length; i++) {
      await sqliteRun(db, 'UPDATE order_profiles SET tracking_no = ? WHERE order_id = ?', [`XM-${year}-${String(i + 1).padStart(4, '0')}`, orders[i].order_id]);
    }
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => db.close(r));
    Object.assign(console, quiet);
  }

  console.log('✅ Demo database ready: Backend/demo_cache.db');
  console.log(`   Log in with owner / admin / production / staff, password: ${PASSWORD}`);
  console.log('   Start it with: npm run demo');
})().catch((err) => {
  console.error('✗ Could not build the demo database:', err.message);
  process.exit(1);
});

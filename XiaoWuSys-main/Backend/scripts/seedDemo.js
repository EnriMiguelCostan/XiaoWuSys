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
//
// Batch M6 part 4 (PB 27, UAT and defense): the demo also shows migrations 009-012 out of the
// box: selling prices and usage rates (Sublimation Ink, Transfer Paper per shirt), orders in
// every step (Pending, Approved, Printing, Pressing, Completed with status history and the
// consumables taken, Delayed), a calculated quote with an Owner discount, misprints with reason
// codes and causes, and this month's overheads, so the Owner's P&L and the dashboard have data.
// Steps the API keeps online-only (status changes, usage rates, the calculated quote) are
// written straight into the demo file, marked "Demo only" below; everything else goes through
// the real API so its rules apply.
//   DEMO_DB_PATH=/tmp/x.db npm run demo:seed   builds it somewhere else (used to test this script)
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

const DEMO_FILE = path.resolve(process.env.DEMO_DB_PATH || path.resolve(__dirname, '..', 'demo_cache.db'));
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
  let pnlLine = '';
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

    // Orders: a school jersey order (part paid), a small notebook order (fully paid),
    // a halted order logged as Delayed, and a print-details example
    const school = await call('POST', '/orders', {
      customer_id: cust['Agdao National High School'], production_deadline: shopDate(5), total_quote_amount: 45000,
      required_items: [{ inventory_id: item['Custom Shirt'], quantity_needed: 300 }, { inventory_id: item['Quaff Sublimation Transfer Paper'], quantity_needed: 1 }]
    });
    await call('POST', `/orders/${school.order_id}/payments`, { amount: 22500, payment_type: 'Bank Transfer' });
    // A second instalment (balance still open), so this month's payments cover the overheads
    // and the Demo P&L opens on a clear net profit
    await call('POST', `/orders/${school.order_id}/payments`, { amount: 15000, payment_type: 'Cash' });
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
    await call('POST', `/inventory/${item['Deli A4 Paper']}/loss`, { quantity_lost: 1, reason_code: 'damaged_in_storage', loss_reason: 'Paper got wet' });

    // ---------- Batch M6 part 4: migrations 009-012 in the demo ----------
    const run = (sql, params = []) => sqliteRun(db, sql, params);
    const ago = (minutes) => `strftime('%Y-%m-%d %H:%M:%f', 'now', '-${Number(minutes)} minutes')`;
    // PB 11: selling prices; PB 15: consumables and their usage rates per shirt
    await call('PATCH', `/inventory/${item['Custom Shirt']}`, { selling_price: 280 });
    await call('PATCH', `/inventory/${item['Valiant Record Book Regular Notebook']}`, { selling_price: 65 });
    const ink = (await call('POST', '/inventory', {
      item_name: 'Sublimation Ink (bulk)', item_category: 'Consumable', unit: 'ml', quantity_available: 5000, minimum_threshold: 500, unit_cost: 0.8, supplier: 'Quaff PH'
    })).item.inventory_id;
    const paper = (await call('POST', '/inventory', {
      item_name: 'Transfer Paper (sheet)', item_category: 'Consumable', unit: 'sheet', quantity_available: 800, minimum_threshold: 100, unit_cost: 6, supplier: 'Quaff PH'
    })).item.inventory_id;
    // Demo only: usage rates are saved online (PUT /api/inventory/:id/consumable-rates)
    await run(`INSERT INTO consumable_rates (rate_id, product_inventory_id, consumable_inventory_id, quantity_per_piece, trigger_status, sync_status)
               VALUES ('demo-rate-ink', ?, ?, 12, 'Pressing', 'synced'), ('demo-rate-paper', ?, ?, 1, 'Pressing', 'synced')`,
    [item['Custom Shirt'], ink, item['Custom Shirt'], paper]);

    // PB 11 / PB 12: the school order's quote, calculated with the 10% volume tier and the Owner's discount
    // Demo only: POST /api/orders/:id/quote needs the cloud
    await run(`UPDATE order_profiles SET subtotal_amount = 50400, discount_amount = 5400,
                 discount_reason = 'Volume tier (300 pcs, 10%) and loyal school client' WHERE order_id = ?`, [school.order_id]);
    await run(`INSERT INTO audit_log (audit_id, entity, entity_id, action, details, performed_by, performed_role, sync_status)
               VALUES ('demo-audit-discount', 'order_profiles', ?, 'discount_applied', ?, 'u-owner', 'Owner', 'synced')`,
    [school.order_id, JSON.stringify({ subtotal_amount: 50400, discount_amount: 5400, total_quote_amount: 45000 })]);

    // Orders in every production step (PB 13 / PB 14). Created through the API (stock reserved,
    // downpayment paid), then moved along. Demo only: status changes need the cloud.
    const step = async (name, qty, payFull) => {
      const quote = qty * 280;
      const o = await call('POST', '/orders', {
        customer_id: cust['Agdao National High School'], production_deadline: shopDate(4), total_quote_amount: quote,
        required_items: [{ inventory_id: item['Custom Shirt'], quantity_needed: qty }]
      });
      await call('POST', `/orders/${o.order_id}/payments`, { amount: payFull ? quote : quote / 2, payment_type: 'GCash' });
      await call('POST', `/orders/${o.order_id}/items`, { product_type: `${name} jersey print`, quantity: qty });
      return o.order_id;
    };
    const history = async (orderId, moves) => {
      let i = 0;
      for (const [from, to, minutesAgo, by, role] of moves) {
        await run(`INSERT INTO order_status_history (history_id, order_id, from_status, to_status, changed_by, changed_role, changed_at, sync_status)
                   VALUES (?, ?, ?, ?, ?, ?, ${ago(minutesAgo)}, 'synced')`, [`demo-h-${orderId}-${++i}`, orderId, from, to, by, role]);
      }
    };
    const setStatus = (orderId, status, extra = '') =>
      run(`UPDATE order_profiles SET production_status = ?, approved_by = 'u-owner', approved_at = ${ago(600)}${extra} WHERE order_id = ?`, [status, orderId]);
    // PB 15: what the Pressing step took (12 ml ink + 1 sheet per shirt), at today's cost
    const takeConsumables = async (orderId, qty) => {
      for (const [id, perPiece, cost] of [[ink, 12, 0.8], [paper, 1, 6]]) {
        await run(`INSERT INTO order_consumables_log (log_id, order_id, trigger_status, consumable_inventory_id, quantity_deducted, shortfall, unit_cost, deducted_at, sync_status)
                   VALUES (?, ?, 'Pressing', ?, ?, 0, ?, ${ago(90)}, 'synced')`, [`demo-c-${orderId}-${id}`, orderId, id, qty * perPiece, cost]);
        await run('UPDATE inventory_items SET quantity_available = quantity_available - ? WHERE inventory_id = ?', [qty * perPiece, id]);
      }
    };

    const approved = await step('Barangay league', 10, false);
    await setStatus(approved, 'Approved');
    await history(approved, [[null, 'Pending', 900, 'u-production', 'Production'], ['Pending', 'Approved', 600, 'u-owner', 'Owner']]);

    const printing = await step('Agdao Warriors', 15, false);
    await setStatus(printing, 'Printing');
    await history(printing, [[null, 'Pending', 900, 'u-production', 'Production'], ['Pending', 'Approved', 600, 'u-owner', 'Owner'],
      ['Approved', 'Printing', 240, 'u-production', 'Production']]);

    const pressing = await step('Faculty shirts', 20, false);
    await setStatus(pressing, 'Pressing');
    await history(pressing, [[null, 'Pending', 900, 'u-production', 'Production'], ['Pending', 'Approved', 600, 'u-owner', 'Owner'],
      ['Approved', 'Printing', 300, 'u-production', 'Production'], ['Printing', 'Pressing', 90, 'u-production', 'Production']]);
    await takeConsumables(pressing, 20);

    const completed = await step('Intramurals', 25, true);
    await setStatus(completed, 'Completed', ', stock_reserved = 0');
    await history(completed, [[null, 'Pending', 2000, 'u-production', 'Production'], ['Pending', 'Approved', 1800, 'u-owner', 'Owner'],
      ['Approved', 'Printing', 600, 'u-production', 'Production'], ['Printing', 'Pressing', 90, 'u-production', 'Production'],
      ['Pressing', 'Completed', 30, 'u-production', 'Production']]);
    await takeConsumables(completed, 25);
    // Completing uses up the reserved blanks and keeps their cost for the P&L (PB 22, migration 013)
    await run('UPDATE inventory_items SET quantity_available = quantity_available - 25, quantity_reserved = quantity_reserved - 25 WHERE inventory_id = ?', [item['Custom Shirt']]);
    await run('UPDATE order_items SET unit_cost = 150 WHERE order_id = ? AND inventory_id IS NOT NULL', [completed]);

    // PB 18 / PB 19: misprints logged against orders in production, through the real API, so the
    // causes are diagnosed (two losses during printing / pressing within the hour = machine failure)
    await call('POST', `/inventory/${item['Custom Shirt']}/loss`, { quantity_lost: 2, reason_code: 'misprint_alignment', order_id: printing, loss_reason: 'Logo shifted on the left sleeve' });
    await call('POST', `/inventory/${item['Custom Shirt']}/loss`, { quantity_lost: 1, reason_code: 'heat_press_scorch', order_id: pressing });
    await call('POST', `/inventory/${item['Custom Shirt']}/loss`, { quantity_lost: 1, reason_code: 'supplier_defect', loss_reason: 'Pinhole near the collar' });
    // Demo only: in real use the cloud re-marks the earlier loss of a cluster as a machine failure
    await run(`UPDATE material_loss SET loss_category = 'Machine Failure' WHERE order_id IN (?, ?)`, [printing, pressing]);

    // PB 22: this month's overheads (and last month's rent), through the real API
    const month = shopDate(0).slice(0, 7);
    const lastMonthFirst = new Date(`${month}-01T00:00:00Z`);
    lastMonthFirst.setUTCMonth(lastMonthFirst.getUTCMonth() - 1);
    for (const [expense_date, category, description, amount] of [
      [`${month}-01`, 'Rent', 'Shop rent, Agdao', 8000],
      [`${month}-01`, 'Electricity & Utilities', 'Electricity and water', 3500],
      [`${month}-01`, 'Salaries & Wages', 'Two production staff', 24000],
      [lastMonthFirst.toISOString().slice(0, 10), 'Rent', 'Shop rent, Agdao (last month)', 8000]
    ]) {
      await call('POST', '/reports/overheads', { expense_date, category, description, amount });
    }
    // The server's own P&L for this month, printed so a rebuild shows the demo opens in profit
    pnlLine = await call('GET', '/reports/pnl').then(
      (p) => `   P&L this month: income ₱${p.gross_income}, expenses ₱${p.total_expenses}, ${p.profitable ? 'net profit' : 'NET LOSS'} ₱${p.net_profit}`,
      () => ''
    );
    // Demo only: the demo never syncs, so show these as already in the cloud
    for (const table of ['overhead_expenses', 'material_loss', 'audit_log', 'payments', 'order_items']) {
      await run(`UPDATE ${table} SET sync_status = 'synced' WHERE sync_status = 'pending_insert'`);
    }
    // Demo only: in real use the cloud gives each order its XM-YYYY-NNNN number when it syncs.
    // The demo never syncs, so number the sample orders here to show what staff will see.
    const year = shopDate(0).slice(0, 4);
    const orders = await new Promise((resolve, reject) => db.all(
      'SELECT order_id FROM order_profiles ORDER BY date_created, rowid', (err, rows) => (err ? reject(err) : resolve(rows))));
    for (let i = 0; i < orders.length; i++) {
      await sqliteRun(db, 'UPDATE order_profiles SET tracking_no = ? WHERE order_id = ?', [`XM-${year}-${String(i + 1).padStart(4, '0')}`, orders[i].order_id]);
    }
    // Demo only: receipts get their AR-YYYY-NNNN number from the cloud too
    const pays = await new Promise((resolve, reject) => db.all(
      'SELECT payment_id FROM payments ORDER BY payment_date, rowid', (err, rows) => (err ? reject(err) : resolve(rows))));
    for (let i = 0; i < pays.length; i++) {
      await sqliteRun(db, 'UPDATE payments SET receipt_no = ? WHERE payment_id = ?', [`AR-${year}-${String(i + 1).padStart(4, '0')}`, pays[i].payment_id]);
    }
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => db.close(r));
    Object.assign(console, quiet);
  }

  console.log(`✅ Demo database ready: ${path.relative(process.cwd(), DEMO_FILE) || DEMO_FILE}`);
  console.log(`   Log in with owner / admin / production / staff, password: ${PASSWORD}`);
  if (pnlLine) console.log(pnlLine);
  console.log('   Start it with: npm run demo');
})().catch((err) => {
  console.error('✗ Could not build the demo database:', err.message);
  process.exit(1);
});

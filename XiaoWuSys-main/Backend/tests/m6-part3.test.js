// Batch M6, part 3 on this computer's database (cloud switched off, like `npm run demo`):
// misprints logged against an order with reason codes and diagnoses (PB 18 / PB 19), the
// dashboard waste card and waste.csv (PB 20), overhead expenses and the Owner's P&L (PB 22),
// and the void routes that need the cloud (PB 23). The cloud paths run on real PostgreSQL in
// m6-part3.pg.test.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTestServer, openDb, shopDate } = require('./helpers/testServer');
const { createLocalSchema } = require('../services/localSchema');
const { ensureLocalSyncColumns } = require('../utils/localSync');
const { SYNC_TABLES } = require('../services/sync');
const { sqliteRun, sqliteAll } = require('../services/records');
const { localDateTime } = require('../utils/validation');

describe('M6 part 3 offline: misprints, waste, overheads, P&L, voids', () => {
  let t;
  let owner; let admin; let production; let staff;
  let shirt; let cap; let mug; let pen; let customer; let orderId;
  const loss = (id, body, token = production) => t.request('POST', `/api/inventory/${id}/loss`, { token, body });

  before(async () => {
    t = await startTestServer();
    owner = await t.login('owner');
    admin = await t.login('admin');
    production = await t.login('production');
    staff = await t.login('staff');
    customer = (await t.request('POST', '/api/customers', { token: production, body: { full_name: 'Agdao NHS' } })).body.customer.customer_id;
    const item = async (item_name, quantity_available, unit_cost) =>
      (await t.request('POST', '/api/inventory', { token: production, body: { item_name, item_category: 'Apparel', quantity_available, unit_cost } })).body.item.inventory_id;
    shirt = await item('Jersey Blank', 6, 120);
    cap = await item('Cap', 50, 80);
    mug = await item('Mug', 50, 60);
    pen = await item('Pen', 50, 10);
    const created = await t.request('POST', '/api/orders', {
      token: production,
      body: { customer_id: customer, production_deadline: shopDate(9), required_items: [{ inventory_id: shirt, quantity_needed: 4 }] }
    });
    assert.equal(created.status, 201, created.text);
    orderId = created.body.order_id;
  });
  after(async () => { await t.close(); });

  it('logs a misprint against an order with a standard reason, its step and a replacement warning', async () => {
    // The order is being printed (status changes need the cloud, so the copy is set directly)
    await t.run("UPDATE order_profiles SET production_status = 'Printing' WHERE order_id = ?", [orderId]);
    const r = await loss(shirt, { quantity_lost: 2, reason_code: 'misprint_alignment', order_id: orderId });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.source, 'local');
    assert.deepEqual(
      [r.body.loss.reason_code, r.body.loss.loss_reason, r.body.loss.production_stage, r.body.loss.loss_category, r.body.loss.is_statistical_anomaly],
      ['misprint_alignment', 'Misprint / alignment error', 'Printing', 'Human Error', false]);
    assert.deepEqual([r.body.loss.item_name, r.body.loss.reason_label, r.body.loss.category_label], ['Jersey Blank', 'Misprint / alignment error', 'Human Error']);
    assert.deepEqual([r.body.diagnosis.rule, r.body.diagnosis.cluster_with], ['reason_code', []]);
    // D1: 6 on hand, 4 reserved for the order; the loss takes 2 from general stock -> 0 free
    assert.deepEqual([r.body.item.quantity_available, r.body.item.quantity_reserved], [4, 4], 'the reservation is untouched');
    assert.equal(r.body.replacement_warning.code, 'REPLACEMENT_STOCK_DEPLETED');
    assert.match(r.body.replacement_warning.message, /Jersey Blank.*may delay this order/);
    assert.equal((await t.get('SELECT financial_cost FROM material_loss WHERE loss_id = ?', [r.body.loss.loss_id])).financial_cost, 240);
  });

  it('clusters a second machine-step loss within the hour as a machine failure', async () => {
    const r = await loss(cap, { quantity_lost: 1, reason_code: 'sizing_encoding_error', order_id: orderId });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.loss.loss_category, r.body.diagnosis.rule, r.body.diagnosis.cluster_with.length], ['Machine Failure', 'machine_cluster', 1]);
    assert.deepEqual(r.body.diagnosis.escalated, [], 'earlier losses are re-marked in the cloud only');
    assert.equal(r.body.replacement_warning, null, 'plenty of caps left');
  });

  it('keeps older screens working: free text only, the code read from its words', async () => {
    const old = await loss(mug, { quantity_lost: 1, loss_reason: 'Pinhole from the supplier' });
    assert.equal(old.status, 201, old.text);
    assert.deepEqual([old.body.loss.reason_code, old.body.loss.loss_reason, old.body.loss.loss_category, old.body.loss.production_stage],
      ['supplier_defect', 'Pinhole from the supplier', 'Product Defect', null]);
    const plain = await loss(mug, { quantity_lost: 1, loss_reason: 'Test reason' });
    assert.deepEqual([plain.status, plain.body.loss.reason_code, plain.body.loss.loss_category, plain.body.loss.category_label],
      [201, null, null, 'Not classified']);
    const nothing = await loss(mug, { quantity_lost: 1 });
    assert.deepEqual([nothing.status, nothing.body.details[0].field], [400, 'loss_reason']);
    const bad = await loss(mug, { quantity_lost: 1, reason_code: 'gremlins' });
    assert.deepEqual([bad.status, bad.body.details[0].field], [400, 'reason_code']);
    assert.match(bad.body.message, /^Reason must be one of these/);
  });

  it('flags a statistical anomaly once an item’s losses stand far above the others', async () => {
    // Baseline: shirt 2, cap 1, mug 2 (pen has none yet). Pens: 9 lost > mean 1.67 + 2 x sd 0.58
    const r = await loss(pen, { quantity_lost: 9, reason_code: 'damaged_in_storage' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.loss.is_statistical_anomaly, r.body.loss.loss_category, r.body.diagnosis.rule], [true, 'Product Defect', 'statistical']);
    assert.deepEqual(r.body.diagnosis.baseline, { items: 3, mean: 1.67, sd: 0.58 });
  });

  it('labels a loss on an order rushed through Printing as human error', async () => {
    const other = (await t.request('POST', '/api/orders', {
      token: production, body: { customer_id: customer, production_deadline: shopDate(9), resolution: 'Delayed' }
    })).body.order_id;
    await t.run("UPDATE order_profiles SET production_status = 'Completed' WHERE order_id = ?", [other]);
    const h = (id, from, to, ts) => t.run(
      'INSERT INTO order_status_history (history_id, order_id, from_status, to_status, changed_at) VALUES (?, ?, ?, ?, ?)', [id, other, from, to, ts]);
    await h('h1', 'Approved', 'Printing', '2026-11-10 09:00:00');
    await h('h2', 'Printing', 'Completed', '2026-11-10 09:03:00');
    const r = await loss(cap, { quantity_lost: 1, reason_code: 'heat_press_scorch', order_id: other });
    assert.deepEqual([r.status, r.body.loss.loss_category, r.body.diagnosis.rule, r.body.loss.production_stage], [201, 'Human Error', 'rushed_step', 'Completed']);
  });

  it('shows the order’s losses on its detail, and who may log one', async () => {
    const owners = await t.request('GET', `/api/orders/${orderId}`, { token: owner });
    assert.equal(owners.status, 200, owners.text);
    assert.deepEqual(owners.body.material_losses.map((l) => [l.item_name, l.quantity_lost, l.category_label]).sort(),
      [['Cap', 1, 'Machine Failure'], ['Jersey Blank', 2, 'Human Error']]);
    assert.equal(owners.body.allowed_actions.log_loss, true);
    const staffView = await t.request('GET', `/api/orders/${orderId}`, { token: staff });
    assert.deepEqual([staffView.body.allowed_actions.log_loss, staffView.body.allowed_actions.void_payment], [false, false]);
    assert.equal((await loss(shirt, { quantity_lost: 1, reason_code: 'misprint_alignment' }, staff)).status, 403);
  });

  it('sums this month’s waste on the dashboard, with costs for finance accounts only', async () => {
    const mine = await t.request('GET', '/api/reports/dashboard', { token: owner });
    assert.equal(mine.status, 200, mine.text);
    const w = mine.body.waste;
    assert.deepEqual([w.costs_visible, w.count_this_month, w.total_items_this_month], [true, 6, 15]);
    assert.equal(w.total_cost_this_month, 240 + 80 + 60 + 60 + 90 + 80);
    assert.deepEqual(w.by_category.map((c) => [c.category, c.count, c.cost]),
      [['Machine Failure', 1, 80], ['Human Error', 2, 320], ['Product Defect', 2, 150], ['Not classified', 1, 60]]);
    assert.deepEqual(w.anomalies.map((a) => a.item_name), ['Pen']);
    assert.equal(w.recent.length, 6);
    assert.equal(w.recent.find((l) => l.item_name === 'Jersey Blank').order_label, 'New order', 'an order saved offline has no number yet');
    const theirs = await t.request('GET', '/api/reports/dashboard', { token: production });
    assert.deepEqual([theirs.body.waste.costs_visible, theirs.body.waste.total_cost_this_month, theirs.body.waste.recent[0].financial_cost], [false, null, null]);
    assert.equal(theirs.body.waste.count_this_month, 6);
  });

  it('exports waste.csv for finance accounts', async () => {
    const r = await t.request('GET', '/api/reports/export/waste.csv', { token: admin });
    assert.equal(r.status, 200, r.text);
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], 'Date,Item,Order,Quantity lost,Unit cost (PHP),Cost (PHP),Reason,Reason code,Cause,Statistical anomaly,Production step,Notes');
    assert.equal(lines.length, 7);
    assert.ok(lines.some((l) => /^.*,Pen,,9,10,90,Damaged or lost in storage \/ handling,damaged_in_storage,Product Defect,Yes,,/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes(',Jersey Blank,New order,2,120,240,') && l.includes(',Human Error,No,Printing,')), lines.join('\n'));
    assert.equal((await t.request('GET', '/api/reports/export/waste.csv', { token: production })).status, 403);
  });

  const today = localDateTime(new Date()).slice(0, 10);
  it('records overhead expenses offline, checks them, and keeps removing them for the Owner online', async () => {
    const add = (body, token = admin) => t.request('POST', '/api/reports/overheads', { token, body });
    const rent = await add({ expense_date: `${today.slice(0, 7)}-01`, category: 'Rent', description: 'Shop rent', amount: 8000 });
    assert.equal(rent.status, 201, rent.text);
    assert.deepEqual([rent.body.source, rent.body.expense.category, rent.body.expense.amount, rent.body.expense.recorded_by, rent.body.expense.sync_status],
      ['local', 'Rent', 8000, 'u-admin', 'pending_insert']);
    assert.equal(rent.body.expense.expense_date, `${today.slice(0, 7)}-01T00:00:00`);
    const power = await add({ expense_date: today, category: 'Electricity & Utilities', description: 'Meralco', amount: 1500.55 }, owner);
    assert.equal(power.status, 201, power.text);
    const audit = await t.all("SELECT action, performed_role, sync_status FROM audit_log WHERE entity = 'overhead_expenses' ORDER BY created_at");
    assert.deepEqual(audit.map((a) => [a.action, a.performed_role, a.sync_status]), [['overhead_recorded', 'Admin', 'pending_insert'], ['overhead_recorded', 'Owner', 'pending_insert']]);

    for (const [body, field] of [
      [{ expense_date: '2999-01-01', category: 'Rent', description: 'x', amount: 1 }, 'expense_date'],
      [{ expense_date: '2026-02-30', category: 'Rent', description: 'x', amount: 1 }, 'expense_date'],
      [{ expense_date: today, category: 'Snacks', description: 'x', amount: 1 }, 'category'],
      [{ expense_date: today, category: 'Rent', description: ' ', amount: 1 }, 'description'],
      [{ expense_date: today, category: 'Rent', description: 'x', amount: '1' }, 'amount'],
      [{ expense_date: today, category: 'Rent', description: 'x', amount: 0 }, 'amount'],
      [{ expense_date: today, category: 'Rent', description: 'x', amount: 1, recorded_by: 'u-owner' }, 'recorded_by']
    ]) {
      const r = await add(body);
      assert.deepEqual([r.status, r.body.details[0].field], [400, field], JSON.stringify(body));
    }
    assert.equal((await add({ expense_date: today, category: 'Rent', description: 'x', amount: 1 }, production)).status, 403);

    const list = await t.request('GET', '/api/reports/overheads', { token: admin });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual([list.body.total, list.body.expenses.length, list.body.can_delete], [9500.55, 2, false]);
    assert.deepEqual(list.body.by_category, [{ category: 'Rent', amount: 8000 }, { category: 'Electricity & Utilities', amount: 1500.55 }]);
    assert.ok(list.body.categories.includes('Outsourced Printing / Embroidery'));
    assert.equal(list.body.expenses.find((e) => e.category === 'Electricity & Utilities').recorded_by_name, 'owner');
    const ownerList = await t.request('GET', '/api/reports/overheads', { token: owner });
    assert.deepEqual([ownerList.body.can_delete, ownerList.body.expenses[0].can_delete], [true, false], 'not synced yet: removed after sync');
    const lastMonth = await t.request('GET', '/api/reports/overheads?from=2020-01-01&to=2020-01-31', { token: admin });
    assert.deepEqual([lastMonth.body.total, lastMonth.body.expenses], [0, []]);
    assert.equal((await t.request('GET', '/api/reports/overheads?from=2026-02-01&to=2026-01-01', { token: admin })).status, 400);

    const id = rent.body.expense.expense_id;
    assert.equal((await t.request('DELETE', `/api/reports/overheads/${id}`, { token: admin })).status, 403, 'Owner only');
    const offline = await t.request('DELETE', `/api/reports/overheads/${id}`, { token: owner });
    assert.deepEqual([offline.status, offline.body.error], [503, 'OVERHEAD_DELETE_REQUIRES_CLOUD']);
    assert.equal((await t.request('DELETE', '/api/reports/overheads/nope', { token: owner })).status, 404);
  });

  it('builds the P&L for the Owner only, with a CSV and a printable period', async () => {
    for (const token of [admin, production, staff]) {
      assert.equal((await t.request('GET', '/api/reports/pnl', { token })).status, 403);
      assert.equal((await t.request('GET', '/api/reports/export/pnl.csv', { token })).status, 403);
    }
    const r = await t.request('GET', '/api/reports/pnl', { token: owner });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.period, { from: `${today.slice(0, 7)}-01`, to: today });
    assert.equal(r.body.source, 'local');
    assert.deepEqual([r.body.gross_income, r.body.cogs_blanks, r.body.overhead_cost], [0, 0, 9500.55]);
    assert.equal(r.body.waste_cost, 610);
    assert.equal(r.body.total_expenses, 10110.55);
    assert.deepEqual([r.body.net_profit, r.body.profitable], [-10110.55, false]);
    assert.ok(r.body.notes.some((n) => /Offline/.test(n)));
    const bad = await t.request('GET', '/api/reports/pnl?from=2026-13-01', { token: owner });
    assert.deepEqual([bad.status, bad.body.details[0].field], [400, 'from']);

    const csv = await t.request('GET', '/api/reports/export/pnl.csv', { token: owner });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /xiaomei-pnl-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}-/);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], 'Section,Line,Amount (PHP)');
    assert.ok(lines.includes('Overheads,Rent,8000'));
    assert.ok(lines.includes('Total,Net loss,-10110.55'));
  });

  it('keeps payment voids and order cancels for the Owner, online only', async () => {
    const pay = await t.request('POST', `/api/orders/${orderId}/payments`, { token: production, body: { amount: 10, payment_type: 'Cash' } });
    // no quote yet: refused, but any id works to check the void route's guards
    assert.equal(pay.status, 422);
    const url = `/api/orders/${orderId}/payments/some-payment/void`;
    for (const token of [admin, production, staff]) assert.equal((await t.request('POST', url, { token, body: { reason: 'Refund' } })).status, 403);
    const noReason = await t.request('POST', url, { token: owner, body: {} });
    assert.deepEqual([noReason.status, noReason.body.details[0].field, noReason.body.message],
      [400, 'void_reason', 'Reason for voiding is required. Please fill it in.']);
    const offline = await t.request('POST', url, { token: owner, body: { reason: 'Refund' } });
    assert.deepEqual([offline.status, offline.body.error], [503, 'VOID_REQUIRES_CLOUD']);
    const forged = await t.request('POST', `/api/orders/${orderId}/payments`, {
      token: owner, body: { amount: 10, payment_type: 'Cash', voids_payment_id: 'x' }
    });
    assert.deepEqual([forged.status, forged.body.details[0].field], [400, 'voids_payment_id'], 'a void is never sent as a plain payment');

    const cancel = await t.request('PATCH', `/api/orders/${orderId}/status`, { token: owner, body: { status: 'Cancelled', cancellation_reason: 'Customer backed out' } });
    assert.deepEqual([cancel.status, cancel.body.error], [503, 'STATUS_CHANGE_REQUIRES_CLOUD']);
    const misplaced = await t.request('PATCH', `/api/orders/${orderId}/status`, { token: owner, body: { status: 'Completed', cancellation_reason: 'x' } });
    assert.deepEqual([misplaced.status, misplaced.body.details[0].field], [400, 'cancellation_reason']);
  });

  it('upgrades an older offline cache for migration 012 without losing rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-012-'));
    const db = await openDb(path.join(dir, 'old.db'));
    try {
      await sqliteRun(db, `CREATE TABLE material_loss (loss_id TEXT PRIMARY KEY, order_id TEXT, inventory_id TEXT, quantity_lost INTEGER NOT NULL,
        loss_reason TEXT NOT NULL, date_recorded DATETIME DEFAULT CURRENT_TIMESTAMP, financial_cost REAL NOT NULL DEFAULT 0.00,
        sync_status TEXT DEFAULT 'synced', last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      await sqliteRun(db, `CREATE TABLE payments (payment_id TEXT PRIMARY KEY, order_id TEXT, amount REAL NOT NULL, payment_date DATETIME,
        payment_type TEXT NOT NULL, sync_status TEXT DEFAULT 'synced', last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      await sqliteRun(db, "INSERT INTO material_loss (loss_id, quantity_lost, loss_reason) VALUES ('l-1', 2, 'Torn')");
      await sqliteRun(db, "INSERT INTO payments (payment_id, order_id, amount, payment_type) VALUES ('p-1', 'o-1', 500, 'Cash')");
      await createLocalSchema(db);
      await ensureLocalSyncColumns(db, SYNC_TABLES.map((s) => s.table), { log: () => {} });
      const [l] = await sqliteAll(db, 'SELECT loss_reason, reason_code, loss_category, production_stage, is_statistical_anomaly FROM material_loss');
      assert.deepEqual(l, { loss_reason: 'Torn', reason_code: null, loss_category: null, production_stage: null, is_statistical_anomaly: 0 });
      const [p] = await sqliteAll(db, 'SELECT amount, voids_payment_id, void_reason FROM payments');
      assert.deepEqual(p, { amount: 500, voids_payment_id: null, void_reason: null });
      const tables = (await sqliteAll(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
      assert.ok(tables.includes('overhead_expenses'));
    } finally {
      await new Promise((resolve) => db.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

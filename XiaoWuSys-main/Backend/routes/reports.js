// ==========================================
// REPORTS: dashboard numbers and Excel / Google Sheets exports
//   GET /api/reports/dashboard                 everyone logged in
//   GET /api/reports/export/inventory.csv      everyone logged in
//   GET /api/reports/export/orders.csv         Owner, Admin
//   GET /api/reports/export/payments.csv       Owner, Admin
//   GET /api/reports/export/waste.csv          Owner, Admin            (PB 20)
//   GET/POST /api/reports/overheads            Owner, Admin            (PB 22)
//   DELETE /api/reports/overheads/:expense_id  Owner, online only      (PB 22)
//   GET /api/reports/pnl, /export/pnl.csv      Owner only              (PB 22 "Magic Button")
// Reads the cloud, or the local cache when offline (the response says which).
// CSV files open directly in Excel (UTF-8 with BOM, so ₱ and ñ display correctly).
// ==========================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { sendDbError, isConnectionError } = require('../utils/dbErrors');
const { localDateTime, createValidator } = require('../utils/validation');
const { LOCAL_NOW } = require('../utils/localSync');
const {
  listRecords, userNames, locateRecord, readLocal, serialize, selectList, withPgTransaction, withLocalTransaction, sqliteRun
} = require('../services/records');
const { paymentSummary, toCentavos, toPesos, needsVerification } = require('../services/domain/payments');
const { can, rolesWith } = require('../services/domain/permissions');
const { deadlineFlag } = require('../services/domain/orderLifecycle');
const { buildInventorySnapshot } = require('../services/inventorySnapshot');
const { loadAllLosses } = require('../services/waste');
const { wasteSummary } = require('../services/domain/wasteReport');
const { computePnl, defaultPeriod, shopDayOf, OVERHEAD_CATEGORIES } = require('../services/domain/pnl');
const { writeAudit, writeAuditLocal } = require('../services/auditLog');

const READ_ROLES = rolesWith('view_orders');
const FINANCE_ROLES = ['Owner', 'Admin'];
const PNL_ROLES = rolesWith('set_quote');            // PB 22: the P&L is the Owner's (SIA 1 "Generate P&L Report")
const OVERHEAD_DELETE_ROLES = rolesWith('void_order'); // removing a recorded expense is a void (Owner)
const DESCRIPTION_MAX = 250; // matches the screen (Web/lib/input-limits.ts EXPENSE_DESCRIPTION_MAX)
const OPEN = (o) => !['Completed', 'Cancelled'].includes(o.production_status);
const MAX_ROWS = 10000;
const round2 = (n) => Math.round(n * 100) / 100;
// Order number for people (PB 6): XM-2026-0123, or the old short id until an offline order syncs
const orderLabel = (o) => {
  if (!o) return '';
  if (o.tracking_no) return o.tracking_no;
  if (o.sync_status && o.sync_status !== 'synced') return 'New order'; // saved offline: numbered when it syncs
  return `#${String(o.order_id).slice(0, 8).toUpperCase()}`;
};

router.use(verifyToken);

// Server-generated timestamps (date_created, payment_date) are UTC; show them in shop time
const toShopTime = (utcText) => (utcText ? localDateTime(new Date(`${utcText}Z`)) : '');
const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Everything the reports need, from one source (cloud, or local when offline)
const loadAll = async (req) => {
  const [orders, payments, customers, items] = await Promise.all([
    listRecords(req, 'order_profiles', { orderBy: 'date_created DESC, order_id', limit: MAX_ROWS }),
    listRecords(req, 'payments', { orderBy: 'payments.payment_date, payments.payment_id', limit: MAX_ROWS * 5 }),
    listRecords(req, 'customers', { orderBy: 'customer_id', limit: MAX_ROWS }),
    listRecords(req, 'order_items', { orderBy: 'line_item_id', limit: MAX_ROWS * 5 })
  ]);
  const paidByOrder = new Map();
  const paymentsByOrder = new Map();
  for (const p of payments.records) {
    paidByOrder.set(p.order_id, round2((paidByOrder.get(p.order_id) || 0) + p.amount));
    paymentsByOrder.set(p.order_id, [...(paymentsByOrder.get(p.order_id) || []), p]);
  }
  // PB 21: payment status per order, from the same rules as the order screen
  const summaryOf = (o) => paymentSummary({ quote: o.total_quote_amount, payments: paymentsByOrder.get(o.order_id) || [] });
  return {
    source: [orders, payments, customers, items].some((r) => r.source === 'local') ? 'local' : 'cloud',
    orders: orders.records,
    payments: payments.records,
    customers: new Map(customers.records.map((c) => [c.customer_id, c])),
    itemsByOrder: items.records.reduce((m, i) => m.set(i.order_id, [...(m.get(i.order_id) || []), i]), new Map()),
    paidByOrder,
    summaryOf
  };
};

// ==========================================
// DASHBOARD
// ==========================================
router.get('/dashboard', requireRole(READ_ROLES), async (req, res) => {
  try {
    const data = await loadAll(req);
    const snapshot = await buildInventorySnapshot(req);
    const wasteData = await loadAllLosses(req);
    const today = localDateTime(new Date()).slice(0, 10);
    const weekAhead = addDays(today, 7);
    const name = (id) => data.customers.get(id)?.full_name || id;

    const brief = (o) => {
      const paid = data.paidByOrder.get(o.order_id) || 0;
      return {
        order_id: o.order_id,
        tracking_no: o.tracking_no, // null until an offline order syncs
        sync_status: o.sync_status,
        customer_name: name(o.customer_id),
        production_status: o.production_status,
        production_deadline: o.production_deadline,
        deadline_flag: deadlineFlag(o), // PB 16: overdue | urgent_24h | warning_72h | normal
        total_quote_amount: o.total_quote_amount || 0,
        total_paid: paid,
        balance: round2((o.total_quote_amount || 0) - paid),
        payment_status: data.summaryOf(o).payment_status
      };
    };
    const open = data.orders.filter(OPEN);
    const byDeadline = (a, b) => String(a.production_deadline).localeCompare(String(b.production_deadline));
    const overdue = open.filter((o) => String(o.production_deadline).slice(0, 10) < today).sort(byDeadline).map(brief);
    const dueSoon = open.filter((o) => {
      const d = String(o.production_deadline).slice(0, 10);
      return d >= today && d <= weekAhead;
    }).sort(byDeadline).map(brief);
    const unpaid = data.orders.filter((o) => o.production_status !== 'Cancelled')
      .map(brief).filter((o) => o.balance > 0).sort((a, b) => b.balance - a.balance);
    // D2: branches that together overpaid while offline. The Owner reviews and refunds by hand.
    // Money figures, so only for accounts that may see finances.
    const overpaid = !can(req.user.role, 'view_finance') ? [] : data.orders
      .map((o) => ({ o, s: data.summaryOf(o) }))
      .filter(({ s }) => s.payment_status === 'Overpaid')
      .map(({ o, s }) => ({ ...brief(o), overpaid_by: s.overpaid_by }))
      .sort((a, b) => b.overpaid_by - a.overpaid_by);

    // Money received per month (shop time), last 6 months including this one
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const income = Object.fromEntries(months.map((m) => [m, 0]));
    for (const p of data.payments) {
      const m = toShopTime(p.payment_date).slice(0, 7);
      if (m in income) income[m] = round2(income[m] + p.amount);
    }

    // Materials used by orders that were not cancelled
    const usage = new Map();
    for (const o of data.orders) {
      if (o.production_status === 'Cancelled') continue;
      for (const it of data.itemsByOrder.get(o.order_id) || []) {
        if (!it.inventory_id) continue;
        const prev = usage.get(it.inventory_id) || { inventory_id: it.inventory_id, item_name: it.product_type, quantity: 0, orders: 0 };
        prev.quantity += it.quantity;
        prev.orders += 1;
        usage.set(it.inventory_id, prev);
      }
    }
    const nameById = new Map(snapshot.items.map((i) => [i.inventory_id, i]));
    const topMaterials = [...usage.values()]
      .map((u) => ({ ...u, item_name: nameById.get(u.inventory_id)?.item_name || u.item_name, unit: nameById.get(u.inventory_id)?.unit || 'pcs' }))
      .sort((a, b) => b.quantity - a.quantity).slice(0, 5);

    // Restock list: bring free stock back up to twice its low-stock alert level
    const restock = snapshot.items
      .filter((i) => i.stock_status !== 'in_stock')
      .map((i) => ({
        inventory_id: i.inventory_id,
        item_name: i.item_name,
        item_category: i.item_category,
        unit: i.unit || 'pcs',
        supplier: i.supplier || null,
        stock_status: i.stock_status,
        quantity_available: i.quantity_available,
        quantity_reserved: i.quantity_reserved,
        free: i.quantity_available_net,
        minimum_threshold: i.minimum_threshold,
        suggested_order: Math.max(1, i.minimum_threshold * 2 - i.quantity_available_net)
      }))
      .sort((a, b) => a.free - b.free || a.item_name.localeCompare(b.item_name));

    const counts = Object.fromEntries(['Pending', 'Approved', 'Printing', 'Pressing', 'Ready', 'Delayed', 'Completed', 'Cancelled']
      .map((st) => [st, data.orders.filter((o) => o.production_status === st).length]));

    // PB 20: this month's waste by cause; costs only for accounts that may see finances
    const ordersById = new Map(data.orders.map((o) => [o.order_id, o]));
    const waste = wasteSummary({
      losses: wasteData.losses,
      month: today.slice(0, 7),
      showCosts: can(req.user.role, 'view_finance'),
      orderLabel: (id) => orderLabel(ordersById.get(id) || { order_id: id })
    });

    res.status(200).json({
      source: [data.source, snapshot.source, wasteData.source].includes('local') ? 'local' : 'cloud',
      generated_at: new Date().toISOString(),
      today,
      orders: {
        total: data.orders.length,
        open: open.length,
        by_status: counts,
        overdue,
        due_this_week: dueSoon,
        unpaid: unpaid.slice(0, 20),
        unpaid_count: unpaid.length,
        outstanding_balance: round2(unpaid.reduce((s, o) => s + o.balance, 0)),
        overpaid,
        overpaid_total: round2(overpaid.reduce((s, o) => s + o.overpaid_by, 0))
      },
      income_by_month: months.map((m) => ({ month: m, amount: income[m] })),
      top_materials: topMaterials,
      inventory: { summary: snapshot.summary, restock },
      waste
    });
  } catch (err) {
    sendDbError(res, err, 'building the dashboard');
  }
});

// ==========================================
// CSV EXPORTS
// ==========================================
// Cells that start with = + - @ (or tab / CR) are prefixed with ' so a spreadsheet shows them
// as text instead of running them as formulas (CSV / formula injection). Numbers stay numbers.
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let text = String(v);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const toCsv = (header, rows) =>
  `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

const sendCsv = (res, base, header, rows, source) => {
  const stamp = localDateTime(new Date()).slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="xiaomei-${base}-${stamp}.csv"`);
  res.set('X-Data-Source', source);
  res.status(200).send(toCsv(header, rows));
};

router.get('/export/inventory.csv', requireRole(READ_ROLES), async (req, res) => {
  try {
    const snap = await buildInventorySnapshot(req);
    const label = { in_stock: 'In Stock', low_stock: 'Low Stock', out_of_stock: 'Out of Stock' };
    sendCsv(res, 'inventory',
      ['Item', 'Category', 'Unit', 'Supplier', 'On hand', 'Reserved', 'Free to use', 'Low-stock alert', 'Status', 'Unit cost (PHP)', 'Stock value (PHP)'],
      snap.items.map((i) => [i.item_name, i.item_category, i.unit || 'pcs', i.supplier || '', i.quantity_available, i.quantity_reserved,
        i.quantity_available_net, i.minimum_threshold, label[i.stock_status] || i.stock_status, i.unit_cost,
        round2(i.quantity_available * i.unit_cost)]),
      snap.source);
  } catch (err) {
    sendDbError(res, err, 'exporting inventory');
  }
});

router.get('/export/orders.csv', requireRole(FINANCE_ROLES), async (req, res) => {
  try {
    const data = await loadAll(req);
    sendCsv(res, 'orders',
      ['Order', 'Created', 'Customer', 'Mobile number', 'From', 'Deadline', 'Status', 'Quote (PHP)', 'Paid (PHP)', 'Balance (PHP)',
        'Payment status', 'Materials / items'],
      data.orders.map((o) => {
        const c = data.customers.get(o.customer_id) || {};
        const paid = data.paidByOrder.get(o.order_id) || 0;
        const lines = (data.itemsByOrder.get(o.order_id) || [])
          .map((i) => `${i.product_type} x${i.quantity}${[i.size, i.custom_name, i.custom_number].filter(Boolean).length ? ` (${[i.size, i.custom_name, i.custom_number].filter(Boolean).join(' ')})` : ''}`)
          .join('; ');
        return [orderLabel(o), toShopTime(o.date_created).replace('T', ' '), c.full_name || o.customer_id,
          c.contact_number || '', c.platform_source || '', String(o.production_deadline || '').slice(0, 10), o.production_status,
          o.total_quote_amount || 0, paid, round2((o.total_quote_amount || 0) - paid), data.summaryOf(o).payment_status, lines];
      }),
      data.source);
  } catch (err) {
    sendDbError(res, err, 'exporting orders');
  }
});

router.get('/export/payments.csv', requireRole(FINANCE_ROLES), async (req, res) => {
  try {
    const data = await loadAll(req);
    const orders = new Map(data.orders.map((o) => [o.order_id, o]));
    const names = await userNames(req, data.payments.map((p) => p.received_by));
    sendCsv(res, 'payments',
      ['Date', 'Receipt no.', 'Order', 'Customer', 'Payment type', 'Amount (PHP)', 'Received by'],
      data.payments.map((p) => [toShopTime(p.payment_date).replace('T', ' '),
        p.receipt_no || 'Given after sync',
        orderLabel(orders.get(p.order_id) || { order_id: p.order_id }),
        data.customers.get(orders.get(p.order_id)?.customer_id)?.full_name || '', p.payment_type, p.amount,
        (p.received_by && names.get(p.received_by)) || 'Not recorded']),
      data.source);
  } catch (err) {
    sendDbError(res, err, 'exporting payments');
  }
});

// PB 20: every material loss with its cost and diagnosed cause
router.get('/export/waste.csv', requireRole(FINANCE_ROLES), async (req, res) => {
  try {
    const [losses, orders] = await Promise.all([
      loadAllLosses(req),
      listRecords(req, 'order_profiles', { orderBy: 'order_id', limit: MAX_ROWS })
    ]);
    const byId = new Map(orders.records.map((o) => [o.order_id, o]));
    sendCsv(res, 'waste',
      ['Date', 'Item', 'Order', 'Quantity lost', 'Unit cost (PHP)', 'Cost (PHP)', 'Reason', 'Reason code', 'Cause', 'Statistical anomaly',
        'Production step', 'Notes'],
      losses.losses.map((l) => {
        const costC = toCentavos(l.financial_cost);
        return [toShopTime(l.date_recorded).replace('T', ' '), l.item_name, l.order_id ? orderLabel(byId.get(l.order_id) || { order_id: l.order_id }) : '',
          l.quantity_lost, l.quantity_lost > 0 ? toPesos(Math.round(costC / l.quantity_lost)) : 0, toPesos(costC),
          l.reason_label || '', l.reason_code || '', l.category_label, l.is_statistical_anomaly ? 'Yes' : 'No', l.production_stage || '',
          l.loss_reason || ''];
      }),
      [losses.source, orders.source].includes('local') ? 'local' : 'cloud');
  } catch (err) {
    sendDbError(res, err, 'exporting waste');
  }
});

// ==========================================
// OVERHEAD EXPENSES (PB 22)
// GET    /api/reports/overheads?from=YYYY-MM-DD&to=YYYY-MM-DD   (default: this month so far)
//   -> { source, period, expenses: [{ ...expense, recorded_by_name, can_delete }], total, by_category,
//        categories, can_delete }
// POST   /api/reports/overheads   { expense_date, category, description, amount }
//   Cloud first; offline (connection error only) it is saved here and synced later.
//   -> 201 { message, source, expense }
// DELETE /api/reports/overheads/:expense_id   Owner only, online only (audit_log 'overhead_deleted')
// ==========================================
const readPeriod = (req, res) => {
  const v = createValidator();
  const fallback = defaultPeriod();
  const from = v.shopDay(req.query.from, 'from', { required: false }) || fallback.from;
  const to = v.shopDay(req.query.to, 'to', { required: false }) || fallback.to;
  if (!v.failed() && from > to) {
    v.errors.push({ field: 'from', message: 'Start date must be on or before the end date.' });
  }
  if (v.failed()) {
    v.send(res);
    return null;
  }
  return { from, to };
};

const sumByCategory = (rows) => {
  const by = new Map();
  for (const r of rows) by.set(r.category, (by.get(r.category) || 0) + toCentavos(r.amount));
  return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category, c]) => ({ category, amount: toPesos(c) }));
};

router.get('/overheads', requireRole(FINANCE_ROLES), async (req, res) => {
  const period = readPeriod(req, res);
  if (!period) return;
  try {
    const list = await listRecords(req, 'overhead_expenses', { orderBy: 'expense_date DESC, expense_id', limit: MAX_ROWS });
    const rows = list.records.filter((e) => {
      const day = String(e.expense_date || '').slice(0, 10);
      return day >= period.from && day <= period.to;
    });
    const names = await userNames(req, rows.map((e) => e.recorded_by));
    const mayDelete = can(req.user.role, 'void_order');
    res.status(200).json({
      source: list.source,
      period,
      expenses: rows.map((e) => ({
        ...e,
        recorded_by_name: (e.recorded_by && names.get(e.recorded_by)) || 'Not recorded',
        can_delete: mayDelete && e.sync_status === 'synced'
      })),
      total: toPesos(rows.reduce((s, e) => s + toCentavos(e.amount), 0)),
      by_category: sumByCategory(rows),
      categories: OVERHEAD_CATEGORIES,
      can_delete: mayDelete
    });
  } catch (err) {
    sendDbError(res, err, 'listing overhead expenses');
  }
});

router.post('/overheads', requireRole(FINANCE_ROLES), async (req, res) => {
  const body = req.body || {};
  const v = createValidator();
  const today = localDateTime(new Date()).slice(0, 10);
  const day = v.shopDay(body.expense_date, 'expense_date', { latest: today });
  const category = v.oneOf(body.category, 'category', OVERHEAD_CATEGORIES);
  const description = v.requiredString(body.description, 'description', DESCRIPTION_MAX);
  const amount = v.positiveMoney(body.amount, 'amount');
  for (const field of ['recorded_by', 'expense_id']) {
    if (body[field] !== undefined) v.errors.push({ field, message: 'This is filled in by the system. Remove it and try again.' });
  }
  if (v.failed()) return v.send(res);

  const expense_id = crypto.randomUUID();
  const expense_date = `${day} 00:00:00`; // a shop day, stored as Manila wall time like deadlines
  const recorded_by = req.user.user_id;
  const audit = { entity: 'overhead_expenses', entity_id: expense_id, action: 'overhead_recorded', actor: req.user,
    details: { expense_date: day, category, description, amount } };

  const inCloud = () => withPgTransaction(req.pgPool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO overhead_expenses (expense_id, expense_date, category, description, amount, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${selectList('overhead_expenses', 'pg')}`,
      [expense_id, expense_date, category, description, amount, recorded_by]);
    await writeAudit(client, audit);
    return { source: 'cloud', expense: serialize('overhead_expenses', rows[0]) };
  });
  const locally = () => withLocalTransaction(req.localDbPath, async (tx) => {
    await sqliteRun(tx,
      `INSERT INTO overhead_expenses (expense_id, expense_date, category, description, amount, recorded_by, sync_status, last_modified)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
      [expense_id, expense_date, category, description, amount, recorded_by]);
    await writeAuditLocal(tx, audit);
    return { source: 'local', expense: await readLocal(tx, 'overhead_expenses', expense_id) };
  });

  try {
    let result;
    try {
      result = await inCloud();
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      if (err.commitUnknown) {
        return res.status(503).json({
          error: 'COMMIT_UNKNOWN',
          message: 'The connection to the cloud dropped while saving. Reload the list to see whether the expense was saved before trying again.'
        });
      }
      result = await locally(); // C5: genuine outage only
    }
    res.status(201).json({
      message: result.source === 'cloud' ? 'Expense recorded.' : 'Expense saved on this computer (offline). It will be sent to the cloud when the connection is back.',
      source: result.source,
      expense: result.expense
    });
  } catch (err) {
    sendDbError(res, err, 'recording an overhead expense');
  }
});

router.delete('/overheads/:expense_id', requireRole(OVERHEAD_DELETE_ROLES), async (req, res) => {
  const v = createValidator();
  const expense_id = v.id(req.params.expense_id, 'expense_id');
  if (v.failed()) return v.send(res);
  const needsCloud = {
    error: 'OVERHEAD_DELETE_REQUIRES_CLOUD',
    message: 'Removing an expense needs the cloud connection, so every branch sees the same totals. Try again when online.'
  };
  try {
    const located = await locateRecord(req, 'overhead_expenses', expense_id);
    if (!located.location) return res.status(404).json({ error: 'EXPENSE_NOT_FOUND', message: 'We could not find this expense. Reload the list.' });
    if (!located.cloudReachable) return res.status(503).json(needsCloud);
    if (located.location === 'local') {
      return res.status(409).json({
        error: 'EXPENSE_NOT_SYNCED',
        message: 'This expense was saved offline and is not in the cloud yet. Sync first, then remove it.'
      });
    }
    const removed = await withPgTransaction(req.pgPool, async (client) => {
      const { rows } = await client.query(
        `SELECT ${selectList('overhead_expenses', 'pg')} FROM overhead_expenses WHERE expense_id = $1 FOR UPDATE`, [expense_id]);
      if (rows.length === 0) return null;
      const before = serialize('overhead_expenses', rows[0]);
      await client.query('DELETE FROM overhead_expenses WHERE expense_id = $1', [expense_id]);
      await writeAudit(client, {
        entity: 'overhead_expenses', entity_id: expense_id, action: 'overhead_deleted', actor: req.user,
        details: { before: { expense_date: before.expense_date, category: before.category, description: before.description, amount: before.amount } }
      });
      return before;
    });
    if (!removed) return res.status(404).json({ error: 'EXPENSE_NOT_FOUND', message: 'We could not find this expense. Reload the list.' });
    await sqliteRun(req.localDb, 'DELETE FROM overhead_expenses WHERE expense_id = ?', [expense_id])
      .catch((err) => console.error('⚠️ Could not remove the local copy of an expense:', err.message));
    res.status(200).json({ message: 'Expense removed.', source: 'cloud', expense_id });
  } catch (err) {
    if (isConnectionError(err)) {
      return res.status(503).json(err.commitUnknown
        ? { error: 'COMMIT_UNKNOWN', message: 'The connection dropped while removing. Reload the list to see whether it was removed.' }
        : needsCloud);
    }
    sendDbError(res, err, 'removing an overhead expense');
  }
});

// ==========================================
// TRUE-COST PROFIT & LOSS, the Owner's "Magic Button" (PB 22)
// GET /api/reports/pnl?from=YYYY-MM-DD&to=YYYY-MM-DD   (default: this month so far, shop time)
// GET /api/reports/export/pnl.csv?from=...&to=...
// Owner only (403 for Admin, Production, Staff). The maths is services/domain/pnl.js.
// -> { source, generated_at, period, gross_income, voids_in_period, discounts_given, cogs_blanks,
//      cogs_consumables, total_cogs, waste_cost, waste_by_category, overhead_cost,
//      overhead_by_category, total_expenses, net_profit, profitable, counts, notes }
// ==========================================
const buildPnl = async (req, period) => {
  const big = MAX_ROWS * 5;
  const [payments, orders, items, completions, consumables, losses, overheads, inventory] = await Promise.all([
    listRecords(req, 'payments', { orderBy: 'payments.payment_date, payments.payment_id', limit: big }),
    listRecords(req, 'order_profiles', { orderBy: 'order_id', limit: MAX_ROWS }),
    listRecords(req, 'order_items', { orderBy: 'line_item_id', limit: big }),
    listRecords(req, 'order_status_history', { filters: [['to_status', 'Completed']], orderBy: 'history_id', limit: big }),
    listRecords(req, 'order_consumables_log', { orderBy: 'log_id', limit: big }),
    listRecords(req, 'material_loss', { orderBy: 'loss_id', limit: big }),
    listRecords(req, 'overhead_expenses', { orderBy: 'expense_id', limit: big }),
    listRecords(req, 'inventory_items', { orderBy: 'inventory_id', limit: big }) // Recycle Bin items keep their cost
  ]);
  const all = [payments, orders, items, completions, consumables, losses, overheads, inventory];
  const pnl = computePnl({
    from: period.from,
    to: period.to,
    payments: payments.records,
    orders: orders.records,
    orderItems: items.records,
    completions: completions.records,
    consumablesLog: consumables.records,
    losses: losses.records,
    overheads: overheads.records,
    unitCosts: new Map(inventory.records.map((i) => [i.inventory_id, i.unit_cost]))
  });
  const pending = payments.records.filter((p) => {
    const day = shopDayOf(p.payment_date);
    return p.sync_status !== 'synced' && day && day >= period.from && day <= period.to;
  }).length;
  const source = all.some((r) => r.source === 'local') ? 'local' : 'cloud';
  return {
    source,
    generated_at: new Date().toISOString(),
    ...pnl,
    notes: [
      'Costs use each item’s unit cost when the order was completed or the consumable was taken (today’s catalog cost for older records).',
      'Blanks are counted when their order is marked Completed.',
      ...(source === 'local' ? ['Offline: this is this computer’s copy. Generate it again when online for every branch’s figures.'] : []),
      ...(pending > 0 ? [`${pending} payment(s) saved offline are included and will sync later.`] : [])
    ]
  };
};

router.get('/pnl', requireRole(PNL_ROLES), async (req, res) => {
  const period = readPeriod(req, res);
  if (!period) return;
  try {
    res.status(200).json(await buildPnl(req, period));
  } catch (err) {
    sendDbError(res, err, 'building the profit and loss report');
  }
});

router.get('/export/pnl.csv', requireRole(PNL_ROLES), async (req, res) => {
  const period = readPeriod(req, res);
  if (!period) return;
  try {
    const p = await buildPnl(req, period);
    const rows = [
      ['Period', `${p.period.from} to ${p.period.to}`, ''],
      ['Income', 'Payments received (after voids)', p.gross_income],
      ['Income', 'Voided payments in the period', -p.voids_in_period],
      ['Info', 'Discounts given (already taken off the quotes)', p.discounts_given],
      ['Cost of goods', 'Blanks used (completed orders)', p.cogs_blanks],
      ['Cost of goods', 'Consumables used', p.cogs_consumables],
      ['Cost of goods', 'Total cost of goods', p.total_cogs],
      ...p.waste_by_category.map((w) => ['Material waste', w.category, w.amount]),
      ['Material waste', 'Total material waste', p.waste_cost],
      ...p.overhead_by_category.map((o) => ['Overheads', o.category, o.amount]),
      ['Overheads', 'Total overheads', p.overhead_cost],
      ['Total', 'Total expenses', p.total_expenses],
      ['Total', p.profitable ? 'Net profit' : 'Net loss', p.net_profit],
      ...p.notes.map((n) => ['Note', n, ''])
    ];
    sendCsv(res, `pnl-${p.period.from}-to-${p.period.to}`, ['Section', 'Line', 'Amount (PHP)'], rows, p.source);
  } catch (err) {
    sendDbError(res, err, 'exporting the profit and loss report');
  }
});

// ==========================================
// MIGRATION 015 REPORTS (Finance and Waste pages)
// GET /api/reports/payments?month=YYYY-MM          Owner, Admin
//   ?until=YYYY-MM (default this month): the last month of the 12-month list
//   -> { source, month, until, current_month, months: [{ month, received, refunded, voided, net, count }] (12 ending at until),
//        detail: { month, payments: [{ ...payment, order_label, customer_name, received_by_name, kind, needs_verification }],
//                  by_method: [{ payment_type, count, amount }], received, refunded, net, unverified,
//                  billed: orders created this month (not cancelled), collected_on_those, progress_percent } }
// GET /api/reports/waste?from=&to=   (default this month)   every account; costs for Owner / Admin
//   -> { source, period, totals: { count, quantity, cost }, by_category, by_item, by_order, by_day, losses }
// GET /api/reports/transactions?month=YYYY-MM     Owner, Admin
//   -> { source, month, entries: [{ date, kind, label, reference, amount, direction: 'in' | 'out' }],
//        totals: { money_in, refunds, expenses, purchases, net } }   (purchases = stock in, needs the cloud)
// ==========================================
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const readMonth = (req, res, name = 'month') => {
  const m = req.query[name];
  if (m === undefined || m === '') return localDateTime(new Date()).slice(0, 7);
  if (typeof m !== 'string' || !MONTH_PATTERN.test(m) || m < '2018-01' || m > '2034-12') {
    res.status(400).json({ error: 'VALIDATION_FAILED', message: 'Month must look like 2026-11.', details: [{ field: name, message: 'Month must look like 2026-11.' }] });
    return null;
  }
  return m;
};
const lastMonths = (month, n) => {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
};
const kindOf = (p) => (p.is_refund ? 'Refund' : p.voids_payment_id ? 'Void' : 'Payment');

router.get('/payments', requireRole(FINANCE_ROLES), async (req, res) => {
  const month = readMonth(req, res);
  if (!month) return;
  // The 12-month list ends at ?until= (default: this month), NOT at the month opened, so opening an
  // old month no longer pushes the list back a year with no way to return
  const until = readMonth(req, res, 'until');
  if (!until) return;
  try {
    const data = await loadAll(req);
    const months = lastMonths(until, 12);
    const per = Object.fromEntries(months.map((m) => [m, { receivedC: 0, refundedC: 0, voidedC: 0, count: 0 }]));
    const monthOf = (p) => (shopDayOf(p.payment_date) || '').slice(0, 7);
    for (const p of data.payments) {
      const m = monthOf(p);
      if (!per[m]) continue;
      const c = toCentavos(p.amount);
      if (p.is_refund) per[m].refundedC += -c;
      else if (p.voids_payment_id) per[m].voidedC += -c;
      else { per[m].receivedC += c; per[m].count += 1; }
    }
    const ordersById = new Map(data.orders.map((o) => [o.order_id, o]));
    const inMonth = data.payments.filter((p) => monthOf(p) === month)
      .sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)));
    const names = await userNames(req, inMonth.map((p) => p.received_by));
    const byMethod = new Map();
    let unverified = 0;
    for (const p of inMonth) {
      if (kindOf(p) !== 'Payment') continue;
      const g = byMethod.get(p.payment_type) || { payment_type: p.payment_type, count: 0, amountC: 0 };
      g.count += 1;
      g.amountC += toCentavos(p.amount);
      byMethod.set(p.payment_type, g);
      if (needsVerification(p)) unverified += 1;
    }
    // Collection progress: what orders created this month were billed, and how much of it is in
    const created = data.orders.filter((o) => (shopDayOf(o.date_created) || '').slice(0, 7) === month && o.production_status !== 'Cancelled');
    const billedC = created.reduce((s, o) => s + toCentavos(o.total_quote_amount), 0);
    const collectedC = created.reduce((s, o) => s + Math.max(0, toCentavos(data.summaryOf(o).total_paid)), 0);
    // The opened month's totals from its own payments (it may be outside the 12-month list)
    const p0 = { receivedC: 0, refundedC: 0, voidedC: 0 };
    for (const p of inMonth) {
      const c = toCentavos(p.amount);
      if (p.is_refund) p0.refundedC += -c;
      else if (p.voids_payment_id) p0.voidedC += -c;
      else p0.receivedC += c;
    }
    res.status(200).json({
      source: data.source,
      month,
      until,
      current_month: localDateTime(new Date()).slice(0, 7),
      months: months.map((m) => ({
        month: m, received: toPesos(per[m].receivedC), refunded: toPesos(per[m].refundedC), voided: toPesos(per[m].voidedC),
        net: toPesos(per[m].receivedC - per[m].refundedC - per[m].voidedC), count: per[m].count
      })),
      detail: {
        month,
        payments: inMonth.map((p) => {
          const o = ordersById.get(p.order_id);
          return {
            ...p,
            kind: kindOf(p),
            order_label: orderLabel(o || { order_id: p.order_id }),
            customer_name: o ? (data.customers.get(o.customer_id)?.full_name || 'Unknown customer') : 'Unknown customer',
            received_by_name: (p.received_by && names.get(p.received_by)) || 'Not recorded',
            needs_verification: needsVerification(p)
          };
        }),
        by_method: [...byMethod.values()].sort((a, b) => b.amountC - a.amountC).map((g) => ({ payment_type: g.payment_type, count: g.count, amount: toPesos(g.amountC) })),
        received: toPesos(p0.receivedC),
        refunded: toPesos(p0.refundedC),
        voided: toPesos(p0.voidedC),
        net: toPesos(p0.receivedC - p0.refundedC - p0.voidedC),
        unverified,
        billed: toPesos(billedC),
        collected_on_those: toPesos(collectedC),
        progress_percent: billedC > 0 ? Math.min(100, Math.round((collectedC / billedC) * 100)) : null,
        orders_created: created.length
      }
    });
  } catch (err) {
    sendDbError(res, err, 'building the payments report');
  }
});

router.get('/waste', requireRole(READ_ROLES), async (req, res) => {
  const period = readPeriod(req, res);
  if (!period) return;
  try {
    const [wasteData, orders] = await Promise.all([
      loadAllLosses(req),
      listRecords(req, 'order_profiles', { orderBy: 'order_id', limit: MAX_ROWS })
    ]);
    const showCosts = can(req.user.role, 'view_finance');
    const money = (c) => (showCosts ? toPesos(c) : null);
    const byId = new Map(orders.records.map((o) => [o.order_id, o]));
    const rows = wasteData.losses.filter((l) => {
      const day = shopDayOf(l.date_recorded);
      return day && day >= period.from && day <= period.to;
    });
    const group = (keyOf, labelOf) => {
      const m = new Map();
      for (const l of rows) {
        const key = keyOf(l);
        if (key === null) continue;
        const g = m.get(key) || { key, label: labelOf(l), count: 0, quantity: 0, costC: 0 };
        g.count += 1;
        g.quantity += Number(l.quantity_lost) || 0;
        g.costC += toCentavos(l.financial_cost);
        m.set(key, g);
      }
      return [...m.values()].sort((a, b) => b.costC - a.costC || b.quantity - a.quantity)
        .map((g) => ({ key: g.key, label: g.label, count: g.count, quantity: g.quantity, cost: money(g.costC) }));
    };
    const totalC = rows.reduce((s, l) => s + toCentavos(l.financial_cost), 0);
    res.status(200).json({
      source: [wasteData.source, orders.source].includes('local') ? 'local' : 'cloud',
      period,
      costs_visible: showCosts,
      totals: { count: rows.length, quantity: rows.reduce((s, l) => s + (Number(l.quantity_lost) || 0), 0), cost: money(totalC) },
      by_category: group((l) => l.category_label || 'Not classified', (l) => l.category_label || 'Not classified'),
      by_item: group((l) => l.inventory_id, (l) => l.item_name),
      by_order: group((l) => l.order_id || null, (l) => orderLabel(byId.get(l.order_id) || { order_id: l.order_id })),
      by_day: group((l) => shopDayOf(l.date_recorded), (l) => shopDayOf(l.date_recorded)).sort((a, b) => a.key.localeCompare(b.key)),
      losses: rows.map((l) => ({
        ...l,
        order_label: l.order_id ? orderLabel(byId.get(l.order_id) || { order_id: l.order_id }) : null,
        financial_cost: money(toCentavos(l.financial_cost))
      }))
    });
  } catch (err) {
    sendDbError(res, err, 'building the waste report');
  }
});

router.get('/transactions', requireRole(FINANCE_ROLES), async (req, res) => {
  const month = readMonth(req, res);
  if (!month) return;
  try {
    const data = await loadAll(req);
    const overheads = await listRecords(req, 'overhead_expenses', { orderBy: 'expense_date, expense_id', limit: MAX_ROWS });
    const ordersById = new Map(data.orders.map((o) => [o.order_id, o]));
    const entries = [];
    for (const p of data.payments) {
      if ((shopDayOf(p.payment_date) || '').slice(0, 7) !== month) continue;
      const o = ordersById.get(p.order_id);
      const kind = kindOf(p);
      entries.push({
        date: toShopTime(p.payment_date),
        kind,
        label: `${kind === 'Payment' ? 'Payment' : kind === 'Refund' ? 'Refund' : 'Voided payment'}: ${o ? (data.customers.get(o.customer_id)?.full_name || '') : ''}`.trim(),
        reference: [p.receipt_no, orderLabel(o || { order_id: p.order_id })].filter(Boolean).join(' · '),
        method: p.payment_type,
        amount: Math.abs(p.amount),
        direction: p.amount >= 0 ? 'in' : 'out'
      });
    }
    for (const e of overheads.records) {
      if (String(e.expense_date).slice(0, 7) !== month) continue;
      entries.push({ date: e.expense_date, kind: 'Expense', label: `${e.category}: ${e.description}`, reference: null, method: null, amount: e.amount, direction: 'out' });
    }
    let purchasesAvailable = true;
    try {
      const from = `${month}-01`;
      // A day either side of the month (UTC vs shop time), then filtered by the shop day below
      const { rows } = await req.pgPool.query(
        `SELECT d.document_no, d.total_cost::text AS total_cost, to_char(d.occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS occurred_at, s.supplier_name
           FROM stock_documents d LEFT JOIN suppliers s ON s.supplier_id = d.supplier_id
          WHERE d.document_type = 'stock_in' AND d.voided_at IS NULL
            AND d.occurred_at >= ($1::date - INTERVAL '1 day') AND d.occurred_at < ($1::date + INTERVAL '32 days')`, [from]);
      for (const r of rows) {
        const day = shopDayOf(r.occurred_at) || '';
        if (day.slice(0, 7) !== month) continue;
        entries.push({
          date: toShopTime(r.occurred_at), kind: 'Purchase', label: `Stock in from ${r.supplier_name || 'a supplier'}`,
          reference: r.document_no, method: null, amount: Math.round(Number(r.total_cost) * 100) / 100, direction: 'out'
        });
      }
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      purchasesAvailable = false;
    }
    entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const sum = (pred) => toPesos(entries.filter(pred).reduce((s, e) => s + toCentavos(e.amount), 0));
    const moneyIn = sum((e) => e.kind === 'Payment');
    const refunds = sum((e) => e.kind === 'Refund' || e.kind === 'Void');
    const expenses = sum((e) => e.kind === 'Expense');
    const purchases = sum((e) => e.kind === 'Purchase');
    res.status(200).json({
      source: purchasesAvailable ? data.source : 'local',
      month,
      purchases_available: purchasesAvailable,
      entries,
      totals: {
        money_in: moneyIn, refunds, expenses, purchases,
        net: toPesos(toCentavos(moneyIn) - toCentavos(refunds) - toCentavos(expenses) - toCentavos(purchases))
      }
    });
  } catch (err) {
    sendDbError(res, err, 'building the monthly transactions');
  }
});

router.toCsv = toCsv; // for tests
module.exports = router;

// ==========================================
// REPORTS: dashboard numbers and Excel / Google Sheets exports
//   GET /api/reports/dashboard                 everyone logged in
//   GET /api/reports/export/inventory.csv      everyone logged in
//   GET /api/reports/export/orders.csv         Owner, Admin
//   GET /api/reports/export/payments.csv       Owner, Admin
// Reads the cloud, or the local cache when offline (the response says which).
// CSV files open directly in Excel (UTF-8 with BOM, so ₱ and ñ display correctly).
// ==========================================
const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { sendDbError } = require('../utils/dbErrors');
const { localDateTime } = require('../utils/validation');
const { listRecords, userNames } = require('../services/records');
const { paymentSummary } = require('../services/domain/payments');
const { can } = require('../services/domain/permissions');
const { buildInventorySnapshot } = require('../services/inventorySnapshot');

const READ_ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
const FINANCE_ROLES = ['Owner', 'Admin'];
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

    const counts = Object.fromEntries(['Pending', 'Approved', 'Printing', 'Delayed', 'Completed', 'Cancelled']
      .map((st) => [st, data.orders.filter((o) => o.production_status === st).length]));

    res.status(200).json({
      source: data.source === 'local' || snapshot.source === 'local' ? 'local' : 'cloud',
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
      inventory: { summary: snapshot.summary, restock }
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

router.toCsv = toCsv; // for tests
module.exports = router;

const express = require('express');
const crypto = require('crypto'); // Built-in Node module for generating UUIDs
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { normalizeRequiredItems, computeAvailable, evaluateCapacity } = require('../services/capacity');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { validateDriveLink } = require('../utils/validateDriveLink');
const { LOCAL_NOW, PG_VERSION_FORMAT, offlineUpdateBookkeeping } = require('../utils/localSync');
const { createValidator, PAYMENT_TYPES, PRODUCTION_STATUSES } = require('../utils/validation');
const {
  selectList, serialize, listRecords, getRecord, locateRecord, readLocal, userNames, sqliteRun, sqliteAll, sqliteGet,
  withPgTransaction, withLocalTransaction, ACTIVE_ITEM_SQL
} = require('../services/records');
const { withAvailability } = require('../services/inventorySnapshot');
const { rolesWith, can, capabilitiesFor, outranks } = require('../services/domain/permissions');
const {
  STATUS_TRANSITIONS, CLOSED_STATUSES, EDITABLE_STATUSES, QUOTE_FROZEN_STATUSES, APPROVABLE_STATUSES, capabilityForTransition, allowedActions,
  withDeadlineFlag, deadlineWindows
} = require('../services/domain/orderLifecycle');
const { writeAudit, writeAuditLocal } = require('../services/auditLog');
const { computeQuote, quoteBreakdown, quoteLines, manualQuoteColumns, DISCOUNT_REASON_MAX } = require('../services/domain/pricing');
const { planConsumables, applyConsumables, consumablesSentence, loadOrderConsumables } = require('../services/consumables');
const { needsReservation, stockNeeds, buildStockCheck } = require('../services/domain/stockCheck');
const {
  paymentSummary, runningTotals, checkPayment, downpaymentWarnings, toCentavos, toPesos, pesoText
} = require('../services/domain/payments');

const VERSION_SQL = `to_char(last_modified, '${PG_VERSION_FORMAT}')`;
const READ_ROLES = rolesWith('view_orders');
const WRITE_ROLES = rolesWith('edit_order');
const APPROVE_ROLES = rolesWith('approve_order'); // PB 13: only an Owner may approve a job order (§4.3)

// PB 2: only the Owner sets or changes a quote, and only the Owner voids (cancels) an order
const quoteOwnerOnly = (res) => res.status(403).json({
  error: 'QUOTE_OWNER_ONLY',
  message: 'Only the Owner can set or change the quote. Ask the Owner to enter the price.'
});
const voidOwnerOnly = (res) => res.status(403).json({
  error: 'VOID_OWNER_ONLY',
  message: 'Only the Owner can cancel an order. Ask the Owner to cancel it.'
});

// Business-rule failure inside a transaction: rolled back, then sent as-is
class Rejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const pushStockChange = (req, ids, reason) => {
  if (req.inventoryEvents && ids.length > 0) req.inventoryEvents.notifyChanged(ids, reason);
};
// PB 14: live "order_updated" to every screen. Call only AFTER the write is committed.
const pushOrderChange = (req, order) => {
  if (req.orderEvents && order) req.orderEvents.notifyUpdated(order);
};

// ---- PB 5: who last changed an order, and replacing a lower rank's conflicting change ----
// Always from the verified login token
const EDITOR_FIELDS = ['last_edited_by', 'last_edited_role'];
const editorOf = (req) => [req.user.user_id, req.user.role];

// May this account replace the change that caused the conflict? Strictly higher rank than
// the order's last editor, and never on a closed order.
const canOverride = (req, current) => Boolean(current)
  && !CLOSED_STATUSES.includes(current.production_status)
  && outranks(req.user.role, current.last_edited_role);

const editConflict = (req, current, message) => ({
  error: 'EDIT_CONFLICT',
  message,
  current: withDeadlineFlag(current),
  can_override: canOverride(req, current)
});

const COMMIT_UNKNOWN = {
  error: 'COMMIT_UNKNOWN',
  message: 'The connection to the cloud dropped while saving. Reload the order to see whether the change was applied.'
};

// The caller confirmed "replace their changes with mine" (override: true) after a 409 that
// said can_override. One transaction: lock the order, check the rank again on the locked row
// (from the login token), apply, and record before / after in audit_log.
//   guard(lockedOrder) -> null, or { status, body } when the order no longer accepts this change
// -> { before, after }
const overrideInCloud = (req, order_id, updates, guard = () => null) => withPgTransaction(req.pgPool, async (client) => {
  const { rows } = await client.query(
    `SELECT ${selectList('order_profiles', 'pg')} FROM order_profiles WHERE order_id = $1 FOR UPDATE`, [order_id]);
  if (rows.length === 0) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: NOT_FOUND_TEXT.Order });
  const before = serialize('order_profiles', rows[0]);
  if (!outranks(req.user.role, before.last_edited_role)) {
    throw new Rejected(403, {
      error: 'OVERRIDE_NOT_ALLOWED',
      message: 'You can only replace changes made by an account with a lower role than yours. Reload the order and try again.',
      current: withDeadlineFlag(before)
    });
  }
  const problem = guard(before);
  if (problem) throw new Rejected(problem.status, problem.body);

  const fields = Object.keys(updates);
  const updated = await client.query(
    `UPDATE order_profiles
        SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')},
            last_edited_by = $${fields.length + 2}, last_edited_role = $${fields.length + 3}
      WHERE order_id = $1 RETURNING ${selectList('order_profiles', 'pg')}`,
    [order_id, ...fields.map((f) => updates[f]), ...editorOf(req)]);
  const after = serialize('order_profiles', updated.rows[0]);
  const snapshot = (order) => Object.fromEntries([...fields, ...EDITOR_FIELDS, 'version'].map((f) => [f, order[f]]));
  await writeAudit(client, {
    entity: 'order_profiles',
    entity_id: order_id,
    action: 'conflict_override',
    actor: req.user,
    details: { fields, before: snapshot(before), after: snapshot(after) }
  });
  return { before, after };
});

// The money fields of an order, for the audit trail of a quote change
const QUOTE_FIELDS = ['total_quote_amount', 'subtotal_amount', 'discount_amount', 'discount_reason'];
const quoteFieldsOf = (order) => (order ? Object.fromEntries([...QUOTE_FIELDS, 'version'].map((f) => [f, order[f] ?? null])) : null);

// After the override is committed: refresh every screen and tell the account whose change was replaced
const announceOverride = (req, { before, after }) => {
  pushOrderChange(req, after);
  if (req.orderEvents && before.last_edited_by && before.last_edited_by !== req.user.user_id) {
    req.orderEvents.notifyOverridden({
      user_id: before.last_edited_by,
      order_id: after.order_id,
      tracking_no: after.tracking_no,
      overridden_by_role: req.user.role
    });
  }
  console.log(`⚖️  Order ${after.order_id}: ${req.user.user_id} (${req.user.role}) replaced a change by ${before.last_edited_by || 'an unknown account'} (${before.last_edited_role || 'unknown role'})`);
};

// PB 14: one row per status change, in the same transaction as the change
const recordStatusChange = (client, req, order_id, from, to) => client.query(
  `INSERT INTO order_status_history (history_id, order_id, from_status, to_status, changed_by, changed_role)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [crypto.randomUUID(), order_id, from || null, to, ...editorOf(req)]);

// The order's status timeline, oldest first, with each account's name -> { source, history }
const loadStatusHistory = async (req, order_id) => {
  const list = await listRecords(req, 'order_status_history', {
    filters: [['order_id', order_id]], orderBy: 'order_status_history.changed_at, order_status_history.history_id'
  });
  const names = await userNames(req, list.records.map((h) => h.changed_by));
  return {
    source: list.source,
    history: list.records.map((h) => ({
      history_id: h.history_id,
      from_status: h.from_status,
      to_status: h.to_status,
      changed_by_name: (h.changed_by && names.get(h.changed_by)) || NOT_RECORDED,
      changed_role: h.changed_role,
      changed_at: h.changed_at
    }))
  };
};
const shortageRejection = (shortages, source) => new Rejected(409, {
  error: 'INSUFFICIENT_INVENTORY',
  can_fulfill: false,
  message: 'There is not enough stock for this order right now.',
  shortages,
  total_shortfall: shortages.reduce((sum, x) => sum + x.shortfall, 0),
  source
});
const missingItemsRejection = (ids, source) => new Rejected(404, {
  error: 'INVENTORY_ITEM_NOT_FOUND',
  message: 'One or more chosen materials are no longer in the inventory (they may have been deleted). Please choose the materials again.',
  missing_inventory_ids: ids,
  source
});
// Compares locked stock rows against the needed quantities -> { missing, shortages }
const checkStock = (needs, rowsById) => {
  const missing = [];
  const shortages = [];
  for (const { inventory_id, quantity_needed } of needs) {
    const row = rowsById.get(inventory_id);
    if (!row) { missing.push(inventory_id); continue; }
    const available = computeAvailable(row);
    if (quantity_needed > available) {
      shortages.push({ inventory_id, item_name: row.item_name, requested: quantity_needed, available, shortfall: quantity_needed - available });
    }
  }
  return { missing, shortages };
};

// ---- Payments as shown to people (PB 21) ----
const NOT_RECORDED = 'Not recorded';
// Stable sort: payments in the same second keep the database order (full timestamp precision)
const byPaymentDate = (a, b) => String(a.payment_date || '').localeCompare(String(b.payment_date || ''));

// The order's payments (oldest first) with the receiver's name and the totals right after each
// one (for the printable acknowledgement), plus the order's payment summary.
// -> { source, payments, summary }
const loadPaymentView = async (req, order) => {
  // Qualified names: a bare payment_date would sort by the SELECT alias, which is cut to whole seconds
  const list = await listRecords(req, 'payments', {
    filters: [['order_id', order.order_id]], orderBy: 'payments.payment_date, payments.payment_id'
  });
  const payments = [...list.records].sort(byPaymentDate);
  const names = await userNames(req, payments.map((p) => p.received_by));
  const running = runningTotals({ quote: order.total_quote_amount, payments });
  return {
    source: list.source,
    summary: paymentSummary({ quote: order.total_quote_amount, payments }),
    payments: payments.map((p, i) => ({
      ...p,
      received_by_name: (p.received_by && names.get(p.received_by)) || NOT_RECORDED,
      paid_to_date: running[i].paid_to_date,
      remaining_after: running[i].remaining_after,
      status_after: running[i].status_after
    }))
  };
};

// "totals" money fields of an order response. balance keeps its old meaning (quote - paid,
// negative when overpaid); remaining never goes below 0.
const paymentTotals = (order, summary) => ({
  total_paid: summary.total_paid,
  balance: toPesos(toCentavos(order.total_quote_amount) - toCentavos(summary.total_paid)),
  remaining: summary.remaining,
  overpaid_by: summary.overpaid_by,
  payment_status: summary.payment_status,
  downpayment: summary.downpayment
});

// Statuses staff can log when an order is halted for insufficient inventory (PB 10)
const HALT_RESOLUTIONS = ['Delayed', 'Cancelled'];

const NOT_FOUND_TEXT = {
  Customer: 'We could not find this customer. They may have been removed. Please choose the customer again.',
  Order: 'We could not find this order. It may have been removed. Please refresh the Orders list.'
};
const notFound = (res, what, id) =>
  res.status(404).json({
    error: `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`,
    message: NOT_FOUND_TEXT[what] || `${what} ${id} could not be found.`,
    id
  });

// H2: blocks writes to an order someone else holds the edit lock for (Owner prevails)
const requireOrderEditAccess = (req, res, next) => {
  const blocked = req.orderLocks && req.orderLocks.assertCanEdit(req.params.order_id, req.user);
  if (blocked) return res.status(409).json(blocked);
  next();
};

// M7: rejects malformed :order_id before any query runs
router.param('order_id', (req, res, next, value) => {
  const v = createValidator();
  v.id(value, 'order_id');
  if (v.failed()) return v.send(res);
  next();
});

// Runs cloudWrite() unless the target lives only in the local cache, falling back to
// localWrite() when Neon is unreachable (C5). Both must resolve to { source, record }.
const writeCloudFirst = async (target, cloudWrite, localWrite) => {
  if (target === 'local') return localWrite();
  try {
    return await cloudWrite();
  } catch (err) {
    if (!isConnectionError(err) || err.commitUnknown) throw err;
    console.error('☁️  Cloud unreachable, saving locally:', err.message);
    return localWrite();
  }
};

// Protect EVERY route in this file by telling the router to use the middleware first
router.use(verifyToken);

// ==========================================
// LIST ORDERS (M10)
// GET /api/orders?status=Pending&customer_id=CUST-001&sort=production_deadline&dir=asc&limit=50&offset=0
//   sort: date_created (default) | production_deadline | total_quote_amount | production_status | priority
//   dir:  desc (default) | asc     (priority defaults to asc: most urgent first)
//   priority (PB 16): overdue orders first, then due today / tomorrow, then due within 3 days,
//                     then the rest by deadline; Completed / Cancelled orders last.
// Every order carries deadline_flag: 'overdue' | 'urgent_24h' | 'warning_72h' | 'normal' | null (closed).
// Sorting runs in the database, so it is correct across pages (not just within one page).
// The ORDER BY text comes only from the allow-list below, never from the request.
// -> { source, orders: [...], limit, offset, sort, dir, unsynced }
// ==========================================
const STATUS_RANK_SQL = `CASE production_status ${PRODUCTION_STATUSES.map((st, i) => `WHEN '${st}' THEN ${i}`).join(' ')} ELSE 99 END`;
// Qualified names on purpose: a bare name in ORDER BY would match the SELECT alias, and the
// select list returns money as text (so 1000 would sort before 999).
const ORDER_SORTS = {
  date_created: 'order_profiles.date_created',
  production_deadline: 'order_profiles.production_deadline',
  total_quote_amount: 'order_profiles.total_quote_amount',
  production_status: STATUS_RANK_SQL // lifecycle order: Pending, Approved, Printing, ...
};
// PB 16: the same day windows as deadlineFlag() (services/domain/orderLifecycle.js), as SQL
// that runs in both databases. The dates are produced by the server ('YYYY-MM-DD' only),
// never taken from the request.
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const prioritySql = (now = new Date()) => {
  const { today, urgent_until, warning_until } = deadlineWindows(now);
  if (![today, urgent_until, warning_until].every((d) => YMD.test(d))) throw new Error('bad deadline window');
  const due = 'substr(CAST(order_profiles.production_deadline AS text), 1, 10)';
  return `CASE WHEN order_profiles.production_status IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(', ')}) THEN 4
               WHEN ${due} < '${today}' THEN 0
               WHEN ${due} <= '${urgent_until}' THEN 1
               WHEN ${due} <= '${warning_until}' THEN 2
               ELSE 3 END`;
};
const SORT_NAMES = [...Object.keys(ORDER_SORTS), 'priority'];

router.get('/', requireRole(READ_ROLES), async (req, res) => {
  const v = createValidator();
  const status = v.oneOf(req.query.status, 'status', PRODUCTION_STATUSES, { required: false });
  const customer_id = v.id(req.query.customer_id, 'customer_id', { required: false });
  const tracking_no = v.trackingNo(req.query.tracking_no, 'tracking_no', { required: false }); // PB 6: find by order number
  const sort = v.oneOf(req.query.sort, 'sort', SORT_NAMES, { required: false }) || 'date_created';
  const dir = v.oneOf(req.query.dir, 'dir', ['asc', 'desc'], { required: false }) || (sort === 'priority' ? 'asc' : 'desc');
  const { limit, offset } = v.pagination(req.query);
  if (v.failed()) return v.send(res);

  try {
    const result = await listRecords(req, 'order_profiles', {
      filters: [['production_status', status], ['customer_id', customer_id], ['tracking_no', tracking_no]],
      // Ties broken by newest first, then order_id, so paging is stable. Within one urgency
      // group the nearest deadline comes first.
      orderBy: sort === 'priority'
        ? `${prioritySql()} ${dir.toUpperCase()}, order_profiles.production_deadline ASC, order_profiles.order_id`
        : `${ORDER_SORTS[sort]} ${dir.toUpperCase()}, order_profiles.date_created DESC, order_profiles.order_id`,
      limit,
      offset
    });
    res.status(200).json({
      source: result.source, orders: result.records.map((o) => withDeadlineFlag(o)), limit, offset, sort, dir, unsynced: result.unsynced,
      capabilities: capabilitiesFor(req.user.role)
    });
  } catch (err) {
    sendDbError(res, err, 'listing orders');
  }
});

// ==========================================
// ORDER DETAIL (M10)
// GET /api/orders/:order_id -> { source, order, items, payments, totals, allowed_actions, stock_check, status_history,
//                               quote, consumables_deducted }
//   quote (PB 11 / PB 12): { has_quote, subtotal_amount, discount_amount, discount_reason, total_quote_amount,
//                    lines: [{ line_item_id, product_type, size, custom_name, custom_number, quantity, unit_price,
//                    line_total }] | null (null when the item prices do not add up to the subtotal) }
//   consumables_deducted (PB 15): [{ log_id, trigger_status, consumable_inventory_id, item_name, unit,
//                    quantity_deducted, shortfall, deducted_at }] what its status changes took from stock
//   order.deadline_flag (PB 16): 'overdue' | 'urgent_24h' | 'warning_72h' | 'normal' | null (closed)
//   status_history (PB 14): [{ history_id, from_status, to_status, changed_by_name, changed_role, changed_at }]
//                    oldest first; changed_at is UTC like date_created
//   allowed_actions: which buttons this account may use on this order (role + status rules),
//                    e.g. { approve, statuses: ['Printing', 'Cancelled'], edit_quote, ... }
//   stock_check (PB 9): for an order that still has to reserve its stock (Pending / Delayed,
//                    not reserved yet), whether the free stock covers it, with the shortfalls.
//                    Approve and Resume re-check on locked rows; this is advice for the screen.
// ==========================================
router.get('/:order_id', requireRole(READ_ROLES), async (req, res) => {
  const { order_id } = req.params;
  try {
    const { source, record: order } = await getRecord(req, 'order_profiles', order_id);
    if (!order) return notFound(res, 'Order', order_id);

    const items = await listRecords(req, 'order_items', { filters: [['order_id', order_id]], orderBy: 'line_item_id' });
    const view = await loadPaymentView(req, order);
    const timeline = await loadStatusHistory(req, order_id);
    const used = await loadOrderConsumables(req, order_id);
    const needs = needsReservation(order) ? stockNeeds(items.records) : [];
    const evaluation = needs.length > 0 ? await evaluateCapacity(req, needs) : null;
    const sources = [source, items.source, view.source, timeline.source, used.source, evaluation && evaluation.source];

    res.status(200).json({
      source: sources.includes('local') ? 'local' : 'cloud',
      order: withDeadlineFlag(order),
      status_history: timeline.history,
      items: items.records,
      payments: view.payments,
      totals: {
        item_count: items.records.length,
        total_quantity: items.records.reduce((sum, i) => sum + i.quantity, 0),
        ...paymentTotals(order, view.summary)
      },
      allowed_actions: allowedActions(order, req.user.role, view.summary),
      stock_check: buildStockCheck(order, items.records, evaluation),
      quote: { ...quoteBreakdown(order), lines: quoteLines(items.records, quoteBreakdown(order)) },
      consumables_deducted: used.consumables
    });
  } catch (err) {
    sendDbError(res, err, 'reading order');
  }
});

// ==========================================
// CREATE ORDER PROFILE (Sprint 6 / PB 6, capacity-gated in Sprint 9 / PB 9 & PB 10)
// Body: { customer_id, production_deadline, required_items: [{ inventory_id, quantity_needed }],
//         total_quote_amount?, resolution? }
//  - No resolution: stock is strictly evaluated; shortages -> 409 and NO order is created.
//    On success the order, its order_items AND the stock reservation are written in ONE
//    transaction (quantity_reserved += needed), so the Catalog's "Free to use", Low Stock and
//    Out of Stock numbers change the moment the order exists.
//  - resolution 'Delayed':   recorded as Delayed with the NEW deadline; items saved, nothing reserved
//                            (reserved later via PATCH /:order_id/status -> Pending).
//  - resolution 'Cancelled': recorded as Cancelled (permanent record of the lost sale).
// -> 201 { message, source, order_id, production_status, order, items }
// ==========================================
router.post('/', requireRole(WRITE_ROLES), async (req, res) => {
  const body = req.body || {};

  // 1.) M7: validate every field before touching a database
  const v = createValidator();
  const customer_id = v.id(body.customer_id, 'customer_id');
  const production_deadline = v.deadline(body.production_deadline, 'production_deadline');
  const resolution = v.oneOf(body.resolution, 'resolution', HALT_RESOLUTIONS, { required: false });
  const total_quote_amount = v.nonNegativeMoney(body.total_quote_amount, 'total_quote_amount', { required: false, defaultValue: 0 });
  if (v.failed()) return v.send(res);
  // PB 2: staff create the order; the Owner prices it (0 = "no quote yet")
  if (total_quote_amount !== 0 && !can(req.user.role, 'set_quote')) return quoteOwnerOnly(res);

  const production_status = resolution || 'Pending';
  const normalized = (resolution && body.required_items === undefined) ? { items: [] } : normalizeRequiredItems(body.required_items);
  if (normalized.error) {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: normalized.error });
  }
  const needs = normalized.items;
  const reserve = !resolution && needs.length > 0;
  const ids = needs.map((n) => n.inventory_id).sort();
  const order_id = crypto.randomUUID();
  const lineIds = needs.map(() => crypto.randomUUID());

  // ---- Online: lock stock rows (fixed order = no deadlocks), check, insert, reserve ----
  const createInCloud = () => withPgTransaction(req.pgPool, async (client) => {
    const stock = await client.query(
      `SELECT inventory_id, item_name, quantity_available, quantity_reserved FROM inventory_items
        WHERE inventory_id = ANY($1::text[]) AND ${ACTIVE_ITEM_SQL} ORDER BY inventory_id FOR UPDATE`,
      [ids]
    );
    const rowsById = new Map(stock.rows.map((r) => [r.inventory_id, r]));
    const { missing, shortages } = checkStock(needs, rowsById);
    if (missing.length) throw missingItemsRejection(missing, 'cloud');
    if (reserve && shortages.length) throw shortageRejection(shortages, 'cloud');

    const { rows } = await client.query(
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount, stock_reserved)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${selectList('order_profiles', 'pg')}`,
      [order_id, customer_id, production_deadline, production_status, total_quote_amount, reserve]
    );
    const items = [];
    for (let i = 0; i < needs.length; i++) {
      const { inventory_id, quantity_needed } = needs[i];
      const item = await client.query(
        `INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, price)
         VALUES ($1, $2, $3, $4, $5, 0) RETURNING ${selectList('order_items', 'pg')}`,
        [lineIds[i], order_id, inventory_id, rowsById.get(inventory_id).item_name.slice(0, 100), quantity_needed]
      );
      items.push(serialize('order_items', item.rows[0]));
      if (reserve) {
        const reserved = await client.query(
          `UPDATE inventory_items SET quantity_reserved = quantity_reserved + $1
            WHERE inventory_id = $2 AND quantity_available - quantity_reserved >= $1`,
          [quantity_needed, inventory_id]
        );
        if (reserved.rowCount !== 1) throw shortageRejection(checkStock([needs[i]], rowsById).shortages, 'cloud');
      }
    }
    return { source: 'cloud', record: serialize('order_profiles', rows[0]), items };
  });

  // ---- Offline: same steps on a dedicated SQLite connection (pushed by the normal sync) ----
  const createLocally = () => withLocalTransaction(req.localDbPath, async (tx) => {
    const stock = ids.length === 0 ? [] : await sqliteAll(tx,
      `SELECT inventory_id, item_name, quantity_available, quantity_reserved FROM inventory_items
        WHERE inventory_id IN (${ids.map(() => '?').join(', ')}) AND ${ACTIVE_ITEM_SQL}`, ids);
    const rowsById = new Map(stock.map((r) => [r.inventory_id, r]));
    const { missing, shortages } = checkStock(needs, rowsById);
    if (missing.length) throw missingItemsRejection(missing, 'local');
    if (reserve && shortages.length) throw shortageRejection(shortages, 'local');

    await sqliteRun(tx,
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount,
                                   stock_reserved, sync_status, last_modified)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
      [order_id, customer_id, production_deadline, production_status, total_quote_amount, reserve ? 1 : 0]);
    const items = [];
    for (let i = 0; i < needs.length; i++) {
      const { inventory_id, quantity_needed } = needs[i];
      await sqliteRun(tx,
        `INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, price, sync_status, last_modified)
         VALUES (?, ?, ?, ?, ?, 0, 'pending_insert', ${LOCAL_NOW})`,
        [lineIds[i], order_id, inventory_id, rowsById.get(inventory_id).item_name.slice(0, 100), quantity_needed]);
      if (reserve) {
        await sqliteRun(tx,
          `UPDATE inventory_items SET quantity_reserved = quantity_reserved + ?,
             ${offlineUpdateBookkeeping('inventory_items', ['quantity_reserved'])} WHERE inventory_id = ?`,
          [quantity_needed, inventory_id]);
      }
      items.push(await readLocal(tx, 'order_items', lineIds[i]));
    }
    return { source: 'local', record: await readLocal(tx, 'order_profiles', order_id), items };
  });

  try {
    // 2.) M7: the customer must exist (Neon, or the local cache when offline)
    const customer = await locateRecord(req, 'customers', customer_id);
    if (!customer.location) return notFound(res, 'Customer', customer_id);

    let result;
    if (customer.location === 'local') {
      result = await createLocally();
    } else {
      try {
        result = await createInCloud();
      } catch (err) {
        if (err instanceof Rejected || !isConnectionError(err)) throw err;
        if (err.commitUnknown) {
          return res.status(503).json({
            error: 'COMMIT_UNKNOWN',
            message: 'Connection to the cloud dropped while saving. Check the Orders list before retrying.'
          });
        }
        console.error('☁️  Cloud unreachable, saving order locally:', err.message);
        result = await createLocally();
      }
    }

    if (reserve) pushStockChange(req, ids, 'order_reserved');
    pushOrderChange(req, result.record);
    console.log(`✅ Order ${order_id} (${production_status}, ${needs.length} material(s)${reserve ? ', stock reserved' : ''}) saved to ${result.source}`);
    return res.status(201).json({
      message: result.source === 'cloud'
        ? (reserve ? 'Order created and materials reserved.' : 'Order created.')
        : 'Saved offline. Will sync to cloud when connection is restored.',
      source: result.source,
      order_id,
      production_status,
      order: withDeadlineFlag(result.record),
      items: result.items
    });
  } catch (err) {
    if (err instanceof Rejected) {
      if (err.status === 409) console.warn(`⛔ Order halted (409) for customer ${customer_id}: ${err.body.error}`);
      return res.status(err.status).json(err.body);
    }
    return sendDbError(res, err, 'order creation');
  }
});

// ==========================================
// CHANGE ORDER STATUS (Orders tab)
// PATCH /api/orders/:order_id/status   Body: { status, expected_version? }
//   The allowed moves are STATUS_TRANSITIONS in services/domain/orderLifecycle.js:
//   Pending  -> Cancelled             (Pending -> Approved only via POST /:order_id/approve, Owner)
//   Approved -> Printing | Cancelled
//   Printing -> Pressing | Completed | Cancelled   (PB 14: Pressing is optional)
//   Pressing -> Completed | Cancelled
//   Delayed  -> Pending (reserves stock now; 409 INSUFFICIENT_INVENTORY if short) | Cancelled
//   Completed / Cancelled are final.
// PB 2: Cancelled is a void, so only the Owner may send it (403 VOID_OWNER_ONLY otherwise).
// PB 13: Printing is only reachable through Approved, so production can never start without
// the Owner's approval and the 50% downpayment check.
// Stock effects (same transaction): Cancelled releases the reservation; Completed consumes it
// (quantity_available and quantity_reserved both go down). Needs the cloud: stock shared by all
// branches must not be released or consumed from a stale offline copy.
// PB 14: the same transaction writes one order_status_history row; "order_updated" is pushed
// to every screen after COMMIT.
// PB 15: leaving Printing (for Pressing, or for Completed when Pressing is skipped) takes the
// 'Pressing' usage rates of the order's blanks from stock; Completed also takes the 'Completed'
// rates. Same transaction, each (order, step, consumable) at most once (order_consumables_log),
// never below 0: a shortfall is recorded, never a reason to refuse the change (steering §5).
// The consumable ids join "inventory_updated", so the low-stock warning follows at once.
// -> 200 { message, order, stock_changes, consumables_deducted: [{ log_id, trigger_status,
//          consumable_inventory_id, item_name, unit, needed, quantity_deducted, shortfall }] }
// ==========================================
router.patch('/:order_id/status', requireRole(WRITE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const status = v.oneOf(body.status, 'status', PRODUCTION_STATUSES);
  if (body.expected_version !== undefined && body.expected_version !== null && typeof body.expected_version !== 'string') {
    v.errors.push({ field: 'expected_version', message: 'expected_version must be the string returned as "version".' });
  }
  if (v.failed()) return v.send(res);
  if (status === 'Cancelled' && !can(req.user.role, capabilityForTransition(status))) return voidOwnerOnly(res);
  const expected_version = body.expected_version || null;

  try {
    const located = await locateRecord(req, 'order_profiles', order_id);
    if (!located.location) return notFound(res, 'Order', order_id);
    if (located.location === 'local') {
      return res.status(503).json({
        error: 'STATUS_CHANGE_REQUIRES_CLOUD',
        message: 'Changing an order status needs the cloud connection (and the order synced). Try again when online.'
      });
    }

    let changedIds = [];
    const result = await withPgTransaction(req.pgPool, async (client) => {
      const { rows } = await client.query(
        `SELECT ${selectList('order_profiles', 'pg')} FROM order_profiles WHERE order_id = $1 FOR UPDATE`, [order_id]);
      if (rows.length === 0) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: `Order ${order_id} does not exist.` });
      const order = serialize('order_profiles', rows[0]);
      if (expected_version && order.version !== expected_version) {
        // A status change is never forced over someone else's change: reload and decide again
        throw new Rejected(409, {
          error: 'EDIT_CONFLICT', message: 'This order was changed by someone else. Reload it and try again.',
          current: withDeadlineFlag(order), can_override: false
        });
      }
      const from = order.production_status;
      if (status === 'Approved') {
        throw new Rejected(409, {
          error: 'INVALID_STATUS_TRANSITION',
          message: 'Orders are approved with POST /api/orders/:order_id/approve (Owner only), not by a status change.',
          allowed: STATUS_TRANSITIONS[from] || []
        });
      }
      if (!(STATUS_TRANSITIONS[from] || []).includes(status)) {
        throw new Rejected(409, {
          error: 'INVALID_STATUS_TRANSITION',
          message: `An order that is ${from} cannot be changed to ${status}.`,
          allowed: STATUS_TRANSITIONS[from] || []
        });
      }

      // Materials of this order, summed per inventory item
      const lines = await client.query(
        `SELECT inventory_id, SUM(quantity)::int AS qty FROM order_items
          WHERE order_id = $1 AND inventory_id IS NOT NULL GROUP BY inventory_id ORDER BY inventory_id`, [order_id]);
      const needs = lines.rows.map((r) => ({ inventory_id: r.inventory_id, quantity_needed: r.qty }));
      const ids = needs.map((n) => n.inventory_id);
      // PB 15: the consumables this change takes (not taken before), locked together with the
      // materials in ONE inventory_id order so two status changes can never deadlock
      const consumablePlan = await planConsumables(client, { order_id, from, to: status, lines: needs });
      const lockIds = [...new Set([...ids, ...consumablePlan.ids])].sort();
      const stock = lockIds.length === 0 ? { rows: [] } : await client.query(
        `SELECT inventory_id, item_name, quantity_available, quantity_reserved, deleted_at, purged_at FROM inventory_items
          WHERE inventory_id = ANY($1::text[]) ORDER BY inventory_id FOR UPDATE`, [lockIds]);
      const rowsById = new Map(stock.rows.map((r) => [r.inventory_id, r]));

      let stockReserved = order.stock_reserved;
      const stockChanges = [];
      if (status === 'Pending' && from === 'Delayed' && needs.length > 0) {
        const activeById = new Map([...rowsById].filter(([, r]) => !r.deleted_at && !r.purged_at));
        const { missing, shortages } = checkStock(needs, activeById);
        if (missing.length) throw missingItemsRejection(missing, 'cloud');
        if (shortages.length) throw shortageRejection(shortages, 'cloud');
        for (const n of needs) {
          // Guarded in SQL as well as checked above (steering §4.5): never over-commit stock
          const held = await client.query(
            `UPDATE inventory_items SET quantity_reserved = quantity_reserved + $1
              WHERE inventory_id = $2 AND quantity_available - quantity_reserved >= $1`,
            [n.quantity_needed, n.inventory_id]);
          if (held.rowCount !== 1) throw shortageRejection(checkStock([n], activeById).shortages, 'cloud');
          stockChanges.push({ inventory_id: n.inventory_id, item_name: rowsById.get(n.inventory_id).item_name, reserved: n.quantity_needed });
        }
        stockReserved = true;
      } else if (order.stock_reserved && (status === 'Cancelled' || status === 'Completed')) {
        for (const n of needs) {
          if (!rowsById.has(n.inventory_id)) continue;
          if (status === 'Cancelled') {
            await client.query(
              'UPDATE inventory_items SET quantity_reserved = GREATEST(quantity_reserved - $1, 0) WHERE inventory_id = $2',
              [n.quantity_needed, n.inventory_id]);
            stockChanges.push({ inventory_id: n.inventory_id, item_name: rowsById.get(n.inventory_id).item_name, released: n.quantity_needed });
          } else {
            const used = await client.query(
              `UPDATE inventory_items SET quantity_available = quantity_available - $1,
                      quantity_reserved = GREATEST(quantity_reserved - $1, 0)
                WHERE inventory_id = $2 AND quantity_available >= $1`,
              [n.quantity_needed, n.inventory_id]);
            if (used.rowCount !== 1) {
              const row = rowsById.get(n.inventory_id);
              throw new Rejected(409, {
                error: 'INSUFFICIENT_STOCK',
                message: `Cannot complete: "${row.item_name}" has only ${row.quantity_available} on hand but the order uses ${n.quantity_needed}. Correct the stock first.`
              });
            }
            stockChanges.push({ inventory_id: n.inventory_id, item_name: rowsById.get(n.inventory_id).item_name, consumed: n.quantity_needed });
          }
        }
        stockReserved = false;
      }
      // PB 15: never blocks the change; a shortfall clamps the stock at 0 and is recorded
      const consumables = await applyConsumables(client, req, { order_id, planned: consumablePlan.planned, rowsById });
      changedIds = [...new Set([...stockChanges.map((c) => c.inventory_id), ...consumables.map((c) => c.consumable_inventory_id)])];

      const updated = await client.query(
        `UPDATE order_profiles SET production_status = $2, stock_reserved = $3, last_edited_by = $4, last_edited_role = $5
          WHERE order_id = $1 RETURNING ${selectList('order_profiles', 'pg')}`,
        [order_id, status, stockReserved, ...editorOf(req)]);
      await recordStatusChange(client, req, order_id, from, status);
      return { order: serialize('order_profiles', updated.rows[0]), stockChanges, consumables, from };
    });

    pushStockChange(req, changedIds, `order_${status.toLowerCase()}`);
    pushOrderChange(req, result.order);
    console.log(`🔁 Order ${order_id}: ${result.from} -> ${status} by ${req.user.user_id} (${req.user.role})`);
    res.status(200).json({
      message: `Order is now ${status}.` + (result.stockChanges.length
        ? (status === 'Cancelled' ? ' Reserved materials were released back to stock.'
          : status === 'Completed' ? ' Reserved materials were used up from stock.'
            : ' Materials were reserved.')
        : '') + consumablesSentence(result.consumables),
      order: withDeadlineFlag(result.order),
      stock_changes: result.stockChanges,
      consumables_deducted: result.consumables
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    if (isConnectionError(err)) {
      return res.status(503).json({
        error: err.commitUnknown ? 'COMMIT_UNKNOWN' : 'STATUS_CHANGE_REQUIRES_CLOUD',
        message: err.commitUnknown
          ? 'Connection dropped while saving. Reload the order to see whether the change was applied.'
          : 'Changing an order status needs the cloud connection. Try again when online.'
      });
    }
    sendDbError(res, err, 'changing order status');
  }
});

// ==========================================
// ORDER ITEMS (Sprint 7 / PB 7)
// GET  /api/orders/:order_id/items -> { source, order_id, items }
// POST /api/orders/:order_id/items -> 201 { message, source, item }
// ==========================================
router.get('/:order_id/items', requireRole(READ_ROLES), async (req, res) => {
  const { order_id } = req.params;
  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);
    const items = await listRecords(req, 'order_items', { filters: [['order_id', order_id]], orderBy: 'line_item_id' });
    res.status(200).json({ source: items.source, order_id, items: items.records });
  } catch (err) {
    sendDbError(res, err, 'listing order items');
  }
});

router.post('/:order_id/items', requireRole(WRITE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};

  // M7: strict validation (quantity must be a positive whole JSON number)
  const v = createValidator();
  const product_type = v.requiredString(body.product_type, 'product_type', 100);
  const quantity = v.positiveInt(body.quantity, 'quantity');
  const size = v.optionalString(body.size, 'size', 50);
  const custom_name = v.optionalString(body.custom_name, 'custom_name', 255);
  const custom_number = v.optionalString(body.custom_number, 'custom_number', 50);
  // Sprint 11 / PB 13: an item MAY link to a stock item. It is optional here, but items
  // without an inventory_id block job-order approval (see POST /:order_id/approve).
  const inventory_id = v.id(body.inventory_id, 'inventory_id', { required: false });
  if (v.failed()) return v.send(res);

  const line_item_id = crypto.randomUUID();
  const values = [line_item_id, order_id, inventory_id || null, product_type, quantity, size, custom_name, custom_number];
  const missingStock = () => new Rejected(404, {
    error: 'INVENTORY_ITEM_NOT_FOUND',
    message: `Inventory item ${inventory_id} does not exist (or is in the Recycle Bin).`
  });
  // An order that already holds a reservation (stock_reserved) must also hold this item's
  // stock, or Cancel/Complete would later release or consume stock it never reserved.
  const needsCloud = () => new Rejected(503, {
    error: 'ITEM_RESERVATION_REQUIRES_CLOUD',
    message: 'This order already holds reserved stock, so adding a stock-linked item reserves it too. '
      + 'That needs the cloud connection (and the order synced). Try again when online.'
  });

  // ---- Online: lock order (+ stock row), insert, and reserve if the order holds stock ----
  const addInCloud = () => withPgTransaction(req.pgPool, async (client) => {
    const ord = await client.query('SELECT stock_reserved FROM order_profiles WHERE order_id = $1 FOR UPDATE', [order_id]);
    if (ord.rowCount === 0) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: `Order ${order_id} does not exist.` });
    let stockRow = null;
    if (inventory_id) {
      const stock = await client.query(
        `SELECT inventory_id, item_name, quantity_available, quantity_reserved FROM inventory_items
          WHERE inventory_id = $1 AND ${ACTIVE_ITEM_SQL} FOR UPDATE`, [inventory_id]);
      if (stock.rowCount === 0) throw missingStock();
      stockRow = stock.rows[0];
    }
    const { rows } = await client.query(
      `INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, size, custom_name, custom_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${selectList('order_items', 'pg')}`,
      values
    );
    const reserve = Boolean(stockRow && ord.rows[0].stock_reserved);
    if (reserve) {
      const held = await client.query(
        `UPDATE inventory_items SET quantity_reserved = quantity_reserved + $1
          WHERE inventory_id = $2 AND quantity_available - quantity_reserved >= $1`,
        [quantity, inventory_id]);
      if (held.rowCount !== 1) {
        throw shortageRejection(checkStock([{ inventory_id, quantity_needed: quantity }], new Map([[inventory_id, stockRow]])).shortages, 'cloud');
      }
    }
    return { source: 'cloud', record: serialize('order_items', rows[0]), reserved: reserve };
  });

  // ---- Offline: allowed only when nothing has to be reserved ----
  const addLocally = async () => {
    const local = await sqliteGet(req.localDb, 'SELECT stock_reserved FROM order_profiles WHERE order_id = ?', [order_id]);
    if (!local) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: `Order ${order_id} does not exist.` });
    if (inventory_id) {
      const stock = await sqliteGet(req.localDb,
        `SELECT 1 AS ok FROM inventory_items WHERE inventory_id = ? AND ${ACTIVE_ITEM_SQL}`, [inventory_id]);
      if (!stock) throw missingStock();
      if (Number(local.stock_reserved) === 1) throw needsCloud();
    }
    await sqliteRun(
      req.localDb,
      `INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, size, custom_name, custom_number, sync_status, last_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
      values
    );
    return { source: 'local', record: await readLocal(req.localDb, 'order_items', line_item_id), reserved: false };
  };

  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);

    let result;
    if (order.location === 'local') {
      result = await addLocally();
    } else {
      try {
        result = await addInCloud();
      } catch (err) {
        if (err instanceof Rejected || !isConnectionError(err)) throw err;
        if (err.commitUnknown) {
          return res.status(503).json({
            error: 'COMMIT_UNKNOWN',
            message: 'Connection to the cloud dropped while saving. Reload the order before retrying.'
          });
        }
        console.error('☁️  Cloud unreachable, saving order item locally:', err.message);
        result = await addLocally(); // C5: genuine outage only
      }
    }

    if (result.reserved) pushStockChange(req, [inventory_id], 'order_item_reserved');
    res.status(201).json({
      message: result.source === 'cloud'
        ? (result.reserved ? 'Order item added and its stock reserved.' : 'Order item added.')
        : 'Order item saved locally (Offline Mode).',
      source: result.source,
      item: result.record,
      stock_reserved: result.reserved
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    sendDbError(res, err, 'adding order item');
  }
});

// ==========================================
// BULK ITEMS: A JERSEY ROSTER IN ONE GO (PB 7)
// POST /api/orders/:order_id/items/bulk
// Body: { items: [{ product_type, quantity, size?, custom_name?, custom_number?, inventory_id? }] }   1 to 500 rows
//  - Every row is checked first (400 VALIDATION_FAILED, each message starts with "Row N:").
//  - All rows are added in ONE transaction, or none are.
//  - Same stock guard as adding one item: when the order already holds its stock (stock_reserved),
//    the linked rows reserve theirs too (409 INSUFFICIENT_INVENTORY if short; nothing added), and
//    that needs the cloud (503 ITEM_RESERVATION_REQUIRES_CLOUD offline).
//  - Only open orders take items (409 ORDER_CLOSED).
// -> 201 { message, source, items, stock_reserved }
// ==========================================
const BULK_ITEMS_MAX = 500;
const BULK_ERRORS_SHOWN = 20;

const checkBulkItems = (list) => {
  if (!Array.isArray(list) || list.length === 0) {
    return { errors: [{ field: 'items', message: 'Add at least one row to import.' }] };
  }
  if (list.length > BULK_ITEMS_MAX) {
    return { errors: [{ field: 'items', message: `At most ${BULK_ITEMS_MAX} rows can be imported at once. Split the list and import it in parts.` }] };
  }
  const errors = [];
  const rows = list.map((raw, i) => {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const v = createValidator();
    const row = {
      product_type: v.requiredString(r.product_type, 'product_type', 100),
      quantity: v.positiveInt(r.quantity, 'quantity'),
      size: v.optionalString(r.size, 'size', 50),
      custom_name: v.optionalString(r.custom_name, 'custom_name', 255),
      custom_number: v.optionalString(r.custom_number, 'custom_number', 50),
      inventory_id: v.id(r.inventory_id, 'inventory_id', { required: false }) || null
    };
    for (const e of v.errors) errors.push({ field: `items[${i}].${e.field}`, message: `Row ${i + 1}: ${e.message}` });
    return row;
  });
  return { errors: errors.slice(0, BULK_ERRORS_SHOWN), rows };
};

router.post('/:order_id/items/bulk', requireRole(WRITE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const checked = checkBulkItems((req.body || {}).items);
  if (checked.errors.length > 0) {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: checked.errors[0].message, details: checked.errors });
  }
  const rows = checked.rows.map((r) => ({ ...r, line_item_id: crypto.randomUUID() }));
  const totals = new Map();
  for (const r of rows) if (r.inventory_id) totals.set(r.inventory_id, (totals.get(r.inventory_id) || 0) + r.quantity);
  const needs = [...totals].map(([inventory_id, quantity_needed]) => ({ inventory_id, quantity_needed }))
    .sort((a, b) => (a.inventory_id < b.inventory_id ? -1 : a.inventory_id > b.inventory_id ? 1 : 0));
  const ids = needs.map((n) => n.inventory_id);
  const closed = (status) => new Rejected(409, {
    error: 'ORDER_CLOSED', message: `This order is ${status}, so items can no longer be added.`
  });
  const needsCloud = () => new Rejected(503, {
    error: 'ITEM_RESERVATION_REQUIRES_CLOUD',
    message: 'This order already holds reserved stock, so adding stock-linked items reserves them too. '
      + 'That needs the cloud connection (and the order synced). Try again when online.'
  });
  const columns = ['line_item_id', 'inventory_id', 'product_type', 'quantity', 'size', 'custom_name', 'custom_number'];

  // ---- Online: lock the order and the stock rows (inventory_id order), insert all, reserve ----
  const addInCloud = () => withPgTransaction(req.pgPool, async (client) => {
    const ord = await client.query('SELECT production_status, stock_reserved FROM order_profiles WHERE order_id = $1 FOR UPDATE', [order_id]);
    if (ord.rowCount === 0) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: NOT_FOUND_TEXT.Order });
    if (!EDITABLE_STATUSES.includes(ord.rows[0].production_status)) throw closed(ord.rows[0].production_status);
    const stock = ids.length === 0 ? { rows: [] } : await client.query(
      `SELECT inventory_id, item_name, quantity_available, quantity_reserved FROM inventory_items
        WHERE inventory_id = ANY($1::text[]) AND ${ACTIVE_ITEM_SQL} ORDER BY inventory_id FOR UPDATE`, [ids]);
    const rowsById = new Map(stock.rows.map((r) => [r.inventory_id, r]));
    const { missing, shortages } = checkStock(needs, rowsById);
    if (missing.length) throw missingItemsRejection(missing, 'cloud');
    const reserve = Boolean(ord.rows[0].stock_reserved) && needs.length > 0;
    if (reserve && shortages.length) throw shortageRejection(shortages, 'cloud');

    const inserted = await client.query(
      `INSERT INTO order_items (order_id, ${columns.join(', ')})
       SELECT $1::text, * FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[])
       RETURNING ${selectList('order_items', 'pg')}`,
      [order_id, ...columns.map((c) => rows.map((r) => r[c]))]);
    if (inserted.rowCount !== rows.length) throw new Error(`bulk insert wrote ${inserted.rowCount} of ${rows.length} rows`);
    if (reserve) {
      for (const n of needs) {
        // Guarded in SQL as well as checked above: never over-commit stock
        const held = await client.query(
          `UPDATE inventory_items SET quantity_reserved = quantity_reserved + $1
            WHERE inventory_id = $2 AND quantity_available - quantity_reserved >= $1`, [n.quantity_needed, n.inventory_id]);
        if (held.rowCount !== 1) throw shortageRejection(checkStock([n], rowsById).shortages, 'cloud');
      }
    }
    const byId = new Map(inserted.rows.map((r) => [r.line_item_id, serialize('order_items', r)]));
    return { source: 'cloud', items: rows.map((r) => byId.get(r.line_item_id)), reserved: reserve };
  });

  // ---- Offline: allowed only when nothing has to be reserved ----
  const addLocally = () => withLocalTransaction(req.localDbPath, async (tx) => {
    const local = await sqliteGet(tx, 'SELECT production_status, stock_reserved FROM order_profiles WHERE order_id = ?', [order_id]);
    if (!local) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: NOT_FOUND_TEXT.Order });
    if (!EDITABLE_STATUSES.includes(local.production_status)) throw closed(local.production_status);
    const found = ids.length === 0 ? [] : await sqliteAll(tx,
      `SELECT inventory_id FROM inventory_items WHERE inventory_id IN (${ids.map(() => '?').join(', ')}) AND ${ACTIVE_ITEM_SQL}`, ids);
    const present = new Set(found.map((r) => r.inventory_id));
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length) throw missingItemsRejection(missing, 'local');
    if (ids.length > 0 && Number(local.stock_reserved) === 1) throw needsCloud();
    for (const r of rows) {
      await sqliteRun(tx,
        `INSERT INTO order_items (order_id, ${columns.join(', ')}, sync_status, last_modified)
         VALUES (?, ${columns.map(() => '?').join(', ')}, 'pending_insert', ${LOCAL_NOW})`,
        [order_id, ...columns.map((c) => r[c])]);
    }
    const saved = await sqliteAll(tx,
      `SELECT ${selectList('order_items', 'sqlite')} FROM order_items WHERE line_item_id IN (${rows.map(() => '?').join(', ')})`,
      rows.map((r) => r.line_item_id));
    const byId = new Map(saved.map((r) => [r.line_item_id, serialize('order_items', r)]));
    return { source: 'local', items: rows.map((r) => byId.get(r.line_item_id)), reserved: false };
  });

  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);

    let result;
    if (order.location === 'local') {
      result = await addLocally();
    } else {
      try {
        result = await addInCloud();
      } catch (err) {
        if (err instanceof Rejected || !isConnectionError(err)) throw err;
        if (err.commitUnknown) return res.status(503).json(COMMIT_UNKNOWN);
        console.error('☁️  Cloud unreachable, saving the imported items locally:', err.message);
        result = await addLocally(); // C5: genuine outage only
      }
    }

    if (result.reserved) pushStockChange(req, ids, 'order_item_reserved');
    console.log(`📋 Order ${order_id}: ${rows.length} item(s) imported by ${req.user.user_id} [${result.source}]`);
    res.status(201).json({
      message: result.source === 'cloud'
        ? `${rows.length} item${rows.length === 1 ? '' : 's'} added.${result.reserved ? ' Their stock was reserved.' : ''}`
        : `${rows.length} item${rows.length === 1 ? '' : 's'} saved on this computer (offline). They will sync when the connection is back.`,
      source: result.source,
      items: result.items,
      stock_reserved: result.reserved
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    sendDbError(res, err, 'importing order items');
  }
});

// ==========================================
// ORDER PAYMENTS (PB 21)
// GET  /api/orders/:order_id/payments
//   -> { source, order_id, payments: [{ ...payment, received_by_name, paid_to_date, remaining_after,
//        status_after }], total_paid, totals }
// POST /api/orders/:order_id/payments   Body: { amount, payment_type }
//   -> 201 { message, source, payment, totals, allowed_actions, warnings: [{ code, message }] }
//
// Rules (services/domain/payments.js):
//   409 ORDER_CLOSED             the order was cancelled (Completed orders still take the final balance)
//   422 QUOTE_REQUIRED           no quote yet (only the Owner sets it)
//   409 PAYMENT_EXCEEDS_BALANCE  amount > remaining balance { remaining, total_paid, total_quote_amount }
//   400 VALIDATION_FAILED        received_by / receipt_no sent: the server fills them in
// received_by is always the logged-in account. receipt_no (AR-YYYY-NNNN) comes from the cloud
// database; a payment saved offline gets it when it syncs.
// Online: one transaction that locks the order row FOR UPDATE, so two payments at the same
// moment are checked one after the other; the INSERT is guarded in SQL as well.
// Offline (cloud unreachable only, C5): the same checks against this computer's copy,
// including payments still waiting to sync. Sync later pushes them with no cap (D2).
// ==========================================
router.get('/:order_id/payments', requireRole(WRITE_ROLES), async (req, res) => {
  const { order_id } = req.params;
  try {
    const { record: order } = await getRecord(req, 'order_profiles', order_id);
    if (!order) return notFound(res, 'Order', order_id);
    const view = await loadPaymentView(req, order);
    res.status(200).json({
      source: view.source, order_id, payments: view.payments, total_paid: view.summary.total_paid, totals: paymentTotals(order, view.summary)
    });
  } catch (err) {
    sendDbError(res, err, 'listing payments');
  }
});

const SERVER_FILLED_PAYMENT_FIELDS = ['received_by', 'receipt_no'];

router.post('/:order_id/payments', requireRole(rolesWith('record_payment')), async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};

  // M7: amount must be a positive JSON number with at most 2 decimals (centavos)
  const v = createValidator();
  const amount = v.positiveMoney(body.amount, 'amount');
  const payment_type = v.oneOf(body.payment_type, 'payment_type', PAYMENT_TYPES);
  for (const field of SERVER_FILLED_PAYMENT_FIELDS) {
    if (body[field] !== undefined) {
      v.errors.push({ field, message: 'The receiver and the receipt number are filled in by the system. Remove them and try again.' });
    }
  }
  if (v.failed()) return v.send(res);

  const payment_id = crypto.randomUUID();
  const received_by = req.user.user_id; // from the verified login token, never from the body
  const reject = (problem) => new Rejected(problem.status, problem.body);

  // ---- Online: lock the order, check, insert with a SQL guard ----
  const recordInCloud = () => withPgTransaction(req.pgPool, async (client) => {
    const ord = await client.query(
      `SELECT production_status, ROUND(COALESCE(total_quote_amount, 0) * 100)::bigint AS quote_centavos
         FROM order_profiles WHERE order_id = $1 FOR UPDATE`,
      [order_id]
    );
    if (ord.rowCount === 0) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: NOT_FOUND_TEXT.Order });
    const quote = toPesos(Number(ord.rows[0].quote_centavos));
    const paidRes = await client.query(
      'SELECT COALESCE(ROUND(SUM(amount) * 100), 0)::bigint AS paid_centavos FROM payments WHERE order_id = $1',
      [order_id]
    );
    const paid = toPesos(Number(paidRes.rows[0].paid_centavos));
    const problem = checkPayment({ status: ord.rows[0].production_status, quote, paid, amount });
    if (problem) throw reject(problem);

    // Defence in depth: the order lock already serialises payments for this order
    const inserted = await client.query(
      `INSERT INTO payments (payment_id, order_id, amount, payment_type, received_by)
       SELECT $1::text, $2::text, $3::numeric, $4::text, $5::text
        WHERE (SELECT ROUND(COALESCE(total_quote_amount, 0) * 100) FROM order_profiles WHERE order_id = $2::text)
            - (SELECT COALESCE(ROUND(SUM(amount) * 100), 0) FROM payments WHERE order_id = $2::text)
            >= ROUND($3::numeric * 100)
       RETURNING ${selectList('payments', 'pg')}`,
      [payment_id, order_id, amount, payment_type, received_by]
    );
    if (inserted.rowCount !== 1) {
      const again = await client.query(
        'SELECT COALESCE(ROUND(SUM(amount) * 100), 0)::bigint AS paid_centavos FROM payments WHERE order_id = $1', [order_id]);
      throw reject(checkPayment({ status: ord.rows[0].production_status, quote, paid: toPesos(Number(again.rows[0].paid_centavos)), amount })
        || { status: 409, body: { error: 'PAYMENT_EXCEEDS_BALANCE', message: 'The balance changed while saving. Reload the order and try again.' } });
    }
    return { source: 'cloud', record: serialize('payments', inserted.rows[0]), status: ord.rows[0].production_status };
  });

  // ---- Offline: the same checks against the local copy (pending payments included) ----
  const recordLocally = () => withLocalTransaction(req.localDbPath, async (tx) => {
    const ord = await sqliteGet(tx,
      'SELECT production_status, ROUND(COALESCE(total_quote_amount, 0) * 100) AS quote_centavos FROM order_profiles WHERE order_id = ?',
      [order_id]);
    if (!ord) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: NOT_FOUND_TEXT.Order });
    const paidRow = await sqliteGet(tx,
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0) AS paid_centavos FROM payments WHERE order_id = ?', [order_id]);
    const problem = checkPayment({
      status: ord.production_status, quote: toPesos(Number(ord.quote_centavos)), paid: toPesos(Number(paidRow.paid_centavos)), amount
    });
    if (problem) throw reject(problem);
    await sqliteRun(tx,
      `INSERT INTO payments (payment_id, order_id, amount, payment_type, received_by, payment_date, sync_status, last_modified)
       VALUES (?, ?, ?, ?, ?, ${LOCAL_NOW}, 'pending_insert', ${LOCAL_NOW})`,
      [payment_id, order_id, amount, payment_type, received_by]);
    return { source: 'local', record: await readLocal(tx, 'payments', payment_id), status: ord.production_status };
  });

  try {
    const located = await locateRecord(req, 'order_profiles', order_id);
    if (!located.location) return notFound(res, 'Order', order_id);

    let result;
    if (located.location === 'local') {
      result = await recordLocally();
    } else {
      try {
        result = await recordInCloud();
      } catch (err) {
        if (err instanceof Rejected || !isConnectionError(err)) throw err;
        if (err.commitUnknown) {
          return res.status(503).json({
            error: 'COMMIT_UNKNOWN',
            message: 'The connection to the cloud dropped while saving. Reload the order to see whether the payment was recorded before trying again.'
          });
        }
        console.error('☁️  Cloud unreachable, saving payment locally:', err.message);
        result = await recordLocally(); // C5: genuine outage only
      }
    }

    // Fresh totals, read the same way as GET /:order_id (cloud + payments waiting to sync)
    const { record: order } = await getRecord(req, 'order_profiles', order_id);
    const view = await loadPaymentView(req, order);
    const payment = view.payments.find((p) => p.payment_id === payment_id)
      || { ...result.record, received_by_name: NOT_RECORDED };
    const warnings = downpaymentWarnings({
      status: result.status,
      quote: view.summary.quote,
      paidTotal: view.summary.total_paid,
      paidSynced: view.summary.downpayment.paid_synced
    });

    console.log(`💰 Payment on order ${order_id} by ${received_by} saved to ${result.source}`);
    res.status(201).json({
      message: result.source === 'cloud'
        ? 'Payment recorded.'
        : 'Payment saved on this computer (offline). It will be sent to the cloud when the connection is back.',
      source: result.source,
      payment,
      totals: paymentTotals(order, view.summary),
      allowed_actions: allowedActions(order, req.user.role, view.summary),
      warnings
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    sendDbError(res, err, 'recording payment');
  }
});

// ==========================================
// LINK DESIGN FILE (Sprint 8 / PB 8)
// Body: { design_drive_link, expected_version?, override? }
//  H6: link must be an https:// drive.google.com or docs.google.com URL
//  H2: 409 ORDER_LOCKED if another user holds the edit lock (Owner prevails)
//  C3: if expected_version is sent and the cloud row changed since, 409 EDIT_CONFLICT
//      { current, can_override }
//  PB 5: can_override is true when this account outranks the order's last editor. Sending the
//      same body again with override: true replaces their change (rank re-checked from the
//      login token on the locked row, audit_log row written, "order_overridden" sent to them).
// -> 200 { message, source, order, version }
// ==========================================
router.patch('/:order_id/design', requireRole(WRITE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const { design_drive_link, expected_version, override } = req.body || {};

  const validation = validateDriveLink(design_drive_link);
  if (validation.error) {
    return res.status(400).json({ error: 'INVALID_DRIVE_LINK', message: validation.error });
  }
  if (expected_version !== undefined && typeof expected_version !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'expected_version must be the string returned as "version".' });
  }
  if (override !== undefined && typeof override !== 'boolean') {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'override must be true or false.' });
  }
  const link = validation.url;

  const updateLocal = async () => {
    // Record the field as dirty so sync pushes ONLY this change (C3),
    // and bump last_modified so an in-flight sync will not mark it synced (H3)
    const { changes } = await sqliteRun(
      req.localDb,
      `UPDATE order_profiles
          SET design_drive_link = ?, last_edited_by = ?, last_edited_role = ?,
              ${offlineUpdateBookkeeping('order_profiles', ['design_drive_link', ...EDITOR_FIELDS])}
        WHERE order_id = ?`,
      [link, ...editorOf(req), order_id]
    );
    return changes === 0 ? null : { source: 'local', record: await readLocal(req.localDb, 'order_profiles', order_id) };
  };

  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);

    let conflict = null;
    let overridden = null;
    const result = await writeCloudFirst(
      order.location,
      async () => {
        // Optimistic update: only if the row is still at expected_version
        const { rows, rowCount } = await req.pgPool.query(
          `UPDATE order_profiles
              SET design_drive_link = $1, last_edited_by = $4, last_edited_role = $5, last_modified = NOW()
            WHERE order_id = $2
              AND ($3::text IS NULL OR ${VERSION_SQL} = $3::text)
            RETURNING ${selectList('order_profiles', 'pg')}`,
          [link, order_id, expected_version || null, ...editorOf(req)]
        );
        if (rowCount === 0) {
          const current = await getRecord(req, 'order_profiles', order_id);
          conflict = current.record;
          // PB 5: the caller confirmed "replace their changes with mine"
          if (override === true && canOverride(req, conflict)) {
            overridden = await overrideInCloud(req, order_id, { design_drive_link: link });
            conflict = null;
            return { source: 'cloud', record: overridden.after };
          }
          return null;
        }
        return { source: 'cloud', record: serialize('order_profiles', rows[0]) };
      },
      updateLocal
    );

    if (conflict) {
      return res.status(409).json(editConflict(req, conflict, 'This order was changed by someone else. Reload it and apply your change again.'));
    }
    if (!result) return notFound(res, 'Order', order_id);

    if (overridden) announceOverride(req, overridden);
    else pushOrderChange(req, result.record);
    res.status(200).json({
      message: overridden ? 'Design linked. Your change replaced theirs.'
        : result.source === 'cloud'
          ? 'Design linked.'
          : 'Design linked locally (Offline Mode). Will sync when internet is restored.',
      source: result.source,
      order: withDeadlineFlag(result.record),
      version: result.record.version, // null offline until the next sync
      overridden: Boolean(overridden)
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    if (err.commitUnknown) return res.status(503).json(COMMIT_UNKNOWN);
    sendDbError(res, err, 'linking design file');
  }
});

// ==========================================
// EDIT ORDER DETAILS (Orders tab "Edit details")
// PATCH /api/orders/:order_id/details   Body (any of): { production_deadline, total_quote_amount, expected_version?, override? }
//  - Completed / Cancelled orders cannot be edited.
//  - PB 2: only the Owner may send total_quote_amount (403 QUOTE_OWNER_ONLY).
//  - PB 12: a quote typed in by hand replaces the calculated breakdown (it becomes its own
//    subtotal, with no discount) and writes an audit_log row 'quote_overridden' (before / after)
//    in the same transaction, online or offline. POST /:order_id/quote calculates it instead.
//  - The quote is frozen once an order is Approved (its downpayment was checked against it).
//  - Optimistic concurrency: if the order changed since it was loaded -> 409 EDIT_CONFLICT
//    { current, can_override }.
//  - PB 5: can_override is true when this account outranks the order's last editor. Sending the
//    same body again with override: true replaces their change: the rank is checked again from
//    the login token on the locked row, the change and its audit_log row (before / after) are
//    written in one transaction, and "order_overridden" goes to the replaced account's screens.
//    A closed order and a frozen quote stay refused, override or not.
// Works offline (synced later, pushing only the changed fields; the sync settles a clash by rank).
// -> 200 { message, source, order, changed, overridden }
// ==========================================
router.patch('/:order_id/details', requireRole(WRITE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const updates = {};
  if (body.production_deadline !== undefined) updates.production_deadline = v.deadline(body.production_deadline, 'production_deadline');
  if (body.total_quote_amount !== undefined) updates.total_quote_amount = v.nonNegativeMoney(body.total_quote_amount, 'total_quote_amount');
  if (body.expected_version !== undefined && body.expected_version !== null && typeof body.expected_version !== 'string') {
    v.errors.push({ field: 'expected_version', message: 'expected_version must be the string returned as "version".' });
  }
  if (body.override !== undefined && typeof body.override !== 'boolean') {
    v.errors.push({ field: 'override', message: 'override must be true or false.' });
  }
  if (Object.keys(updates).length === 0 && !v.failed()) {
    v.errors.push({ field: 'body', message: 'Nothing to change: send a new deadline or quote amount.' });
  }
  if (v.failed()) return v.send(res);
  if (body.total_quote_amount !== undefined && !can(req.user.role, 'set_quote')) return quoteOwnerOnly(res);

  try {
    const { record: current } = await getRecord(req, 'order_profiles', order_id);
    if (!current) return notFound(res, 'Order', order_id);
    if (CLOSED_STATUSES.includes(current.production_status)) {
      return res.status(409).json({ error: 'ORDER_CLOSED', message: `This order is ${current.production_status}, so its details can no longer be changed.` });
    }
    const quoteLocked = {
      error: 'QUOTE_LOCKED',
      message: 'The quote cannot be changed after the job order was approved, because the downpayment was based on it.'
    };
    if (updates.total_quote_amount !== undefined && updates.total_quote_amount !== current.total_quote_amount
        && QUOTE_FROZEN_STATUSES.includes(current.production_status)) {
      return res.status(409).json(quoteLocked);
    }
    const expected = body.expected_version || current.version || null;
    const fields = Object.keys(updates).filter((f) => updates[f] !== current[f]
      && !(f === 'production_deadline' && String(current[f]).slice(0, 10) === String(updates[f]).slice(0, 10)));
    if (fields.length === 0) {
      return res.status(200).json({ message: 'Nothing changed.', source: 'cloud', order: withDeadlineFlag(current), changed: [], overridden: false });
    }

    // The lifecycle rules an override must still respect, checked on the locked row
    const overrideGuard = (locked) => {
      if (CLOSED_STATUSES.includes(locked.production_status)) {
        return { status: 409, body: { error: 'ORDER_CLOSED', message: `This order is ${locked.production_status}, so its details can no longer be changed.` } };
      }
      if (fields.includes('total_quote_amount') && updates.total_quote_amount !== locked.total_quote_amount
          && QUOTE_FROZEN_STATUSES.includes(locked.production_status)) {
        return { status: 409, body: quoteLocked };
      }
      return null;
    };

    // PB 11 / PB 12: a quote typed in by hand is its own subtotal (no discount), and the change
    // is recorded in audit_log in the same transaction as the write
    const quoteTyped = fields.includes('total_quote_amount');
    const writes = Object.fromEntries(fields.map((f) => [f, updates[f]]));
    if (quoteTyped) Object.assign(writes, manualQuoteColumns(updates.total_quote_amount));
    const cols = Object.keys(writes);
    const quoteAudit = (before, after) => ({
      entity: 'order_profiles', entity_id: order_id, action: 'quote_overridden', actor: req.user,
      details: { before: quoteFieldsOf(before), after: quoteFieldsOf(after) }
    });

    let conflict = null;
    let overridden = null;
    const result = await writeCloudFirst(
      current.sync_status === 'pending_insert' ? 'local' : 'cloud',
      async () => {
        const n = cols.length;
        const written = await withPgTransaction(req.pgPool, async (client) => {
          const before = quoteTyped ? (await client.query(
            `SELECT ${selectList('order_profiles', 'pg')} FROM order_profiles WHERE order_id = $1 FOR UPDATE`, [order_id])).rows[0] : null;
          const { rows, rowCount } = await client.query(
            `UPDATE order_profiles SET ${cols.map((f, i) => `${f} = $${i + 1}`).join(', ')},
                    last_edited_by = $${n + 4}, last_edited_role = $${n + 5}
              WHERE order_id = $${n + 1}
                AND production_status <> ALL($${n + 2}::text[])
                AND ($${n + 3}::text IS NULL OR ${VERSION_SQL} = $${n + 3}::text)
              RETURNING ${selectList('order_profiles', 'pg')}`,
            [...cols.map((f) => writes[f]), order_id, CLOSED_STATUSES, expected, ...editorOf(req)]
          );
          if (rowCount === 0) return null; // nothing was written: the conflict is handled after this transaction
          const record = serialize('order_profiles', rows[0]);
          if (quoteTyped) await writeAudit(client, quoteAudit(serialize('order_profiles', before), record));
          return record;
        });
        if (!written) {
          conflict = (await getRecord(req, 'order_profiles', order_id)).record;
          // PB 5: the caller confirmed "replace their changes with mine"
          if (body.override === true && canOverride(req, conflict)) {
            overridden = await overrideInCloud(req, order_id, writes, overrideGuard);
            conflict = null;
            return { source: 'cloud', record: overridden.after };
          }
          return null;
        }
        return { source: 'cloud', record: written };
      },
      () => withLocalTransaction(req.localDbPath, async (tx) => {
        const before = quoteTyped ? await readLocal(tx, 'order_profiles', order_id) : null;
        const { changes } = await sqliteRun(tx,
          `UPDATE order_profiles SET ${cols.map((f) => `${f} = ?`).join(', ')}, last_edited_by = ?, last_edited_role = ?,
             ${offlineUpdateBookkeeping('order_profiles', [...cols, ...EDITOR_FIELDS])}
           WHERE order_id = ? AND production_status NOT IN ('Completed', 'Cancelled')`,
          [...cols.map((f) => writes[f]), ...editorOf(req), order_id]);
        if (changes === 0) return null;
        const record = await readLocal(tx, 'order_profiles', order_id);
        if (quoteTyped) await writeAuditLocal(tx, quoteAudit(before, record));
        return { source: 'local', record };
      })
    );

    if (conflict || !result) {
      return res.status(409).json(editConflict(req, conflict,
        'This order was changed by someone else while you were editing. Reload it and try again.'));
    }
    if (overridden) announceOverride(req, overridden);
    else pushOrderChange(req, result.record);
    console.log(`✏️  Order ${order_id}: ${fields.join(', ')} changed by ${req.user.user_id} [${result.source}]`);
    res.status(200).json({
      message: overridden ? 'Order details saved. Your changes replaced theirs.'
        : result.source === 'cloud' ? 'Order details saved.' : 'Order details saved offline. They will sync when the internet is back.',
      source: result.source,
      order: withDeadlineFlag(result.record),
      changed: fields,
      overridden: Boolean(overridden)
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    if (err.commitUnknown) return res.status(503).json(COMMIT_UNKNOWN);
    sendDbError(res, err, 'editing order details');
  }
});

// ==========================================
// CALCULATE THE QUOTE, WITH AN OPTIONAL DISCOUNT (PB 11 / PB 12)
// POST /api/orders/:order_id/quote   (Owner only: set_quote; a discount also needs apply_discount)
// Body: { dry_run?, discount_amount? | discount_percent?, discount_reason?, expected_version? }
//  - Each item's price is its catalog selling price less the volume tier for the order's total
//    quantity (services/domain/pricing.js); subtotal = the line totals; total = subtotal - discount.
//  - discount_amount (pesos) or discount_percent (0-100, converted to pesos here), never both;
//    a reason is required whenever there is a discount. Neither sent: the order's current
//    discount is kept (re-pricing after items change keeps it). discount_amount 0 removes it.
//  - dry_run: true works it all out and saves nothing (the panel's preview).
//  - Saved: every item's price, the order's subtotal / discount / reason / total and one
//    audit_log row ('quote_generated', or 'discount_applied' with a discount) in ONE transaction.
//  Refused (nothing saved):
//    400 VALIDATION_FAILED   403 DISCOUNT_OWNER_ONLY   404 ORDER_NOT_FOUND   409 ORDER_NOT_SYNCED
//    409 EDIT_CONFLICT (expected_version)   409 ORDER_CLOSED | QUOTE_LOCKED (after approval)
//    422 NO_ITEMS | ITEMS_NOT_LINKED_TO_STOCK | SELLING_PRICE_MISSING | DISCOUNT_TOO_LARGE
//    503 QUOTE_REQUIRES_CLOUD | COMMIT_UNKNOWN (the Owner's final price is never set from a stale copy)
// -> 200 { message, source: 'cloud', dry_run, calculation: { total_quantity, tier, lines: [{ line_item_id,
//          product_type, size, quantity, selling_price, unit_price, line_total }], subtotal_amount,
//          discount_amount, discount_percent, discount_reason, total_quote_amount },
//          quote: { has_quote, subtotal_amount, discount_amount, discount_reason, total_quote_amount }, order }
// ==========================================
const atMostTwoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
const QUOTE_REQUIRES_CLOUD = {
  error: 'QUOTE_REQUIRES_CLOUD',
  message: 'Calculating the quote needs the cloud connection, so the latest prices are used. Nothing was changed. Try again when online.'
};

router.post('/:order_id/quote', requireRole(rolesWith('set_quote')), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const given = (x) => x !== undefined && x !== null;
  const dry_run = given(body.dry_run) ? body.dry_run : false;
  if (typeof dry_run !== 'boolean') v.errors.push({ field: 'dry_run', message: 'Preview only must be true or false.' });
  if (given(body.discount_amount) && given(body.discount_percent)) {
    v.errors.push({ field: 'discount_percent', message: 'Send either a discount amount or a percentage, not both.' });
  }
  const discount_amount = given(body.discount_amount) ? v.nonNegativeMoney(body.discount_amount, 'discount_amount') : undefined;
  let discount_percent;
  if (given(body.discount_percent)) {
    const p = body.discount_percent;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
      v.errors.push({ field: 'discount_percent', message: 'Discount (%) must be a number from 0 to 100, like 5 or 12.5.' });
    } else if (!atMostTwoDecimals(p)) {
      v.errors.push({ field: 'discount_percent', message: 'Discount (%) can have at most 2 decimals, like 12.5.' });
    } else {
      discount_percent = p;
    }
  }
  const discount_reason = given(body.discount_reason) ? v.optionalString(body.discount_reason, 'discount_reason', DISCOUNT_REASON_MAX) : undefined;
  if (given(body.expected_version) && typeof body.expected_version !== 'string') {
    v.errors.push({ field: 'expected_version', message: 'expected_version must be the string returned as "version".' });
  }
  if (v.failed()) return v.send(res);
  if ((discount_amount > 0 || discount_percent > 0) && !can(req.user.role, 'apply_discount')) {
    return res.status(403).json({ error: 'DISCOUNT_OWNER_ONLY', message: 'Only the Owner can give a discount.' });
  }
  const expected_version = body.expected_version || null;

  try {
    const located = await locateRecord(req, 'order_profiles', order_id);
    if (!located.location) return notFound(res, 'Order', order_id);
    if (located.location === 'local') {
      if (!located.cloudReachable) return res.status(503).json(QUOTE_REQUIRES_CLOUD);
      return res.status(409).json({ error: 'ORDER_NOT_SYNCED', message: 'This order was saved offline and is not in the cloud yet. Sync, then calculate the quote.' });
    }

    const result = await withPgTransaction(req.pgPool, async (client) => {
      const locked = await client.query(
        `SELECT ${selectList('order_profiles', 'pg')} FROM order_profiles WHERE order_id = $1 FOR UPDATE`, [order_id]);
      if (locked.rowCount === 0) throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: NOT_FOUND_TEXT.Order });
      const before = serialize('order_profiles', locked.rows[0]);
      if (expected_version && before.version !== expected_version) {
        // A price is never forced over someone else's change: reload and decide again
        throw new Rejected(409, {
          error: 'EDIT_CONFLICT', message: 'This order was changed by someone else. Reload it and calculate the quote again.',
          current: withDeadlineFlag(before), can_override: false
        });
      }
      if (CLOSED_STATUSES.includes(before.production_status)) {
        throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${before.production_status}, so its quote can no longer be changed.` });
      }
      if (QUOTE_FROZEN_STATUSES.includes(before.production_status)) {
        throw new Rejected(409, {
          error: 'QUOTE_LOCKED', message: 'The quote cannot be changed after the job order was approved, because the downpayment was based on it.'
        });
      }
      const items = await client.query(
        `SELECT oi.line_item_id, oi.product_type, oi.size, oi.quantity, oi.inventory_id,
                ii.item_name, ii.selling_price::text AS selling_price
           FROM order_items oi LEFT JOIN inventory_items ii ON ii.inventory_id = oi.inventory_id
          WHERE oi.order_id = $1 ORDER BY oi.line_item_id`, [order_id]);
      const shown = quoteBreakdown(before);
      const { problem, quote } = computeQuote({
        items: items.rows,
        requested: { amount: discount_amount, percent: discount_percent, reason: discount_reason },
        existing: { amount: shown.discount_amount, reason: shown.discount_reason }
      });
      if (problem) throw new Rejected(problem.status, problem.body);
      if (dry_run) return { quote, order: before, saved: false };

      const priced = await client.query(
        `UPDATE order_items oi SET price = v.price
           FROM unnest($1::text[], $2::numeric[]) AS v(line_item_id, price)
          WHERE oi.line_item_id = v.line_item_id AND oi.order_id = $3`,
        [quote.lines.map((l) => l.line_item_id), quote.lines.map((l) => l.unit_price), order_id]);
      if (priced.rowCount !== quote.lines.length) throw new Error(`priced ${priced.rowCount} of ${quote.lines.length} items`);
      const updated = await client.query(
        `UPDATE order_profiles
            SET subtotal_amount = $2, discount_amount = $3, discount_reason = $4, total_quote_amount = $5,
                last_edited_by = $6, last_edited_role = $7
          WHERE order_id = $1 RETURNING ${selectList('order_profiles', 'pg')}`,
        [order_id, quote.subtotal_amount, quote.discount_amount, quote.discount_reason, quote.total_quote_amount, ...editorOf(req)]);
      const after = serialize('order_profiles', updated.rows[0]);
      await writeAudit(client, {
        entity: 'order_profiles',
        entity_id: order_id,
        action: quote.discount_amount > 0 ? 'discount_applied' : 'quote_generated',
        actor: req.user,
        details: {
          total_quantity: quote.total_quantity,
          tier: quote.tier,
          lines: quote.lines.map((l) => ({ line_item_id: l.line_item_id, quantity: l.quantity, unit_price: l.unit_price, line_total: l.line_total })),
          discount_percent: quote.discount_percent,
          before: quoteFieldsOf(before),
          after: quoteFieldsOf(after)
        }
      });
      return { quote, order: after, saved: true };
    });

    if (result.saved) pushOrderChange(req, result.order);
    const q = result.quote;
    console.log(`🧾 Order ${order_id}: quote ${result.saved ? 'saved' : 'previewed'} by ${req.user.user_id} (${q.lines.length} line(s))`);
    res.status(200).json({
      message: result.saved
        ? `Quote saved: ${pesoText(q.total_quote_amount)}${q.discount_amount > 0 ? ` after a ${pesoText(q.discount_amount)} discount` : ''}.`
        : 'Here is the quote. Nothing is saved until you confirm it.',
      source: 'cloud',
      dry_run: !result.saved,
      calculation: q,
      quote: quoteBreakdown(result.order),
      order: withDeadlineFlag(result.order)
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    if (err.commitUnknown) return res.status(503).json(COMMIT_UNKNOWN);
    if (isConnectionError(err)) return res.status(503).json(QUOTE_REQUIRES_CLOUD);
    sendDbError(res, err, 'calculating the quote');
  }
});

// ==========================================
// APPROVE JOB ORDER & RESERVE BLANK STOCK (Sprint 11 / PB 13)
// POST /api/orders/:order_id/approve   Body: { expected_version }   (required)
//
// Auth (§4.3): verifyToken (router.use) -> requireRole(['Owner']) -> requireOrderEditAccess.
//   Role comes from the JWT only. Admin / Production / Staff -> 403.
//   Another user's edit lock -> 409 ORDER_LOCKED (an Owner may take over any lock by design).
//
// Online only: every precondition and the reservation run in ONE Neon transaction after the
// order row (and every stock row involved) is locked FOR UPDATE. Locking the order also blocks
// new payments / items for it (their FK check needs a KEY SHARE lock) until we commit.
// Connection loss -> 503, never an offline fallback.
//
// Reservation model ("available = on-hand", PR #10): POST /api/orders already reserves stock
// when a Pending order is created (stock_reserved = true). Approval therefore reserves ONLY
// when the order does not hold its stock yet (Delayed orders, orders created before PR #10),
// and never twice. Either way, an approved order always holds its stock (stock_reserved = true).
//
// Preconditions, in order (any failure rolls back and changes nothing):
//   1 404 ORDER_NOT_FOUND (409 ORDER_NOT_SYNCED if it exists only in the offline cache)
//   2 409 EDIT_CONFLICT { current }
//   3 409 ALREADY_APPROVED | INVALID_STATUS_TRANSITION (only Pending / Delayed can be approved)
//   4 422 QUOTE_REQUIRED
//   5 402 DOWNPAYMENT_REQUIRED (integer centavos, Neon payments only)
//   6 422 ITEMS_NOT_LINKED_TO_STOCK { unlinked_line_item_ids }
//   7 409 INSUFFICIENT_INVENTORY { shortages } (only when stock still has to be reserved)
// -> 200 { message, source:'cloud', order, reserved:[{inventory_id,item_name,quantity}],
//          newly_reserved, inventory:[InventoryItem...] }
// ==========================================
router.post('/:order_id/approve', requireRole(APPROVE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const { expected_version } = req.body || {};

  // §4.2: expected_version is REQUIRED, so the approval is based on the order the Owner saw
  if (typeof expected_version !== 'string' || expected_version.trim() === '') {
    return res.status(400).json({
      error: 'VALIDATION_FAILED',
      message: 'expected_version is required: send the "version" of the order you are approving.',
      details: [{ field: 'expected_version', message: 'expected_version is required.' }]
    });
  }

  try {
    const result = await withPgTransaction(req.pgPool, async (client) => {
      // ---- Lock the order ----
      const orderRes = await client.query(
        `SELECT ${selectList('order_profiles', 'pg')},
                ROUND(COALESCE(total_quote_amount, 0) * 100)::bigint AS quote_centavos
           FROM order_profiles WHERE order_id = $1 FOR UPDATE`,
        [order_id]
      );
      // 1. The order exists in Neon
      if (orderRes.rowCount === 0) {
        throw new Rejected(404, { error: 'ORDER_NOT_FOUND', message: `Order ${order_id} does not exist.` });
      }
      const row = orderRes.rows[0];
      const order = serialize('order_profiles', row);

      // Already approved wins over a stale version: approving the same order twice (or two
      // Owners at once) reports ALREADY_APPROVED, not EDIT_CONFLICT (§4.8 tests 7 and 8).
      if (order.production_status === 'Approved') {
        throw new Rejected(409, { error: 'ALREADY_APPROVED', message: 'This job order is already approved.', current: order });
      }

      // 2. Optimistic concurrency
      if (order.version !== expected_version) {
        // An approval is never forced over someone else's change: reload and decide again
        throw new Rejected(409, {
          error: 'EDIT_CONFLICT',
          message: 'This order was changed by someone else. Reload it and approve again.',
          current: withDeadlineFlag(order),
          can_override: false
        });
      }

      // 3. Status
      if (!APPROVABLE_STATUSES.includes(order.production_status)) {
        throw new Rejected(409, {
          error: 'INVALID_STATUS_TRANSITION',
          message: `An order that is ${order.production_status} cannot be approved. Only Pending or Delayed orders can.`,
          current: order
        });
      }

      // 4. A quote exists
      const quoteCentavos = Number(row.quote_centavos);
      if (quoteCentavos <= 0) {
        throw new Rejected(422, { error: 'QUOTE_REQUIRED', message: 'Set the order quote before approving it.' });
      }

      // 5. 50% downpayment, in integer centavos. Only rows in Neon count: payments still
      //    pending offline are not visible here by design.
      const paid = await client.query(
        'SELECT COALESCE(ROUND(SUM(amount) * 100), 0)::bigint AS paid_centavos FROM payments WHERE order_id = $1',
        [order_id]
      );
      const paidCentavos = Number(paid.rows[0].paid_centavos);
      const requiredCentavos = Math.ceil(quoteCentavos / 2); // ₱999.99 -> ₱500.00
      if (paidCentavos < requiredCentavos) {
        throw new Rejected(402, {
          error: 'DOWNPAYMENT_REQUIRED',
          message: 'At least 50% of the quote must be paid before the job order can be approved.',
          total_quote_amount: quoteCentavos / 100,
          required_downpayment: requiredCentavos / 100,
          total_paid: paidCentavos / 100,
          remaining: (requiredCentavos - paidCentavos) / 100
        });
      }

      // 6. At least one item, and every item linked to stock
      const items = await client.query(
        'SELECT line_item_id, inventory_id, quantity FROM order_items WHERE order_id = $1 ORDER BY line_item_id',
        [order_id]
      );
      const unlinked = items.rows.filter((i) => !i.inventory_id).map((i) => i.line_item_id);
      if (items.rowCount === 0 || unlinked.length > 0) {
        throw new Rejected(422, {
          error: 'ITEMS_NOT_LINKED_TO_STOCK',
          message: items.rowCount === 0
            ? 'This order has no items. Add at least one item linked to a stock item.'
            : 'Every order item must be linked to a stock item before the order can be approved.',
          unlinked_line_item_ids: unlinked
        });
      }

      // Quantities per stock item (duplicate lines add up), in a FIXED order
      const totals = new Map();
      for (const i of items.rows) totals.set(i.inventory_id, (totals.get(i.inventory_id) || 0) + Number(i.quantity));
      const needs = [...totals].map(([inventory_id, quantity_needed]) => ({ inventory_id, quantity_needed }))
        .sort((a, b) => (a.inventory_id < b.inventory_id ? -1 : a.inventory_id > b.inventory_id ? 1 : 0));
      const ids = needs.map((n) => n.inventory_id);

      // ---- Lock every stock row involved, ORDER BY inventory_id (no deadlocks) ----
      const stock = await client.query(
        `SELECT inventory_id, item_name, quantity_available, quantity_reserved, deleted_at, purged_at
           FROM inventory_items WHERE inventory_id = ANY($1::text[]) ORDER BY inventory_id FOR UPDATE`,
        [ids]
      );
      const rowsById = new Map(stock.rows.map((r) => [r.inventory_id, r]));

      const newlyReserved = !order.stock_reserved;
      if (newlyReserved) {
        // 7. Capacity, on the locked rows: free stock = available - reserved (computeAvailable)
        const activeById = new Map([...rowsById].filter(([, r]) => !r.deleted_at && !r.purged_at));
        const { missing, shortages } = checkStock(needs, activeById);
        if (missing.length) throw missingItemsRejection(missing, 'cloud');
        const shortage = (list) => new Rejected(409, {
          error: 'INSUFFICIENT_INVENTORY',
          can_fulfill: false,
          message: 'Not enough free stock to approve this job order. Nothing was reserved.',
          shortages: list,
          total_shortfall: list.reduce((sum, s) => sum + s.shortfall, 0),
          source: 'cloud'
        });
        if (shortages.length) throw shortage(shortages);

        // Reserve, guarded in SQL; any miss rolls back every earlier reservation
        for (const n of needs) {
          const held = await client.query(
            `UPDATE inventory_items SET quantity_reserved = quantity_reserved + $1
              WHERE inventory_id = $2 AND quantity_available - quantity_reserved >= $1`,
            [n.quantity_needed, n.inventory_id]
          );
          if (held.rowCount !== 1) throw shortage(checkStock([n], activeById).shortages);
        }
      }

      // ---- Approve ----
      const approved = await client.query(
        `UPDATE order_profiles
            SET production_status = 'Approved', approved_by = $2, approved_at = NOW(), stock_reserved = TRUE,
                last_edited_by = $2, last_edited_role = $3
          WHERE order_id = $1 RETURNING ${selectList('order_profiles', 'pg')}`,
        [order_id, req.user.user_id, req.user.role]
      );
      // PB 14: the approval is a status change too (same transaction)
      await recordStatusChange(client, req, order_id, order.production_status, 'Approved');
      const fresh = await client.query(
        `SELECT ${selectList('inventory_items', 'pg')} FROM inventory_items
          WHERE inventory_id = ANY($1::text[]) ORDER BY inventory_id`,
        [ids]
      );
      return {
        order: serialize('order_profiles', approved.rows[0]),
        reserved: needs.map((n) => ({
          inventory_id: n.inventory_id,
          item_name: rowsById.get(n.inventory_id)?.item_name || null,
          quantity: n.quantity_needed
        })),
        newlyReserved,
        inventory: fresh.rows.map((r) => withAvailability(serialize('inventory_items', r))),
        ids
      };
    });

    if (result.newlyReserved) pushStockChange(req, result.ids, 'order_approved');
    pushOrderChange(req, result.order);
    console.log(`✅ Order ${order_id} approved by ${req.user.user_id} (Owner)` +
                (result.newlyReserved ? `; reserved ${result.ids.length} stock item(s)` : '; stock was already reserved'));
    return res.status(200).json({
      message: 'Job order approved.',
      source: 'cloud',
      order: withDeadlineFlag(result.order),
      reserved: result.reserved,
      newly_reserved: result.newlyReserved,
      inventory: result.inventory
    });
  } catch (err) {
    if (err instanceof Rejected) {
      // Helpful extras, read from the local cache AFTER the rollback (best effort)
      if (err.status === 404 && err.body.error === 'ORDER_NOT_FOUND') {
        const local = await sqliteGet(req.localDb, 'SELECT sync_status FROM order_profiles WHERE order_id = ?', [order_id]).catch(() => null);
        if (local && local.sync_status === 'pending_insert') {
          return res.status(409).json({
            error: 'ORDER_NOT_SYNCED',
            message: 'This order was saved offline and is not in the cloud yet. Sync, then approve it.'
          });
        }
      }
      if (err.status === 402) {
        const pending = await sqliteGet(req.localDb,
          "SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND sync_status = 'pending_insert'", [order_id]).catch(() => null);
        err.body.unsynced_payments = pending ? Number(pending.n) : 0;
        if (err.body.unsynced_payments > 0) {
          err.body.message += ` ${err.body.unsynced_payments} payment(s) saved offline do not count yet; sync first.`;
        }
      }
      return res.status(err.status).json(err.body);
    }
    // Online only (§4.5): no offline fallback
    if (err.commitUnknown) {
      return res.status(503).json({
        error: 'COMMIT_UNKNOWN',
        message: 'Connection to the cloud dropped while approving. Reload the order to see whether it was approved.'
      });
    }
    if (isConnectionError(err)) {
      return res.status(503).json({
        error: 'APPROVAL_REQUIRES_CLOUD',
        message: 'Approval needs an internet connection. Nothing was changed.'
      });
    }
    return sendDbError(res, err, 'approving job order');
  }
});

module.exports = router;

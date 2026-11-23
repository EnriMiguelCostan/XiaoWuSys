// ==========================================
// ORDERS, PART 2 (migration 015): print details, deliveries, refunds, payment checks, price cuts
// Mounted on /api/orders BEFORE routes/orders.js (so GET /api/orders/options is not read as an order id).
//
// POST   /api/orders/quote-preview   { required_items, labor_amount?, incidental_amount? | incidental_percent? }  Owner, nothing saved
// GET    /api/orders/options
//        -> { payment_methods: [{ value, verify, fields: [{ name, label, required, type, max, hint }] }],
//             refund_reasons, delivery_methods, garment_sizes, print_limits }
//
// Print details (sizes / names / numbers on garments; the text to print on anything else):
// POST   /api/orders/:order_id/print-details           { print_type, quantity, size?, custom_name?, custom_number?, notes?, line_item_id? }
// POST   /api/orders/:order_id/print-details/bulk      { rows: [same] }   a roster (all rows or none)
// PATCH  /api/orders/:order_id/print-details/:print_detail_id   (online only)
// DELETE /api/orders/:order_id/print-details/:print_detail_id   (online only)
//        Adding works offline too (pushed by the sync). Only open orders take them. The pieces listed
//        for a material can never be more than the order has of it (409 PRINT_DETAILS_EXCEED_MATERIAL).
//
// Deliveries / pick-ups in batches (online only, 503 DELIVERY_REQUIRES_CLOUD):
// POST   /api/orders/:order_id/deliveries              { quantity, delivered_at?, method?, received_by_name?, notes? }
// PATCH  /api/orders/:order_id/deliveries/:delivery_id (any of those)
// DELETE /api/orders/:order_id/deliveries/:delivery_id
//        From Approved until the order is closed; never more pieces than are left to hand over.
//
// Money (online only):
// POST   /api/orders/:order_id/refunds                 { amount, refund_reason, notes?, payment_type, ...details, payment_date? }  Owner
// POST   /api/orders/:order_id/payments/:payment_id/verify                                            Owner / Admin
// PATCH  /api/orders/:order_id/payments/:payment_id    { payment_date?, payment_type?, ...details }     Owner / Admin
// POST   /api/orders/:order_id/price-adjustment        { adjustment_amount, adjustment_reason }          Owner
// Every change is written with an audit_log row in the same transaction.
// ==========================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { createValidator, PAYMENT_TYPES } = require('../utils/validation');
const { LOCAL_NOW } = require('../utils/localSync');
const {
  selectList, serialize, listRecords, getRecord, locateRecord, withPgTransaction, withLocalTransaction, sqliteRun, sqliteAll, readLocal
} = require('../services/records');
const { rolesWith, can } = require('../services/domain/permissions');
const { EDITABLE_STATUSES, CLOSED_STATUSES, DELIVERY_STATUSES, DELIVERY_METHODS, fulfillmentSummary, withDeadlineFlag } = require('../services/domain/orderLifecycle');
const {
  paymentMethodForms, checkPaymentDetails, PAYMENT_DETAIL_NAMES, REFUND_REASONS, checkRefund, toCentavos, toPesos, pesoText
} = require('../services/domain/payments');
const { resolveAdjustment, ADJUSTMENT_REASON_MAX, quoteBreakdown, computeQuote, INCIDENTAL_PERCENT_MAX } = require('../services/domain/pricing');
const { normalizeRequiredItems } = require('../services/capacity');
const { GARMENT_SIZES, PRINT_LIMITS, checkPrintLine, overListed, defaultMaterialFor } = require('../services/domain/printDetails');
const { catalogFacts, describeMaterials, piecesOf } = require('../services/orderContext');
const { writeAudit } = require('../services/auditLog');
const { refreshLocalRows } = require('../services/sync');
const { helpers } = require('./orders');

const {
  Rejected, requireOrderEditAccess, refuseArchivedOrder, loadPaymentView, paymentTotals, actionsWithContext,
  pushOrderChange, NOT_FOUND_TEXT, COMMIT_UNKNOWN, RECORD_ARCHIVED
} = helpers;

const EDIT_ROLES = rolesWith('edit_order');
const needsCloud = (what) => ({
  error: `${what.toUpperCase()}_REQUIRES_CLOUD`,
  message: {
    delivery: 'Recording a delivery needs the cloud connection, so every branch sees what was handed over. Nothing was saved. Try again when online.',
    print_detail: 'Changing or removing a print detail needs the cloud connection. Adding new ones works offline.',
    refund: 'A refund needs the cloud connection, so every branch sees the same totals. Nothing was saved. Try again when online.',
    payment_check: 'Checking or correcting a payment needs the cloud connection. Try again when online.',
    price_adjustment: 'A price cut needs the cloud connection, so every branch sees the same bill. Try again when online.'
  }[what]
});
const sendError = (res, err, context, cloudBody) => {
  if (err instanceof Rejected) return res.status(err.status).json(err.body);
  if (isConnectionError(err)) return res.status(503).json(err.commitUnknown ? COMMIT_UNKNOWN : cloudBody);
  return sendDbError(res, err, context);
};
const orderNotFound = () => new Rejected(404, { error: 'ORDER_NOT_FOUND', message: NOT_FOUND_TEXT.Order });

router.use(verifyToken);
for (const name of ['order_id', 'print_detail_id', 'delivery_id', 'payment_id']) {
  router.param(name, (req, res, next, value) => {
    const v = createValidator();
    v.id(value, name);
    if (v.failed()) return v.send(res);
    next();
  });
}

// ---------- Options the order screens offer (the server decides) ----------
router.get('/options', requireRole(rolesWith('view_orders')), (req, res) => {
  res.status(200).json({
    payment_methods: paymentMethodForms(PAYMENT_TYPES),
    refund_reasons: REFUND_REASONS,
    delivery_methods: DELIVERY_METHODS,
    garment_sizes: GARMENT_SIZES,
    print_limits: PRINT_LIMITS
  });
});

// ---------- Quote preview while an order is being created (Owner: set_quote) ----------
// POST /api/orders/quote-preview { required_items: [{ inventory_id, quantity_needed }], labor_amount?,
//                                  incidental_amount? | incidental_percent? }
// -> 200 { quote (same shape as POST /:order_id/quote), source }   nothing is saved
//    422 SELLING_PRICE_MISSING / 404 INVENTORY_ITEM_NOT_FOUND / 400 VALIDATION_FAILED
// Prices come from the catalog's selling prices with the bulk tier, exactly as the Quote tab will
// calculate them once the order exists. Works offline (reads the local cache).
const twoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
router.post('/quote-preview', requireRole(rolesWith('set_quote')), async (req, res) => {
  const body = req.body || {};
  const given = (x) => x !== undefined && x !== null && x !== '';
  const normalized = normalizeRequiredItems(body.required_items);
  if (normalized.error) return res.status(400).json({ error: 'VALIDATION_FAILED', message: normalized.error });
  const v = createValidator();
  const labor = given(body.labor_amount) ? v.nonNegativeMoney(body.labor_amount, 'labor_amount') : undefined;
  if (given(body.incidental_amount) && given(body.incidental_percent)) {
    v.errors.push({ field: 'incidental_percent', message: 'Send either incidental charges in pesos or a percentage, not both.' });
  }
  const incidental = given(body.incidental_amount) ? v.nonNegativeMoney(body.incidental_amount, 'incidental_amount') : undefined;
  let incidental_percent;
  if (given(body.incidental_percent)) {
    const p = body.incidental_percent;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > INCIDENTAL_PERCENT_MAX || !twoDecimals(p)) {
      v.errors.push({ field: 'incidental_percent', message: `Incidental charges (%) must be a number from 0 to ${INCIDENTAL_PERCENT_MAX}, with at most 2 decimals.` });
    } else incidental_percent = p;
  }
  if (v.failed()) return v.send(res);

  const ids = normalized.items.map((i) => i.inventory_id);
  const SQL_COLUMNS = 'inventory_id, item_name, selling_price';
  let rows;
  let source = 'cloud';
  try {
    rows = (await req.pgPool.query(
      `SELECT inventory_id, item_name, selling_price::text AS selling_price FROM inventory_items
        WHERE inventory_id = ANY($1::text[]) AND deleted_at IS NULL AND purged_at IS NULL`, [ids])).rows;
  } catch (err) {
    if (!isConnectionError(err)) return sendDbError(res, err, 'quote preview');
    source = 'local';
    try {
      rows = await sqliteAll(req.localDb,
        `SELECT ${SQL_COLUMNS} FROM inventory_items
          WHERE inventory_id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL AND purged_at IS NULL`, ids);
    } catch (localErr) {
      return sendDbError(res, localErr, 'quote preview');
    }
  }
  const byId = new Map(rows.map((r) => [String(r.inventory_id), r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    return res.status(404).json({
      error: 'INVENTORY_ITEM_NOT_FOUND',
      message: 'One or more chosen materials are no longer in the inventory. Please choose the materials again.',
      missing_inventory_ids: missing, source
    });
  }
  const { problem, quote } = computeQuote({
    items: normalized.items.map((n, i) => {
      const row = byId.get(n.inventory_id);
      return {
        line_item_id: String(i + 1), product_type: row.item_name, quantity: n.quantity_needed,
        inventory_id: n.inventory_id, item_name: row.item_name, selling_price: row.selling_price
      };
    }),
    requested: { labor, incidental, incidental_percent },
    existing: { amount: 0, reason: null, labor: 0, incidental: 0 }
  });
  if (problem) return res.status(problem.status).json({ ...problem.body, source });
  // line_item_id here is only a position: send the material instead
  quote.lines = quote.lines.map((l, i) => ({ ...l, line_item_id: undefined, inventory_id: normalized.items[i].inventory_id }));
  return res.status(200).json({ quote, source });
});

// The order after a change, as the detail screen needs it -> { order, totals, allowed_actions, fulfillment }
const freshOrderView = async (req, order_id) => {
  const { record: order } = await getRecord(req, 'order_profiles', order_id);
  const { allowed_actions, context, view } = await actionsWithContext(req, order);
  return {
    order: withDeadlineFlag(order),
    totals: { ...paymentTotals(order, view.summary), total_refunded: view.summary.total_refunded, max_refund: context.max_refund },
    allowed_actions,
    fulfillment: context.fulfillment,
    completion: context.completion
  };
};

// =====================================================================
// PRINT DETAILS
// =====================================================================
// The order's materials with their catalog facts (cloud or this computer's copy)
const orderMaterials = async (req, order_id) => {
  const items = await listRecords(req, 'order_items', { filters: [['order_id', order_id]], orderBy: 'line_item_id' });
  const facts = await catalogFacts(req, items.records.map((i) => i.inventory_id));
  return describeMaterials(items.records, facts).map((m) => ({ ...m, item_name: m.product_type }));
};

// rows as sent + the order's materials -> { errors, lines }
const checkRows = (rows, materials) => {
  const errors = [];
  const lines = rows.map((raw, i) => {
    const wanted = raw && raw.line_item_id;
    let material = null;
    if (wanted) {
      material = materials.find((m) => m.line_item_id === wanted) || null;
      if (!material) errors.push({ field: `rows[${i}].line_item_id`, message: `${rows.length > 1 ? `Row ${i + 1}: ` : ''}choose a material of this order.` });
    } else {
      material = defaultMaterialFor(raw, materials);
    }
    const checked = checkPrintLine(raw, material, { prefix: rows.length > 1 ? `Row ${i + 1}: ` : '' });
    errors.push(...checked.errors.map((e) => ({ ...e, field: rows.length > 1 ? `rows[${i}].${e.field}` : e.field })));
    return checked.line;
  });
  return { errors: errors.slice(0, 20), lines };
};

const overListedRejection = (problems) => new Rejected(409, {
  error: 'PRINT_DETAILS_EXCEED_MATERIAL',
  message: problems.map((p) => `"${p.item_name}": ${p.listed} pieces listed, but the order has ${p.ordered}`).join('; ')
    + '. Add more of the material first, or list fewer pieces.',
  problems
});

const addPrintDetails = (bulk) => async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const rows = bulk ? body.rows : [body];
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'Add at least one row to import.', details: [{ field: 'rows', message: 'Add at least one row.' }] });
  }
  if (rows.length > PRINT_LIMITS.bulk_rows) {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: `At most ${PRINT_LIMITS.bulk_rows} rows can be imported at once. Split the list.` });
  }
  try {
    const located = await locateRecord(req, 'order_profiles', order_id);
    if (!located.location) throw orderNotFound();
    const materials = await orderMaterials(req, order_id);
    const checked = checkRows(rows, materials);
    if (checked.errors.length) {
      return res.status(400).json({ error: 'VALIDATION_FAILED', message: checked.errors[0].message, details: checked.errors });
    }
    const lines = checked.lines.map((l) => ({ ...l, print_detail_id: crypto.randomUUID() }));
    const cols = ['print_detail_id', 'order_id', 'line_item_id', 'print_type', 'quantity', 'size', 'custom_name', 'custom_number', 'notes', 'created_by'];
    const valuesOf = (l) => [l.print_detail_id, order_id, l.line_item_id, l.print_type, l.quantity, l.size, l.custom_name, l.custom_number, l.notes, req.user.user_id];

    const inCloud = () => withPgTransaction(req.pgPool, async (client) => {
      const ord = await client.query('SELECT production_status, archived_at IS NOT NULL AS archived FROM order_profiles WHERE order_id = $1 FOR UPDATE', [order_id]);
      if (ord.rowCount === 0) throw orderNotFound();
      if (ord.rows[0].archived) throw new Rejected(409, RECORD_ARCHIVED);
      if (!EDITABLE_STATUSES.includes(ord.rows[0].production_status)) {
        throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${ord.rows[0].production_status}, so its print details can no longer change.` });
      }
      const existing = await client.query('SELECT print_detail_id, line_item_id, quantity FROM order_print_details WHERE order_id = $1', [order_id]);
      const problems = overListed(materials, existing.rows, lines);
      if (problems.length) throw overListedRejection(problems);
      for (const l of lines) {
        await client.query(`INSERT INTO order_print_details (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, valuesOf(l));
      }
      const saved = await client.query(
        `SELECT ${selectList('order_print_details', 'pg')} FROM order_print_details WHERE print_detail_id = ANY($1::text[])`,
        [lines.map((l) => l.print_detail_id)]);
      return { source: 'cloud', rows: saved.rows.map((r) => serialize('order_print_details', r)) };
    });
    const locally = () => withLocalTransaction(req.localDbPath, async (tx) => {
      const ord = await sqliteAll(tx, 'SELECT production_status, archived_at FROM order_profiles WHERE order_id = ?', [order_id]);
      if (ord.length === 0) throw orderNotFound();
      if (ord[0].archived_at) throw new Rejected(409, RECORD_ARCHIVED);
      if (!EDITABLE_STATUSES.includes(ord[0].production_status)) {
        throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${ord[0].production_status}, so its print details can no longer change.` });
      }
      const existing = await sqliteAll(tx, 'SELECT print_detail_id, line_item_id, quantity FROM order_print_details WHERE order_id = ?', [order_id]);
      const problems = overListed(materials, existing, lines);
      if (problems.length) throw overListedRejection(problems);
      for (const l of lines) {
        await sqliteRun(tx,
          `INSERT INTO order_print_details (${cols.join(', ')}, created_at, sync_status, last_modified)
           VALUES (${cols.map(() => '?').join(', ')}, ${LOCAL_NOW}, 'pending_insert', ${LOCAL_NOW})`, valuesOf(l));
      }
      return { source: 'local', rows: await Promise.all(lines.map((l) => readLocal(tx, 'order_print_details', l.print_detail_id))) };
    });

    let result;
    if (located.location === 'local') result = await locally();
    else {
      try {
        result = await inCloud();
      } catch (err) {
        if (err instanceof Rejected || !isConnectionError(err)) throw err;
        if (err.commitUnknown) return res.status(503).json(COMMIT_UNKNOWN);
        result = await locally();
      }
    }
    if (result.source === 'cloud') {
      await refreshLocalRows(req.pgPool, req.localDb, 'order_print_details', lines.map((l) => l.print_detail_id)).catch(() => {});
    }
    const n = result.rows.length;
    res.status(201).json({
      message: result.source === 'cloud'
        ? `${n} print detail${n === 1 ? '' : 's'} added.`
        : `${n} print detail${n === 1 ? '' : 's'} saved on this computer (offline). They will sync when the connection is back.`,
      source: result.source,
      print_details: result.rows,
      print_detail: result.rows[0]
    });
  } catch (err) {
    sendError(res, err, 'adding print details', needsCloud('print_detail'));
  }
};
router.post('/:order_id/print-details', requireRole(EDIT_ROLES), requireOrderEditAccess, refuseArchivedOrder, addPrintDetails(false));
router.post('/:order_id/print-details/bulk', requireRole(EDIT_ROLES), requireOrderEditAccess, refuseArchivedOrder, addPrintDetails(true));

// Change or remove one line (online only; a line still waiting to sync is removed on this computer)
const lockedPrintLine = async (client, order_id, print_detail_id) => {
  const ord = await client.query('SELECT production_status FROM order_profiles WHERE order_id = $1 FOR UPDATE', [order_id]);
  if (ord.rowCount === 0) throw orderNotFound();
  if (!EDITABLE_STATUSES.includes(ord.rows[0].production_status)) {
    throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${ord.rows[0].production_status}, so its print details can no longer change.` });
  }
  const found = await client.query(
    `SELECT ${selectList('order_print_details', 'pg')} FROM order_print_details WHERE print_detail_id = $1 AND order_id = $2 FOR UPDATE`,
    [print_detail_id, order_id]);
  if (found.rowCount === 0) {
    throw new Rejected(404, { error: 'PRINT_DETAIL_NOT_FOUND', message: 'We could not find this print detail. If it was added offline, sync first.' });
  }
  return serialize('order_print_details', found.rows[0]);
};

router.patch('/:order_id/print-details/:print_detail_id', requireRole(EDIT_ROLES), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id, print_detail_id } = req.params;
  try {
    const materials = await orderMaterials(req, order_id);
    const saved = await withPgTransaction(req.pgPool, async (client) => {
      const current = await lockedPrintLine(client, order_id, print_detail_id);
      const merged = { ...current, ...(req.body || {}) };
      const material = merged.line_item_id ? materials.find((m) => m.line_item_id === merged.line_item_id) || null : null;
      if (merged.line_item_id && !material) {
        throw new Rejected(400, { error: 'VALIDATION_FAILED', message: 'Choose a material of this order.', details: [{ field: 'line_item_id', message: 'Choose a material of this order.' }] });
      }
      const checked = checkPrintLine(merged, material);
      if (checked.errors.length) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: checked.errors[0].message, details: checked.errors });
      const existing = await client.query('SELECT print_detail_id, line_item_id, quantity FROM order_print_details WHERE order_id = $1', [order_id]);
      const problems = overListed(materials, existing.rows, [checked.line], print_detail_id);
      if (problems.length) throw overListedRejection(problems);
      const l = checked.line;
      const { rows } = await client.query(
        `UPDATE order_print_details SET line_item_id = $2, print_type = $3, quantity = $4, size = $5, custom_name = $6, custom_number = $7, notes = $8
          WHERE print_detail_id = $1 RETURNING ${selectList('order_print_details', 'pg')}`,
        [print_detail_id, l.line_item_id, l.print_type, l.quantity, l.size, l.custom_name, l.custom_number, l.notes]);
      return serialize('order_print_details', rows[0]);
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'order_print_details', [print_detail_id]).catch(() => {});
    res.status(200).json({ message: 'Print detail updated.', source: 'cloud', print_detail: saved });
  } catch (err) {
    sendError(res, err, 'changing a print detail', needsCloud('print_detail'));
  }
});

router.delete('/:order_id/print-details/:print_detail_id', requireRole(EDIT_ROLES), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id, print_detail_id } = req.params;
  try {
    // A line added offline and not synced yet is simply removed here
    const local = await sqliteAll(req.localDb,
      "SELECT 1 FROM order_print_details WHERE print_detail_id = ? AND order_id = ? AND sync_status = 'pending_insert'", [print_detail_id, order_id]);
    if (local.length) {
      await sqliteRun(req.localDb, 'DELETE FROM order_print_details WHERE print_detail_id = ?', [print_detail_id]);
      return res.status(200).json({ message: 'Print detail removed.', source: 'local' });
    }
    await withPgTransaction(req.pgPool, async (client) => {
      const current = await lockedPrintLine(client, order_id, print_detail_id);
      await client.query('DELETE FROM order_print_details WHERE print_detail_id = $1', [print_detail_id]);
      await writeAudit(client, {
        entity: 'order_print_details', entity_id: print_detail_id, action: 'print_detail_removed', actor: req.user,
        details: { order_id, print_type: current.print_type, quantity: current.quantity, size: current.size, custom_name: current.custom_name, custom_number: current.custom_number }
      });
    });
    await sqliteRun(req.localDb, 'DELETE FROM order_print_details WHERE print_detail_id = ?', [print_detail_id]).catch(() => {});
    res.status(200).json({ message: 'Print detail removed.', source: 'cloud' });
  } catch (err) {
    sendError(res, err, 'removing a print detail', needsCloud('print_detail'));
  }
});

// =====================================================================
// DELIVERIES / PICK-UPS IN BATCHES
// =====================================================================
const readDelivery = (body, { partial }) => {
  const v = createValidator();
  const out = {};
  const given = (f) => body[f] !== undefined;
  if (!partial || given('quantity')) out.quantity = v.positiveInt(body.quantity, 'quantity');
  if (!partial || given('delivered_at')) out.delivered_at = v.pastShopDateTime(body.delivered_at, 'delivered_at', { required: false });
  if (!partial || given('method')) out.method = v.oneOf(body.method, 'method', DELIVERY_METHODS, { required: false }) || 'Pick-up';
  if (given('received_by_name')) out.received_by_name = v.optionalString(body.received_by_name, 'received_by_name', 255);
  if (given('notes')) out.notes = v.optionalString(body.notes, 'notes', 500);
  if (partial && Object.keys(out).length === 0 && !v.failed()) v.errors.push({ field: 'body', message: 'Nothing to change.' });
  return { v, fields: out };
};

// Locks the order and reads what has been handed over -> { order, pieces, deliveries }
const lockForDelivery = async (client, req, order_id) => {
  const ord = await client.query(
    `SELECT ${selectList('order_profiles', 'pg')} FROM order_profiles WHERE order_id = $1 FOR UPDATE`, [order_id]);
  if (ord.rowCount === 0) throw orderNotFound();
  const order = serialize('order_profiles', ord.rows[0]);
  if (order.archived_at) throw new Rejected(409, RECORD_ARCHIVED);
  const facts = await client.query(
    `SELECT COALESCE(SUM(oi.quantity) FILTER (WHERE LOWER(BTRIM(COALESCE(ii.item_category, ''))) <> 'consumable'), 0)::int AS pieces
       FROM order_items oi LEFT JOIN inventory_items ii ON ii.inventory_id = oi.inventory_id WHERE oi.order_id = $1`, [order_id]);
  const batches = await client.query(
    `SELECT ${selectList('order_deliveries', 'pg')} FROM order_deliveries WHERE order_id = $1 ORDER BY batch_no FOR UPDATE`, [order_id]);
  return { order, pieces: facts.rows[0].pieces, deliveries: batches.rows.map((r) => serialize('order_deliveries', r)) };
};

const tooMany = (remaining) => new Rejected(409, {
  error: 'DELIVERY_EXCEEDS_REMAINING',
  message: remaining > 0 ? `Only ${remaining} piece${remaining === 1 ? ' is' : 's are'} left to hand over.` : 'Every piece of this order was already handed over.',
  remaining
});

const deliveryRoute = (handler) => async (req, res) => {
  try {
    const located = await locateRecord(req, 'order_profiles', req.params.order_id);
    if (!located.location) throw orderNotFound();
    if (!located.cloudReachable) return res.status(503).json(needsCloud('delivery'));
    if (located.location === 'local') {
      return res.status(409).json({ error: 'ORDER_NOT_SYNCED', message: 'This order was saved offline and is not in the cloud yet. Sync first.' });
    }
    const out = await handler(req);
    await refreshLocalRows(req.pgPool, req.localDb, 'order_deliveries', out.ids).catch(() => {});
    if (out.removed) await sqliteRun(req.localDb, 'DELETE FROM order_deliveries WHERE delivery_id = ?', [out.removed]).catch(() => {});
    const view = await freshOrderView(req, req.params.order_id);
    pushOrderChange(req, view.order);
    res.status(out.status || 200).json({ message: out.message, source: 'cloud', delivery: out.delivery || null, ...view });
  } catch (err) {
    sendError(res, err, 'recording a delivery', needsCloud('delivery'));
  }
};

router.post('/:order_id/deliveries', requireRole(rolesWith('record_delivery')), requireOrderEditAccess, deliveryRoute(async (req) => {
  const { order_id } = req.params;
  const { v, fields } = readDelivery(req.body || {}, { partial: false });
  if (v.failed()) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: v.errors[0].message, details: v.errors });
  const delivery_id = crypto.randomUUID();
  return withPgTransaction(req.pgPool, async (client) => {
    const { order, pieces, deliveries } = await lockForDelivery(client, req, order_id);
    if (!DELIVERY_STATUSES.includes(order.production_status)) {
      throw new Rejected(409, {
        error: 'DELIVERY_NOT_ALLOWED',
        message: CLOSED_STATUSES.includes(order.production_status)
          ? `This order is ${order.production_status}, so no more pieces can be handed over.`
          : 'Pieces can be handed over once the job order is approved.'
      });
    }
    const f = fulfillmentSummary({ pieces_ordered: pieces, deliveries });
    if (fields.quantity > f.pieces_remaining) throw tooMany(f.pieces_remaining);
    const batch_no = deliveries.reduce((m, d) => Math.max(m, d.batch_no), 0) + 1;
    const { rows } = await client.query(
      `INSERT INTO order_deliveries (delivery_id, order_id, batch_no, quantity, delivered_at, method, received_by_name, notes, recorded_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, NOW() AT TIME ZONE 'UTC'), $6, $7, $8, $9)
       RETURNING ${selectList('order_deliveries', 'pg')}`,
      [delivery_id, order_id, batch_no, fields.quantity, fields.delivered_at, fields.method, fields.received_by_name || null, fields.notes || null, req.user.user_id]);
    const left = f.pieces_remaining - fields.quantity;
    return {
      status: 201,
      ids: [delivery_id],
      delivery: serialize('order_deliveries', rows[0]),
      message: `Batch ${batch_no} recorded: ${fields.quantity} piece${fields.quantity === 1 ? '' : 's'} handed over.`
        + (left > 0 ? ` ${left} left.` : ' Every piece is now handed over.')
    };
  });
}));

router.patch('/:order_id/deliveries/:delivery_id', requireRole(rolesWith('record_delivery')), requireOrderEditAccess, deliveryRoute(async (req) => {
  const { order_id, delivery_id } = req.params;
  const { v, fields } = readDelivery(req.body || {}, { partial: true });
  if (v.failed()) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: v.errors[0].message, details: v.errors });
  return withPgTransaction(req.pgPool, async (client) => {
    const { order, pieces, deliveries } = await lockForDelivery(client, req, order_id);
    if (CLOSED_STATUSES.includes(order.production_status)) {
      throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${order.production_status}, so its deliveries can no longer change.` });
    }
    const current = deliveries.find((d) => d.delivery_id === delivery_id);
    if (!current) throw new Rejected(404, { error: 'DELIVERY_NOT_FOUND', message: 'We could not find this batch.' });
    if (fields.quantity !== undefined) {
      const others = fulfillmentSummary({ pieces_ordered: pieces, deliveries: deliveries.filter((d) => d.delivery_id !== delivery_id) });
      if (fields.quantity > others.pieces_remaining) throw tooMany(others.pieces_remaining);
    }
    const changed = Object.keys(fields).filter((k) => fields[k] !== undefined && (fields[k] ?? null) !== (current[k] ?? null));
    if (changed.length === 0) return { ids: [delivery_id], delivery: current, message: 'Nothing changed.' };
    const { rows } = await client.query(
      `UPDATE order_deliveries SET ${changed.map((k, i) => `${k} = $${i + 2}${k === 'delivered_at' ? '::timestamp' : ''}`).join(', ')}
        WHERE delivery_id = $1 RETURNING ${selectList('order_deliveries', 'pg')}`,
      [delivery_id, ...changed.map((k) => fields[k])]);
    await writeAudit(client, {
      entity: 'order_deliveries', entity_id: delivery_id, action: 'delivery_corrected', actor: req.user,
      details: { order_id, batch_no: current.batch_no, before: Object.fromEntries(changed.map((k) => [k, current[k]])), after: Object.fromEntries(changed.map((k) => [k, fields[k]])) }
    });
    return { ids: [delivery_id], delivery: serialize('order_deliveries', rows[0]), message: `Batch ${current.batch_no} corrected.` };
  });
}));

router.delete('/:order_id/deliveries/:delivery_id', requireRole(rolesWith('record_delivery')), requireOrderEditAccess, deliveryRoute(async (req) => {
  const { order_id, delivery_id } = req.params;
  return withPgTransaction(req.pgPool, async (client) => {
    const { order, deliveries } = await lockForDelivery(client, req, order_id);
    if (CLOSED_STATUSES.includes(order.production_status)) {
      throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${order.production_status}, so its deliveries can no longer change.` });
    }
    const current = deliveries.find((d) => d.delivery_id === delivery_id);
    if (!current) throw new Rejected(404, { error: 'DELIVERY_NOT_FOUND', message: 'We could not find this batch.' });
    await client.query('DELETE FROM order_deliveries WHERE delivery_id = $1', [delivery_id]);
    await writeAudit(client, {
      entity: 'order_deliveries', entity_id: delivery_id, action: 'delivery_removed', actor: req.user,
      details: { order_id, batch_no: current.batch_no, quantity: current.quantity, delivered_at: current.delivered_at }
    });
    return { ids: [], removed: delivery_id, message: `Batch ${current.batch_no} removed.` };
  });
}));

// =====================================================================
// MONEY: refunds, verification, corrections, price cuts (online only)
// =====================================================================
const cloudOrder = async (req, res, what) => {
  const located = await locateRecord(req, 'order_profiles', req.params.order_id);
  if (!located.location) throw orderNotFound();
  if (!located.cloudReachable) { res.status(503).json(needsCloud(what)); return false; }
  if (located.location === 'local') {
    res.status(409).json({ error: 'ORDER_NOT_SYNCED', message: 'This order was saved offline and is not in the cloud yet. Sync first.' });
    return false;
  }
  return true;
};

const paidNetCentavos = async (client, order_id) => Number((await client.query(
  'SELECT COALESCE(ROUND(SUM(amount) * 100), 0)::bigint AS c FROM payments WHERE order_id = $1', [order_id])).rows[0].c);

router.post('/:order_id/refunds', requireRole(rolesWith('refund_payment')), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const amount = v.positiveMoney(body.amount, 'amount');
  const reason = v.oneOf(body.refund_reason, 'refund_reason', REFUND_REASONS);
  const notes = v.optionalString(body.notes, 'notes', 500);
  const payment_type = v.oneOf(body.payment_type, 'payment_type', PAYMENT_TYPES);
  const paid_at = v.pastShopDateTime(body.payment_date, 'payment_date', { required: false });
  if (reason === 'Other' && !notes) v.errors.push({ field: 'notes', message: 'Notes are required: write why the money is given back.' });
  // A refund names how the money went back; the method's own required fields are not forced
  // (a cash refund has no reference), but what is given is checked
  const checked = payment_type ? checkPaymentDetails(payment_type, body, { allOptional: true }) : { errors: [], details: {} };
  v.errors.push(...checked.errors);
  if (v.failed()) return v.send(res);
  const { details } = checked;
  const payment_id = crypto.randomUUID();
  const refund_reason = notes ? `${reason}: ${notes}` : reason;
  try {
    if (!(await cloudOrder(req, res, 'refund'))) return;
    const saved = await withPgTransaction(req.pgPool, async (client) => {
      const ord = await client.query(
        'SELECT production_status, tracking_no, total_quote_amount::text AS quote, archived_at IS NOT NULL AS archived FROM order_profiles WHERE order_id = $1 FOR UPDATE',
        [order_id]);
      if (ord.rowCount === 0) throw orderNotFound();
      if (ord.rows[0].archived) throw new Rejected(409, RECORD_ARCHIVED);
      const paidNet = toPesos(await paidNetCentavos(client, order_id));
      const problem = checkRefund({ status: ord.rows[0].production_status, quote: Number(ord.rows[0].quote), paidNet, amount });
      if (problem) throw new Rejected(problem.status, problem.body);
      const { rows } = await client.query(
        `INSERT INTO payments (payment_id, order_id, amount, payment_type, received_by, payment_date, is_refund, refund_reason, ${PAYMENT_DETAIL_NAMES.join(', ')})
         VALUES ($1, $2, -($3::numeric), $4, $5, COALESCE($6::timestamp, NOW() AT TIME ZONE 'UTC'), TRUE, $7,
                 ${PAYMENT_DETAIL_NAMES.map((n, i) => `$${i + 8}${n === 'cheque_date' ? '::date' : ''}`).join(', ')})
         RETURNING ${selectList('payments', 'pg')}`,
        [payment_id, order_id, amount, payment_type, req.user.user_id, paid_at, refund_reason, ...PAYMENT_DETAIL_NAMES.map((n) => details[n])]);
      const refund = serialize('payments', rows[0]);
      await writeAudit(client, {
        entity: 'payments', entity_id: payment_id, action: 'payment_refunded', actor: req.user,
        details: { order_id, tracking_no: ord.rows[0].tracking_no, amount, reason: refund_reason, payment_type, receipt_no: refund.receipt_no }
      });
      return refund;
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'payments', [payment_id]).catch(() => {});
    const view = await freshOrderView(req, order_id);
    pushOrderChange(req, view.order);
    res.status(201).json({
      message: `Refund of ${pesoText(amount)} recorded${saved.receipt_no ? ` as ${saved.receipt_no}` : ''}.`,
      source: 'cloud', payment: saved, ...view
    });
  } catch (err) {
    sendError(res, err, 'recording a refund', needsCloud('refund'));
  }
});

const lockedPayment = async (client, order_id, payment_id) => {
  const ord = await client.query('SELECT archived_at IS NOT NULL AS archived FROM order_profiles WHERE order_id = $1 FOR UPDATE', [order_id]);
  if (ord.rowCount === 0) throw orderNotFound();
  if (ord.rows[0].archived) throw new Rejected(409, RECORD_ARCHIVED);
  const found = await client.query(
    `SELECT ${selectList('payments', 'pg')} FROM payments WHERE payment_id = $1 AND order_id = $2 FOR UPDATE`, [payment_id, order_id]);
  if (found.rowCount === 0) {
    throw new Rejected(404, { error: 'PAYMENT_NOT_FOUND', message: 'We could not find this payment on this order. If it was saved offline, sync first.' });
  }
  return serialize('payments', found.rows[0]);
};

router.post('/:order_id/payments/:payment_id/verify', requireRole(rolesWith('verify_payment')), refuseArchivedOrder, async (req, res) => {
  const { order_id, payment_id } = req.params;
  try {
    if (!(await cloudOrder(req, res, 'payment_check'))) return;
    const saved = await withPgTransaction(req.pgPool, async (client) => {
      const p = await lockedPayment(client, order_id, payment_id);
      if (toCentavos(p.amount) <= 0) throw new Rejected(409, { error: 'NOT_VERIFIABLE', message: 'Voids and refunds are not verified.' });
      if (p.verified_at) throw new Rejected(409, { error: 'ALREADY_VERIFIED', message: 'This payment was already verified.' });
      const { rows } = await client.query(
        `UPDATE payments SET verified_by = $2, verified_at = NOW() AT TIME ZONE 'UTC' WHERE payment_id = $1 RETURNING ${selectList('payments', 'pg')}`,
        [payment_id, req.user.user_id]);
      await writeAudit(client, {
        entity: 'payments', entity_id: payment_id, action: 'payment_verified', actor: req.user,
        details: { order_id, receipt_no: p.receipt_no, payment_type: p.payment_type, reference_no: p.reference_no, amount: p.amount }
      });
      return serialize('payments', rows[0]);
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'payments', [payment_id]).catch(() => {});
    res.status(200).json({ message: `Payment ${saved.receipt_no || ''} marked as verified: the money was received.`.replace('  ', ' '), source: 'cloud', payment: saved });
  } catch (err) {
    sendError(res, err, 'verifying a payment', needsCloud('payment_check'));
  }
});

router.patch('/:order_id/payments/:payment_id', requireRole(rolesWith('edit_payment')), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id, payment_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  if (body.amount !== undefined) {
    v.errors.push({ field: 'amount', message: 'The amount of a payment cannot be changed. Void it and record the right amount instead.' });
  }
  const payment_type = v.oneOf(body.payment_type, 'payment_type', PAYMENT_TYPES, { required: false });
  const paid_at = body.payment_date !== undefined ? v.pastShopDateTime(body.payment_date, 'payment_date') : undefined;
  if (v.failed()) return v.send(res);
  try {
    if (!(await cloudOrder(req, res, 'payment_check'))) return;
    const saved = await withPgTransaction(req.pgPool, async (client) => {
      const before = await lockedPayment(client, order_id, payment_id);
      if (before.voids_payment_id) throw new Rejected(409, { error: 'NOT_EDITABLE', message: 'A void cannot be changed.' });
      const type = payment_type || before.payment_type;
      // Details not sent keep their current value (for the method they are checked against)
      const merged = Object.fromEntries(PAYMENT_DETAIL_NAMES.map((n) => [n, body[n] !== undefined ? body[n] : before[n]]));
      const checked = checkPaymentDetails(type, merged, { allOptional: Boolean(before.is_refund) });
      if (checked.errors.length) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: checked.errors[0].message, details: checked.errors });
      const next = { payment_type: type, ...checked.details };
      if (paid_at !== undefined) next.payment_date = paid_at.replace(' ', 'T');
      const changed = Object.keys(next).filter((k) => String(next[k] ?? '') !== String(before[k] ?? ''));
      if (changed.length === 0) return { payment: before, changed };
      // Changed money details must be checked again (notes and payer name do not count)
      const recheck = changed.some((k) => !['payment_notes', 'payer_name', 'payment_date'].includes(k)) && before.verified_at;
      const { rows } = await client.query(
        `UPDATE payments SET ${changed.map((k, i) => `${k} = $${i + 2}${k === 'payment_date' ? '::timestamp' : k === 'cheque_date' ? '::date' : ''}`).join(', ')}
                ${recheck ? ', verified_by = NULL, verified_at = NULL' : ''}
          WHERE payment_id = $1 RETURNING ${selectList('payments', 'pg')}`,
        [payment_id, ...changed.map((k) => next[k])]);
      await writeAudit(client, {
        entity: 'payments', entity_id: payment_id, action: 'payment_corrected', actor: req.user,
        details: {
          order_id, receipt_no: before.receipt_no, verification_cleared: Boolean(recheck),
          before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]]))
        }
      });
      return { payment: serialize('payments', rows[0]), changed, recheck };
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'payments', [payment_id]).catch(() => {});
    res.status(200).json({
      message: saved.changed.length === 0 ? 'Nothing changed.'
        : `Payment corrected.${saved.recheck ? ' Its money details changed, so it needs to be verified again.' : ''}`,
      source: 'cloud', payment: saved.payment, changed: saved.changed
    });
  } catch (err) {
    sendError(res, err, 'correcting a payment', needsCloud('payment_check'));
  }
});

router.post('/:order_id/price-adjustment', requireRole(rolesWith('set_quote')), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const amount = v.nonNegativeMoney(body.adjustment_amount, 'adjustment_amount');
  const reason = v.optionalString(body.adjustment_reason, 'adjustment_reason', ADJUSTMENT_REASON_MAX);
  if (v.failed()) return v.send(res);
  try {
    if (!(await cloudOrder(req, res, 'price_adjustment'))) return;
    await withPgTransaction(req.pgPool, async (client) => {
      const { rows } = await client.query(`SELECT ${selectList('order_profiles', 'pg')} FROM order_profiles WHERE order_id = $1 FOR UPDATE`, [order_id]);
      if (rows.length === 0) throw orderNotFound();
      const order = serialize('order_profiles', rows[0]);
      if (!['Approved', 'Printing', 'Pressing', 'Completed'].includes(order.production_status)) {
        throw new Rejected(409, {
          error: 'ADJUSTMENT_NOT_ALLOWED',
          message: order.production_status === 'Cancelled'
            ? 'This order was cancelled. Refund what was paid instead.'
            : 'Before approval, change the quote itself (discount) instead of a price cut.'
        });
      }
      const resolved = resolveAdjustment(order, { amount, reason });
      if (resolved.problem) throw new Rejected(resolved.problem.status, resolved.problem.body);
      await client.query(
        `UPDATE order_profiles SET adjustment_amount = $2, adjustment_reason = $3, total_quote_amount = $4,
                last_edited_by = $5, last_edited_role = $6 WHERE order_id = $1`,
        [order_id, toPesos(resolved.adjustmentC), resolved.adjustmentC > 0 ? reason : null, toPesos(resolved.totalC), req.user.user_id, req.user.role]);
      await writeAudit(client, {
        entity: 'order_profiles', entity_id: order_id, action: 'price_adjusted', actor: req.user,
        details: {
          tracking_no: order.tracking_no, reason, before: quoteBreakdown(order),
          after: { adjustment_amount: toPesos(resolved.adjustmentC), total_quote_amount: toPesos(resolved.totalC) }
        }
      });
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'order_profiles', [order_id]).catch(() => {});
    const view = await freshOrderView(req, order_id);
    pushOrderChange(req, view.order);
    const overpaid = view.totals.overpaid_by > 0;
    res.status(200).json({
      message: amount > 0
        ? `Price cut saved. The bill is now ${pesoText(view.order.total_quote_amount)}.${overpaid ? ` ${pesoText(view.totals.overpaid_by)} was paid above it: refund it to the customer.` : ''}`
        : 'Price cut removed.',
      source: 'cloud', ...view
    });
  } catch (err) {
    sendError(res, err, 'saving a price cut', needsCloud('price_adjustment'));
  }
});

module.exports = router;

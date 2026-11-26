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
// POST   /api/orders/:order_id/deliveries              { quantity, delivered_at?, method?, received_by_name?, notes?, plan_id? }
// PATCH  /api/orders/:order_id/deliveries/:delivery_id (any of those)
// DELETE /api/orders/:order_id/deliveries/:delivery_id
// Migration 016 (adviser consultation): batches planned ahead, and design files from the computer
// POST   /api/orders/:order_id/delivery-plans           { planned_quantity, planned_date?, notes? }
// PATCH  /api/orders/:order_id/delivery-plans/:plan_id  { planned_quantity?, planned_date?, notes?, ready? }
// DELETE /api/orders/:order_id/delivery-plans/:plan_id  (only while nothing of it was handed over)
//   When batches are planned, every hand-over names its batch (plan_id), a batch is handed over
//   only once it is marked ready, and the order is Completed only when every batch is delivered.
// GET    /api/orders/:order_id/design-files             -> { files, available }
// POST   /api/orders/:order_id/design-files?name=&notes=   body: the file itself (any content type), 20 MB max
// GET    /api/orders/:order_id/design-files/:file_id    the file (download, or ?inline=1 for an image preview)
// DELETE /api/orders/:order_id/design-files/:file_id
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
  selectList, serialize, listRecords, getRecord, locateRecord, withPgTransaction, withLocalTransaction, sqliteRun, sqliteAll, readLocal,
  userNames
} = require('../services/records');
const { rolesWith, can } = require('../services/domain/permissions');
const {
  EDITABLE_STATUSES, CLOSED_STATUSES, DELIVERY_STATUSES, DELIVERY_METHODS, fulfillmentSummary, planSummary, withDeadlineFlag
} = require('../services/domain/orderLifecycle');
const {
  paymentMethodForms, checkPaymentDetails, PAYMENT_DETAIL_NAMES, REFUND_REASONS, checkRefund, toCentavos, toPesos, pesoText
} = require('../services/domain/payments');
const { resolveAdjustment, ADJUSTMENT_REASON_MAX, quoteBreakdown, computeQuote, INCIDENTAL_PERCENT_MAX } = require('../services/domain/pricing');
const { normalizeRequiredItems } = require('../services/capacity');
const { PRINT_SIZES, PRINT_PLACEMENTS, VOLUME_TIERS } = require('../services/domain/pricing');
const { productionProgress, refundLimits, lateDeliveryCut, checkProgressUpdate } = require('../services/domain/orderPolicies');
const { GARMENT_SIZES, PRINT_LIMITS, checkPrintLine, overListed, defaultMaterialFor } = require('../services/domain/printDetails');
const { catalogFacts, describeMaterials, piecesOf } = require('../services/orderContext');
const { writeAudit } = require('../services/auditLog');
const {
  MAX_FILE_BYTES, MAX_FILES_PER_ORDER, FILE_NOTES_MAX, FILE_COLUMNS, checkUpload, contentDisposition, shownFile, listDesignFiles,
  isPreviewable
} = require('../services/designFiles');
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
    price_adjustment: 'A price cut needs the cloud connection, so every branch sees the same bill. Try again when online.',
    delivery_plan: 'Planning delivery batches needs the cloud connection, so every branch sees the same plan. Nothing was saved. Try again when online.',
    design_file: 'Design files are kept in the cloud, so attaching, opening or removing one needs the internet connection. Try again when online.',
    progress: 'Recording production progress needs the cloud connection, so every branch sees the same counts. Try again when online.'
  }[what]
});
const sendError = (res, err, context, cloudBody) => {
  if (err instanceof Rejected) return res.status(err.status).json(err.body);
  if (isConnectionError(err)) return res.status(503).json(err.commitUnknown ? COMMIT_UNKNOWN : cloudBody);
  return sendDbError(res, err, context);
};
const orderNotFound = () => new Rejected(404, { error: 'ORDER_NOT_FOUND', message: NOT_FOUND_TEXT.Order });

router.use(verifyToken);
for (const name of ['order_id', 'print_detail_id', 'delivery_id', 'payment_id', 'plan_id', 'file_id']) {
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
    print_limits: PRINT_LIMITS,
    // migration 017: print areas that price a per-area item (blank + each print), and the tiers
    print_sizes: Object.entries(PRINT_SIZES).map(([size, s]) => ({ size, label: s.label, price: s.price })),
    print_placements: PRINT_PLACEMENTS,
    volume_tiers: VOLUME_TIERS
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
  const SQL_COLUMNS = 'inventory_id, item_name, selling_price, unit_cost, print_pricing';
  let rows;
  let source = 'cloud';
  try {
    rows = (await req.pgPool.query(
      `SELECT inventory_id, item_name, selling_price::text AS selling_price, unit_cost::text AS unit_cost, print_pricing FROM inventory_items
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
    items: normalized.lines.map((n, i) => {
      const row = byId.get(n.inventory_id);
      return {
        line_item_id: String(i + 1), product_type: row.item_name, quantity: n.quantity_needed,
        inventory_id: n.inventory_id, item_name: row.item_name, selling_price: row.selling_price,
        unit_cost: row.unit_cost, print_pricing: row.print_pricing, print_areas: n.print_areas
      };
    }),
    requested: { labor, incidental, incidental_percent },
    existing: { amount: 0, reason: null, labor: 0, incidental: 0 }
  });
  if (problem) return res.status(problem.status).json({ ...problem.body, source });
  // line_item_id here is only a position: send the material instead
  quote.lines = quote.lines.map((l, i) => ({ ...l, line_item_id: undefined, inventory_id: normalized.lines[i].inventory_id }));
  return res.status(200).json({ quote, source });
});

// The order after a change, as the detail screen needs it -> { order, totals, allowed_actions, fulfillment }
const freshOrderView = async (req, order_id) => {
  const { record: order } = await getRecord(req, 'order_profiles', order_id);
  const { allowed_actions, context, view } = await actionsWithContext(req, order);
  return {
    order: withDeadlineFlag(order),
    totals: {
      ...paymentTotals(order, view.summary), total_refunded: view.summary.total_refunded, max_refund: context.max_refund,
      admin_max_refund: context.admin_max_refund
    },
    allowed_actions,
    fulfillment: context.fulfillment,
    completion: context.completion,
    // migration 017
    progress: context.progress,
    cancel_terms: context.cancel_terms,
    late_cut: context.late_cut
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
  if (given('plan_id')) out.plan_id = body.plan_id === null ? null : v.id(body.plan_id, 'plan_id'); // migration 016
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
  // migration 016: the batches planned ahead
  const plans = await client.query(
    `SELECT ${selectList('order_delivery_plans', 'pg')} FROM order_delivery_plans WHERE order_id = $1 ORDER BY batch_no FOR UPDATE`, [order_id]);
  return {
    order,
    pieces: facts.rows[0].pieces,
    deliveries: batches.rows.map((r) => serialize('order_deliveries', r)),
    plans: plans.rows.map((r) => serialize('order_delivery_plans', r))
  };
};

// migration 016: the planned batch a hand-over is for. With batches planned, every hand-over must
// name a batch that is ready, and may not hand over more than is left of it.
//   quantity: the pieces of this hand-over; others: the other hand-overs of the order
const checkPlannedBatch = ({ plans, others, plan_id, quantity }) => {
  if (plans.length === 0) {
    if (plan_id) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: 'This order has no planned batches.', details: [{ field: 'plan_id', message: 'No planned batch to choose.' }] });
    return null;
  }
  if (!plan_id) {
    throw new Rejected(400, {
      error: 'VALIDATION_FAILED',
      message: 'This order is delivered in planned batches. Choose which batch these pieces belong to.',
      details: [{ field: 'plan_id', message: 'Choose the planned batch.' }]
    });
  }
  const plan = plans.find((p) => p.plan_id === plan_id);
  if (!plan) throw new Rejected(404, { error: 'DELIVERY_PLAN_NOT_FOUND', message: 'We could not find this planned batch.' });
  const summary = planSummary(plan, others);
  if (!plan.ready_at) {
    throw new Rejected(409, {
      error: 'BATCH_NOT_READY',
      message: `Planned batch #${plan.batch_no} is not marked ready yet. Mark it ready when its pieces are done, then record the hand-over.`
    });
  }
  if (quantity > summary.remaining) {
    throw new Rejected(409, {
      error: 'DELIVERY_EXCEEDS_BATCH',
      message: summary.remaining > 0
        ? `Planned batch #${plan.batch_no} has only ${summary.remaining} piece${summary.remaining === 1 ? '' : 's'} left to hand over.`
        : `Planned batch #${plan.batch_no} was already handed over in full.`,
      remaining: summary.remaining
    });
  }
  return plan;
};

// migration 017: how many pieces are ready (printed, and pressed where needed)
const readyPieces = async (client, order_id, status = null) => {
  const { rows } = await client.query(
    `SELECT oi.line_item_id, oi.product_type, oi.quantity, oi.qty_printed, oi.qty_pressed,
            COALESCE(ii.requires_pressing, FALSE) AS requires_pressing,
            LOWER(BTRIM(COALESCE(ii.item_category, ''))) = 'consumable' AS is_consumable
       FROM order_items oi LEFT JOIN inventory_items ii ON ii.inventory_id = oi.inventory_id WHERE oi.order_id = $1`, [order_id]);
  return productionProgress(rows, status).ready;
};
const notReady = (canGive, ready) => new Rejected(409, {
  error: 'PIECES_NOT_READY',
  message: canGive > 0
    ? `Only ${canGive} more piece${canGive === 1 ? ' is' : 's are'} ready to hand over (${ready} ready so far). Record the printing / pressing first.`
    : `No more pieces are ready to hand over (${ready} ready so far). Record the printing / pressing first.`,
  ready
});

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
    const { order, pieces, deliveries, plans } = await lockForDelivery(client, req, order_id);
    if (!DELIVERY_STATUSES.includes(order.production_status)) {
      throw new Rejected(409, {
        error: 'DELIVERY_NOT_ALLOWED',
        message: CLOSED_STATUSES.includes(order.production_status)
          ? `This order is ${order.production_status}, so no more pieces can be handed over.`
          : 'Pieces can be handed over once printing has started, as they are finished.'
      });
    }
    const f = fulfillmentSummary({ pieces_ordered: pieces, deliveries });
    if (fields.quantity > f.pieces_remaining) throw tooMany(f.pieces_remaining);
    const ready = await readyPieces(client, order_id, order.production_status);
    if (fields.quantity > ready - f.pieces_delivered) throw notReady(ready - f.pieces_delivered, ready);
    const plan = checkPlannedBatch({ plans, others: deliveries, plan_id: fields.plan_id, quantity: fields.quantity });
    const batch_no = deliveries.reduce((m, d) => Math.max(m, d.batch_no), 0) + 1;
    const { rows } = await client.query(
      `INSERT INTO order_deliveries (delivery_id, order_id, batch_no, quantity, delivered_at, method, received_by_name, notes, recorded_by, plan_id)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, NOW() AT TIME ZONE 'UTC'), $6, $7, $8, $9, $10)
       RETURNING ${selectList('order_deliveries', 'pg')}`,
      [delivery_id, order_id, batch_no, fields.quantity, fields.delivered_at, fields.method, fields.received_by_name || null, fields.notes || null,
        req.user.user_id, plan ? plan.plan_id : null]);
    const left = f.pieces_remaining - fields.quantity;
    return {
      status: 201,
      ids: [delivery_id],
      delivery: serialize('order_deliveries', rows[0]),
      message: `${plan ? `Planned batch #${plan.batch_no}: ` : `Batch ${batch_no} recorded: `}${fields.quantity} piece${fields.quantity === 1 ? '' : 's'} handed over.`
        + (left > 0 ? ` ${left} left.` : ' Every piece is now handed over.')
    };
  });
}));

router.patch('/:order_id/deliveries/:delivery_id', requireRole(rolesWith('record_delivery')), requireOrderEditAccess, deliveryRoute(async (req) => {
  const { order_id, delivery_id } = req.params;
  const { v, fields } = readDelivery(req.body || {}, { partial: true });
  if (v.failed()) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: v.errors[0].message, details: v.errors });
  return withPgTransaction(req.pgPool, async (client) => {
    const { order, pieces, deliveries, plans } = await lockForDelivery(client, req, order_id);
    if (CLOSED_STATUSES.includes(order.production_status)) {
      throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${order.production_status}, so its deliveries can no longer change.` });
    }
    const current = deliveries.find((d) => d.delivery_id === delivery_id);
    if (!current) throw new Rejected(404, { error: 'DELIVERY_NOT_FOUND', message: 'We could not find this batch.' });
    const otherRows = deliveries.filter((d) => d.delivery_id !== delivery_id);
    if (fields.quantity !== undefined) {
      const others = fulfillmentSummary({ pieces_ordered: pieces, deliveries: otherRows });
      if (fields.quantity > others.pieces_remaining) throw tooMany(others.pieces_remaining);
      if (fields.quantity > current.quantity) {
        const ready = await readyPieces(client, order_id, order.production_status);
        if (fields.quantity > ready - others.pieces_delivered) throw notReady(ready - others.pieces_delivered, ready);
      }
    }
    // migration 016: a hand-over of a planned batch stays within what is left of that batch
    if (plans.length > 0 && (fields.quantity !== undefined || fields.plan_id !== undefined)) {
      const planId = fields.plan_id !== undefined ? fields.plan_id : current.plan_id;
      checkPlannedBatch({ plans, others: otherRows, plan_id: planId, quantity: fields.quantity !== undefined ? fields.quantity : current.quantity });
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
// MIGRATION 016: DELIVERY BATCHES PLANNED AHEAD (online only, like deliveries)
// =====================================================================
const PLAN_NOTES_MAX = 500;
const readPlan = (body, { partial }) => {
  const v = createValidator();
  const out = {};
  const given = (f) => body[f] !== undefined;
  if (!partial || given('planned_quantity')) out.planned_quantity = v.positiveInt(body.planned_quantity, 'planned_quantity');
  if (given('planned_date')) out.planned_date = body.planned_date === null || body.planned_date === '' ? null : v.shopDay(body.planned_date, 'planned_date');
  if (given('notes')) out.notes = v.optionalString(body.notes, 'notes', PLAN_NOTES_MAX);
  if (partial && given('ready')) out.ready = v.bool(body.ready, 'ready');
  if (partial && Object.keys(out).length === 0 && !v.failed()) v.errors.push({ field: 'body', message: 'Nothing to change.' });
  return { v, fields: out };
};
const planOpenOrClosed = (order) => {
  if (!EDITABLE_STATUSES.includes(order.production_status)) {
    throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${order.production_status}, so its delivery plan can no longer change.` });
  }
};
// Planned pieces may not add up to more than the order's pieces
const tooManyPlanned = (pieces, plannedElsewhere) => new Rejected(409, {
  error: 'PLAN_EXCEEDS_ORDER',
  message: `The batches would add up to more than the order's ${pieces} piece${pieces === 1 ? '' : 's'}. `
    + `${Math.max(0, pieces - plannedElsewhere)} piece${pieces - plannedElsewhere === 1 ? ' is' : 's are'} left to plan.`,
  left_to_plan: Math.max(0, pieces - plannedElsewhere)
});

const planRoute = (handler) => async (req, res) => {
  try {
    const located = await locateRecord(req, 'order_profiles', req.params.order_id);
    if (!located.location) throw orderNotFound();
    if (!located.cloudReachable) return res.status(503).json(needsCloud('delivery_plan'));
    if (located.location === 'local') {
      return res.status(409).json({ error: 'ORDER_NOT_SYNCED', message: 'This order was saved offline and is not in the cloud yet. Sync first.' });
    }
    const out = await handler(req);
    await refreshLocalRows(req.pgPool, req.localDb, 'order_delivery_plans', out.ids).catch(() => {});
    if (out.removed) await sqliteRun(req.localDb, 'DELETE FROM order_delivery_plans WHERE plan_id = ?', [out.removed]).catch(() => {});
    const view = await freshOrderView(req, req.params.order_id);
    pushOrderChange(req, view.order);
    res.status(out.status || 200).json({ message: out.message, source: 'cloud', plan: out.plan || null, ...view });
  } catch (err) {
    sendError(res, err, 'planning a delivery batch', needsCloud('delivery_plan'));
  }
};

router.post('/:order_id/delivery-plans', requireRole(rolesWith('record_delivery')), requireOrderEditAccess, planRoute(async (req) => {
  const { order_id } = req.params;
  const { v, fields } = readPlan(req.body || {}, { partial: false });
  if (v.failed()) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: v.errors[0].message, details: v.errors });
  const plan_id = crypto.randomUUID();
  return withPgTransaction(req.pgPool, async (client) => {
    const { order, pieces, plans } = await lockForDelivery(client, req, order_id);
    planOpenOrClosed(order);
    if (pieces <= 0) throw new Rejected(409, { error: 'NO_PIECES', message: 'Add the order’s materials first: there are no pieces to deliver yet.' });
    const planned = plans.reduce((s, p) => s + p.planned_quantity, 0);
    if (planned + fields.planned_quantity > pieces) throw tooManyPlanned(pieces, planned);
    const batch_no = plans.reduce((m, p) => Math.max(m, p.batch_no), 0) + 1;
    const { rows } = await client.query(
      `INSERT INTO order_delivery_plans (plan_id, order_id, batch_no, planned_quantity, planned_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7) RETURNING ${selectList('order_delivery_plans', 'pg')}`,
      [plan_id, order_id, batch_no, fields.planned_quantity, fields.planned_date || null, fields.notes || null, req.user.user_id]);
    await writeAudit(client, {
      entity: 'order_delivery_plans', entity_id: plan_id, action: 'delivery_batch_planned', actor: req.user,
      details: { order_id, batch_no, planned_quantity: fields.planned_quantity, planned_date: fields.planned_date || null }
    });
    const left = pieces - planned - fields.planned_quantity;
    return {
      status: 201,
      ids: [plan_id],
      plan: serialize('order_delivery_plans', rows[0]),
      message: `Batch #${batch_no} planned: ${fields.planned_quantity} piece${fields.planned_quantity === 1 ? '' : 's'}.`
        + (left > 0 ? ` ${left} piece${left === 1 ? ' is' : 's are'} not in a batch yet.` : ' Every piece is now in a batch.')
    };
  });
}));

router.patch('/:order_id/delivery-plans/:plan_id', requireRole(rolesWith('record_delivery')), requireOrderEditAccess, planRoute(async (req) => {
  const { order_id, plan_id } = req.params;
  const { v, fields } = readPlan(req.body || {}, { partial: true });
  if (v.failed()) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: v.errors[0].message, details: v.errors });
  return withPgTransaction(req.pgPool, async (client) => {
    const { order, pieces, plans, deliveries } = await lockForDelivery(client, req, order_id);
    planOpenOrClosed(order);
    const current = plans.find((p) => p.plan_id === plan_id);
    if (!current) throw new Rejected(404, { error: 'DELIVERY_PLAN_NOT_FOUND', message: 'We could not find this planned batch.' });
    const summary = planSummary(current, deliveries);
    if (fields.planned_quantity !== undefined) {
      if (fields.planned_quantity < summary.delivered) {
        throw new Rejected(409, {
          error: 'PLAN_BELOW_DELIVERED',
          message: `${summary.delivered} piece${summary.delivered === 1 ? ' of this batch was' : 's of this batch were'} already handed over, so it cannot be smaller than that.`
        });
      }
      const elsewhere = plans.filter((p) => p.plan_id !== plan_id).reduce((s, p) => s + p.planned_quantity, 0);
      if (elsewhere + fields.planned_quantity > pieces) throw tooManyPlanned(pieces, elsewhere);
    }
    const sets = [];
    const params = [plan_id];
    const put = (col, value, cast = '') => { params.push(value); sets.push(`${col} = $${params.length}${cast}`); };
    if (fields.planned_quantity !== undefined) put('planned_quantity', fields.planned_quantity);
    if (fields.planned_date !== undefined) put('planned_date', fields.planned_date, '::date');
    if (fields.notes !== undefined) put('notes', fields.notes || null);
    let readyNote = '';
    if (fields.ready === true && !current.ready_at) {
      if (!DELIVERY_STATUSES.includes(order.production_status)) {
        throw new Rejected(409, { error: 'NOT_APPROVED_YET', message: 'A batch can be marked ready once printing has started.' });
      }
      sets.push("ready_at = NOW() AT TIME ZONE 'UTC'");
      put('ready_by', req.user.user_id);
      readyNote = ' It is ready to be picked up or delivered.';
    } else if (fields.ready === false && current.ready_at) {
      if (summary.delivered > 0) {
        throw new Rejected(409, { error: 'BATCH_ALREADY_HANDED_OVER', message: 'Pieces of this batch were already handed over, so it stays marked ready.' });
      }
      sets.push('ready_at = NULL', 'ready_by = NULL');
      readyNote = ' It is back in production.';
    }
    if (sets.length === 0) return { ids: [plan_id], plan: current, message: 'Nothing changed.' };
    const { rows } = await client.query(
      `UPDATE order_delivery_plans SET ${sets.join(', ')} WHERE plan_id = $1 RETURNING ${selectList('order_delivery_plans', 'pg')}`, params);
    const updated = serialize('order_delivery_plans', rows[0]);
    await writeAudit(client, {
      entity: 'order_delivery_plans', entity_id: plan_id, action: fields.ready === true ? 'delivery_batch_ready' : 'delivery_batch_changed', actor: req.user,
      details: {
        order_id, batch_no: current.batch_no,
        before: { planned_quantity: current.planned_quantity, planned_date: current.planned_date, ready_at: current.ready_at, notes: current.notes },
        after: { planned_quantity: updated.planned_quantity, planned_date: updated.planned_date, ready_at: updated.ready_at, notes: updated.notes }
      }
    });
    return { ids: [plan_id], plan: updated, message: `Batch #${current.batch_no} updated.${readyNote}` };
  });
}));

router.delete('/:order_id/delivery-plans/:plan_id', requireRole(rolesWith('record_delivery')), requireOrderEditAccess, planRoute(async (req) => {
  const { order_id, plan_id } = req.params;
  return withPgTransaction(req.pgPool, async (client) => {
    const { order, plans, deliveries } = await lockForDelivery(client, req, order_id);
    planOpenOrClosed(order);
    const current = plans.find((p) => p.plan_id === plan_id);
    if (!current) throw new Rejected(404, { error: 'DELIVERY_PLAN_NOT_FOUND', message: 'We could not find this planned batch.' });
    if (deliveries.some((d) => d.plan_id === plan_id)) {
      throw new Rejected(409, {
        error: 'BATCH_ALREADY_HANDED_OVER',
        message: 'Pieces of this batch were already handed over. Remove those hand-overs first, or keep the batch.'
      });
    }
    await client.query('DELETE FROM order_delivery_plans WHERE plan_id = $1', [plan_id]);
    await writeAudit(client, {
      entity: 'order_delivery_plans', entity_id: plan_id, action: 'delivery_batch_removed', actor: req.user,
      details: { order_id, batch_no: current.batch_no, planned_quantity: current.planned_quantity, planned_date: current.planned_date }
    });
    return { ids: [], removed: plan_id, message: `Planned batch #${current.batch_no} removed.` };
  });
}));

// =====================================================================
// MIGRATION 016: DESIGN FILES FROM THE COMPUTER (cloud only)
// =====================================================================
const designFileOrder = async (req, res) => {
  const located = await locateRecord(req, 'order_profiles', req.params.order_id);
  if (!located.location) throw orderNotFound();
  if (!located.cloudReachable) { res.status(503).json(needsCloud('design_file')); return null; }
  if (located.location === 'local') {
    res.status(409).json({ error: 'ORDER_NOT_SYNCED', message: 'This order was saved offline and is not in the cloud yet. Attach design files after it syncs.' });
    return null;
  }
  return located;
};

router.get('/:order_id/design-files', requireRole(rolesWith('view_orders')), async (req, res) => {
  try {
    const out = await listDesignFiles(req, req.params.order_id);
    res.status(200).json({ source: out.available ? 'cloud' : 'local', ...out });
  } catch (err) {
    sendError(res, err, 'listing design files', needsCloud('design_file'));
  }
});

// The file itself comes as the request body (no multipart): the browser sends the File as it is
router.post('/:order_id/design-files', requireRole(EDIT_ROLES), requireOrderEditAccess, refuseArchivedOrder,
  express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), async (req, res) => {
    const { order_id } = req.params;
    const v = createValidator();
    const notes = v.optionalString(req.query.notes, 'notes', FILE_NOTES_MAX);
    if (v.failed()) return v.send(res);
    const checked = checkUpload({ name: req.query.name, buffer: Buffer.isBuffer(req.body) ? req.body : null });
    if (checked.error) {
      return res.status(400).json({ error: 'INVALID_DESIGN_FILE', message: checked.error, details: [{ field: 'file', message: checked.error }] });
    }
    try {
      if (!(await designFileOrder(req, res))) return;
      const file_id = crypto.randomUUID();
      const row = await withPgTransaction(req.pgPool, async (client) => {
        const ord = await client.query(
          `SELECT ${selectList('order_profiles', 'pg')} FROM order_profiles WHERE order_id = $1 FOR UPDATE`, [order_id]);
        if (ord.rowCount === 0) throw orderNotFound();
        const order = serialize('order_profiles', ord.rows[0]);
        if (order.archived_at) throw new Rejected(409, RECORD_ARCHIVED);
        if (!EDITABLE_STATUSES.includes(order.production_status)) {
          throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${order.production_status}, so no more design files can be attached.` });
        }
        const count = await client.query('SELECT COUNT(*)::int AS n FROM order_design_files WHERE order_id = $1', [order_id]);
        if (count.rows[0].n >= MAX_FILES_PER_ORDER) {
          throw new Rejected(409, { error: 'TOO_MANY_DESIGN_FILES', message: `An order can have up to ${MAX_FILES_PER_ORDER} design files. Remove one first.` });
        }
        const { rows } = await client.query(
          `INSERT INTO order_design_files (file_id, order_id, file_name, mime_type, size_bytes, content, notes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${FILE_COLUMNS}`,
          [file_id, order_id, checked.file_name, checked.mime_type, checked.size_bytes, req.body, notes || null, req.user.user_id]);
        await writeAudit(client, {
          entity: 'order_design_files', entity_id: file_id, action: 'design_file_added', actor: req.user,
          details: { order_id, tracking_no: order.tracking_no, file_name: checked.file_name, size_bytes: checked.size_bytes }
        });
        return rows[0];
      });
      res.status(201).json({
        message: `${checked.file_name} attached to the order.`,
        source: 'cloud',
        file: shownFile(row, await userNames(req, [req.user.user_id]))
      });
    } catch (err) {
      sendError(res, err, 'attaching a design file', needsCloud('design_file'));
    }
  });

router.get('/:order_id/design-files/:file_id', requireRole(rolesWith('view_orders')), async (req, res) => {
  const { order_id, file_id } = req.params;
  try {
    const { rows } = await req.pgPool.query(
      'SELECT file_name, mime_type, content FROM order_design_files WHERE order_id = $1 AND file_id = $2', [order_id, file_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'DESIGN_FILE_NOT_FOUND', message: 'We could not find this design file.' });
    const file = rows[0];
    // Only real PNG / JPEG / GIF / WebP images are shown in the page; everything else downloads
    const inline = req.query.inline === '1' && isPreviewable(file.mime_type, file.content);
    res.set('Content-Type', inline ? file.mime_type : 'application/octet-stream');
    res.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', file.file_name));
    res.set('X-Content-Type-Options', 'nosniff');
    res.status(200).send(file.content);
  } catch (err) {
    sendError(res, err, 'opening a design file', needsCloud('design_file'));
  }
});

router.delete('/:order_id/design-files/:file_id', requireRole(EDIT_ROLES), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id, file_id } = req.params;
  try {
    if (!(await designFileOrder(req, res))) return;
    const removed = await withPgTransaction(req.pgPool, async (client) => {
      const ord = await client.query('SELECT production_status, tracking_no FROM order_profiles WHERE order_id = $1 FOR UPDATE', [order_id]);
      if (ord.rowCount === 0) throw orderNotFound();
      if (!EDITABLE_STATUSES.includes(ord.rows[0].production_status)) {
        throw new Rejected(409, { error: 'ORDER_CLOSED', message: `This order is ${ord.rows[0].production_status}, so its design files are kept as they are.` });
      }
      const { rows } = await client.query(
        'DELETE FROM order_design_files WHERE order_id = $1 AND file_id = $2 RETURNING file_name, size_bytes', [order_id, file_id]);
      if (rows.length === 0) throw new Rejected(404, { error: 'DESIGN_FILE_NOT_FOUND', message: 'We could not find this design file.' });
      await writeAudit(client, {
        entity: 'order_design_files', entity_id: file_id, action: 'design_file_removed', actor: req.user,
        details: { order_id, tracking_no: ord.rows[0].tracking_no, file_name: rows[0].file_name, size_bytes: rows[0].size_bytes }
      });
      return rows[0];
    });
    res.status(200).json({ message: `${removed.file_name} removed from the order.`, source: 'cloud' });
  } catch (err) {
    sendError(res, err, 'removing a design file', needsCloud('design_file'));
  }
});

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
  // who received the money back, like the payer on a payment
  if (payment_type && !checked.details.payer_name && !checked.errors.some((e) => e.field === 'payer_name')) {
    v.errors.push({ field: 'payer_name', message: 'Write who received the money back.' });
  }
  if (v.failed()) return v.send(res);
  const { details } = checked;
  const payment_id = crypto.randomUUID();
  const refund_reason = notes ? `${reason}: ${notes}` : reason;
  try {
    if (!(await cloudOrder(req, res, 'refund'))) return;
    const saved = await withPgTransaction(req.pgPool, async (client) => {
      const ord = await client.query(
        `SELECT production_status, tracking_no, total_quote_amount::text AS quote, cancellation_fee::text AS cancellation_fee,
                archived_at IS NOT NULL AS archived FROM order_profiles WHERE order_id = $1 FOR UPDATE`,
        [order_id]);
      if (ord.rowCount === 0) throw orderNotFound();
      if (ord.rows[0].archived) throw new Rejected(409, RECORD_ARCHIVED);
      const paidNet = toPesos(await paidNetCentavos(client, order_id));
      const problem = checkRefund({ status: ord.rows[0].production_status, quote: Number(ord.rows[0].quote), paidNet, amount });
      if (problem) throw new Rejected(problem.status, problem.body);
      // migration 017: an Admin refunds up to the policy's suggestion; more is the Owner's goodwill
      const limits = refundLimits({
        status: ord.rows[0].production_status, bill: Number(ord.rows[0].quote), paidNet,
        cancellationFee: ord.rows[0].cancellation_fee === null ? null : Number(ord.rows[0].cancellation_fee)
      });
      if (!can(req.user.role, 'refund_above_policy') && toCentavos(amount) > toCentavos(limits.admin_max)) {
        throw new Rejected(403, {
          error: 'REFUND_ABOVE_POLICY',
          message: `The shop policy suggests refunding at most ${pesoText(limits.admin_max)} (what was paid less the cancellation fee). `
            + 'Only the Owner can give back more.',
          suggested_refund: limits.admin_max
        });
      }
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

router.post('/:order_id/price-adjustment', requireRole(rolesWith('adjust_price')), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const amount = v.nonNegativeMoney(body.adjustment_amount, 'adjustment_amount');
  const reason = v.optionalString(body.adjustment_reason, 'adjustment_reason', ADJUSTMENT_REASON_MAX);
  if (v.failed()) return v.send(res);
  try {
    if (!(await cloudOrder(req, res, 'price_adjustment'))) return;
    // migration 017: an Admin gives a price cut up to the late-delivery suggestion; more is the Owner's
    if (!can(req.user.role, 'price_cut_above_policy')) {
      const { record: current } = await getRecord(req, 'order_profiles', order_id);
      const { context } = current ? await actionsWithContext(req, current) : { context: null };
      const allowedC = Math.max(toCentavos(context ? context.late_cut_amount : 0), toCentavos(current ? current.adjustment_amount : 0));
      if (toCentavos(amount) > allowedC) {
        return res.status(403).json({
          error: 'PRICE_CUT_ABOVE_POLICY',
          message: allowedC > 0
            ? `The late-delivery rule suggests a price cut of at most ${pesoText(toPesos(allowedC))}. Only the Owner can give more.`
            : 'This order is not late by the shop policy (1 day of grace), so only the Owner can give a price cut.',
          suggested_cut: toPesos(allowedC),
          late_cut: context ? context.late_cut : null
        });
      }
    }
    await withPgTransaction(req.pgPool, async (client) => {
      const { rows } = await client.query(`SELECT ${selectList('order_profiles', 'pg')} FROM order_profiles WHERE order_id = $1 FOR UPDATE`, [order_id]);
      if (rows.length === 0) throw orderNotFound();
      const order = serialize('order_profiles', rows[0]);
      if (!['Approved', 'Printing', 'Pressing', 'Ready', 'Completed'].includes(order.production_status)) {
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

// ==========================================
// MIGRATION 017: PRODUCTION PROGRESS AND THE CLIENT'S DELAY
// POST  /api/orders/:order_id/progress      { lines: [{ line_item_id, printed?, pressed? }] }   anyone who changes statuses
//   How many pieces of each item are printed / pressed (pressed only for items that need the heat
//   press). Printing or Pressing orders, online only. Pieces already handed over stay ready.
// PATCH /api/orders/:order_id/client-delay  { reason: string | null }   Owner / Admin
//   The delay was the client's doing (late design, late payment, changes): no late-delivery price
//   cut is suggested. null clears it.
// ==========================================
router.post('/:order_id/progress', requireRole(rolesWith('change_status')), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id } = req.params;
  const sent = (req.body || {}).lines;
  try {
    if (!(await cloudOrder(req, res, 'progress'))) return;
    const result = await withPgTransaction(req.pgPool, async (client) => {
      const ord = await client.query('SELECT production_status FROM order_profiles WHERE order_id = $1 FOR UPDATE', [order_id]);
      if (ord.rowCount === 0) throw orderNotFound();
      if (!['Printing', 'Pressing'].includes(ord.rows[0].production_status)) {
        throw new Rejected(409, {
          error: 'PROGRESS_NOT_ALLOWED',
          message: `This order is ${ord.rows[0].production_status}. Printed and pressed pieces are recorded while it is being printed or pressed.`
        });
      }
      const { rows: lines } = await client.query(
        `SELECT oi.line_item_id, oi.product_type, oi.size, oi.quantity, oi.qty_printed, oi.qty_pressed,
                COALESCE(ii.requires_pressing, FALSE) AS requires_pressing,
                LOWER(BTRIM(COALESCE(ii.item_category, ''))) = 'consumable' AS is_consumable
           FROM order_items oi LEFT JOIN inventory_items ii ON ii.inventory_id = oi.inventory_id
          WHERE oi.order_id = $1 ORDER BY oi.line_item_id FOR UPDATE OF oi`, [order_id]);
      const delivered = (await client.query('SELECT COALESCE(SUM(quantity), 0)::int AS n FROM order_deliveries WHERE order_id = $1', [order_id])).rows[0].n;
      const checked = checkProgressUpdate({ lines, sent, delivered, status: ord.rows[0].production_status });
      if (checked.problem) throw new Rejected(checked.problem.status, checked.problem.body);
      for (const u of checked.updates) {
        await client.query('UPDATE order_items SET qty_printed = $2, qty_pressed = $3 WHERE line_item_id = $1', [u.line_item_id, u.printed, u.pressed]);
      }
      await client.query("UPDATE order_profiles SET last_edited_by = $2, last_edited_role = $3 WHERE order_id = $1", [order_id, req.user.user_id, req.user.role]);
      return checked.after;
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'order_items', null).catch(() => {});
    const view = await freshOrderView(req, order_id);
    pushOrderChange(req, view.order);
    res.status(200).json({
      message: `${result.printed} of ${result.pieces} printed${result.needs_pressing ? `, ${result.pressed} of ${result.press_pieces} pressed` : ''}; ${result.ready} ready.`,
      source: 'cloud', progress: result, ...view
    });
  } catch (err) {
    sendError(res, err, 'recording production progress', needsCloud('progress'));
  }
});

router.patch('/:order_id/client-delay', requireRole(rolesWith('adjust_price')), requireOrderEditAccess, refuseArchivedOrder, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const reason = body.reason === null ? null : v.requiredString(body.reason, 'reason', 300);
  if (v.failed()) return v.send(res);
  try {
    if (!(await cloudOrder(req, res, 'progress'))) return;
    await withPgTransaction(req.pgPool, async (client) => {
      const ord = await client.query('SELECT production_status, tracking_no, client_delay_reason FROM order_profiles WHERE order_id = $1 FOR UPDATE', [order_id]);
      if (ord.rowCount === 0) throw orderNotFound();
      await client.query('UPDATE order_profiles SET client_delay_reason = $2, last_edited_by = $3, last_edited_role = $4 WHERE order_id = $1',
        [order_id, reason, req.user.user_id, req.user.role]);
      await writeAudit(client, {
        entity: 'order_profiles', entity_id: order_id, action: 'client_delay_marked', actor: req.user,
        details: { tracking_no: ord.rows[0].tracking_no, before: ord.rows[0].client_delay_reason, after: reason }
      });
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'order_profiles', [order_id]).catch(() => {});
    const view = await freshOrderView(req, order_id);
    pushOrderChange(req, view.order);
    res.status(200).json({
      message: reason ? 'Marked as delayed by the client: no late-delivery price cut is suggested.' : "The client's delay was cleared.",
      source: 'cloud', ...view
    });
  } catch (err) {
    sendError(res, err, "saving the client's delay", needsCloud('progress'));
  }
});

module.exports = router;

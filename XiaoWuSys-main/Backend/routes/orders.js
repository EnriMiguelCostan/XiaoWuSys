const express = require('express');
const crypto = require('crypto'); // Built-in Node module for generating UUIDs
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  normalizeRequiredItems,
  evaluateCapacity,
  capacityFailureResponse
} = require('../services/capacity');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { validateDriveLink } = require('../utils/validateDriveLink');
const { LOCAL_NOW, PG_VERSION_FORMAT, offlineUpdateBookkeeping } = require('../utils/localSync');
const { createValidator, PAYMENT_TYPES, PRODUCTION_STATUSES } = require('../utils/validation');
const {
  selectList, serialize, listRecords, getRecord, locateRecord, readLocal, sqliteRun,
  withPgTransaction
} = require('../services/records');
const { withAvailability } = require('../services/inventorySnapshot');

const VERSION_SQL = `to_char(last_modified, '${PG_VERSION_FORMAT}')`;
const READ_ROLES = ['Admin', 'Production', 'Staff'];
const WRITE_ROLES = ['Admin', 'Production'];
const APPROVE_ROLES = ['Owner']; // PB 13: only an Owner may approve a job order (§4.3)

// Real-time push (Socket.io) after a stock change made by this server (reservations, §4.6)
const pushStockChange = (req, ids, reason) => {
  if (req.inventoryEvents) req.inventoryEvents.notifyChanged(ids, reason);
};

// Statuses staff can log when an order is halted for insufficient inventory (PB 10)
const HALT_RESOLUTIONS = ['Delayed', 'Cancelled'];

const notFound = (res, what, id) =>
  res.status(404).json({ error: `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, message: `${what} ${id} does not exist.` });

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
    if (!isConnectionError(err)) throw err;
    console.error('☁️  Cloud unreachable, saving locally:', err.message);
    return localWrite();
  }
};

// Protect EVERY route in this file by telling the router to use the middleware first
router.use(verifyToken);

// ==========================================
// LIST ORDERS (M10)
// GET /api/orders?status=Pending&customer_id=CUST-001&limit=50&offset=0
// -> { source, orders: [...], limit, offset, unsynced }
// ==========================================
router.get('/', requireRole(READ_ROLES), async (req, res) => {
  const v = createValidator();
  const status = v.oneOf(req.query.status, 'status', PRODUCTION_STATUSES, { required: false });
  const customer_id = v.id(req.query.customer_id, 'customer_id', { required: false });
  const { limit, offset } = v.pagination(req.query);
  if (v.failed()) return v.send(res);

  try {
    const result = await listRecords(req, 'order_profiles', {
      filters: [['production_status', status], ['customer_id', customer_id]],
      orderBy: 'date_created DESC, order_id',
      limit,
      offset
    });
    res.status(200).json({ source: result.source, orders: result.records, limit, offset, unsynced: result.unsynced });
  } catch (err) {
    sendDbError(res, err, 'listing orders');
  }
});

// ==========================================
// ORDER DETAIL (M10)
// GET /api/orders/:order_id -> { source, order, items, payments, totals }
// ==========================================
router.get('/:order_id', requireRole(READ_ROLES), async (req, res) => {
  const { order_id } = req.params;
  try {
    const { source, record: order } = await getRecord(req, 'order_profiles', order_id);
    if (!order) return notFound(res, 'Order', order_id);

    const items = await listRecords(req, 'order_items', { filters: [['order_id', order_id]], orderBy: 'line_item_id' });
    const payments = await listRecords(req, 'payments', { filters: [['order_id', order_id]], orderBy: 'payment_date, payment_id' });
    const totalPaid = Math.round(payments.records.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;
    const sources = [source, items.source, payments.source];

    res.status(200).json({
      source: sources.includes('local') ? 'local' : 'cloud',
      order,
      items: items.records,
      payments: payments.records,
      totals: {
        item_count: items.records.length,
        total_quantity: items.records.reduce((sum, i) => sum + i.quantity, 0),
        total_paid: totalPaid,
        balance: Math.round(((order.total_quote_amount || 0) - totalPaid) * 100) / 100
      }
    });
  } catch (err) {
    sendDbError(res, err, 'reading order');
  }
});

// ==========================================
// CREATE ORDER PROFILE (Sprint 6 / PB 6, capacity-gated in Sprint 9 / PB 9 & PB 10)
// Body: { customer_id, production_deadline, required_items: [{ inventory_id, quantity_needed }], resolution? }
//  - No resolution: stock is strictly evaluated; shortages -> 409 and NO order is created.
//  - resolution 'Delayed':   order is recorded as Delayed with the NEW production_deadline.
//  - resolution 'Cancelled': order is recorded as Cancelled (permanent record of the lost sale).
// -> 201 { message, source, order_id, production_status, order }
// ==========================================
router.post('/', requireRole(WRITE_ROLES), async (req, res) => {
  const body = req.body || {};

  // 1.) M7: validate every field before touching a database
  const v = createValidator();
  const customer_id = v.id(body.customer_id, 'customer_id');
  const production_deadline = v.deadline(body.production_deadline, 'production_deadline');
  const resolution = v.oneOf(body.resolution, 'resolution', HALT_RESOLUTIONS, { required: false });
  if (v.failed()) return v.send(res);

  const production_status = resolution || 'Pending';
  const normalized = (resolution && body.required_items === undefined) ? null : normalizeRequiredItems(body.required_items);
  if (normalized && normalized.error) {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: normalized.error });
  }

  try {
    // 2.) M7: the customer must exist (Neon, or the local cache when offline)
    const customer = await locateRecord(req, 'customers', customer_id);
    if (!customer.location) return notFound(res, 'Customer', customer_id);

    // 3.) Strict server-side capacity gate (skipped once staff logged a Delay/Cancel resolution)
    if (!resolution) {
      const failure = capacityFailureResponse(await evaluateCapacity(req, normalized.items));
      if (failure) {
        console.warn(`⛔ Order halted (${failure.status}) for customer ${customer_id}: ${failure.body.error}`);
        return res.status(failure.status).json(failure.body);
      }
    }

    // 4.) Generate a universally unique ID to prevent sync collisions
    const order_id = crypto.randomUUID();
    const values = [order_id, customer_id, production_deadline, production_status];

    const { source, record } = await writeCloudFirst(
      customer.location,
      async () => {
        const { rows } = await req.pgPool.query(
          `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status)
           VALUES ($1, $2, $3, $4) RETURNING ${selectList('order_profiles', 'pg')}`,
          values
        );
        return { source: 'cloud', record: serialize('order_profiles', rows[0]) };
      },
      async () => {
        await sqliteRun(
          req.localDb,
          `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, sync_status, last_modified)
           VALUES (?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
          values
        );
        return { source: 'local', record: await readLocal(req.localDb, 'order_profiles', order_id) };
      }
    );

    console.log(`✅ Order ${order_id} (${production_status}) saved to ${source}`);
    return res.status(201).json({
      message: source === 'cloud'
        ? 'Order created.'
        : 'Saved offline. Will sync to cloud when connection is restored.',
      source,
      order_id,
      production_status,
      order: record
    });
  } catch (err) {
    return sendDbError(res, err, 'order creation');
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

  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);

    // If a stock link was supplied, the referenced inventory item must exist (M7).
    if (inventory_id) {
      const stock = await locateRecord(req, 'inventory_items', inventory_id);
      if (!stock.location) return notFound(res, 'Inventory item', inventory_id);
    }

    const line_item_id = crypto.randomUUID();
    const values = [line_item_id, order_id, inventory_id || null, product_type, quantity, size, custom_name, custom_number];

    const { source, record } = await writeCloudFirst(
      order.location,
      async () => {
        const { rows } = await req.pgPool.query(
          `INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, size, custom_name, custom_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${selectList('order_items', 'pg')}`,
          values
        );
        return { source: 'cloud', record: serialize('order_items', rows[0]) };
      },
      async () => {
        await sqliteRun(
          req.localDb,
          `INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, size, custom_name, custom_number, sync_status, last_modified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
          values
        );
        return { source: 'local', record: await readLocal(req.localDb, 'order_items', line_item_id) };
      }
    );

    res.status(201).json({
      message: source === 'cloud' ? 'Order item added.' : 'Order item saved locally (Offline Mode).',
      source,
      item: record
    });
  } catch (err) {
    sendDbError(res, err, 'adding order item');
  }
});

// ==========================================
// ORDER PAYMENTS
// GET  /api/orders/:order_id/payments -> { source, order_id, payments, total_paid }
// POST /api/orders/:order_id/payments -> 201 { message, source, payment }
// ==========================================
router.get('/:order_id/payments', requireRole(WRITE_ROLES), async (req, res) => {
  const { order_id } = req.params;
  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);
    const payments = await listRecords(req, 'payments', { filters: [['order_id', order_id]], orderBy: 'payment_date, payment_id' });
    const total_paid = Math.round(payments.records.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;
    res.status(200).json({ source: payments.source, order_id, payments: payments.records, total_paid });
  } catch (err) {
    sendDbError(res, err, 'listing payments');
  }
});

router.post('/:order_id/payments', requireRole(WRITE_ROLES), async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};

  // M7: amount must be a positive JSON number with at most 2 decimals (centavos)
  const v = createValidator();
  const amount = v.positiveMoney(body.amount, 'amount');
  const payment_type = v.oneOf(body.payment_type, 'payment_type', PAYMENT_TYPES);
  if (v.failed()) return v.send(res);

  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);

    const payment_id = crypto.randomUUID();
    const values = [payment_id, order_id, amount, payment_type];

    const { source, record } = await writeCloudFirst(
      order.location,
      async () => {
        const { rows } = await req.pgPool.query(
          `INSERT INTO payments (payment_id, order_id, amount, payment_type)
           VALUES ($1, $2, $3, $4) RETURNING ${selectList('payments', 'pg')}`,
          values
        );
        return { source: 'cloud', record: serialize('payments', rows[0]) };
      },
      async () => {
        await sqliteRun(
          req.localDb,
          `INSERT INTO payments (payment_id, order_id, amount, payment_type, sync_status, last_modified)
           VALUES (?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
          values
        );
        return { source: 'local', record: await readLocal(req.localDb, 'payments', payment_id) };
      }
    );

    res.status(201).json({
      message: source === 'cloud'
        ? 'Payment recorded.'
        : 'Payment saved locally (Offline Mode). It will sync to the cloud when internet is restored.',
      source,
      payment: record
    });
  } catch (err) {
    sendDbError(res, err, 'recording payment');
  }
});

// ==========================================
// LINK DESIGN FILE (Sprint 8 / PB 8)
// Body: { design_drive_link, expected_version? }
//  H6: link must be an https:// drive.google.com or docs.google.com URL
//  H2: 409 ORDER_LOCKED if another user holds the edit lock (Owner prevails)
//  C3: if expected_version is sent and the cloud row changed since, 409 EDIT_CONFLICT
// -> 200 { message, source, order, version }
// ==========================================
router.patch('/:order_id/design', requireRole(WRITE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const { design_drive_link, expected_version } = req.body || {};

  const validation = validateDriveLink(design_drive_link);
  if (validation.error) {
    return res.status(400).json({ error: 'INVALID_DRIVE_LINK', message: validation.error });
  }
  if (expected_version !== undefined && typeof expected_version !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'expected_version must be the string returned as "version".' });
  }
  const link = validation.url;

  const updateLocal = async () => {
    // Record the field as dirty so sync pushes ONLY this change (C3),
    // and bump last_modified so an in-flight sync will not mark it synced (H3)
    const { changes } = await sqliteRun(
      req.localDb,
      `UPDATE order_profiles
          SET design_drive_link = ?, ${offlineUpdateBookkeeping('order_profiles', ['design_drive_link'])}
        WHERE order_id = ?`,
      [link, order_id]
    );
    return changes === 0 ? null : { source: 'local', record: await readLocal(req.localDb, 'order_profiles', order_id) };
  };

  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);

    let conflict = null;
    const result = await writeCloudFirst(
      order.location,
      async () => {
        // Optimistic update: only if the row is still at expected_version
        const { rows, rowCount } = await req.pgPool.query(
          `UPDATE order_profiles
              SET design_drive_link = $1, last_modified = NOW()
            WHERE order_id = $2
              AND ($3::text IS NULL OR ${VERSION_SQL} = $3::text)
            RETURNING ${selectList('order_profiles', 'pg')}`,
          [link, order_id, expected_version || null]
        );
        if (rowCount === 0) {
          const current = await getRecord(req, 'order_profiles', order_id);
          conflict = current.record;
          return null;
        }
        return { source: 'cloud', record: serialize('order_profiles', rows[0]) };
      },
      updateLocal
    );

    if (conflict) {
      return res.status(409).json({
        error: 'EDIT_CONFLICT',
        message: 'This order was changed by someone else. Reload it and apply your change again.',
        current: conflict
      });
    }
    if (!result) return notFound(res, 'Order', order_id);

    res.status(200).json({
      message: result.source === 'cloud'
        ? 'Design linked.'
        : 'Design linked locally (Offline Mode). Will sync when internet is restored.',
      source: result.source,
      order: result.record,
      version: result.record.version // null offline until the next sync
    });
  } catch (err) {
    sendDbError(res, err, 'linking design file');
  }
});

// ==========================================
// APPROVE JOB ORDER & RESERVE BLANK STOCK (Sprint 11 / PB 13)
// POST /api/orders/:order_id/approve   Body: { expected_version }
//
// Business decision: APPROVAL IS ONLINE-ONLY. Reserving stock must be serialized against
// Neon's row locks, so there is no offline fallback. If Neon is unreachable (including a
// COMMIT whose outcome is unknown) we return 503 and change nothing locally.
//
// Auth (§4.3): verifyToken (router.use) -> requireRole(['Owner']) -> requireOrderEditAccess.
//   Only Owner; the role comes from the JWT, never the body. Non-Owners get 403.
//   Another user's edit lock -> 409 ORDER_LOCKED (an Owner may take over any lock by design).
//
// All 7 preconditions (§4.4) run INSIDE the transaction, after the order and every involved
// stock row are locked FOR UPDATE, so nothing can change between the checks and the writes.
// Any failed check throws and rolls the whole transaction back; nothing is reserved.
//
// -> 200 { message, source:'cloud', order, reserved:[{inventory_id,item_name,quantity}], inventory:[InventoryItem...] }
// ==========================================

// A precondition that failed inside the transaction: carries the HTTP status + body to send.
class ApprovalRejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

router.post('/:order_id/approve', requireRole(APPROVE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const { expected_version } = req.body || {};

  // expected_version is REQUIRED (§4.2): an approval must be based on the order the Owner saw.
  if (typeof expected_version !== 'string' || expected_version.trim() === '') {
    return res.status(400).json({
      error: 'VALIDATION_FAILED',
      message: 'expected_version is required and must be the string returned as the order "version".',
      details: [{ field: 'expected_version', message: 'expected_version is required.' }]
    });
  }

  try {
    const result = await withPgTransaction(req.pgPool, async (client) => {
      // ---- 1. Lock the order row ----
      const orderRes = await client.query(
        `SELECT ${selectList('order_profiles', 'pg')}, ${VERSION_SQL} AS locked_version,
                production_status AS raw_status, total_quote_amount AS raw_quote
           FROM order_profiles WHERE order_id = $1 FOR UPDATE`,
        [order_id]
      );
      // Precondition 1: the order exists
      if (orderRes.rowCount === 0) {
        throw new ApprovalRejected(404, { error: 'ORDER_NOT_FOUND', message: `Order ${order_id} does not exist.` });
      }
      const orderRow = orderRes.rows[0];

      // Precondition 2: optimistic concurrency — version must match what the Owner approved
      if (orderRow.locked_version !== expected_version) {
        throw new ApprovalRejected(409, {
          error: 'EDIT_CONFLICT',
          message: 'This order was changed by someone else. Reload it and approve again.',
          current: serialize('order_profiles', orderRow)
        });
      }

      // Precondition 3: status must be Pending or Delayed
      const status = orderRow.raw_status;
      if (status === 'Approved') {
        throw new ApprovalRejected(409, {
          error: 'ALREADY_APPROVED',
          message: 'This job order has already been approved.',
          current: serialize('order_profiles', orderRow)
        });
      }
      if (status !== 'Pending' && status !== 'Delayed') {
        throw new ApprovalRejected(409, {
          error: 'INVALID_STATUS_TRANSITION',
          message: `An order with status "${status}" cannot be approved. Only Pending or Delayed orders can be approved.`,
          current: serialize('order_profiles', orderRow)
        });
      }

      // Precondition 4: a real quote must exist (compared in centavos to avoid float issues)
      const quoteCentavos = Math.round(Number(orderRow.raw_quote || 0) * 100);
      if (quoteCentavos <= 0) {
        throw new ApprovalRejected(422, {
          error: 'QUOTE_REQUIRED',
          message: 'This order has no quote amount yet. Set total_quote_amount before approving.'
        });
      }

      // Precondition 5: 50% downpayment guard, counting ONLY payments that exist in Neon.
      // Compared in integer centavos via NUMERIC in SQL — never as JS floats.
      const payRes = await client.query(
        `SELECT COALESCE(ROUND(SUM(amount) * 100), 0)::bigint AS paid_centavos
           FROM payments WHERE order_id = $1`,
        [order_id]
      );
      const paidCentavos = Number(payRes.rows[0].paid_centavos);
      const requiredCentavos = Math.ceil(quoteCentavos / 2); // half of the quote, rounded up to the centavo
      if (paidCentavos < requiredCentavos) {
        throw new ApprovalRejected(402, {
          error: 'DOWNPAYMENT_REQUIRED',
          message: 'A downpayment of at least 50% of the quote is required before approval. '
            + 'Payments still pending offline do not count — sync them first.',
          total_quote_amount: quoteCentavos / 100,
          required_downpayment: requiredCentavos / 100,
          total_paid: paidCentavos / 100,
          remaining: (requiredCentavos - paidCentavos) / 100
        });
      }

      // Precondition 6: at least one item, and EVERY item linked to stock.
      const itemsRes = await client.query(
        `SELECT line_item_id, inventory_id, quantity FROM order_items WHERE order_id = $1`,
        [order_id]
      );
      if (itemsRes.rowCount === 0) {
        throw new ApprovalRejected(422, {
          error: 'ITEMS_NOT_LINKED_TO_STOCK',
          message: 'This order has no items. Add at least one item linked to a stock item before approving.',
          unlinked_line_item_ids: []
        });
      }
      const unlinked = itemsRes.rows.filter((r) => !r.inventory_id).map((r) => r.line_item_id);
      if (unlinked.length > 0) {
        throw new ApprovalRejected(422, {
          error: 'ITEMS_NOT_LINKED_TO_STOCK',
          message: 'Every order item must be linked to a stock item before the order can be approved.',
          unlinked_line_item_ids: unlinked
        });
      }

      // Aggregate required quantity per inventory_id (duplicate lines of the same stock add up).
      const requiredById = new Map();
      for (const row of itemsRes.rows) {
        requiredById.set(row.inventory_id, (requiredById.get(row.inventory_id) || 0) + Number(row.quantity));
      }
      // Fixed order (ASC by inventory_id) for both the lock and the aggregate, to avoid deadlocks.
      const inventoryIds = [...requiredById.keys()].sort();

      // ---- 2. Lock every involved stock row in a FIXED ORDER ----
      const stockRes = await client.query(
        `SELECT ${selectList('inventory_items', 'pg')}, quantity_available AS raw_available
           FROM inventory_items WHERE inventory_id = ANY($1::text[])
          ORDER BY inventory_id FOR UPDATE`,
        [inventoryIds]
      );
      const stockById = new Map(stockRes.rows.map((r) => [String(r.inventory_id), r]));

      // Any linked inventory_id that no longer exists -> treat as not-found (defence in depth;
      // the FK normally prevents this, but a row could have been deleted between item add and now).
      const missing = inventoryIds.filter((id) => !stockById.has(id));
      if (missing.length > 0) {
        throw new ApprovalRejected(404, {
          error: 'INVENTORY_ITEM_NOT_FOUND',
          message: 'One or more linked inventory items no longer exist.',
          missing_inventory_ids: missing
        });
      }

      // Precondition 7: capacity. required <= quantity_available on the freshly LOCKED rows.
      // Shape mirrors the Sprint 9 capacity check so the frontend can reuse the shortage table.
      const shortages = [];
      for (const id of inventoryIds) {
        const row = stockById.get(id);
        const required = requiredById.get(id);
        const available = Number(row.raw_available);
        if (required > available) {
          shortages.push({
            inventory_id: id,
            item_name: row.item_name,
            requested: required,
            available,
            shortfall: required - available
          });
        }
      }
      if (shortages.length > 0) {
        throw new ApprovalRejected(409, {
          error: 'INSUFFICIENT_INVENTORY',
          can_fulfill: false,
          message: 'CAPACITY ALERT: Order exceeds available stock. Nothing was reserved.',
          shortages,
          total_shortfall: shortages.reduce((sum, s) => sum + s.shortfall, 0)
        });
      }

      // ---- 3. Reserve, guarded in SQL (never only in JS) ----
      // quantity_available is the total on-hand stock and is NOT decremented; reserving simply
      // raises quantity_reserved. The guard (available - reserved) >= qty must still hold on the
      // locked row, so a concurrent reservation competing for the same stock cannot over-commit.
      const reserved = [];
      for (const id of inventoryIds) {
        const required = requiredById.get(id);
        const upd = await client.query(
          `UPDATE inventory_items
              SET quantity_reserved = quantity_reserved + $1
            WHERE inventory_id = $2 AND (quantity_available - quantity_reserved) >= $1`,
          [required, id]
        );
        if (upd.rowCount !== 1) {
          // Lost a race, or stock changed under us: abort the whole approval.
          throw new ApprovalRejected(409, {
            error: 'INSUFFICIENT_INVENTORY',
            can_fulfill: false,
            message: 'CAPACITY ALERT: stock changed during approval. Nothing was reserved. Reload and try again.',
            shortages: [{
              inventory_id: id,
              item_name: stockById.get(id).item_name,
              requested: required,
              available: Number(stockById.get(id).raw_available)
            }]
          });
        }
        reserved.push({ inventory_id: id, item_name: stockById.get(id).item_name, quantity: required });
      }

      // ---- 4. Approve the order ----
      const approveRes = await client.query(
        `UPDATE order_profiles
            SET production_status = 'Approved', approved_by = $2, approved_at = NOW()
          WHERE order_id = $1
          RETURNING ${selectList('order_profiles', 'pg')}`,
        [order_id, req.user.user_id]
      );

      // Re-read the updated stock rows (now with the new reserved counts) for the response.
      const freshStock = await client.query(
        `SELECT ${selectList('inventory_items', 'pg')}
           FROM inventory_items WHERE inventory_id = ANY($1::text[]) ORDER BY inventory_id`,
        [inventoryIds]
      );

      return {
        order: serialize('order_profiles', approveRes.rows[0]),
        reserved,
        inventory: freshStock.rows.map((r) => withAvailability(serialize('inventory_items', r))),
        changedIds: inventoryIds
      };
    });

    // Success: notify every connected client so the Catalog reflects the new reserved numbers.
    pushStockChange(req, result.changedIds, 'order_approved');

    console.log(`✅ Order ${order_id} approved by ${req.user.user_id} (Owner); reserved ${result.reserved.length} item(s)`);
    return res.status(200).json({
      message: 'Job order approved.',
      source: 'cloud',
      order: result.order,
      reserved: result.reserved,
      inventory: result.inventory
    });
  } catch (err) {
    // Business-rule rejection -> its mapped status/body (transaction already rolled back).
    if (err instanceof ApprovalRejected) return res.status(err.status).json(err.body);

    // Online-only: a dropped COMMIT (unknown outcome) or any connection failure -> 503.
    // NEVER fall back offline (§4.5).
    if (err.commitUnknown) {
      return res.status(503).json({
        error: 'COMMIT_UNKNOWN',
        message: 'Connection to the cloud dropped while approving. Reload the order before retrying.'
      });
    }
    if (isConnectionError(err)) {
      return res.status(503).json({
        error: 'CLOUD_UNREACHABLE',
        message: 'Approval needs an internet connection. Nothing was changed. Try again when back online.'
      });
    }
    return sendDbError(res, err, 'approving job order');
  }
});

module.exports = router;

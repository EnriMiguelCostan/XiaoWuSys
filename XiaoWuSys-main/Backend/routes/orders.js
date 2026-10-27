const express = require('express');
const crypto = require('crypto'); // Built-in Node module for generating UUIDs
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { normalizeRequiredItems, computeAvailable } = require('../services/capacity');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { validateDriveLink } = require('../utils/validateDriveLink');
const { LOCAL_NOW, PG_VERSION_FORMAT, offlineUpdateBookkeeping } = require('../utils/localSync');
const { createValidator, PAYMENT_TYPES, PRODUCTION_STATUSES } = require('../utils/validation');
const {
  selectList, serialize, listRecords, getRecord, locateRecord, readLocal, sqliteRun, sqliteAll,
  withPgTransaction, withLocalTransaction, ACTIVE_ITEM_SQL
} = require('../services/records');

const VERSION_SQL = `to_char(last_modified, '${PG_VERSION_FORMAT}')`;
const READ_ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
const WRITE_ROLES = ['Owner', 'Admin', 'Production'];

// Business-rule failure inside a transaction: rolled back, then sent as-is
class Rejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const pushStockChange = (req, ids, reason) => {
  if (req.inventoryEvents && ids.length > 0) req.inventoryEvents.notifyChanged(ids, reason);
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
    console.log(`✅ Order ${order_id} (${production_status}, ${needs.length} material(s)${reserve ? ', stock reserved' : ''}) saved to ${result.source}`);
    return res.status(201).json({
      message: result.source === 'cloud'
        ? (reserve ? 'Order created and materials reserved.' : 'Order created.')
        : 'Saved offline. Will sync to cloud when connection is restored.',
      source: result.source,
      order_id,
      production_status,
      order: result.record,
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
//   Pending  -> Printing | Cancelled
//   Printing -> Completed | Cancelled
//   Delayed  -> Pending (reserves stock now; 409 INSUFFICIENT_INVENTORY if short) | Cancelled
//   Completed / Cancelled are final.
// Stock effects (same transaction): Cancelled releases the reservation; Completed consumes it
// (quantity_available and quantity_reserved both go down). Needs the cloud: stock shared by all
// branches must not be released or consumed from a stale offline copy.
// -> 200 { message, order, stock_changes }
// ==========================================
const STATUS_TRANSITIONS = {
  Pending: ['Printing', 'Cancelled'],
  Printing: ['Completed', 'Cancelled'],
  Delayed: ['Pending', 'Cancelled'],
  Completed: [],
  Cancelled: []
};

router.patch('/:order_id/status', requireRole(WRITE_ROLES), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const status = v.oneOf(body.status, 'status', PRODUCTION_STATUSES);
  if (body.expected_version !== undefined && body.expected_version !== null && typeof body.expected_version !== 'string') {
    v.errors.push({ field: 'expected_version', message: 'expected_version must be the string returned as "version".' });
  }
  if (v.failed()) return v.send(res);
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
        throw new Rejected(409, { error: 'EDIT_CONFLICT', message: 'This order was changed by someone else. Reload it and try again.', current: order });
      }
      const from = order.production_status;
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
      const stock = ids.length === 0 ? { rows: [] } : await client.query(
        `SELECT inventory_id, item_name, quantity_available, quantity_reserved, deleted_at, purged_at FROM inventory_items
          WHERE inventory_id = ANY($1::text[]) ORDER BY inventory_id FOR UPDATE`, [ids]);
      const rowsById = new Map(stock.rows.map((r) => [r.inventory_id, r]));

      let stockReserved = order.stock_reserved;
      const stockChanges = [];
      if (status === 'Pending' && from === 'Delayed' && needs.length > 0) {
        const activeById = new Map([...rowsById].filter(([, r]) => !r.deleted_at && !r.purged_at));
        const { missing, shortages } = checkStock(needs, activeById);
        if (missing.length) throw missingItemsRejection(missing, 'cloud');
        if (shortages.length) throw shortageRejection(shortages, 'cloud');
        for (const n of needs) {
          await client.query('UPDATE inventory_items SET quantity_reserved = quantity_reserved + $1 WHERE inventory_id = $2',
            [n.quantity_needed, n.inventory_id]);
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
      changedIds = stockChanges.map((c) => c.inventory_id);

      const updated = await client.query(
        `UPDATE order_profiles SET production_status = $2, stock_reserved = $3
          WHERE order_id = $1 RETURNING ${selectList('order_profiles', 'pg')}`,
        [order_id, status, stockReserved]);
      return { order: serialize('order_profiles', updated.rows[0]), stockChanges, from };
    });

    pushStockChange(req, changedIds, `order_${status.toLowerCase()}`);
    console.log(`🔁 Order ${order_id}: ${result.from} -> ${status} by ${req.user.user_id} (${req.user.role})`);
    res.status(200).json({
      message: `Order is now ${status}.` + (result.stockChanges.length
        ? (status === 'Cancelled' ? ' Reserved materials were released back to stock.'
          : status === 'Completed' ? ' Reserved materials were used up from stock.'
            : ' Materials were reserved.')
        : ''),
      order: result.order,
      stock_changes: result.stockChanges
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
  if (v.failed()) return v.send(res);

  try {
    const order = await locateRecord(req, 'order_profiles', order_id);
    if (!order.location) return notFound(res, 'Order', order_id);

    const line_item_id = crypto.randomUUID();
    const values = [line_item_id, order_id, product_type, quantity, size, custom_name, custom_number];

    const { source, record } = await writeCloudFirst(
      order.location,
      async () => {
        const { rows } = await req.pgPool.query(
          `INSERT INTO order_items (line_item_id, order_id, product_type, quantity, size, custom_name, custom_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${selectList('order_items', 'pg')}`,
          values
        );
        return { source: 'cloud', record: serialize('order_items', rows[0]) };
      },
      async () => {
        await sqliteRun(
          req.localDb,
          `INSERT INTO order_items (line_item_id, order_id, product_type, quantity, size, custom_name, custom_number, sync_status, last_modified)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
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

module.exports = router;

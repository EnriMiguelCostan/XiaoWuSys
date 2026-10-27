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
  selectList, serialize, listRecords, getRecord, locateRecord, readLocal, sqliteRun, sqliteAll, sqliteGet,
  withPgTransaction, withLocalTransaction, ACTIVE_ITEM_SQL
} = require('../services/records');
const { withAvailability } = require('../services/inventorySnapshot');

const VERSION_SQL = `to_char(last_modified, '${PG_VERSION_FORMAT}')`;
const READ_ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
const WRITE_ROLES = ['Owner', 'Admin', 'Production'];
const APPROVE_ROLES = ['Owner']; // PB 13: only an Owner may approve a job order (§4.3)

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
// GET /api/orders?status=Pending&customer_id=CUST-001&sort=production_deadline&dir=asc&limit=50&offset=0
//   sort: date_created (default) | production_deadline | total_quote_amount | production_status
//   dir:  desc (default) | asc
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

router.get('/', requireRole(READ_ROLES), async (req, res) => {
  const v = createValidator();
  const status = v.oneOf(req.query.status, 'status', PRODUCTION_STATUSES, { required: false });
  const customer_id = v.id(req.query.customer_id, 'customer_id', { required: false });
  const sort = v.oneOf(req.query.sort, 'sort', Object.keys(ORDER_SORTS), { required: false }) || 'date_created';
  const dir = v.oneOf(req.query.dir, 'dir', ['asc', 'desc'], { required: false }) || 'desc';
  const { limit, offset } = v.pagination(req.query);
  if (v.failed()) return v.send(res);

  try {
    const result = await listRecords(req, 'order_profiles', {
      filters: [['production_status', status], ['customer_id', customer_id]],
      // Ties broken by newest first, then order_id, so paging is stable
      orderBy: `${ORDER_SORTS[sort]} ${dir.toUpperCase()}, order_profiles.date_created DESC, order_profiles.order_id`,
      limit,
      offset
    });
    res.status(200).json({ source: result.source, orders: result.records, limit, offset, sort, dir, unsynced: result.unsynced });
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
//   Pending  -> Cancelled             (Pending -> Approved only via POST /:order_id/approve, Owner)
//   Approved -> Printing | Cancelled
//   Printing -> Completed | Cancelled
//   Delayed  -> Pending (reserves stock now; 409 INSUFFICIENT_INVENTORY if short) | Cancelled
//   Completed / Cancelled are final.
// PB 13: Printing is only reachable through Approved, so production can never start without
// the Owner's approval and the 50% downpayment check.
// Stock effects (same transaction): Cancelled releases the reservation; Completed consumes it
// (quantity_available and quantity_reserved both go down). Needs the cloud: stock shared by all
// branches must not be released or consumed from a stale offline copy.
// -> 200 { message, order, stock_changes }
// ==========================================
const STATUS_TRANSITIONS = {
  Pending: ['Cancelled'],
  Approved: ['Printing', 'Cancelled'],
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
const APPROVABLE_STATUSES = ['Pending', 'Delayed'];

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
        throw new Rejected(409, {
          error: 'EDIT_CONFLICT',
          message: 'This order was changed by someone else. Reload it and approve again.',
          current: order
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
            SET production_status = 'Approved', approved_by = $2, approved_at = NOW(), stock_reserved = TRUE
          WHERE order_id = $1 RETURNING ${selectList('order_profiles', 'pg')}`,
        [order_id, req.user.user_id]
      );
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
    console.log(`✅ Order ${order_id} approved by ${req.user.user_id} (Owner)` +
                (result.newlyReserved ? `; reserved ${result.ids.length} stock item(s)` : '; stock was already reserved'));
    return res.status(200).json({
      message: 'Job order approved.',
      source: 'cloud',
      order: result.order,
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

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  normalizeRequiredItems,
  evaluateCapacity,
  capacityFailureResponse
} = require('../services/capacity');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { LOCAL_NOW, offlineUpdateBookkeeping } = require('../utils/localSync');
const { createValidator } = require('../utils/validation');
const {
  selectList, serialize, locateRecord, readLocal,
  withPgTransaction, withLocalTransaction, sqliteGet, sqliteRun
} = require('../services/records');

const { STOCK_STATUSES, withAvailability, buildInventorySnapshot } = require('../services/inventorySnapshot');

// Real-time push (Socket.io) after any stock change made by this server
const pushStockChange = (req, ids, reason) => {
  if (req.inventoryEvents) req.inventoryEvents.notifyChanged(ids, reason);
};

router.use(verifyToken);

// M7: rejects malformed :inventory_id before any query runs
router.param('inventory_id', (req, res, next, value) => {
  const v = createValidator();
  v.id(value, 'inventory_id');
  if (v.failed()) return v.send(res);
  next();
});

// Business-rule failures inside a transaction (rolled back, then mapped to 404/409)
class LossRejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

// ==========================================
// 0. LIST INVENTORY ITEMS (Catalog page + Create Order item picker)
// GET /api/inventory?category=Raw&stock_status=low_stock&search=ink
// -> { source, fetched_at, summary, categories, items: [... , quantity_available_net, stock_status] }
// Identical shape online and offline (M10). summary/categories describe the whole
// catalog, not just the filtered page, so the dashboard counts stay stable while filtering.
// ==========================================
router.get('/', requireRole(['Admin', 'Production', 'Staff']), async (req, res) => {
  const v = createValidator();
  const category = v.optionalString(req.query.category, 'category', 100);
  const stock_status = v.oneOf(req.query.stock_status, 'stock_status', STOCK_STATUSES, { required: false });
  const search = v.optionalString(req.query.search, 'search', 100);
  if (v.failed()) return v.send(res);

  try {
    res.status(200).json(await buildInventorySnapshot(req, { category, stock_status, search }));
  } catch (err) {
    sendDbError(res, err, 'listing inventory');
  }
});

// ==========================================
// 1. ADD NEW INVENTORY ITEM -> 201 { message, source, item }
// ==========================================
router.post('/', requireRole(['Admin', 'Production']), async (req, res) => {
  const body = req.body || {};

  const v = createValidator();
  const item_name = v.requiredString(body.item_name, 'item_name', 255);
  const item_category = v.requiredString(body.item_category, 'item_category', 100);
  const quantity_available = v.nonNegativeInt(body.quantity_available, 'quantity_available', 0);
  const minimum_threshold = v.nonNegativeInt(body.minimum_threshold, 'minimum_threshold', 0);
  const unit_cost = v.nonNegativeMoney(body.unit_cost, 'unit_cost');
  if (v.failed()) return v.send(res);

  const inventory_id = crypto.randomUUID();
  const values = [inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost];

  try {
    let result;
    try {
      const { rows } = await req.pgPool.query(
        `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${selectList('inventory_items', 'pg')}`,
        values
      );
      result = { source: 'cloud', record: serialize('inventory_items', rows[0]) };
    } catch (onlineError) {
      if (!isConnectionError(onlineError)) throw onlineError; // C5
      console.error('Cloud DB unreachable. Saving inventory to SQLite:', onlineError.message);
      await sqliteRun(
        req.localDb,
        `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost, sync_status, last_modified)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
        values
      );
      result = { source: 'local', record: await readLocal(req.localDb, 'inventory_items', inventory_id) };
    }

    pushStockChange(req, [inventory_id], 'item_added');
    res.status(201).json({
      message: result.source === 'cloud' ? 'Inventory item added.' : 'Inventory item saved locally (Offline Mode).',
      source: result.source,
      item: withAvailability(result.record)
    });
  } catch (err) {
    sendDbError(res, err, 'adding inventory item');
  }
});

// ==========================================
// 2. RECORD MATERIAL LOSS (Audit fix M9)
// Body: { quantity_lost, loss_reason, order_id?, financial_cost? }
// The loss record and the stock reduction are written in ONE transaction, so they either
// both happen or neither does. financial_cost defaults to unit_cost x quantity_lost.
// -> 201 { message, source, loss, item }
//    404 INVENTORY_ITEM_NOT_FOUND / ORDER_NOT_FOUND
//    409 INSUFFICIENT_STOCK when the loss is larger than the stock on hand
// ==========================================
router.post('/:inventory_id/loss', requireRole(['Admin', 'Production']), async (req, res) => {
  const { inventory_id } = req.params;
  const body = req.body || {};

  const v = createValidator();
  const quantity_lost = v.positiveInt(body.quantity_lost, 'quantity_lost');
  const loss_reason = v.requiredString(body.loss_reason, 'loss_reason', 1000);
  const order_id = v.id(body.order_id, 'order_id', { required: false });
  const financial_cost = v.nonNegativeMoney(body.financial_cost, 'financial_cost', { required: false, defaultValue: null });
  if (v.failed()) return v.send(res);

  const loss_id = crypto.randomUUID();
  const insufficient = (available) => new LossRejected(409, {
    error: 'INSUFFICIENT_STOCK',
    message: `Cannot record a loss of ${quantity_lost}: only ${available} in stock.`,
    quantity_available: available,
    quantity_lost
  });
  const missingItem = () => new LossRejected(404, {
    error: 'INVENTORY_ITEM_NOT_FOUND', message: `Inventory item ${inventory_id} does not exist.`
  });

  // ---- Online: lock the stock row, decrement, insert, commit ----
  const recordInCloud = () => withPgTransaction(req.pgPool, async (client) => {
    const stock = await client.query(
      'SELECT quantity_available FROM inventory_items WHERE inventory_id = $1 FOR UPDATE',
      [inventory_id]
    );
    if (stock.rowCount === 0) throw missingItem();
    if (stock.rows[0].quantity_available < quantity_lost) throw insufficient(stock.rows[0].quantity_available);

    const item = await client.query(
      `UPDATE inventory_items SET quantity_available = quantity_available - $1, last_modified = NOW()
        WHERE inventory_id = $2 RETURNING ${selectList('inventory_items', 'pg')}, unit_cost AS raw_unit_cost`,
      [quantity_lost, inventory_id]
    );
    const loss = await client.query(
      `INSERT INTO material_loss (loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost)
       VALUES ($1, $2, $3, $4::int, $5, COALESCE($6::numeric, ROUND($7::numeric * $4::int, 2)))
       RETURNING ${selectList('material_loss', 'pg')}`,
      [loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost, item.rows[0].raw_unit_cost]
    );
    return { source: 'cloud', loss: serialize('material_loss', loss.rows[0]), item: serialize('inventory_items', item.rows[0]) };
  });

  // ---- Offline: same transaction on a dedicated SQLite connection ----
  // If the item already exists in Neon, the stock reduction is replayed there when this loss
  // syncs (cloud_stock_delta). If the item itself was created offline, the reduction is baked
  // into the item's pending insert instead (delta 0), so it is never applied twice.
  const recordLocally = () => withLocalTransaction(req.localDbPath, async (tx) => {
    const stock = await sqliteGet(tx,
      'SELECT quantity_available, unit_cost, sync_status FROM inventory_items WHERE inventory_id = ?', [inventory_id]);
    if (!stock) throw missingItem();
    if (stock.quantity_available < quantity_lost) throw insufficient(stock.quantity_available);

    const itemIsLocalOnly = stock.sync_status === 'pending_insert';
    await sqliteRun(tx,
      itemIsLocalOnly
        ? `UPDATE inventory_items SET quantity_available = quantity_available - ?,
             ${offlineUpdateBookkeeping('inventory_items', ['quantity_available'])} WHERE inventory_id = ?`
        : 'UPDATE inventory_items SET quantity_available = quantity_available - ? WHERE inventory_id = ?',
      [quantity_lost, inventory_id]);

    const cost = financial_cost !== null ? financial_cost : Math.round(stock.unit_cost * quantity_lost * 100) / 100;
    await sqliteRun(tx,
      `INSERT INTO material_loss (loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost,
                                  cloud_stock_delta, sync_status, last_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
      [loss_id, order_id, inventory_id, quantity_lost, loss_reason, cost, itemIsLocalOnly ? 0 : quantity_lost]);

    return {
      source: 'local',
      loss: await readLocal(tx, 'material_loss', loss_id),
      item: await readLocal(tx, 'inventory_items', inventory_id)
    };
  });

  try {
    // M7: the inventory item (and the order, if given) must exist
    const item = await locateRecord(req, 'inventory_items', inventory_id);
    if (!item.location) return res.status(404).json(missingItem().body);
    let target = item.location;
    if (order_id) {
      const order = await locateRecord(req, 'order_profiles', order_id);
      if (!order.location) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: `Order ${order_id} does not exist.` });
      if (order.location === 'local') target = 'local';
    }

    let result;
    if (target === 'local') {
      result = await recordLocally();
    } else {
      try {
        result = await recordInCloud();
      } catch (err) {
        if (err instanceof LossRejected || !isConnectionError(err)) throw err;
        if (err.commitUnknown) {
          return res.status(503).json({
            error: 'COMMIT_UNKNOWN',
            message: 'Connection to the cloud dropped while saving. Check the loss list before retrying.'
          });
        }
        console.error('Cloud DB unreachable. Recording loss offline:', err.message);
        result = await recordLocally();
      }
    }

    pushStockChange(req, [inventory_id], 'material_loss');
    res.status(201).json({
      message: result.source === 'cloud' ? 'Material loss recorded.' : 'Material loss saved locally (Offline Mode).',
      source: result.source,
      loss: result.loss,
      item: withAvailability(result.item)
    });
  } catch (err) {
    if (err instanceof LossRejected) return res.status(err.status).json(err.body);
    sendDbError(res, err, 'recording material loss');
  }
});

// ==========================================
// 3. INVENTORY CAPACITY PRE-CHECK (PB 9)
// Body: { required_items: [{ inventory_id, quantity_needed }] }
// 200 -> can fulfill | 409 -> halted (shortages) | 404 -> unknown item | 400 -> bad payload
// ==========================================
router.post('/check-capacity', requireRole(['Admin', 'Production', 'Staff']), async (req, res) => {
  const { required_items } = req.body || {};

  const normalized = normalizeRequiredItems(required_items);
  if (normalized.error) {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: normalized.error });
  }

  let evaluation;
  try {
    evaluation = await evaluateCapacity(req, normalized.items);
  } catch (checkError) {
    // Either a non-connection cloud error, or the cloud was down AND SQLite failed
    return sendDbError(res, checkError, 'inventory capacity check');
  }

  const failure = capacityFailureResponse(evaluation);
  if (failure) {
    return res.status(failure.status).json(failure.body);
  }

  return res.status(200).json({
    can_fulfill: true,
    message: 'Capacity pre-check passed. Sufficient stock available.',
    source: evaluation.source
  });
});

module.exports = router;

// /api/inventory: the catalog (items, blanks and consumables).
//   GET / · POST / · PATCH /:id · DELETE /:id (to the Recycle Bin)
//   Recycle Bin: GET /recycle-bin · POST /:id/restore · DELETE /:id/permanent · POST /recycle-bin/empty
//   Waste: POST /:id/loss (one item) · POST /losses (several at once)
//   Usage rates: GET / PUT /:id/consumable-rates · stock check: POST /check-capacity
//   POST /:id/adjust answers 410: stock changes go through Stock in / out / count (routes/stock.js)
// Each route has its own block comment below with its body and replies.

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
const { createValidator, ID_PATTERN } = require('../utils/validation');
const {
  selectList, serialize, locateRecord, readLocal, listRecords, countRecords, getRecord,
  withPgTransaction, withLocalTransaction, sqliteGet, sqliteRun,
  ACTIVE_ITEM_SQL, BIN_ITEM_SQL
} = require('../services/records');
const { STOCK_STATUSES, withAvailability, buildInventorySnapshot } = require('../services/inventorySnapshot');
const { snapshotOf, auditCloud, auditLocal } = require('../services/inventoryAudit');
const { purgeInCloud, applyPurgeLocally, purgeBatches, RETENTION_DAYS } = require('../services/recycleBin');
const { rolesWith, can } = require('../services/domain/permissions');
const { CONSUMABLE_TRIGGERS, checkRateList } = require('../services/domain/consumables');
const { loadRates } = require('../services/consumables');
const { refreshLocalRows } = require('../services/sync');
const { PRINT_PRICING } = require('../services/domain/pricing');
const { REASON_CODE_LIST, inferReasonCode, reasonLabel, replacementWarning } = require('../services/domain/wasteDiagnostics');
const { diagnoseInCloud, escalateClusterInCloud, diagnoseLocally, shownLoss } = require('../services/waste');
const { setMovementContext, clearMovementContext } = require('../services/stockMovements');

// Who may do what (role always comes from the JWT)
const READ_ROLES = rolesWith('view_stock');
const EDIT_ROLES = rolesWith('edit_inventory');   // add, edit, stock changes, move to / restore from bin
const PURGE_ROLES = rolesWith('purge_inventory'); // permanent delete / empty bin

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

// Business-rule failures inside a transaction (rolled back, then sent as-is)
class Rejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

const sendError = (res, err, context) => {
  if (err instanceof Rejected) return res.status(err.status).json(err.body);
  if (err && err.code === '23505') {
    // uq_inventory_items_name caught a duplicate created at the same moment by someone else
    return res.status(409).json({ error: 'DUPLICATE_ITEM', message: 'An item with this name already exists in the catalog.' });
  }
  return sendDbError(res, err, context);
};

// Cloud first; on a genuine outage, fall back to the local cache (C5). A drop during COMMIT
// has an unknown outcome, so it is reported instead of retried offline.
const cloudFirst = async (location, cloudFn, localFn, doing) => {
  if (location === 'local') return localFn();
  try {
    return await cloudFn();
  } catch (err) {
    if (err instanceof Rejected || !isConnectionError(err)) throw err;
    if (err.commitUnknown) {
      throw new Rejected(503, {
        error: 'COMMIT_UNKNOWN',
        message: `Connection to the cloud dropped while ${doing}. Refresh the catalog before retrying.`
      });
    }
    console.error(`Cloud DB unreachable while ${doing}. Saving offline:`, err.message);
    return localFn();
  }
};

const missingItem = (id) => new Rejected(404, {
  error: 'INVENTORY_ITEM_NOT_FOUND',
  message: `Inventory item ${id} does not exist (or is in the Recycle Bin).`
});

// ---------- migration 015 helpers ----------
// A supplier profile (cloud first, this computer's copy offline) -> { supplier_id, supplier_name } | null
const findSupplier = async (req, supplier_id) => {
  try {
    const { rows } = await req.pgPool.query(
      'SELECT supplier_id, supplier_name FROM suppliers WHERE supplier_id = $1 AND archived_at IS NULL', [supplier_id]);
    return rows[0] || null;
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    return (await sqliteGet(req.localDb,
      'SELECT supplier_id, supplier_name FROM suppliers WHERE supplier_id = ? AND archived_at IS NULL', [supplier_id])) || null;
  }
};
const supplierMissing = () => new Rejected(404, {
  error: 'SUPPLIER_NOT_FOUND', message: 'We could not find this supplier (it may be archived). Choose it again.'
});
// The order number shown on the stock card for a loss recorded against an order
const orderNumberOf = async (client, order_id) => {
  if (!order_id) return null;
  const { rows } = await client.query('SELECT tracking_no FROM order_profiles WHERE order_id = $1', [order_id]);
  return rows[0] ? rows[0].tracking_no : null;
};

// ---------- Duplicate names ----------
// Names are compared ignoring case and whitespace: "Deli A4" = "deli  a4" = "DeliA4".
// Same rule as the uq_inventory_items_name index in migration 004.
const cleanName = (s) => s.replace(/\s+/g, ' ').trim();
const nameKey = (s) => s.toLowerCase().replace(/[ \t\n\r\f\v]+/g, '');
const PG_NAME_KEY = "LOWER(REGEXP_REPLACE(item_name, '\\s', '', 'g'))";
const SQLITE_NAME_KEY =
  "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(item_name, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(12), ''))";

// activeOnly: ignore Recycle Bin items (used when restoring); pendingOnly: local rows not yet in Neon
const findDuplicateCloud = async (db, name, { excludeId = null, activeOnly = false } = {}) => {
  const { rows } = await db.query(
    `SELECT inventory_id, item_name, (deleted_at IS NOT NULL) AS in_bin FROM inventory_items
      WHERE purged_at IS NULL ${activeOnly ? 'AND deleted_at IS NULL' : ''}
        AND ${PG_NAME_KEY} = $1 AND ($2::text IS NULL OR inventory_id <> $2::text)
      ORDER BY deleted_at NULLS FIRST LIMIT 1`,
    [nameKey(name), excludeId]
  );
  return rows[0] || null;
};
const findDuplicateLocal = async (db, name, { excludeId = null, activeOnly = false, pendingOnly = false } = {}) => {
  const row = await sqliteGet(db,
    `SELECT inventory_id, item_name, (deleted_at IS NOT NULL) AS in_bin FROM inventory_items
      WHERE purged_at IS NULL ${activeOnly ? 'AND deleted_at IS NULL' : ''}
        ${pendingOnly ? "AND sync_status = 'pending_insert'" : ''}
        AND ${SQLITE_NAME_KEY} = ? AND (? IS NULL OR inventory_id <> ?)
      ORDER BY deleted_at IS NOT NULL LIMIT 1`,
    [nameKey(name), excludeId, excludeId]);
  return row ? { ...row, in_bin: Boolean(row.in_bin) } : null;
};
const duplicateError = (dup) => new Rejected(409, {
  error: 'DUPLICATE_ITEM',
  message: dup.in_bin
    ? `"${dup.item_name}" is already in the Recycle Bin. Restore it instead of adding it again.`
    : `"${dup.item_name}" already exists in the catalog. Use Add / Subtract Stock to change its quantity.`,
  existing: { inventory_id: dup.inventory_id, item_name: dup.item_name, in_recycle_bin: Boolean(dup.in_bin) }
});

// ---------- Row readers ----------
const lockCloudItem = async (client, id, where = ACTIVE_ITEM_SQL) => {
  const { rows } = await client.query(
    `SELECT ${selectList('inventory_items', 'pg')} FROM inventory_items WHERE inventory_id = $1 AND ${where} FOR UPDATE`,
    [id]
  );
  return rows[0] ? serialize('inventory_items', rows[0]) : null;
};
const readLocalItem = async (tx, id, where = ACTIVE_ITEM_SQL) => {
  const row = await sqliteGet(tx,
    `SELECT ${selectList('inventory_items', 'sqlite')}, sync_status AS raw_sync_status
       FROM inventory_items WHERE inventory_id = ? AND ${where}`, [id]);
  return row ? { ...serialize('inventory_items', row), raw_sync_status: row.raw_sync_status } : null;
};

// ==========================================
// 0. LIST INVENTORY ITEMS (Catalog page + Create Order item picker)
// GET /api/inventory?category=Raw&stock_status=low_stock&search=ink
// -> { source, fetched_at, summary, categories, items }   (active items only)
// ==========================================
router.get('/', requireRole(READ_ROLES), async (req, res) => {
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
//    409 DUPLICATE_ITEM (same name, ignoring case/spaces; also if it sits in the Recycle Bin)
// ==========================================
router.post('/', requireRole(EDIT_ROLES), async (req, res) => {
  const body = req.body || {};

  const v = createValidator();
  const rawName = v.requiredString(body.item_name, 'item_name', 255);
  const item_category = v.requiredString(body.item_category, 'item_category', 100);
  const quantity_available = v.nonNegativeInt(body.quantity_available, 'quantity_available', 0);
  const minimum_threshold = v.nonNegativeInt(body.minimum_threshold, 'minimum_threshold', 0);
  const unit_cost = v.nonNegativeMoney(body.unit_cost, 'unit_cost', { required: false, defaultValue: 0 });
  const unit = v.optionalString(body.unit, 'unit', 30) || 'pcs';
  const typedSupplier = v.optionalString(body.supplier, 'supplier', 255);
  const supplier_id = v.id(body.supplier_id, 'supplier_id', { required: false }); // migration 015
  const has_sizes = v.bool(body.has_sizes, 'has_sizes');                          // migration 015: a garment
  const requires_pressing = v.bool(body.requires_pressing, 'requires_pressing');  // migration 016: a T-shirt (heat press)
  const selling_price = v.nonNegativeMoney(body.selling_price, 'selling_price', { required: false, defaultValue: 0 }); // PB 11
  // migration 017: 'included' (the price is the finished piece) or 'per_area' (the blank; print areas add)
  const print_pricing = v.oneOf(body.print_pricing, 'print_pricing', PRINT_PRICING, { required: false }) || 'included';
  if (v.failed()) return v.send(res);

  const item_name = cleanName(rawName);
  const inventory_id = crypto.randomUUID();

  try {
    // migration 015: the usual supplier is a supplier profile; its name is kept on the item too
    const supplierRow = supplier_id ? await findSupplier(req, supplier_id) : null;
    if (supplier_id && !supplierRow) throw supplierMissing();
    const supplier = supplierRow ? supplierRow.supplier_name : (typedSupplier ? cleanName(typedSupplier) : null);
    const values = [inventory_id, item_name, cleanName(item_category), quantity_available, minimum_threshold, unit_cost,
      cleanName(unit), supplier, selling_price, supplier_id || null, has_sizes, requires_pressing, print_pricing];

    const result = await cloudFirst('cloud',
      () => withPgTransaction(req.pgPool, async (client) => {
        const dup = (await findDuplicateCloud(client, item_name))
          || (await findDuplicateLocal(req.localDb, item_name, { pendingOnly: true }).catch(() => null));
        if (dup) throw duplicateError(dup);
        // The stock card starts with the opening stock typed here (migration 015)
        await setMovementContext(client, {
          type: 'opening', reference_type: 'inventory_item', reference_id: inventory_id,
          note: 'Opening stock when the item was added to the catalog', actor: req.user
        });
        const { rows } = await client.query(
          `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost, unit, supplier,
                                        selling_price, supplier_id, has_sizes, requires_pressing, print_pricing)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${selectList('inventory_items', 'pg')}`,
          values
        );
        await clearMovementContext(client);
        const record = serialize('inventory_items', rows[0]);
        await auditCloud(client, req.user, inventory_id, 'created', item_name, { item: snapshotOf(record) });
        return { source: 'cloud', record };
      }),
      () => withLocalTransaction(req.localDbPath, async (tx) => {
        const dup = await findDuplicateLocal(tx, item_name);
        if (dup) throw duplicateError(dup);
        await sqliteRun(tx,
          `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost, unit, supplier,
                                        selling_price, supplier_id, has_sizes, requires_pressing, print_pricing, sync_status, last_modified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
          values.map((x) => (x === true ? 1 : x === false ? 0 : x)));
        const record = await readLocal(tx, 'inventory_items', inventory_id);
        await auditLocal(tx, req.user, inventory_id, 'created', item_name, { item: snapshotOf(record) });
        return { source: 'local', record };
      }),
      'adding the item'
    );

    pushStockChange(req, [inventory_id], 'item_added');
    res.status(201).json({
      message: result.source === 'cloud'
        ? `"${item_name}" was added to the inventory.`
        : `"${item_name}" was saved locally (Offline Mode) and will sync when online.`,
      source: result.source,
      item: withAvailability(result.record)
    });
  } catch (err) {
    sendError(res, err, 'adding inventory item');
  }
});

// ==========================================
// 1b. EDIT ITEM DETAILS (Catalog card "Edit")
// PATCH /api/inventory/:inventory_id
// Body (any of): { item_name, item_category, minimum_threshold, unit_cost, selling_price, unit, supplier, expected_version? }
//   selling_price (PB 11): what the shop charges per piece before volume discounts
// Quantities are changed through /adjust and /loss so every stock movement is traceable.
// -> 200 { message, source, changed, item }
//    404 not found / in bin | 409 DUPLICATE_ITEM | 409 EDIT_CONFLICT (someone else edited it first)
// ==========================================
const EDITABLE_FIELDS = ['item_name', 'item_category', 'minimum_threshold', 'unit_cost', 'selling_price', 'unit', 'supplier', 'supplier_id', 'has_sizes',
  'requires_pressing', 'print_pricing'];

router.patch('/:inventory_id', requireRole(EDIT_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  const body = req.body || {};

  const v = createValidator();
  const updates = {};
  if (body.item_name !== undefined) updates.item_name = v.requiredString(body.item_name, 'item_name', 255);
  if (body.item_category !== undefined) updates.item_category = v.requiredString(body.item_category, 'item_category', 100);
  if (body.minimum_threshold !== undefined) {
    if (body.minimum_threshold === null || body.minimum_threshold === '') {
      v.errors.push({ field: 'minimum_threshold', message: 'minimum_threshold cannot be empty.' });
    } else {
      updates.minimum_threshold = v.nonNegativeInt(body.minimum_threshold, 'minimum_threshold', 0);
    }
  }
  if (body.unit_cost !== undefined) updates.unit_cost = v.nonNegativeMoney(body.unit_cost, 'unit_cost');
  if (body.selling_price !== undefined) updates.selling_price = v.nonNegativeMoney(body.selling_price, 'selling_price');
  if (body.unit !== undefined) updates.unit = v.requiredString(body.unit, 'unit', 30);
  // supplier may be cleared with null or ''
  if (body.supplier !== undefined) updates.supplier = body.supplier === null ? null : v.optionalString(body.supplier, 'supplier', 255);
  // migration 015: the usual supplier (null clears it) and whether the item is a garment
  if (body.supplier_id !== undefined) updates.supplier_id = body.supplier_id === null || body.supplier_id === '' ? null : v.id(body.supplier_id, 'supplier_id');
  if (body.has_sizes !== undefined) updates.has_sizes = v.bool(body.has_sizes, 'has_sizes');
  // migration 016: a T-shirt, so its orders go through the heat press (Pressing)
  if (body.requires_pressing !== undefined) updates.requires_pressing = v.bool(body.requires_pressing, 'requires_pressing');
  // migration 017: how the item is priced on a quote
  if (body.print_pricing !== undefined) updates.print_pricing = v.oneOf(body.print_pricing, 'print_pricing', PRINT_PRICING);
  if (body.expected_version !== undefined && body.expected_version !== null && typeof body.expected_version !== 'string') {
    v.errors.push({ field: 'expected_version', message: 'expected_version must be the string returned as "version".' });
  }
  if (Object.keys(updates).length === 0 && !v.failed()) {
    v.errors.push({ field: 'body', message: `Send at least one of: ${EDITABLE_FIELDS.join(', ')}.` });
  }
  if (v.failed()) return v.send(res);
  if (updates.item_name) updates.item_name = cleanName(updates.item_name);
  if (updates.item_category) updates.item_category = cleanName(updates.item_category);
  if (updates.unit) updates.unit = cleanName(updates.unit);
  if (updates.supplier) updates.supplier = cleanName(updates.supplier);
  const expected_version = body.expected_version || null;
  const localValue = (x) => (x === true ? 1 : x === false ? 0 : x);

  const diff = (current) => Object.keys(updates).filter((f) => updates[f] !== current[f]);
  const changesOf = (current, fields) => ({
    before: Object.fromEntries(fields.map((f) => [f, current[f]])),
    after: Object.fromEntries(fields.map((f) => [f, updates[f]]))
  });

  try {
    const located = await locateRecord(req, 'inventory_items', inventory_id);
    if (!located.location) throw missingItem(inventory_id);
    // migration 015: choosing a supplier profile also writes its name on the item
    if (updates.supplier_id) {
      const supplierRow = await findSupplier(req, updates.supplier_id);
      if (!supplierRow) throw supplierMissing();
      updates.supplier = supplierRow.supplier_name;
    } else if (updates.supplier_id === null && updates.supplier === undefined) {
      updates.supplier = null;
    }

    const result = await cloudFirst(located.location,
      () => withPgTransaction(req.pgPool, async (client) => {
        const current = await lockCloudItem(client, inventory_id);
        if (!current) throw missingItem(inventory_id);
        if (expected_version && current.version !== expected_version) {
          throw new Rejected(409, {
            error: 'EDIT_CONFLICT',
            message: 'Someone else changed this item while you were editing. Review the latest values and try again.',
            current: withAvailability(current)
          });
        }
        const fields = diff(current);
        if (fields.length === 0) return { source: 'cloud', record: current, fields };
        if (fields.includes('item_name')) {
          const dup = await findDuplicateCloud(client, updates.item_name, { excludeId: inventory_id });
          if (dup) throw duplicateError(dup);
        }
        const { rows } = await client.query(
          `UPDATE inventory_items SET ${fields.map((f, i) => `${f} = $${i + 1}`).join(', ')}
            WHERE inventory_id = $${fields.length + 1} RETURNING ${selectList('inventory_items', 'pg')}`,
          [...fields.map((f) => updates[f]), inventory_id]
        );
        await auditCloud(client, req.user, inventory_id, 'edited', current.item_name, changesOf(current, fields));
        return { source: 'cloud', record: serialize('inventory_items', rows[0]), fields };
      }),
      () => withLocalTransaction(req.localDbPath, async (tx) => {
        const current = await readLocalItem(tx, inventory_id);
        if (!current) throw missingItem(inventory_id);
        const fields = diff(current);
        if (fields.length === 0) return { source: 'local', record: current, fields };
        if (fields.includes('item_name')) {
          const dup = await findDuplicateLocal(tx, updates.item_name, { excludeId: inventory_id });
          if (dup) throw duplicateError(dup);
        }
        await sqliteRun(tx,
          `UPDATE inventory_items SET ${fields.map((f) => `${f} = ?`).join(', ')},
             ${offlineUpdateBookkeeping('inventory_items', fields)} WHERE inventory_id = ?`,
          [...fields.map((f) => localValue(updates[f])), inventory_id]);
        await auditLocal(tx, req.user, inventory_id, 'edited', current.item_name, changesOf(current, fields));
        return { source: 'local', record: await readLocal(tx, 'inventory_items', inventory_id), fields };
      }),
      'editing the item'
    );

    if (result.fields.length > 0) pushStockChange(req, [inventory_id], 'item_edited');
    res.status(200).json({
      message: result.fields.length === 0
        ? 'Nothing changed: the values are the same as before.'
        : result.source === 'cloud'
          ? `"${result.record.item_name}" was updated.`
          : `"${result.record.item_name}" was updated locally (Offline Mode).`,
      source: result.source,
      changed: result.fields,
      item: withAvailability(result.record)
    });
  } catch (err) {
    sendError(res, err, 'editing inventory item');
  }
});

// ==========================================
// 1c. MOVE TO RECYCLE BIN (Catalog card "Delete")
// DELETE /api/inventory/:inventory_id -> 200 { message, source, item }
// Nothing is erased: the item is hidden from the catalog and can be restored from the bin.
//    409 ITEM_RESERVED while active orders still hold some of its stock
// ==========================================
router.delete('/:inventory_id', requireRole(EDIT_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  const reserved = (item) => new Rejected(409, {
    error: 'ITEM_RESERVED',
    message: `"${item.item_name}" has ${item.quantity_reserved} reserved for active orders. Complete or cancel those orders first.`,
    quantity_reserved: item.quantity_reserved
  });

  try {
    const located = await locateRecord(req, 'inventory_items', inventory_id);
    if (!located.location) throw missingItem(inventory_id);

    const result = await cloudFirst(located.location,
      () => withPgTransaction(req.pgPool, async (client) => {
        const current = await lockCloudItem(client, inventory_id);
        if (!current) throw missingItem(inventory_id);
        if (current.quantity_reserved > 0) throw reserved(current);
        const { rows } = await client.query(
          `UPDATE inventory_items SET deleted_at = NOW(), deleted_by = $2
            WHERE inventory_id = $1 RETURNING ${selectList('inventory_items', 'pg')}`,
          [inventory_id, String(req.user.user_id)]
        );
        await auditCloud(client, req.user, inventory_id, 'deleted', current.item_name, { item: snapshotOf(current) });
        return { source: 'cloud', record: serialize('inventory_items', rows[0]) };
      }),
      () => withLocalTransaction(req.localDbPath, async (tx) => {
        const current = await readLocalItem(tx, inventory_id);
        if (!current) throw missingItem(inventory_id);
        if (current.quantity_reserved > 0) throw reserved(current);
        await sqliteRun(tx,
          `UPDATE inventory_items SET deleted_at = ${LOCAL_NOW}, deleted_by = ?,
             ${offlineUpdateBookkeeping('inventory_items', ['deleted_at', 'deleted_by'])} WHERE inventory_id = ?`,
          [String(req.user.user_id), inventory_id]);
        await auditLocal(tx, req.user, inventory_id, 'deleted', current.item_name, { item: snapshotOf(current) });
        return { source: 'local', record: await readLocal(tx, 'inventory_items', inventory_id) };
      }),
      'moving the item to the Recycle Bin'
    );

    pushStockChange(req, [inventory_id], 'item_deleted');
    res.status(200).json({
      message: `"${result.record.item_name}" was moved to the Recycle Bin${result.source === 'local' ? ' (Offline Mode)' : ''}. You can restore it from there.`,
      source: result.source,
      item: result.record
    });
  } catch (err) {
    sendError(res, err, 'deleting inventory item');
  }
});

// ==========================================
// 1d. RECYCLE BIN LIST (paginated so a big bin never slows the page)
// GET /api/inventory/recycle-bin?limit=20&offset=0
// -> { source, items, total, limit, offset, retention_days }
// ==========================================
router.get('/recycle-bin', requireRole(EDIT_ROLES), async (req, res) => {
  const v = createValidator();
  const { limit, offset } = v.pagination(req.query);
  if (v.failed()) return v.send(res);

  try {
    const list = await listRecords(req, 'inventory_items', {
      where: BIN_ITEM_SQL, orderBy: 'deleted_at DESC, inventory_id', limit, offset
    });
    const { count } = await countRecords(req, 'inventory_items', { where: BIN_ITEM_SQL });
    res.status(200).json({
      source: list.source,
      items: list.records,
      total: Math.max(count, list.records.length + offset),
      limit,
      offset,
      retention_days: RETENTION_DAYS
    });
  } catch (err) {
    sendDbError(res, err, 'listing the Recycle Bin');
  }
});

// ==========================================
// 1e. RESTORE FROM RECYCLE BIN
// POST /api/inventory/:inventory_id/restore -> 200 { message, source, item }
//    409 DUPLICATE_ITEM if an active item with the same name was added meanwhile
// ==========================================
router.post('/:inventory_id/restore', requireRole(EDIT_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  const notInBin = () => new Rejected(404, {
    error: 'NOT_IN_RECYCLE_BIN', message: 'This item is not in the Recycle Bin (it may already be restored or permanently deleted).'
  });

  try {
    const located = await locateRecord(req, 'inventory_items', inventory_id);
    if (!located.location) throw notInBin();

    const result = await cloudFirst(located.location,
      () => withPgTransaction(req.pgPool, async (client) => {
        const current = await lockCloudItem(client, inventory_id, BIN_ITEM_SQL);
        if (!current) throw notInBin();
        const dup = await findDuplicateCloud(client, current.item_name, { excludeId: inventory_id, activeOnly: true });
        if (dup) throw duplicateError(dup);
        const { rows } = await client.query(
          `UPDATE inventory_items SET deleted_at = NULL, deleted_by = NULL
            WHERE inventory_id = $1 RETURNING ${selectList('inventory_items', 'pg')}`,
          [inventory_id]
        );
        await auditCloud(client, req.user, inventory_id, 'restored', current.item_name, { item: snapshotOf(current) });
        return { source: 'cloud', record: serialize('inventory_items', rows[0]) };
      }),
      () => withLocalTransaction(req.localDbPath, async (tx) => {
        const current = await readLocalItem(tx, inventory_id, BIN_ITEM_SQL);
        if (!current) throw notInBin();
        const dup = await findDuplicateLocal(tx, current.item_name, { excludeId: inventory_id, activeOnly: true });
        if (dup) throw duplicateError(dup);
        await sqliteRun(tx,
          `UPDATE inventory_items SET deleted_at = NULL, deleted_by = NULL,
             ${offlineUpdateBookkeeping('inventory_items', ['deleted_at', 'deleted_by'])} WHERE inventory_id = ?`,
          [inventory_id]);
        await auditLocal(tx, req.user, inventory_id, 'restored', current.item_name, { item: snapshotOf(current) });
        return { source: 'local', record: await readLocal(tx, 'inventory_items', inventory_id) };
      }),
      'restoring the item'
    );

    pushStockChange(req, [inventory_id], 'item_restored');
    res.status(200).json({
      message: `"${result.record.item_name}" was restored to the catalog${result.source === 'local' ? ' (Offline Mode)' : ''}.`,
      source: result.source,
      item: withAvailability(result.record)
    });
  } catch (err) {
    sendError(res, err, 'restoring inventory item');
  }
});

// ==========================================
// 1f. PERMANENT DELETE (from the Recycle Bin only; Owner/Admin; needs the cloud)
// DELETE /api/inventory/:inventory_id/permanent -> 200 { message, purged }
// The full item snapshot stays in the backend audit trail.
// ==========================================
const requiresCloud = () => new Rejected(503, {
  error: 'PURGE_REQUIRES_CLOUD',
  message: 'Permanent delete needs an internet connection (and the item synced to the cloud). Try again when online.'
});

router.delete('/:inventory_id/permanent', requireRole(PURGE_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  try {
    const located = await locateRecord(req, 'inventory_items', inventory_id);
    if (located.location !== 'cloud') {
      if (!located.cloudReachable || located.location === 'local') throw requiresCloud();
      throw new Rejected(404, { error: 'NOT_IN_RECYCLE_BIN', message: 'This item is not in the Recycle Bin.' });
    }

    let outcome;
    try {
      outcome = await withPgTransaction(req.pgPool, (client) => purgeInCloud(client, [inventory_id], req.user));
    } catch (err) {
      if (isConnectionError(err)) throw requiresCloud();
      throw err;
    }
    if (outcome.purged.length === 0) {
      throw new Rejected(404, { error: 'NOT_IN_RECYCLE_BIN', message: 'Move the item to the Recycle Bin before deleting it permanently.' });
    }
    await applyPurgeLocally(req.localDb, outcome.purged);
    pushStockChange(req, [inventory_id], 'item_purged');

    const [p] = outcome.purged;
    res.status(200).json({
      message: p.mode === 'deleted'
        ? `"${p.item_name}" was permanently deleted.`
        : `"${p.item_name}" was permanently removed. Its record is kept in the backend because past orders use it.`,
      purged: outcome.purged
    });
  } catch (err) {
    sendError(res, err, 'permanently deleting inventory item');
  }
});

// ==========================================
// 1g. EMPTY RECYCLE BIN (bounded batches; call again while remaining > 0)
// POST /api/inventory/recycle-bin/empty -> 200 { message, purged_count, remaining }
// ==========================================
router.post('/recycle-bin/empty', requireRole(PURGE_ROLES), async (req, res) => {
  try {
    let result;
    try {
      result = await purgeBatches(req, req.user);
    } catch (err) {
      if (isConnectionError(err)) throw requiresCloud();
      throw err;
    }
    if (result.purged.length > 0) pushStockChange(req, result.purged.map((p) => p.inventory_id), 'recycle_bin_emptied');
    res.status(200).json({
      message: result.remaining > 0
        ? `Permanently deleted ${result.purged.length} item(s). ${result.remaining} still in the bin, continuing…`
        : `Recycle Bin emptied. ${result.purged.length} item(s) permanently deleted.`,
      purged_count: result.purged.length,
      remaining: result.remaining
    });
  } catch (err) {
    sendError(res, err, 'emptying the Recycle Bin');
  }
});

// ==========================================
// 2. RECORD MATERIAL LOSS (Audit fix M9; PB 18 / PB 19 misprints and diagnostics)
// Body: { quantity_lost, reason_code?, loss_reason?, order_id?, financial_cost? }
// The loss record and the stock reduction are written in ONE transaction, so they either
// both happen or neither does. financial_cost defaults to unit_cost x quantity_lost.
//   reason_code (migration 012): one of REASON_CODES (services/domain/wasteDiagnostics.js).
//     Sent: loss_reason may be left out (the code's label is stored). Left out (older screens):
//     loss_reason is required and the code is read from its words where possible.
//   order_id: the order's status is stored as production_stage.
//   D1: the loss comes out of quantity_available; the order's reservation is untouched. When no
//     free stock is left afterwards, replacement_warning says so (never blocks the loss).
//   The cause (loss_category, is_statistical_anomaly) is diagnosed in the same transaction; a
//     machine-step cluster also marks its earlier losses 'Machine Failure' (cloud only).
// -> 201 { message, source, loss, item, diagnosis: { rule, note, cluster_with, escalated, baseline },
//          replacement_warning: null | { code, message, free } }
//    404 INVENTORY_ITEM_NOT_FOUND / ORDER_NOT_FOUND
//    409 INSUFFICIENT_STOCK when the loss is larger than the stock on hand
// ==========================================
// migration 016: the tagged print line is not on this order
const printLineMissing = () => new Rejected(400, {
  error: 'VALIDATION_FAILED',
  message: 'That print line is not on this order. Choose it again from the list.',
  details: [{ field: 'print_detail_id', message: 'Choose a print line of this order.' }]
});

router.post('/:inventory_id/loss', requireRole(EDIT_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  const body = req.body || {};

  const v = createValidator();
  const quantity_lost = v.positiveInt(body.quantity_lost, 'quantity_lost');
  const sentCode = v.oneOf(body.reason_code, 'reason_code', REASON_CODE_LIST, { required: false });
  const typedReason = sentCode
    ? v.optionalString(body.loss_reason, 'loss_reason', 1000)
    : v.requiredString(body.loss_reason, 'loss_reason', 1000);
  const order_id = v.id(body.order_id, 'order_id', { required: false });
  const financial_cost = v.nonNegativeMoney(body.financial_cost, 'financial_cost', { required: false, defaultValue: null });
  // migration 016: the print line this loss ruined (e.g. jersey #10, size L), on this order
  const print_detail_id = v.id(body.print_detail_id, 'print_detail_id', { required: false });
  if (print_detail_id && !order_id) v.errors.push({ field: 'print_detail_id', message: 'A print line can only be tagged on a loss recorded for its order.' });
  if (v.failed()) return v.send(res);
  const reason_code = sentCode || inferReasonCode(typedReason);
  const loss_reason = typedReason || reasonLabel(sentCode);
  const facts = { inventory_id, order_id, reason_code, quantity_lost };

  const loss_id = crypto.randomUUID();
  const insufficient = (available) => new Rejected(409, {
    error: 'INSUFFICIENT_STOCK',
    message: `Cannot record a loss of ${quantity_lost}: only ${available} in stock.`,
    quantity_available: available,
    quantity_lost
  });

  // ---- Online: lock the stock row, decrement, insert, commit ----
  const recordInCloud = () => withPgTransaction(req.pgPool, async (client) => {
    const stock = await client.query(
      `SELECT quantity_available FROM inventory_items WHERE inventory_id = $1 AND ${ACTIVE_ITEM_SQL} FOR UPDATE`,
      [inventory_id]
    );
    if (stock.rowCount === 0) throw missingItem(inventory_id);
    if (stock.rows[0].quantity_available < quantity_lost) throw insufficient(stock.rows[0].quantity_available);

    await setMovementContext(client, {
      type: 'loss', reference_type: 'material_loss', reference_id: loss_id, reference_no: await orderNumberOf(client, order_id),
      note: loss_reason, actor: req.user
    });
    const item = await client.query(
      `UPDATE inventory_items SET quantity_available = quantity_available - $1, last_modified = NOW()
        WHERE inventory_id = $2 RETURNING ${selectList('inventory_items', 'pg')}, unit_cost AS raw_unit_cost`,
      [quantity_lost, inventory_id]
    );
    if (print_detail_id) {
      const line = await client.query('SELECT 1 FROM order_print_details WHERE print_detail_id = $1 AND order_id = $2', [print_detail_id, order_id]);
      if (line.rowCount === 0) throw printLineMissing();
    }
    const { production_stage, diagnosis } = await diagnoseInCloud(client, facts);
    const loss = await client.query(
      `INSERT INTO material_loss (loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost,
                                  reason_code, loss_category, production_stage, is_statistical_anomaly, print_detail_id)
       VALUES ($1, $2, $3, $4::int, $5, COALESCE($6::numeric, ROUND($7::numeric * $4::int, 2)), $8, $9, $10, $11, $12)
       RETURNING ${selectList('material_loss', 'pg')}`,
      [loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost, item.rows[0].raw_unit_cost,
        reason_code, diagnosis.loss_category, production_stage, diagnosis.is_statistical_anomaly, print_detail_id]
    );
    const escalated = await escalateClusterInCloud(client, diagnosis.cluster_with);
    const record = serialize('inventory_items', item.rows[0]);
    await auditCloud(client, req.user, inventory_id, 'stock_subtracted', record.item_name, {
      kind: 'loss', quantity: quantity_lost, previous_quantity: stock.rows[0].quantity_available, new_quantity: record.quantity_available, reason: loss_reason,
      reason_code, loss_category: diagnosis.loss_category, order_id
    });
    return { source: 'cloud', loss: serialize('material_loss', loss.rows[0]), item: record, diagnosis: { ...diagnosis, escalated } };
  });

  // ---- Offline: same transaction on a dedicated SQLite connection ----
  // If the item already exists in Neon, the stock reduction is replayed there when this loss
  // syncs (cloud_stock_delta). If the item itself was created offline, the reduction is baked
  // into the item's pending insert instead (delta 0), so it is never applied twice.
  const recordLocally = () => withLocalTransaction(req.localDbPath, async (tx) => {
    const stock = await sqliteGet(tx,
      `SELECT quantity_available, unit_cost, sync_status FROM inventory_items WHERE inventory_id = ? AND ${ACTIVE_ITEM_SQL}`,
      [inventory_id]);
    if (!stock) throw missingItem(inventory_id);
    if (stock.quantity_available < quantity_lost) throw insufficient(stock.quantity_available);

    // Baked in only when the item itself was created offline (its insert carries the quantity).
    // An item already in the cloud always gets the delta replayed there (migration 015: quantities
    // are never pushed as absolute numbers any more, so they cannot clash with other branches).
    const itemIsLocalOnly = stock.sync_status === 'pending_insert';
    await sqliteRun(tx,
      itemIsLocalOnly
        ? `UPDATE inventory_items SET quantity_available = quantity_available - ?,
             ${offlineUpdateBookkeeping('inventory_items', ['quantity_available'])} WHERE inventory_id = ?`
        : 'UPDATE inventory_items SET quantity_available = quantity_available - ? WHERE inventory_id = ?',
      [quantity_lost, inventory_id]);

    const cost = financial_cost !== null ? financial_cost : Math.round(stock.unit_cost * quantity_lost * 100) / 100;
    if (print_detail_id) {
      const line = await sqliteGet(tx, 'SELECT 1 AS n FROM order_print_details WHERE print_detail_id = ? AND order_id = ?', [print_detail_id, order_id]);
      if (!line) throw printLineMissing();
    }
    const { production_stage, diagnosis } = await diagnoseLocally(tx, facts);
    await sqliteRun(tx,
      `INSERT INTO material_loss (loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost,
                                  reason_code, loss_category, production_stage, is_statistical_anomaly,
                                  cloud_stock_delta, print_detail_id, sync_status, last_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
      [loss_id, order_id, inventory_id, quantity_lost, loss_reason, cost, reason_code, diagnosis.loss_category, production_stage,
        diagnosis.is_statistical_anomaly ? 1 : 0, itemIsLocalOnly ? 0 : quantity_lost, print_detail_id]);

    const record = await readLocal(tx, 'inventory_items', inventory_id);
    await auditLocal(tx, req.user, inventory_id, 'stock_subtracted', record.item_name, {
      kind: 'loss', quantity: quantity_lost, previous_quantity: stock.quantity_available, new_quantity: record.quantity_available, reason: loss_reason,
      reason_code, loss_category: diagnosis.loss_category, order_id
    });
    // Earlier losses of a cluster are marked in the cloud only (this copy is refreshed from it)
    return { source: 'local', loss: await readLocal(tx, 'material_loss', loss_id), item: record, diagnosis: { ...diagnosis, escalated: [] } };
  });

  try {
    // M7: the inventory item (and the order, if given) must exist
    const item = await locateRecord(req, 'inventory_items', inventory_id);
    if (!item.location) throw missingItem(inventory_id);
    let target = item.location;
    if (order_id) {
      const order = await locateRecord(req, 'order_profiles', order_id);
      if (!order.location) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: `Order ${order_id} does not exist.` });
      // migration 017: waste is recorded on an order once printing has started (before that, a
      // damaged piece is a Stock out: nothing was made for the order yet)
      const { record: lossOrder } = await getRecord(req, 'order_profiles', order_id);
      if (lossOrder && !['Printing', 'Pressing', 'Ready'].includes(lossOrder.production_status)) {
        return res.status(409).json({
          error: 'WASTE_NOT_IN_PRODUCTION',
          message: `This order is ${lossOrder.production_status}. Waste is recorded on an order while it is being printed, pressed or is ready. `
            + 'For a damaged piece before printing, use Stock out.'
        });
      }
      if (order.location === 'local') target = 'local';
    }

    const result = await cloudFirst(target, recordInCloud, recordLocally, 'recording the loss');

    pushStockChange(req, [inventory_id], 'material_loss');
    const { cluster_with, escalated, rule, note, baseline } = result.diagnosis;
    res.status(201).json({
      message: result.source === 'cloud' ? 'Material loss recorded.' : 'Material loss saved locally (Offline Mode).',
      source: result.source,
      loss: shownLoss(result.loss, result.item),
      item: withAvailability(result.item),
      diagnosis: { rule, note, cluster_with, escalated, baseline },
      replacement_warning: replacementWarning(result.item, { forOrder: Boolean(order_id) })
    });
  } catch (err) {
    sendError(res, err, 'recording material loss');
  }
});

// ==========================================
// 2b. ADD / SUBTRACT STOCK: RETIRED (migration 015, adviser consultation November 2026)
// Typing a new quantity by hand left no paper trail. Every change now has a record:
//   stock that arrives            -> Stock in    POST /api/stock/documents { document_type: 'stock_in' }
//   stock that leaves (no order)  -> Stock out   POST /api/stock/documents { document_type: 'stock_out' }
//   the shelf count is different  -> Stock count POST /api/stock/documents { document_type: 'stock_count' }
//   damaged / misprinted stock    -> Record loss POST /api/inventory/:inventory_id/loss (or /losses)
// -> 410 STOCK_ADJUST_RETIRED (older screens show the message)
// ==========================================
router.post('/:inventory_id/adjust', requireRole(EDIT_ROLES), (req, res) => {
  res.status(410).json({
    error: 'STOCK_ADJUST_RETIRED',
    message: 'Add / Subtract stock was replaced. Use Stock in for deliveries, Stock out for stock that leaves without an order, '
      + 'Stock count to correct the count, or Record loss for damaged stock.'
  });
});

// ==========================================
// 2b'. BULK WASTE (migration 015): several materials lost in one go, e.g. a misprinted batch
// POST /api/inventory/losses
// Body: { lines: [{ inventory_id, quantity_lost }] (1-50, one line per item), reason_code? , loss_reason?,
//         order_id?, production_stage is taken from the order }
// One transaction (cloud only, 503 LOSS_BATCH_REQUIRES_CLOUD): every stock row is locked in
// inventory_id order, each loss is diagnosed like a single loss, and all of them share one
// loss_batch_id. Nothing is saved if any line has more than is on hand (409 INSUFFICIENT_STOCK).
// -> 201 { message, loss_batch_id, losses: [shown loss], total_cost }
// ==========================================
const LOSS_LINES_MAX = 50;
router.post('/losses', requireRole(EDIT_ROLES), async (req, res) => {
  const body = req.body || {};
  const v = createValidator();
  const sentCode = v.oneOf(body.reason_code, 'reason_code', REASON_CODE_LIST, { required: false });
  const typedReason = sentCode
    ? v.optionalString(body.loss_reason, 'loss_reason', 1000)
    : v.requiredString(body.loss_reason, 'loss_reason', 1000);
  const order_id = v.id(body.order_id, 'order_id', { required: false });
  const raw = body.lines;
  if (!Array.isArray(raw) || raw.length === 0) v.errors.push({ field: 'lines', message: 'Add at least one material that was wasted.' });
  else if (raw.length > LOSS_LINES_MAX) v.errors.push({ field: 'lines', message: `At most ${LOSS_LINES_MAX} materials at once.` });
  const seen = new Set();
  const lines = (Array.isArray(raw) ? raw : []).slice(0, LOSS_LINES_MAX).map((r, i) => {
    const row = r && typeof r === 'object' ? r : {};
    const lv = createValidator();
    const inventory_id = lv.id(row.inventory_id, 'inventory_id');
    const quantity_lost = lv.positiveInt(row.quantity_lost, 'quantity_lost');
    for (const e of lv.errors) v.errors.push({ field: `lines[${i}].${e.field}`, message: `Line ${i + 1}: ${e.message}` });
    if (inventory_id && seen.has(inventory_id)) {
      v.errors.push({ field: `lines[${i}].inventory_id`, message: `Line ${i + 1}: this material is already on the list.` });
    }
    seen.add(inventory_id);
    return { inventory_id, quantity_lost };
  });
  if (v.failed()) return v.send(res);
  const reason_code = sentCode || inferReasonCode(typedReason);
  const loss_reason = typedReason || reasonLabel(sentCode);
  const loss_batch_id = crypto.randomUUID();
  const ids = lines.map((l) => l.inventory_id).sort();

  try {
    if (order_id) {
      const order = await locateRecord(req, 'order_profiles', order_id);
      if (!order.location) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'We could not find this order.' });
      // migration 017: waste is recorded on an order once printing has started (before that, a
      // damaged piece is a Stock out: nothing was made for the order yet)
      const { record: lossOrder } = await getRecord(req, 'order_profiles', order_id);
      if (lossOrder && !['Printing', 'Pressing', 'Ready'].includes(lossOrder.production_status)) {
        return res.status(409).json({
          error: 'WASTE_NOT_IN_PRODUCTION',
          message: `This order is ${lossOrder.production_status}. Waste is recorded on an order while it is being printed, pressed or is ready. `
            + 'For a damaged piece before printing, use Stock out.'
        });
      }
    }
    const result = await withPgTransaction(req.pgPool, async (client) => {
      const stock = await client.query(
        `SELECT inventory_id, item_name, quantity_available FROM inventory_items
          WHERE inventory_id = ANY($1::text[]) AND ${ACTIVE_ITEM_SQL} ORDER BY inventory_id FOR UPDATE`, [ids]);
      const byId = new Map(stock.rows.map((r) => [r.inventory_id, r]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) throw missingItem(missing[0]);
      const short = lines.filter((l) => byId.get(l.inventory_id).quantity_available < l.quantity_lost);
      if (short.length) {
        throw new Rejected(409, {
          error: 'INSUFFICIENT_STOCK',
          message: `Not enough on hand: ${short.map((l) => `"${byId.get(l.inventory_id).item_name}" has ${byId.get(l.inventory_id).quantity_available}, not ${l.quantity_lost}`).join('; ')}. Nothing was recorded.`
        });
      }
      const reference_no = await orderNumberOf(client, order_id);
      const saved = [];
      for (const l of lines) {
        const loss_id = crypto.randomUUID();
        await setMovementContext(client, {
          type: 'loss', reference_type: 'material_loss', reference_id: loss_id, reference_no, note: loss_reason, actor: req.user
        });
        const item = await client.query(
          `UPDATE inventory_items SET quantity_available = quantity_available - $1
            WHERE inventory_id = $2 RETURNING ${selectList('inventory_items', 'pg')}, unit_cost AS raw_unit_cost`,
          [l.quantity_lost, l.inventory_id]);
        const facts = { inventory_id: l.inventory_id, order_id, reason_code, quantity_lost: l.quantity_lost };
        const { production_stage, diagnosis } = await diagnoseInCloud(client, facts);
        const loss = await client.query(
          `INSERT INTO material_loss (loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost,
                                      reason_code, loss_category, production_stage, is_statistical_anomaly, loss_batch_id)
           VALUES ($1, $2, $3, $4::int, $5, ROUND($6::numeric * $4::int, 2), $7, $8, $9, $10, $11)
           RETURNING ${selectList('material_loss', 'pg')}`,
          [loss_id, order_id, l.inventory_id, l.quantity_lost, loss_reason, item.rows[0].raw_unit_cost,
            reason_code, diagnosis.loss_category, production_stage, diagnosis.is_statistical_anomaly, loss_batch_id]);
        await escalateClusterInCloud(client, diagnosis.cluster_with);
        const record = serialize('inventory_items', item.rows[0]);
        await auditCloud(client, req.user, l.inventory_id, 'stock_subtracted', record.item_name, {
          kind: 'loss', loss_batch_id, quantity: l.quantity_lost, previous_quantity: byId.get(l.inventory_id).quantity_available,
          new_quantity: record.quantity_available, reason: loss_reason, reason_code, loss_category: diagnosis.loss_category, order_id
        });
        saved.push(shownLoss(serialize('material_loss', loss.rows[0]), record));
      }
      await clearMovementContext(client);
      return saved;
    });
    pushStockChange(req, ids, 'material_loss');
    const total = Math.round(result.reduce((s, l) => s + Number(l.financial_cost || 0) * 100, 0)) / 100;
    res.status(201).json({
      message: `${result.length} loss${result.length === 1 ? '' : 'es'} recorded together.`,
      source: 'cloud',
      loss_batch_id,
      losses: result,
      total_cost: total
    });
  } catch (err) {
    if (isConnectionError(err) && !err.commitUnknown) {
      return res.status(503).json({
        error: 'LOSS_BATCH_REQUIRES_CLOUD',
        message: 'Recording several losses at once needs the cloud connection. Record them one by one while offline, or try again when online.'
      });
    }
    sendError(res, err, 'recording losses');
  }
});

// ==========================================
// 2c. USAGE RATES OF A BLANK (PB 15: what one piece uses of each consumable, and when)
// GET /api/inventory/:inventory_id/consumable-rates   (every role)
//   -> { source, product: { inventory_id, item_name, unit }, rates: [{ rate_id, consumable_inventory_id,
//        consumable_name, consumable_unit, consumable_in_recycle_bin, quantity_per_piece, trigger_status,
//        version }], consumable_options: [{ inventory_id, item_name, unit, item_category }],
//        triggers: ['Pressing', 'Completed'], can_edit }
// PUT /api/inventory/:inventory_id/consumable-rates   (edit_inventory)
//   Body: { rates: [{ consumable_inventory_id, quantity_per_piece, trigger_status }] }  (replaces the list; [] clears it)
//   quantity_per_piece > 0 with up to 3 decimals; trigger_status 'Pressing' (default) or 'Completed'.
//   One transaction: the blank is locked, every consumable must be an active catalog item, the old
//   list is replaced and the change is written to the inventory trail (before / after).
//   Needs the cloud (503 RATES_REQUIRE_CLOUD): the rates decide what every branch takes from stock.
//   -> 200 { message, source: 'cloud', rates }
// ==========================================
const ratesRequireCloud = () => new Rejected(503, {
  error: 'RATES_REQUIRE_CLOUD',
  message: 'Changing usage rates needs the cloud connection, because every branch uses them. Nothing was changed. Try again when online.'
});

router.get('/:inventory_id/consumable-rates', requireRole(READ_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  try {
    const { source, record: product } = await getRecord(req, 'inventory_items', inventory_id);
    if (!product) throw missingItem(inventory_id);
    const view = await loadRates(req, inventory_id);
    const options = await listRecords(req, 'inventory_items', { where: ACTIVE_ITEM_SQL, orderBy: 'item_name, inventory_id' });
    res.status(200).json({
      source: [source, view.source, options.source].includes('local') ? 'local' : 'cloud',
      product: { inventory_id: product.inventory_id, item_name: product.item_name, unit: product.unit },
      rates: view.rates,
      consumable_options: options.records
        .filter((i) => i.inventory_id !== inventory_id)
        .map((i) => ({ inventory_id: i.inventory_id, item_name: i.item_name, unit: i.unit, item_category: i.item_category })),
      triggers: CONSUMABLE_TRIGGERS,
      can_edit: can(req.user.role, 'edit_inventory')
    });
  } catch (err) {
    sendError(res, err, 'reading usage rates');
  }
});

router.put('/:inventory_id/consumable-rates', requireRole(EDIT_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  const checked = checkRateList((req.body || {}).rates, inventory_id, ID_PATTERN);
  if (checked.errors.length > 0) {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: checked.errors[0].message, details: checked.errors });
  }
  const rates = checked.rates.map((r) => ({ ...r, rate_id: crypto.randomUUID() }));
  const consumableIds = [...new Set(rates.map((r) => r.consumable_inventory_id))];
  const listOf = (rows) => rows.map((r) => ({
    consumable_inventory_id: r.consumable_inventory_id, quantity_per_piece: Number(r.quantity_per_piece), trigger_status: r.trigger_status
  }));

  try {
    const located = await locateRecord(req, 'inventory_items', inventory_id);
    if (!located.location) throw missingItem(inventory_id);
    if (located.location === 'local') {
      if (!located.cloudReachable) throw ratesRequireCloud();
      throw new Rejected(409, { error: 'ITEM_NOT_SYNCED', message: 'This item was added offline and is not in the cloud yet. Sync, then set its usage rates.' });
    }

    const result = await withPgTransaction(req.pgPool, async (client) => {
      const product = await lockCloudItem(client, inventory_id);
      if (!product) throw missingItem(inventory_id);
      const found = consumableIds.length === 0 ? { rows: [] } : await client.query(
        `SELECT inventory_id FROM inventory_items WHERE inventory_id = ANY($1::text[]) AND ${ACTIVE_ITEM_SQL}`, [consumableIds]);
      const present = new Set(found.rows.map((r) => r.inventory_id));
      const missing = consumableIds.filter((id) => !present.has(id));
      if (missing.length > 0) {
        throw new Rejected(404, {
          error: 'INVENTORY_ITEM_NOT_FOUND',
          message: 'One or more chosen consumables are no longer in the catalog (they may have been deleted). Choose them again.',
          missing_inventory_ids: missing
        });
      }
      const before = await client.query(
        `SELECT consumable_inventory_id, quantity_per_piece::text AS quantity_per_piece, trigger_status
           FROM consumable_rates WHERE product_inventory_id = $1 ORDER BY trigger_status, consumable_inventory_id`, [inventory_id]);
      await client.query('DELETE FROM consumable_rates WHERE product_inventory_id = $1', [inventory_id]);
      if (rates.length > 0) {
        await client.query(
          `INSERT INTO consumable_rates (rate_id, product_inventory_id, consumable_inventory_id, quantity_per_piece, trigger_status)
           SELECT r.rate_id, $1::text, r.consumable_inventory_id, r.quantity_per_piece, r.trigger_status
             FROM unnest($2::text[], $3::text[], $4::numeric[], $5::text[]) AS r(rate_id, consumable_inventory_id, quantity_per_piece, trigger_status)`,
          [inventory_id, rates.map((r) => r.rate_id), rates.map((r) => r.consumable_inventory_id),
            rates.map((r) => r.quantity_per_piece), rates.map((r) => r.trigger_status)]);
      }
      await auditCloud(client, req.user, inventory_id, 'edited', product.item_name, {
        kind: 'consumable_rates', before: listOf(before.rows), after: listOf(rates)
      });
      return { product };
    });

    // This computer's copy follows at once (the next sync would do it too)
    try {
      await sqliteRun(req.localDb, "DELETE FROM consumable_rates WHERE product_inventory_id = ? AND sync_status = 'synced'", [inventory_id]);
      if (rates.length > 0) await refreshLocalRows(req.pgPool, req.localDb, 'consumable_rates', rates.map((r) => r.rate_id));
    } catch (copyErr) {
      console.error('⚠️ Could not copy the new usage rates to this computer (the next sync will):', copyErr.message);
    }

    const view = await loadRates(req, inventory_id);
    console.log(`🧪 Usage rates of ${inventory_id} set by ${req.user.user_id} (${rates.length} rate(s))`);
    res.status(200).json({
      message: rates.length === 0
        ? `"${result.product.item_name}" no longer uses any consumables.`
        : `Usage rates saved for "${result.product.item_name}".`,
      source: 'cloud',
      rates: view.rates
    });
  } catch (err) {
    if (!(err instanceof Rejected) && isConnectionError(err)) {
      return sendError(res, err.commitUnknown
        ? new Rejected(503, { error: 'COMMIT_UNKNOWN', message: 'Connection to the cloud dropped while saving. Reload the usage rates before retrying.' })
        : ratesRequireCloud(), 'saving usage rates');
    }
    sendError(res, err, 'saving usage rates');
  }
});

// ==========================================
// 3. INVENTORY CAPACITY PRE-CHECK (PB 9)
// Body: { required_items: [{ inventory_id, quantity_needed }] }
// 200 -> can fulfill | 409 -> halted (shortages) | 404 -> unknown item | 400 -> bad payload
// ==========================================
router.post('/check-capacity', requireRole(READ_ROLES), async (req, res) => {
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

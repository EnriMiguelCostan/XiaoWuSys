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
  selectList, serialize, locateRecord, readLocal, listRecords, countRecords,
  withPgTransaction, withLocalTransaction, sqliteGet, sqliteRun,
  ACTIVE_ITEM_SQL, BIN_ITEM_SQL
} = require('../services/records');
const { STOCK_STATUSES, withAvailability, buildInventorySnapshot } = require('../services/inventorySnapshot');
const { snapshotOf, auditCloud, auditLocal } = require('../services/inventoryAudit');
const { purgeInCloud, applyPurgeLocally, purgeBatches, RETENTION_DAYS } = require('../services/recycleBin');

// Who may do what (role always comes from the JWT)
const READ_ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
const EDIT_ROLES = ['Owner', 'Admin', 'Production'];   // add, edit, stock changes, move to / restore from bin
const PURGE_ROLES = ['Owner', 'Admin'];                // permanent delete / empty bin

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
  if (v.failed()) return v.send(res);

  const item_name = cleanName(rawName);
  const inventory_id = crypto.randomUUID();
  const values = [inventory_id, item_name, cleanName(item_category), quantity_available, minimum_threshold, unit_cost];

  try {
    const result = await cloudFirst('cloud',
      () => withPgTransaction(req.pgPool, async (client) => {
        const dup = (await findDuplicateCloud(client, item_name))
          || (await findDuplicateLocal(req.localDb, item_name, { pendingOnly: true }).catch(() => null));
        if (dup) throw duplicateError(dup);
        const { rows } = await client.query(
          `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${selectList('inventory_items', 'pg')}`,
          values
        );
        const record = serialize('inventory_items', rows[0]);
        await auditCloud(client, req.user, inventory_id, 'created', item_name, { item: snapshotOf(record) });
        return { source: 'cloud', record };
      }),
      () => withLocalTransaction(req.localDbPath, async (tx) => {
        const dup = await findDuplicateLocal(tx, item_name);
        if (dup) throw duplicateError(dup);
        await sqliteRun(tx,
          `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost, sync_status, last_modified)
           VALUES (?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`,
          values);
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
// Body (any of): { item_name, item_category, minimum_threshold, unit_cost, expected_version? }
// Quantities are changed through /adjust and /loss so every stock movement is traceable.
// -> 200 { message, source, changed, item }
//    404 not found / in bin | 409 DUPLICATE_ITEM | 409 EDIT_CONFLICT (someone else edited it first)
// ==========================================
const EDITABLE_FIELDS = ['item_name', 'item_category', 'minimum_threshold', 'unit_cost'];

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
  if (body.expected_version !== undefined && body.expected_version !== null && typeof body.expected_version !== 'string') {
    v.errors.push({ field: 'expected_version', message: 'expected_version must be the string returned as "version".' });
  }
  if (Object.keys(updates).length === 0 && !v.failed()) {
    v.errors.push({ field: 'body', message: `Send at least one of: ${EDITABLE_FIELDS.join(', ')}.` });
  }
  if (v.failed()) return v.send(res);
  if (updates.item_name) updates.item_name = cleanName(updates.item_name);
  if (updates.item_category) updates.item_category = cleanName(updates.item_category);
  const expected_version = body.expected_version || null;

  const diff = (current) => Object.keys(updates).filter((f) => updates[f] !== current[f]);
  const changesOf = (current, fields) => ({
    before: Object.fromEntries(fields.map((f) => [f, current[f]])),
    after: Object.fromEntries(fields.map((f) => [f, updates[f]]))
  });

  try {
    const located = await locateRecord(req, 'inventory_items', inventory_id);
    if (!located.location) throw missingItem(inventory_id);

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
          [...fields.map((f) => updates[f]), inventory_id]);
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
// 2. RECORD MATERIAL LOSS (Audit fix M9)
// Body: { quantity_lost, loss_reason, order_id?, financial_cost? }
// The loss record and the stock reduction are written in ONE transaction, so they either
// both happen or neither does. financial_cost defaults to unit_cost x quantity_lost.
// -> 201 { message, source, loss, item }
//    404 INVENTORY_ITEM_NOT_FOUND / ORDER_NOT_FOUND
//    409 INSUFFICIENT_STOCK when the loss is larger than the stock on hand
// ==========================================
router.post('/:inventory_id/loss', requireRole(EDIT_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  const body = req.body || {};

  const v = createValidator();
  const quantity_lost = v.positiveInt(body.quantity_lost, 'quantity_lost');
  const loss_reason = v.requiredString(body.loss_reason, 'loss_reason', 1000);
  const order_id = v.id(body.order_id, 'order_id', { required: false });
  const financial_cost = v.nonNegativeMoney(body.financial_cost, 'financial_cost', { required: false, defaultValue: null });
  if (v.failed()) return v.send(res);

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
      `SELECT quantity_available, unit_cost, sync_status FROM inventory_items WHERE inventory_id = ? AND ${ACTIVE_ITEM_SQL}`,
      [inventory_id]);
    if (!stock) throw missingItem(inventory_id);
    if (stock.quantity_available < quantity_lost) throw insufficient(stock.quantity_available);

    // Also bake it in when the item already has unsynced offline edits (e.g. a manual
    // adjustment): sync pushes the item's absolute quantity, so a replayed delta would double-count.
    const itemIsLocalOnly = stock.sync_status !== 'synced';
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
    if (!item.location) throw missingItem(inventory_id);
    let target = item.location;
    if (order_id) {
      const order = await locateRecord(req, 'order_profiles', order_id);
      if (!order.location) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: `Order ${order_id} does not exist.` });
      if (order.location === 'local') target = 'local';
    }

    const result = await cloudFirst(target, recordInCloud, recordLocally, 'recording the loss');

    pushStockChange(req, [inventory_id], 'material_loss');
    res.status(201).json({
      message: result.source === 'cloud' ? 'Material loss recorded.' : 'Material loss saved locally (Offline Mode).',
      source: result.source,
      loss: result.loss,
      item: withAvailability(result.item)
    });
  } catch (err) {
    sendError(res, err, 'recording material loss');
  }
});

// ==========================================
// 2b. MANUAL STOCK ADJUSTMENT (Manage Stock panel)
// Body: { action: 'add' | 'subtract', quantity, reason? }
// Adds delivered stock or removes stock that was taken out by hand. Lost/damaged stock
// should go through /loss instead, so its cost is recorded.
// -> 200 { message, source, previous_quantity, item }
//    404 INVENTORY_ITEM_NOT_FOUND | 409 INSUFFICIENT_STOCK | 503 COMMIT_UNKNOWN
// ==========================================
router.post('/:inventory_id/adjust', requireRole(EDIT_ROLES), async (req, res) => {
  const { inventory_id } = req.params;
  const body = req.body || {};

  const v = createValidator();
  const action = v.oneOf(body.action, 'action', ['add', 'subtract']);
  const quantity = v.positiveInt(body.quantity, 'quantity');
  const reason = v.optionalString(body.reason, 'reason', 255);
  if (v.failed()) return v.send(res);

  const delta = action === 'add' ? quantity : -quantity;
  const auditAction = action === 'add' ? 'stock_added' : 'stock_subtracted';
  const insufficient = (available) => new Rejected(409, {
    error: 'INSUFFICIENT_STOCK',
    message: `Cannot subtract ${quantity}: only ${available} in stock.`,
    quantity_available: available,
    quantity_requested: quantity
  });
  const auditDetails = (previous, item) => ({ quantity, previous_quantity: previous, new_quantity: item.quantity_available, reason });

  // ---- Online: lock the row, apply the change with a SQL guard so stock never goes negative ----
  const adjustInCloud = () => withPgTransaction(req.pgPool, async (client) => {
    const current = await lockCloudItem(client, inventory_id);
    if (!current) throw missingItem(inventory_id);
    const previous = current.quantity_available;
    if (previous + delta < 0) throw insufficient(previous);

    const item = await client.query(
      `UPDATE inventory_items SET quantity_available = quantity_available + $1, last_modified = NOW()
        WHERE inventory_id = $2 AND quantity_available + $1 >= 0
        RETURNING ${selectList('inventory_items', 'pg')}`,
      [delta, inventory_id]
    );
    if (item.rowCount !== 1) throw insufficient(previous);
    const record = serialize('inventory_items', item.rows[0]);
    await auditCloud(client, req.user, inventory_id, auditAction, current.item_name, auditDetails(previous, record));
    return { source: 'cloud', previous, item: record };
  });

  // ---- Offline: same change on a dedicated SQLite connection ----
  // The new absolute quantity is pushed on sync (pending_update + optimistic version check),
  // so a concurrent cloud edit becomes a sync conflict instead of being overwritten.
  // Any offline losses for this item are already included in that absolute value, so their
  // cloud_stock_delta is cleared to avoid subtracting them twice in Neon.
  const adjustLocally = () => withLocalTransaction(req.localDbPath, async (tx) => {
    const current = await readLocalItem(tx, inventory_id);
    if (!current) throw missingItem(inventory_id);
    const previous = current.quantity_available;
    if (previous + delta < 0) throw insufficient(previous);

    await sqliteRun(tx,
      `UPDATE inventory_items SET quantity_available = quantity_available + ?,
         ${offlineUpdateBookkeeping('inventory_items', ['quantity_available'])} WHERE inventory_id = ?`,
      [delta, inventory_id]);
    await sqliteRun(tx,
      `UPDATE material_loss SET cloud_stock_delta = 0
        WHERE inventory_id = ? AND sync_status = 'pending_insert' AND cloud_stock_delta > 0`,
      [inventory_id]);

    const record = await readLocal(tx, 'inventory_items', inventory_id);
    await auditLocal(tx, req.user, inventory_id, auditAction, current.item_name, auditDetails(previous, record));
    return { source: 'local', previous, item: record };
  });

  try {
    const located = await locateRecord(req, 'inventory_items', inventory_id);
    if (!located.location) throw missingItem(inventory_id);

    const result = await cloudFirst(located.location, adjustInCloud, adjustLocally, 'saving the stock change');

    console.log(`📦 Stock ${action} ${quantity} on ${inventory_id} by ${req.user.user_id} (${req.user.role})` +
                `${reason ? `: ${reason}` : ''} [${result.source}]`);
    pushStockChange(req, [inventory_id], `stock_${action}`);
    res.status(200).json({
      message: result.source === 'cloud'
        ? `Stock ${action === 'add' ? 'added' : 'subtracted'}.`
        : `Stock ${action === 'add' ? 'added' : 'subtracted'} locally (Offline Mode).`,
      source: result.source,
      previous_quantity: result.previous,
      item: withAvailability(result.item)
    });
  } catch (err) {
    sendError(res, err, 'adjusting stock');
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

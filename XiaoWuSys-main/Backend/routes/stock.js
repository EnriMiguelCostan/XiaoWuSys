// ==========================================
// STOCK IN / STOCK OUT / STOCK COUNT AND THE STOCK CARD (migration 015)
//
// GET  /api/stock/options                     the lists the forms offer (kinds of paper, stock-out reasons...)
// GET  /api/stock/documents?type=&supplier_id=&inventory_id=&search=&from=&to=&limit=&offset=
//      -> { documents: [{ ...document, supplier_name, recorded_by_name, line_count, total_quantity,
//           label, allowed_actions }], total, limit, offset }
// GET  /api/stock/documents/:document_id      -> { document, lines, supplier, allowed_actions, history }
// POST /api/stock/documents                   record one (201)
//      Body: { document_type: 'stock_in' | 'stock_out' | 'stock_count', occurred_at: 'YYYY-MM-DDTHH:MM' (shop time),
//              supplier_id?, reference_type?, reference_no?, reason?, order_id?, notes?,
//              lines: [{ inventory_id, quantity, unit_cost? } | { inventory_id, counted_quantity }] }
//        stock_in:    supplier, kind of paper and its number (unless "No paper") are required;
//                     each line's cost sets the item's new average unit cost.
//        stock_out:   a reason is required (the supplier too when returning to one; a note for "Other").
//                     Only free stock (on hand - held for orders) can go out.
//        stock_count: the counted quantity becomes the system quantity (never below what orders hold).
// PUT  /api/stock/documents/:document_id      correct a stock in / stock out (same body; the
//      stock moves by the difference only). Body may carry expected_version.
// POST /api/stock/documents/:document_id/void { reason }   Owner / Admin; reverses the stock
// GET  /api/stock/movements?inventory_id=&movement_type=&from=&to=&limit=&offset=
//      -> { movements: [{ ...movement, label, performed_by_name }], total, item }   the stock card
//
// Every write is ONE transaction on the cloud database: the stock rows are locked FOR UPDATE in
// inventory_id order (no deadlocks), the rules run on the locked rows, and the stock card rows
// are written by the database trigger with this document's number. Online only (503
// STOCK_REQUIRES_CLOUD): stock shared by every branch is never moved from an offline copy.
// ==========================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { createValidator, shopTimeToUtc } = require('../utils/validation');
const { selectList, serialize, userNames, withPgTransaction, ACTIVE_ITEM_SQL } = require('../services/records');
const { rolesWith, can } = require('../services/domain/permissions');
const { withAvailability } = require('../services/inventorySnapshot');
const { writeAudit } = require('../services/auditLog');
const { setMovementContext, clearMovementContext } = require('../services/stockMovements');
const { refreshLocalRows } = require('../services/sync');
const D = require('../services/domain/stockDocuments');

const READ_ROLES = rolesWith('view_stock');
const CAP_FOR_TYPE = { stock_in: 'receive_stock', stock_out: 'issue_stock', stock_count: 'count_stock' };
const WRITE_ROLES = [...new Set([...rolesWith('receive_stock'), ...rolesWith('issue_stock'), ...rolesWith('count_stock')])];

class Rejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const NEEDS_CLOUD = {
  error: 'STOCK_REQUIRES_CLOUD',
  message: 'Stock in, stock out and counts need the cloud connection, so every branch sees the same stock. Nothing was saved. Try again when online.'
};
const READ_NEEDS_CLOUD = {
  error: 'STOCK_HISTORY_REQUIRES_CLOUD',
  message: 'The stock records are kept in the cloud. Connect to the internet to see them.'
};
const COMMIT_UNKNOWN = {
  error: 'COMMIT_UNKNOWN',
  message: 'The connection dropped while saving. Reload the list to see whether it was recorded before trying again.'
};
const pushStockChange = (req, ids, reason) => {
  if (req.inventoryEvents && ids.length > 0) req.inventoryEvents.notifyChanged(ids, reason);
};
const sendError = (res, err, context, cloudBody = NEEDS_CLOUD) => {
  if (err instanceof Rejected) return res.status(err.status).json(err.body);
  if (isConnectionError(err)) return res.status(503).json(err.commitUnknown ? COMMIT_UNKNOWN : cloudBody);
  return sendDbError(res, err, context);
};

router.use(verifyToken);

router.param('document_id', (req, res, next, value) => {
  const v = createValidator();
  v.id(value, 'document_id');
  if (v.failed()) return v.send(res);
  next();
});

// ---------- Options (the server decides what the forms offer) ----------
router.get('/options', requireRole(READ_ROLES), (req, res) => {
  res.status(200).json({
    document_types: D.DOCUMENT_TYPES.map((value) => ({ value, label: D.DOCUMENT_LABELS[value], prefix: D.DOCUMENT_PREFIX[value] })),
    reference_types: D.REFERENCE_TYPES,
    stock_out_reasons: D.STOCK_OUT_REASONS,
    note_required_reasons: D.NOTE_REQUIRED_REASONS,
    movement_types: D.MOVEMENT_TYPES.map((value) => ({ value, label: D.MOVEMENT_LABELS[value] })),
    lines_max: D.LINES_MAX,
    can_record: Object.fromEntries(D.DOCUMENT_TYPES.map((t) => [t, can(req.user.role, CAP_FOR_TYPE[t])])),
    can_void: can(req.user.role, 'void_stock_document')
  });
});

// ---------- Reading ----------
// A shop day 'YYYY-MM-DD' -> the UTC start of that day (and of the next one), for date filters
const dayStartUtc = (ymd) => shopTimeToUtc(`${ymd}T00:00:00`).toISOString().slice(0, 19).replace('T', ' ');
const nextDay = (ymd) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const shownDocument = (doc, extra, role) => ({
  ...doc,
  label: D.DOCUMENT_LABELS[doc.document_type],
  status: doc.voided_at ? 'Voided' : doc.edited_at ? 'Corrected' : 'Recorded',
  ...extra,
  allowed_actions: D.documentActions(doc, role, can)
});

router.get('/documents', requireRole(READ_ROLES), async (req, res) => {
  const v = createValidator();
  const type = v.oneOf(req.query.type, 'document_type', D.DOCUMENT_TYPES, { required: false });
  const supplier_id = v.id(req.query.supplier_id, 'supplier_id', { required: false });
  const inventory_id = v.id(req.query.inventory_id, 'inventory_id', { required: false });
  const search = v.optionalString(req.query.search, 'search', 100);
  const from = v.shopDay(req.query.from, 'from', { required: false });
  const to = v.shopDay(req.query.to, 'to', { required: false });
  const { limit, offset } = v.pagination(req.query);
  if (v.failed()) return v.send(res);

  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (type) add('d.document_type = ?', type);
  if (supplier_id) add('d.supplier_id = ?', supplier_id);
  if (inventory_id) add('EXISTS (SELECT 1 FROM stock_document_lines l2 WHERE l2.document_id = d.document_id AND l2.inventory_id = ?)', inventory_id);
  if (search) {
    params.push(`%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const n = params.length;
    where.push(`(d.document_no ILIKE $${n} OR d.reference_no ILIKE $${n} OR s.supplier_name ILIKE $${n})`);
  }
  if (from) add('d.occurred_at >= ?::timestamp', dayStartUtc(from));
  if (to) add('d.occurred_at < ?::timestamp', dayStartUtc(nextDay(to)));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const [list, count] = await Promise.all([
      req.pgPool.query(
        `SELECT ${selectList('stock_documents', 'pg', 'd')}, s.supplier_name,
                (SELECT COUNT(*)::int FROM stock_document_lines l WHERE l.document_id = d.document_id) AS line_count,
                (SELECT COALESCE(SUM(l.quantity), 0)::int FROM stock_document_lines l WHERE l.document_id = d.document_id) AS total_quantity
           FROM stock_documents d LEFT JOIN suppliers s ON s.supplier_id = d.supplier_id
           ${whereSql}
          ORDER BY d.occurred_at DESC, d.created_at DESC, d.document_id
          LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params),
      req.pgPool.query(
        `SELECT COUNT(*)::int AS n FROM stock_documents d LEFT JOIN suppliers s ON s.supplier_id = d.supplier_id ${whereSql}`, params)
    ]);
    const docs = list.rows.map((r) => ({ row: r, doc: serialize('stock_documents', r) }));
    const names = await userNames(req, docs.map((d) => d.doc.recorded_by));
    res.status(200).json({
      source: 'cloud',
      documents: docs.map(({ row, doc }) => shownDocument(doc, {
        supplier_name: row.supplier_name || null,
        recorded_by_name: (doc.recorded_by && names.get(doc.recorded_by)) || 'Not recorded',
        line_count: row.line_count,
        total_quantity: row.total_quantity
      }, req.user.role)),
      total: count.rows[0].n,
      limit,
      offset
    });
  } catch (err) {
    sendError(res, err, 'listing stock records', READ_NEEDS_CLOUD);
  }
});

// One document with its lines, its supplier and its trail (who corrected or voided it)
const loadDocument = async (db, document_id, { lock = false } = {}) => {
  const { rows } = await db.query(
    `SELECT ${selectList('stock_documents', 'pg')} FROM stock_documents WHERE document_id = $1${lock ? ' FOR UPDATE' : ''}`, [document_id]);
  if (rows.length === 0) return null;
  const lines = await db.query(
    `SELECT ${selectList('stock_document_lines', 'pg')} FROM stock_document_lines WHERE document_id = $1 ORDER BY line_no, line_id`,
    [document_id]);
  return { document: serialize('stock_documents', rows[0]), lines: lines.rows.map((r) => serialize('stock_document_lines', r)) };
};

const notFound = () => new Rejected(404, {
  error: 'STOCK_DOCUMENT_NOT_FOUND', message: 'We could not find this stock record. Refresh the list.'
});

router.get('/documents/:document_id', requireRole(READ_ROLES), async (req, res) => {
  try {
    const found = await loadDocument(req.pgPool, req.params.document_id);
    if (!found) throw notFound();
    const { document, lines } = found;
    const supplier = document.supplier_id
      ? serialize('suppliers', (await req.pgPool.query(`SELECT ${selectList('suppliers', 'pg')} FROM suppliers WHERE supplier_id = $1`,
        [document.supplier_id])).rows[0])
      : null;
    const trail = await req.pgPool.query(
      `SELECT action, details, performed_by, performed_role, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
         FROM audit_log WHERE entity = 'stock_documents' AND entity_id = $1 ORDER BY created_at`, [document.document_id]);
    const names = await userNames(req, [document.recorded_by, document.edited_by, document.voided_by, ...trail.rows.map((t) => t.performed_by)]);
    const nameOf = (id) => (id && names.get(id)) || 'Not recorded';
    res.status(200).json({
      source: 'cloud',
      document: shownDocument(document, {
        supplier_name: supplier ? supplier.supplier_name : null,
        recorded_by_name: nameOf(document.recorded_by),
        edited_by_name: document.edited_by ? nameOf(document.edited_by) : null,
        voided_by_name: document.voided_by ? nameOf(document.voided_by) : null,
        line_count: lines.length,
        total_quantity: lines.reduce((s, l) => s + l.quantity, 0)
      }, req.user.role),
      lines: lines.map((l) => ({
        ...l,
        line_total: Math.round(l.quantity * l.unit_cost * 100) / 100,
        difference: l.system_quantity === null ? null : l.quantity - l.system_quantity
      })),
      supplier,
      history: trail.rows.map((t) => ({
        action: t.action === 'stock_document_voided' ? 'Voided' : 'Corrected',
        by_name: nameOf(t.performed_by),
        role: t.performed_role,
        at: t.created_at,
        reason: (() => { try { return JSON.parse(t.details || '{}').reason || null; } catch { return null; } })()
      }))
    });
  } catch (err) {
    sendError(res, err, 'reading a stock record', READ_NEEDS_CLOUD);
  }
});

// ---------- Writing ----------
// The header of a document from the body -> { v, header }
const readHeader = (body, type) => {
  const v = createValidator();
  const occurred_at = v.pastShopDateTime(body.occurred_at, 'occurred_at');
  const supplier_id = v.id(body.supplier_id, 'supplier_id', { required: false });
  const reference_type = v.oneOf(body.reference_type, 'reference_type', D.REFERENCE_TYPES, { required: type === 'stock_in' });
  const reference_no = v.optionalString(body.reference_no, 'reference_no', D.REFERENCE_NO_MAX);
  const reason = v.oneOf(body.reason, 'reason', D.STOCK_OUT_REASONS, { required: type === 'stock_out' });
  const order_id = v.id(body.order_id, 'order_id', { required: false });
  const notes = v.optionalString(body.notes, 'notes', D.NOTES_MAX);
  if (type === 'stock_in') {
    if (!supplier_id && !v.errors.some((e) => e.field === 'supplier_id')) {
      v.errors.push({ field: 'supplier_id', message: 'Supplier is required. Choose who delivered it (add the store as a supplier if you bought it there).' });
    }
    if (reference_type && reference_type !== 'No paper' && !reference_no) {
      v.errors.push({ field: 'reference_no', message: `Reference number is required: type the number printed on the ${reference_type.toLowerCase()}.` });
    }
  }
  if (type === 'stock_out') {
    if (reason === 'Returned to supplier' && !supplier_id) {
      v.errors.push({ field: 'supplier_id', message: 'Supplier is required when stock is returned to a supplier.' });
    }
    if (D.NOTE_REQUIRED_REASONS.includes(reason) && !notes) {
      v.errors.push({ field: 'notes', message: 'Notes are required: write what happened to the stock.' });
    }
  }
  return {
    v,
    header: {
      occurred_at, supplier_id: supplier_id || null, reference_type: type === 'stock_in' ? reference_type : (reference_type || null),
      reference_no: reference_type === 'No paper' ? null : (reference_no || null), reason: type === 'stock_out' ? reason : (type === 'stock_in' ? 'Purchase' : null),
      order_id: order_id || null, notes: notes || null
    }
  };
};

// Locks every stock row involved (inventory_id order) -> Map id -> row
const lockItems = async (client, ids, { activeOnly = true } = {}) => {
  if (ids.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT inventory_id, item_name, unit, quantity_available, quantity_reserved, unit_cost::text AS unit_cost, supplier_id,
            deleted_at, purged_at
       FROM inventory_items WHERE inventory_id = ANY($1::text[]) ${activeOnly ? `AND ${ACTIVE_ITEM_SQL}` : ''}
      ORDER BY inventory_id FOR UPDATE`, [[...new Set(ids)].sort()]);
  return new Map(rows.map((r) => [r.inventory_id, r]));
};

const missingItems = (ids, items) => {
  const missing = ids.filter((id) => !items.has(id));
  if (missing.length === 0) return null;
  return new Rejected(404, {
    error: 'INVENTORY_ITEM_NOT_FOUND',
    message: 'One or more items are no longer in the catalog (they may be in the Recycle Bin). Choose them again.',
    missing_inventory_ids: missing
  });
};

const notEnoughFree = (problems, what) => new Rejected(409, {
  error: 'INSUFFICIENT_FREE_STOCK',
  message: `${what} ${problems.map((p) => `"${p.item_name}" needs ${p.needed} but only ${p.free} is free (the rest is on hand but held for orders, or already used)`).join('; ')}.`,
  shortages: problems
});

const checkSupplier = async (client, supplier_id) => {
  if (!supplier_id) return null;
  const { rows } = await client.query('SELECT supplier_id, supplier_name, archived_at FROM suppliers WHERE supplier_id = $1 FOR SHARE', [supplier_id]);
  if (rows.length === 0) throw new Rejected(404, { error: 'SUPPLIER_NOT_FOUND', message: 'We could not find this supplier. Choose it again.' });
  if (rows[0].archived_at) {
    throw new Rejected(409, { error: 'SUPPLIER_ARCHIVED', message: `${rows[0].supplier_name} is archived. Restore the supplier first, or choose another one.` });
  }
  return rows[0];
};

// Applies planned changes to the locked rows, each with its stock card context
//   linesById: the document's (new) lines per item, for the cost shown on the card
const applyChanges = async (client, req, { changes, movementType, doc, setCost, linesById, supplier }) => {
  const changed = [];
  for (const c of changes) {
    if (c.delta === 0 && !setCost) continue;
    const line = linesById.get(c.inventory_id);
    await setMovementContext(client, {
      type: movementType, reference_type: 'stock_document', reference_id: doc.document_id, reference_no: doc.document_no,
      note: doc.reference_no ? `${doc.reference_type || 'Ref.'} ${doc.reference_no}` : (doc.reason || doc.notes),
      actor: req.user, occurred_at: doc.occurred_at, unit_cost: line ? line.unit_cost : null
    });
    const updated = await client.query(
      `UPDATE inventory_items
          SET quantity_available = quantity_available + $2::int
              ${setCost ? ', unit_cost = $3::numeric' : ''}
              ${supplier ? `, supplier_id = COALESCE(supplier_id, $${setCost ? 4 : 3}::text),
                           supplier = CASE WHEN supplier_id IS NULL THEN $${setCost ? 5 : 4}::text ELSE supplier END` : ''}
        WHERE inventory_id = $1 AND quantity_available + $2::int >= quantity_reserved`,
      [c.inventory_id, c.delta, ...(setCost ? [c.new_unit_cost] : []), ...(supplier ? [supplier.supplier_id, supplier.supplier_name] : [])]);
    if (updated.rowCount !== 1) throw new Error(`stock row ${c.inventory_id} changed while locked`);
    if (c.delta !== 0) changed.push(c.inventory_id);
  }
  await clearMovementContext(client);
  return changed;
};

const insertLines = async (client, document_id, lines, items) => {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const item = items.get(l.inventory_id);
    await client.query(
      `INSERT INTO stock_document_lines (line_id, document_id, line_no, inventory_id, item_name, unit, quantity, system_quantity, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [crypto.randomUUID(), document_id, i + 1, l.inventory_id, item ? item.item_name : null, item ? item.unit : null,
        l.quantity, l.system_quantity === undefined ? null : l.system_quantity, l.unit_cost]);
  }
};

router.post('/documents', requireRole(WRITE_ROLES), async (req, res) => {
  const body = req.body || {};
  const tv = createValidator();
  const type = tv.oneOf(body.document_type, 'document_type', D.DOCUMENT_TYPES);
  if (tv.failed()) return tv.send(res);
  if (!can(req.user.role, CAP_FOR_TYPE[type])) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: type === 'stock_count' ? 'Only the Owner or an Admin can record a stock count.' : 'Your account cannot record this.'
    });
  }
  const { v, header } = readHeader(body, type);
  const checked = D.checkLines(type, body.lines);
  v.errors.push(...checked.errors);
  if (v.failed()) return v.send(res);
  const ids = checked.lines.map((l) => l.inventory_id);
  const document_id = crypto.randomUUID();

  try {
    const result = await withPgTransaction(req.pgPool, async (client) => {
      const supplier = await checkSupplier(client, header.supplier_id);
      const items = await lockItems(client, ids);
      const missing = missingItems(ids, items);
      if (missing) throw missing;

      let lines;
      let changes;
      if (type === 'stock_count') {
        const counted = D.countResult(checked.lines, items);
        if (counted.problems.length) {
          throw new Rejected(409, {
            error: 'COUNT_BELOW_RESERVED',
            message: counted.problems.map((p) => `"${p.item_name}" was counted at ${p.counted}, but open orders hold ${p.reserved}`).join('; ')
              + '. Count again, or delay / cancel those orders first.',
            problems: counted.problems
          });
        }
        lines = counted.lines.map((l) => ({ inventory_id: l.inventory_id, quantity: l.counted_quantity, system_quantity: l.system_quantity, unit_cost: l.unit_cost }));
        changes = counted.lines.map((l) => ({ inventory_id: l.inventory_id, delta: l.difference }));
      } else {
        lines = checked.lines.map((l) => ({
          inventory_id: l.inventory_id, quantity: l.quantity,
          unit_cost: type === 'stock_in' ? l.unit_cost : Number(items.get(l.inventory_id).unit_cost)
        }));
        const plan = D.plannedChanges(type, [], lines, items);
        if (plan.problems.length) throw notEnoughFree(plan.problems, 'Not enough free stock to take out:');
        changes = plan.changes;
      }
      const total = type === 'stock_count'
        ? D.countResult(checked.lines, items).value_difference
        : D.linesTotal(lines);

      const inserted = await client.query(
        `INSERT INTO stock_documents (document_id, document_type, reason, supplier_id, order_id, reference_type, reference_no,
                                      occurred_at, notes, total_cost, recorded_by, recorded_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $9, $10, $11, $12)
         RETURNING ${selectList('stock_documents', 'pg')}`,
        [document_id, type, header.reason, header.supplier_id, header.order_id, header.reference_type, header.reference_no,
          header.occurred_at, header.notes, total, req.user.user_id, req.user.role]);
      const doc = serialize('stock_documents', inserted.rows[0]);
      await insertLines(client, document_id, lines, items);
      const changed = await applyChanges(client, req, {
        changes, movementType: type === 'stock_count' ? 'count' : type, doc, setCost: type === 'stock_in',
        linesById: new Map(lines.map((l) => [l.inventory_id, l])), supplier: type === 'stock_in' ? supplier : null
      });
      return { doc, changed, ids };
    });

    pushStockChange(req, result.changed.length ? result.changed : result.ids, result.doc.document_type);
    await refreshLocalRows(req.pgPool, req.localDb, 'inventory_items', result.ids)
      .catch((err) => console.error('⚠️ Could not refresh the local copy of the stock:', err.message));
    console.log(`📥 ${result.doc.document_no} (${type}, ${checked.lines.length} item(s)) by ${req.user.user_id} (${req.user.role})`);
    const found = await loadDocument(req.pgPool, document_id);
    res.status(201).json({
      message: `${D.DOCUMENT_LABELS[type]} ${result.doc.document_no} recorded.`
        + (type === 'stock_count' && result.changed.length === 0 ? ' The count matched the system: nothing changed.' : ''),
      source: 'cloud',
      document: shownDocument(found.document, {}, req.user.role),
      lines: found.lines
    });
  } catch (err) {
    sendError(res, err, 'recording stock');
  }
});

// ---------- Correct (edit) a stock in / stock out ----------
router.put('/documents/:document_id', requireRole(WRITE_ROLES), async (req, res) => {
  const { document_id } = req.params;
  const body = req.body || {};
  if (body.expected_version !== undefined && body.expected_version !== null && typeof body.expected_version !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'expected_version must be the string returned as "version".' });
  }
  // Why it was corrected (kept in the history): optional, text, at most 500 characters
  const reasonCheck = createValidator();
  const correction_reason = reasonCheck.optionalString(body.correction_reason, 'correction_reason', 500) || null;
  if (reasonCheck.failed()) return reasonCheck.send(res);

  try {
    const result = await withPgTransaction(req.pgPool, async (client) => {
      const found = await loadDocument(client, document_id, { lock: true });
      if (!found) throw notFound();
      const before = found.document;
      const type = before.document_type;
      if (type === 'stock_count') {
        throw new Rejected(409, { error: 'COUNT_NOT_EDITABLE', message: 'A stock count cannot be changed. Count again to correct it.' });
      }
      if (!can(req.user.role, CAP_FOR_TYPE[type])) throw new Rejected(403, { error: 'FORBIDDEN', message: 'Your account cannot correct this record.' });
      if (before.voided_at) throw new Rejected(409, { error: 'STOCK_DOCUMENT_VOIDED', message: 'This record was voided, so it can no longer be changed.' });
      if (body.expected_version && before.version !== body.expected_version) {
        throw new Rejected(409, { error: 'EDIT_CONFLICT', message: 'Someone else changed this record while you were editing. Reload it and try again.' });
      }
      const { v, header } = readHeader(body, type);
      const checked = D.checkLines(type, body.lines);
      v.errors.push(...checked.errors);
      if (v.failed()) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: v.errors[0].message, details: v.errors });

      const supplier = await checkSupplier(client, header.supplier_id);
      const oldLines = found.lines;
      const newIds = checked.lines.map((l) => l.inventory_id);
      // New lines need active items; items only on the old lines may be in the Recycle Bin now
      const items = await lockItems(client, [...oldLines.map((l) => l.inventory_id), ...newIds], { activeOnly: false });
      const wasOnRecord = (id) => oldLines.some((l) => l.inventory_id === id);
      const usable = new Map([...items].filter(([id, r]) => (!r.deleted_at && !r.purged_at) || wasOnRecord(id)));
      const missing = missingItems(newIds, usable);
      if (missing) throw missing;

      const newLines = checked.lines.map((l) => ({
        inventory_id: l.inventory_id, quantity: l.quantity,
        unit_cost: type === 'stock_in' ? l.unit_cost
          : (oldLines.find((o) => o.inventory_id === l.inventory_id) || {}).unit_cost ?? Number(items.get(l.inventory_id).unit_cost)
      }));
      const plan = D.plannedChanges(type, oldLines, newLines, items);
      if (plan.problems.length) {
        throw notEnoughFree(plan.problems, type === 'stock_in' ? 'This correction takes back stock that is no longer free:' : 'Not enough free stock for this correction:');
      }
      const updated = await client.query(
        `UPDATE stock_documents
            SET reason = $2, supplier_id = $3, order_id = $4, reference_type = $5, reference_no = $6, occurred_at = $7::timestamp,
                notes = $8, total_cost = $9, edited_at = NOW() AT TIME ZONE 'UTC', edited_by = $10
          WHERE document_id = $1 RETURNING ${selectList('stock_documents', 'pg')}`,
        [document_id, header.reason, header.supplier_id, header.order_id, header.reference_type, header.reference_no, header.occurred_at,
          header.notes, D.linesTotal(newLines), req.user.user_id]);
      const doc = serialize('stock_documents', updated.rows[0]);
      await client.query('DELETE FROM stock_document_lines WHERE document_id = $1', [document_id]);
      await insertLines(client, document_id, newLines, items);
      const changed = await applyChanges(client, req, {
        changes: plan.changes, movementType: `${type}_correction`, doc, setCost: type === 'stock_in',
        linesById: new Map(newLines.map((l) => [l.inventory_id, l])), supplier: null
      });
      const summary = (d, ls) => ({
        occurred_at: d.occurred_at, supplier_id: d.supplier_id, reference_type: d.reference_type, reference_no: d.reference_no,
        reason: d.reason, notes: d.notes, total_cost: d.total_cost,
        lines: ls.map((l) => ({ inventory_id: l.inventory_id, quantity: l.quantity, unit_cost: l.unit_cost }))
      });
      await writeAudit(client, {
        entity: 'stock_documents', entity_id: document_id, action: 'stock_document_edited', actor: req.user,
        details: { document_no: doc.document_no, reason: correction_reason, before: summary(before, oldLines), after: summary(doc, newLines) }
      });
      return { doc, changed, ids: [...items.keys()] };
    });

    pushStockChange(req, result.changed, `${result.doc.document_type}_corrected`);
    await refreshLocalRows(req.pgPool, req.localDb, 'inventory_items', result.ids)
      .catch((err) => console.error('⚠️ Could not refresh the local copy of the stock:', err.message));
    const found = await loadDocument(req.pgPool, document_id);
    res.status(200).json({
      message: `${result.doc.document_no} corrected.${result.changed.length ? ' The stock was changed by the difference.' : ' The stock did not need to change.'}`,
      source: 'cloud',
      document: shownDocument(found.document, {}, req.user.role),
      lines: found.lines
    });
  } catch (err) {
    sendError(res, err, 'correcting a stock record');
  }
});

// ---------- Void a stock in / stock out ----------
router.post('/documents/:document_id/void', requireRole(rolesWith('void_stock_document')), async (req, res) => {
  const { document_id } = req.params;
  const v = createValidator();
  const reason = v.requiredString((req.body || {}).reason, 'void_reason', 1000);
  if (v.failed()) return v.send(res);

  try {
    const result = await withPgTransaction(req.pgPool, async (client) => {
      const found = await loadDocument(client, document_id, { lock: true });
      if (!found) throw notFound();
      const before = found.document;
      if (before.document_type === 'stock_count') {
        throw new Rejected(409, { error: 'COUNT_NOT_EDITABLE', message: 'A stock count cannot be voided. Count again to correct it.' });
      }
      if (before.voided_at) throw new Rejected(409, { error: 'STOCK_DOCUMENT_VOIDED', message: 'This record was already voided.' });
      const items = await lockItems(client, found.lines.map((l) => l.inventory_id), { activeOnly: false });
      const plan = D.plannedChanges(before.document_type, found.lines, [], items);
      if (plan.problems.length) {
        throw notEnoughFree(plan.problems, 'This record cannot be voided because some of its stock was already used or is held for orders:');
      }
      const updated = await client.query(
        `UPDATE stock_documents SET voided_at = NOW() AT TIME ZONE 'UTC', voided_by = $2, void_reason = $3
          WHERE document_id = $1 RETURNING ${selectList('stock_documents', 'pg')}`, [document_id, req.user.user_id, reason]);
      const doc = serialize('stock_documents', updated.rows[0]);
      const changed = await applyChanges(client, req, {
        changes: plan.changes, movementType: `${before.document_type}_void`, doc: { ...doc, notes: `Voided: ${reason}`, reference_no: null },
        setCost: before.document_type === 'stock_in', linesById: new Map(found.lines.map((l) => [l.inventory_id, l])), supplier: null
      });
      await writeAudit(client, {
        entity: 'stock_documents', entity_id: document_id, action: 'stock_document_voided', actor: req.user,
        details: { document_no: doc.document_no, reason, lines: found.lines.map((l) => ({ inventory_id: l.inventory_id, quantity: l.quantity })) }
      });
      return { doc, changed, ids: [...items.keys()] };
    });

    pushStockChange(req, result.changed, `${result.doc.document_type}_voided`);
    await refreshLocalRows(req.pgPool, req.localDb, 'inventory_items', result.ids)
      .catch((err) => console.error('⚠️ Could not refresh the local copy of the stock:', err.message));
    res.status(200).json({
      message: `${result.doc.document_no} voided. Its stock was reversed.`,
      source: 'cloud',
      document: shownDocument(result.doc, {}, req.user.role)
    });
  } catch (err) {
    sendError(res, err, 'voiding a stock record');
  }
});

// ---------- The stock card ----------
router.get('/movements', requireRole(READ_ROLES), async (req, res) => {
  const v = createValidator();
  const inventory_id = v.id(req.query.inventory_id, 'inventory_id', { required: false });
  const movement_type = v.oneOf(req.query.movement_type, 'movement_type', D.MOVEMENT_TYPES, { required: false });
  const from = v.shopDay(req.query.from, 'from', { required: false });
  const to = v.shopDay(req.query.to, 'to', { required: false });
  const { limit, offset } = v.pagination(req.query);
  if (v.failed()) return v.send(res);

  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (inventory_id) add('inventory_id = ?', inventory_id);
  if (movement_type) add('movement_type = ?', movement_type);
  if (from) add('created_at >= ?::timestamp', dayStartUtc(from));
  if (to) add('created_at < ?::timestamp', dayStartUtc(nextDay(to)));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const [list, count, totals] = await Promise.all([
      req.pgPool.query(
        `SELECT ${selectList('stock_movements', 'pg')} FROM stock_movements ${whereSql}
          ORDER BY stock_movements.created_at DESC, stock_movements.movement_id DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params),
      req.pgPool.query(`SELECT COUNT(*)::int AS n FROM stock_movements ${whereSql}`, params),
      req.pgPool.query(
        `SELECT COALESCE(SUM(quantity_change) FILTER (WHERE quantity_change > 0), 0)::int AS total_in,
                COALESCE(-SUM(quantity_change) FILTER (WHERE quantity_change < 0), 0)::int AS total_out
           FROM stock_movements ${whereSql}`, params)
    ]);
    const movements = list.rows.map((r) => serialize('stock_movements', r));
    const names = await userNames(req, movements.map((m) => m.performed_by));
    let item = null;
    if (inventory_id) {
      const found = await req.pgPool.query(`SELECT ${selectList('inventory_items', 'pg')} FROM inventory_items WHERE inventory_id = $1`, [inventory_id]);
      item = found.rows[0] ? withAvailability(serialize('inventory_items', found.rows[0])) : null;
    }
    res.status(200).json({
      source: 'cloud',
      movements: movements.map((m) => ({
        ...m,
        label: D.movementLabel(m.movement_type),
        direction: m.quantity_change > 0 ? 'in' : 'out',
        performed_by_name: m.performed_by ? (names.get(m.performed_by) || 'Not recorded') : 'System'
      })),
      total: count.rows[0].n,
      totals: totals.rows[0],
      limit,
      offset,
      item
    });
  } catch (err) {
    sendError(res, err, 'reading the stock card', READ_NEEDS_CLOUD);
  }
});

module.exports = router;

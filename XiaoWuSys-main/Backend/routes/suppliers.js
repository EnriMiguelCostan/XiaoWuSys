// ==========================================
// SUPPLIERS (migration 015): who the shop buys from
// GET  /api/suppliers?include_archived=true|false&search=
//      -> { source, suppliers: [{ ...supplier, item_count, delivery_count, last_delivery_at, total_purchased }] }
//      (offline: this computer's copy, without the delivery figures)
// GET  /api/suppliers/:supplier_id
//      -> { source, supplier, items: [catalog items whose usual supplier this is],
//           deliveries: [latest stock in records from them], totals: { delivery_count, total_purchased,
//           last_delivery_at, returns } , allowed_actions }
// POST  /api/suppliers                  { supplier_name, contact_person?, contact_number?, email?, address?, notes? }
// PATCH /api/suppliers/:supplier_id     any of those (renaming also renames it on its catalog items)
// POST  /api/suppliers/:supplier_id/archive | restore   (Owner / Admin)
// Writes need the cloud (503 SUPPLIER_REQUIRES_CLOUD); this computer's copy follows at once.
// 409 DUPLICATE_SUPPLIER: the same name already exists (case and spaces ignored).
// ==========================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { createValidator } = require('../utils/validation');
const { selectList, serialize, listRecords, withPgTransaction, userNames } = require('../services/records');
const { rolesWith, can } = require('../services/domain/permissions');
const { withAvailability } = require('../services/inventorySnapshot');
const { writeAudit } = require('../services/auditLog');
const { refreshLocalRows } = require('../services/sync');

const READ_ROLES = rolesWith('view_stock');
const EDIT_ROLES = rolesWith('manage_suppliers');
const ARCHIVE_ROLES = rolesWith('archive_supplier');
const FIELDS = ['supplier_name', 'contact_person', 'contact_number', 'email', 'address', 'notes'];

class Rejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const NEEDS_CLOUD = {
  error: 'SUPPLIER_REQUIRES_CLOUD',
  message: 'Saving a supplier needs the cloud connection, so every branch sees the same list. Nothing was saved. Try again when online.'
};
const sendError = (res, err, context) => {
  if (err instanceof Rejected) return res.status(err.status).json(err.body);
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'DUPLICATE_SUPPLIER', message: 'A supplier with this name already exists.' });
  }
  if (isConnectionError(err)) return res.status(503).json(NEEDS_CLOUD);
  return sendDbError(res, err, context);
};
const cleanText = (s) => (s ? s.replace(/\s+/g, ' ').trim() : s);
const nameKey = (s) => s.toLowerCase().replace(/\s/g, '');
const actionsFor = (supplier, role) => ({
  edit: can(role, 'manage_suppliers') && !supplier.archived_at,
  archive: can(role, 'archive_supplier') && !supplier.archived_at,
  restore: can(role, 'archive_supplier') && Boolean(supplier.archived_at),
  record_stock_in: can(role, 'receive_stock') && !supplier.archived_at
});

router.use(verifyToken);
router.param('supplier_id', (req, res, next, value) => {
  const v = createValidator();
  v.id(value, 'supplier_id');
  if (v.failed()) return v.send(res);
  next();
});

const readFields = (body, { partial }) => {
  const v = createValidator();
  const out = {};
  const given = (f) => body[f] !== undefined;
  if (!partial || given('supplier_name')) out.supplier_name = v.requiredString(body.supplier_name, 'supplier_name', 255);
  if (given('contact_person')) out.contact_person = v.optionalString(body.contact_person, 'contact_person', 255);
  if (given('contact_number')) out.contact_number = v.phone(body.contact_number, 'contact_number');
  if (given('email')) out.email = v.email(body.email, 'email');
  if (given('address')) out.address = v.optionalString(body.address, 'address', 1000);
  if (given('notes')) out.notes = v.optionalString(body.notes, 'notes', 1000);
  if (partial && Object.keys(out).length === 0 && !v.failed()) {
    v.errors.push({ field: 'body', message: `Send at least one of: ${FIELDS.join(', ')}.` });
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (out.supplier_name) out.supplier_name = cleanText(out.supplier_name);
  if (out.contact_person) out.contact_person = cleanText(out.contact_person);
  return { v, fields: out };
};

const findDuplicate = async (db, name, excludeId = null) => {
  const { rows } = await db.query(
    `SELECT supplier_id, supplier_name, archived_at IS NOT NULL AS archived FROM suppliers
      WHERE LOWER(REGEXP_REPLACE(supplier_name, '\\s', '', 'g')) = $1 AND ($2::text IS NULL OR supplier_id <> $2::text) LIMIT 1`,
    [nameKey(name), excludeId]);
  return rows[0] || null;
};
const duplicate = (dup) => new Rejected(409, {
  error: 'DUPLICATE_SUPPLIER',
  message: dup.archived
    ? `"${dup.supplier_name}" is already saved but archived. Restore it instead of adding it again.`
    : `"${dup.supplier_name}" is already saved. Choose it from the list.`,
  existing: { supplier_id: dup.supplier_id, supplier_name: dup.supplier_name, archived: dup.archived }
});

router.get('/', requireRole(READ_ROLES), async (req, res) => {
  const v = createValidator();
  const includeArchived = v.oneOf(req.query.include_archived, 'include_archived', ['true', 'false'], { required: false }) === 'true';
  const search = v.optionalString(req.query.search, 'search', 100);
  if (v.failed()) return v.send(res);
  try {
    try {
      const { rows } = await req.pgPool.query(
        `SELECT ${selectList('suppliers', 'pg', 's')},
                (SELECT COUNT(*)::int FROM inventory_items ii WHERE ii.supplier_id = s.supplier_id AND ii.deleted_at IS NULL AND ii.purged_at IS NULL) AS item_count,
                (SELECT COUNT(*)::int FROM stock_documents d WHERE d.supplier_id = s.supplier_id AND d.document_type = 'stock_in' AND d.voided_at IS NULL) AS delivery_count,
                (SELECT to_char(MAX(d.occurred_at), 'YYYY-MM-DD"T"HH24:MI:SS') FROM stock_documents d
                  WHERE d.supplier_id = s.supplier_id AND d.document_type = 'stock_in' AND d.voided_at IS NULL) AS last_delivery_at,
                (SELECT COALESCE(SUM(d.total_cost), 0)::text FROM stock_documents d
                  WHERE d.supplier_id = s.supplier_id AND d.document_type = 'stock_in' AND d.voided_at IS NULL) AS total_purchased
           FROM suppliers s
          WHERE (${includeArchived ? 'TRUE' : 's.archived_at IS NULL'})
            AND ($1::text IS NULL OR s.supplier_name ILIKE $1 OR s.contact_person ILIKE $1)
          ORDER BY LOWER(s.supplier_name), s.supplier_id`,
        [search ? `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null]);
      return res.status(200).json({
        source: 'cloud',
        suppliers: rows.map((r) => ({
          ...serialize('suppliers', r),
          item_count: r.item_count, delivery_count: r.delivery_count, last_delivery_at: r.last_delivery_at,
          total_purchased: Math.round(Number(r.total_purchased) * 100) / 100
        })),
        can_add: can(req.user.role, 'manage_suppliers')
      });
    } catch (err) {
      if (!isConnectionError(err)) throw err;
    }
    // Offline: this computer's copy (figures from the stock records need the cloud)
    const list = await listRecords(req, 'suppliers', {
      where: includeArchived ? null : 'archived_at IS NULL', orderBy: 'supplier_name, supplier_id'
    });
    const term = search ? search.toLowerCase() : null;
    res.status(200).json({
      source: list.source,
      suppliers: list.records
        .filter((s) => !term || s.supplier_name.toLowerCase().includes(term) || (s.contact_person || '').toLowerCase().includes(term))
        .map((s) => ({ ...s, item_count: null, delivery_count: null, last_delivery_at: null, total_purchased: null })),
      can_add: can(req.user.role, 'manage_suppliers')
    });
  } catch (err) {
    sendDbError(res, err, 'listing suppliers');
  }
});

router.get('/:supplier_id', requireRole(READ_ROLES), async (req, res) => {
  const { supplier_id } = req.params;
  try {
    const found = await req.pgPool.query(`SELECT ${selectList('suppliers', 'pg')} FROM suppliers WHERE supplier_id = $1`, [supplier_id]);
    if (found.rowCount === 0) return res.status(404).json({ error: 'SUPPLIER_NOT_FOUND', message: 'We could not find this supplier.' });
    const supplier = serialize('suppliers', found.rows[0]);
    const [items, deliveries, totals] = await Promise.all([
      req.pgPool.query(
        `SELECT ${selectList('inventory_items', 'pg')} FROM inventory_items
          WHERE supplier_id = $1 AND deleted_at IS NULL AND purged_at IS NULL ORDER BY item_name`, [supplier_id]),
      req.pgPool.query(
        `SELECT ${selectList('stock_documents', 'pg', 'd')},
                (SELECT COALESCE(SUM(l.quantity), 0)::int FROM stock_document_lines l WHERE l.document_id = d.document_id) AS total_quantity,
                (SELECT string_agg(l.item_name, ', ' ORDER BY l.line_no) FROM stock_document_lines l WHERE l.document_id = d.document_id) AS item_names
           FROM stock_documents d WHERE d.supplier_id = $1 ORDER BY d.occurred_at DESC, d.created_at DESC LIMIT 50`, [supplier_id]),
      req.pgPool.query(
        `SELECT COUNT(*) FILTER (WHERE document_type = 'stock_in' AND voided_at IS NULL)::int AS delivery_count,
                COALESCE(SUM(total_cost) FILTER (WHERE document_type = 'stock_in' AND voided_at IS NULL), 0)::text AS total_purchased,
                to_char(MAX(occurred_at) FILTER (WHERE document_type = 'stock_in' AND voided_at IS NULL), 'YYYY-MM-DD"T"HH24:MI:SS') AS last_delivery_at,
                COUNT(*) FILTER (WHERE document_type = 'stock_out' AND voided_at IS NULL)::int AS returns
           FROM stock_documents WHERE supplier_id = $1`, [supplier_id])
    ]);
    const docs = deliveries.rows.map((r) => ({ ...serialize('stock_documents', r), total_quantity: r.total_quantity, item_names: r.item_names }));
    const names = await userNames(req, docs.map((d) => d.recorded_by));
    const t = totals.rows[0];
    res.status(200).json({
      source: 'cloud',
      supplier,
      items: items.rows.map((r) => withAvailability(serialize('inventory_items', r))),
      deliveries: docs.map((d) => ({ ...d, recorded_by_name: (d.recorded_by && names.get(d.recorded_by)) || 'Not recorded' })),
      totals: { delivery_count: t.delivery_count, total_purchased: Math.round(Number(t.total_purchased) * 100) / 100, last_delivery_at: t.last_delivery_at, returns: t.returns },
      allowed_actions: actionsFor(supplier, req.user.role)
    });
  } catch (err) {
    if (isConnectionError(err)) {
      return res.status(503).json({ error: 'SUPPLIER_PROFILE_REQUIRES_CLOUD', message: 'A supplier’s deliveries are kept in the cloud. Connect to the internet to see them.' });
    }
    sendDbError(res, err, 'reading a supplier');
  }
});

router.post('/', requireRole(EDIT_ROLES), async (req, res) => {
  const { v, fields } = readFields(req.body || {}, { partial: false });
  if (v.failed()) return v.send(res);
  const supplier_id = `SUP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  try {
    const supplier = await withPgTransaction(req.pgPool, async (client) => {
      const dup = await findDuplicate(client, fields.supplier_name);
      if (dup) throw duplicate(dup);
      const cols = ['supplier_id', ...Object.keys(fields)];
      const { rows } = await client.query(
        `INSERT INTO suppliers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING ${selectList('suppliers', 'pg')}`,
        [supplier_id, ...Object.values(fields)]);
      return serialize('suppliers', rows[0]);
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'suppliers', [supplier_id])
      .catch((err) => console.error('⚠️ Could not refresh the local copy of a supplier:', err.message));
    res.status(201).json({ message: `${supplier.supplier_name} saved.`, source: 'cloud', supplier, allowed_actions: actionsFor(supplier, req.user.role) });
  } catch (err) {
    sendError(res, err, 'saving a supplier');
  }
});

router.patch('/:supplier_id', requireRole(EDIT_ROLES), async (req, res) => {
  const { supplier_id } = req.params;
  const { v, fields } = readFields(req.body || {}, { partial: true });
  if (v.failed()) return v.send(res);
  try {
    const result = await withPgTransaction(req.pgPool, async (client) => {
      const found = await client.query(`SELECT ${selectList('suppliers', 'pg')} FROM suppliers WHERE supplier_id = $1 FOR UPDATE`, [supplier_id]);
      if (found.rowCount === 0) throw new Rejected(404, { error: 'SUPPLIER_NOT_FOUND', message: 'We could not find this supplier.' });
      const before = serialize('suppliers', found.rows[0]);
      if (before.archived_at) throw new Rejected(409, { error: 'SUPPLIER_ARCHIVED', message: 'This supplier is archived. Restore it first to change it.' });
      if (fields.supplier_name && nameKey(fields.supplier_name) !== nameKey(before.supplier_name)) {
        const dup = await findDuplicate(client, fields.supplier_name, supplier_id);
        if (dup) throw duplicate(dup);
      }
      const changed = Object.keys(fields).filter((f) => (fields[f] || null) !== (before[f] || null));
      if (changed.length === 0) return { supplier: before, changed, itemIds: [] };
      const { rows } = await client.query(
        `UPDATE suppliers SET ${changed.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE supplier_id = $1
         RETURNING ${selectList('suppliers', 'pg')}`,
        [supplier_id, ...changed.map((f) => fields[f])]);
      let itemIds = [];
      if (changed.includes('supplier_name')) {
        const items = await client.query(
          'UPDATE inventory_items SET supplier = $2 WHERE supplier_id = $1 RETURNING inventory_id', [supplier_id, fields.supplier_name]);
        itemIds = items.rows.map((r) => r.inventory_id);
      }
      await writeAudit(client, {
        entity: 'suppliers', entity_id: supplier_id, action: 'supplier_edited', actor: req.user,
        details: { before: Object.fromEntries(changed.map((f) => [f, before[f]])), after: Object.fromEntries(changed.map((f) => [f, fields[f]])) }
      });
      return { supplier: serialize('suppliers', rows[0]), changed, itemIds };
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'suppliers', [supplier_id]).catch(() => {});
    if (result.itemIds.length) {
      await refreshLocalRows(req.pgPool, req.localDb, 'inventory_items', result.itemIds).catch(() => {});
      if (req.inventoryEvents) req.inventoryEvents.notifyChanged(result.itemIds, 'supplier_renamed');
    }
    res.status(200).json({
      message: result.changed.length ? `${result.supplier.supplier_name} updated.` : 'Nothing changed: the details are the same as before.',
      source: 'cloud', supplier: result.supplier, changed: result.changed, allowed_actions: actionsFor(result.supplier, req.user.role)
    });
  } catch (err) {
    sendError(res, err, 'editing a supplier');
  }
});

const archiveRoute = (archive) => async (req, res) => {
  const { supplier_id } = req.params;
  try {
    const supplier = await withPgTransaction(req.pgPool, async (client) => {
      const found = await client.query(`SELECT ${selectList('suppliers', 'pg')} FROM suppliers WHERE supplier_id = $1 FOR UPDATE`, [supplier_id]);
      if (found.rowCount === 0) throw new Rejected(404, { error: 'SUPPLIER_NOT_FOUND', message: 'We could not find this supplier.' });
      const current = serialize('suppliers', found.rows[0]);
      if (archive && current.archived_at) throw new Rejected(409, { error: 'ALREADY_ARCHIVED', message: 'This supplier is already archived.' });
      if (!archive && !current.archived_at) throw new Rejected(409, { error: 'NOT_ARCHIVED', message: 'This supplier is not archived.' });
      const { rows } = await client.query(
        `UPDATE suppliers SET archived_at = ${archive ? "NOW() AT TIME ZONE 'UTC'" : 'NULL'}, archived_by = $2 WHERE supplier_id = $1
         RETURNING ${selectList('suppliers', 'pg')}`, [supplier_id, archive ? req.user.user_id : null]);
      await writeAudit(client, {
        entity: 'suppliers', entity_id: supplier_id, action: archive ? 'supplier_archived' : 'supplier_restored', actor: req.user,
        details: { supplier_name: current.supplier_name }
      });
      return serialize('suppliers', rows[0]);
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'suppliers', [supplier_id]).catch(() => {});
    res.status(200).json({
      message: archive
        ? `${supplier.supplier_name} archived. It is hidden from the supplier lists; its deliveries are kept.`
        : `${supplier.supplier_name} restored.`,
      source: 'cloud', supplier, allowed_actions: actionsFor(supplier, req.user.role)
    });
  } catch (err) {
    sendError(res, err, archive ? 'archiving a supplier' : 'restoring a supplier');
  }
};
router.post('/:supplier_id/archive', requireRole(ARCHIVE_ROLES), archiveRoute(true));
router.post('/:supplier_id/restore', requireRole(ARCHIVE_ROLES), archiveRoute(false));

module.exports = router;

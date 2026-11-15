// ==========================================
// CUSTOMERS (needed to create orders: every order belongs to a customer)
// GET  /api/customers            -> { source, customers }
// POST /api/customers            -> 201 { message, source, customer }
//      Body: { full_name, contact_number?, platform_source? }
//      contact_number: 11 digits starting with 0 (e.g. 09171234567); spaces/dashes are removed
//      409 DUPLICATE_CUSTOMER when the same name + contact number already exists
// GET  /api/customers?include_archived=true   archived customers are hidden unless asked for
// POST /api/customers/:customer_id/archive | restore   (PB 23, D2; Owner / Admin, online only)
//      409 ORDER_STILL_OPEN while the customer has an order that is not Completed / Cancelled
// ==========================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { LOCAL_NOW } = require('../utils/localSync');
const { createValidator } = require('../utils/validation');
const { selectList, serialize, listRecords, readLocal, sqliteGet, sqliteRun, locateRecord, withPgTransaction } = require('../services/records');
const { rolesWith } = require('../services/domain/permissions');
const { CLOSED_STATUSES } = require('../services/domain/orderLifecycle');
const { writeAudit } = require('../services/auditLog');
const { refreshLocalRows } = require('../services/sync');

const READ_ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
const WRITE_ROLES = ['Owner', 'Admin', 'Production'];
const ARCHIVE_ROLES = rolesWith('manage_accounts');

router.use(verifyToken);

router.get('/', requireRole(READ_ROLES), async (req, res) => {
  const v = createValidator();
  const includeArchived = v.oneOf(req.query.include_archived, 'include_archived', ['true', 'false'], { required: false }) === 'true';
  if (v.failed()) return v.send(res);
  try {
    const result = await listRecords(req, 'customers', {
      orderBy: 'full_name, customer_id', limit: 1000, where: includeArchived ? null : 'archived_at IS NULL'
    });
    res.status(200).json({ source: result.source, customers: result.records, include_archived: includeArchived });
  } catch (err) {
    sendDbError(res, err, 'listing customers');
  }
});

const nameKey = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

router.post('/', requireRole(WRITE_ROLES), async (req, res) => {
  const body = req.body || {};
  const v = createValidator();
  const full_name = v.requiredString(body.full_name, 'full_name', 255);
  const contact_number = v.mobileNumber(body.contact_number, 'contact_number');
  const platform_source = v.optionalString(body.platform_source, 'platform_source', 100);
  if (v.failed()) return v.send(res);

  const cleanName = full_name.replace(/\s+/g, ' ');
  const customer_id = `CUST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const values = [customer_id, cleanName, contact_number, platform_source];
  const duplicate = (existing) => res.status(409).json({
    error: 'DUPLICATE_CUSTOMER',
    message: `${existing.full_name} (${existing.customer_id}) is already saved${existing.contact_number ? ` with ${existing.contact_number}` : ''}. Select them from the list.`,
    existing: serialize('customers', existing)
  });

  try {
    try {
      const dup = await req.pgPool.query(
        `SELECT ${selectList('customers', 'pg')} FROM customers
          WHERE LOWER(REGEXP_REPLACE(TRIM(full_name), '\\s+', ' ', 'g')) = $1
            AND COALESCE(contact_number, '') = COALESCE($2, '') LIMIT 1`,
        [nameKey(cleanName), contact_number]
      );
      if (dup.rows[0]) return duplicate(dup.rows[0]);
      const { rows } = await req.pgPool.query(
        `INSERT INTO customers (customer_id, full_name, contact_number, platform_source)
         VALUES ($1, $2, $3, $4) RETURNING ${selectList('customers', 'pg')}`,
        values
      );
      return res.status(201).json({ message: `Customer ${cleanName} saved.`, source: 'cloud', customer: serialize('customers', rows[0]) });
    } catch (onlineError) {
      if (!isConnectionError(onlineError)) throw onlineError; // C5
      console.error('Cloud DB unreachable. Saving customer to SQLite:', onlineError.message);
      const dup = await sqliteGet(req.localDb,
        `SELECT ${selectList('customers', 'sqlite')} FROM customers
          WHERE LOWER(TRIM(full_name)) = ? AND COALESCE(contact_number, '') = COALESCE(?, '') LIMIT 1`,
        [nameKey(cleanName), contact_number]);
      if (dup) return duplicate(dup);
      await sqliteRun(req.localDb,
        `INSERT INTO customers (customer_id, full_name, contact_number, platform_source, sync_status, last_modified)
         VALUES (?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})`, values);
      return res.status(201).json({
        message: `Customer ${cleanName} saved locally (Offline Mode).`,
        source: 'local',
        customer: await readLocal(req.localDb, 'customers', customer_id)
      });
    }
  } catch (err) {
    sendDbError(res, err, 'saving customer');
  }
});

// ---------- PB 23 / D2: archive and restore (kept forever, never deleted) ----------
class Rejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const NEEDS_CLOUD = {
  error: 'ARCHIVE_REQUIRES_CLOUD',
  message: 'Archiving and restoring need the cloud connection, so every branch sees the same lists. Try again when online.'
};
const CLOSED_SQL = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

router.param('customer_id', (req, res, next, value) => {
  const v = createValidator();
  v.id(value, 'customer_id');
  if (v.failed()) return v.send(res);
  next();
});

const archiveRoute = (archive) => async (req, res) => {
  const { customer_id } = req.params;
  try {
    const located = await locateRecord(req, 'customers', customer_id);
    if (!located.location) return res.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'We could not find this customer.' });
    if (!located.cloudReachable) return res.status(503).json(NEEDS_CLOUD);
    if (located.location === 'local') {
      return res.status(409).json({ error: 'CUSTOMER_NOT_SYNCED', message: 'This customer was saved offline and is not in the cloud yet. Sync first.' });
    }
    // Orders saved on this computer and not synced yet count as open too
    const pendingHere = archive && await sqliteGet(req.localDb,
      `SELECT 1 AS n FROM order_profiles WHERE customer_id = ? AND sync_status = 'pending_insert' AND production_status NOT IN (${CLOSED_SQL}) LIMIT 1`,
      [customer_id]);
    const customer = await withPgTransaction(req.pgPool, async (client) => {
      const { rows } = await client.query(
        `SELECT ${selectList('customers', 'pg')} FROM customers WHERE customer_id = $1 FOR UPDATE`, [customer_id]);
      if (rows.length === 0) throw new Rejected(404, { error: 'CUSTOMER_NOT_FOUND', message: 'We could not find this customer.' });
      const current = serialize('customers', rows[0]);
      if (archive) {
        if (current.archived_at) throw new Rejected(409, { error: 'ALREADY_ARCHIVED', message: 'This customer is already archived.' });
        const open = await client.query(
          `SELECT COUNT(*)::int AS n FROM order_profiles WHERE customer_id = $1 AND production_status NOT IN (${CLOSED_SQL})`, [customer_id]);
        if (open.rows[0].n > 0 || pendingHere) {
          throw new Rejected(409, {
            error: 'ORDER_STILL_OPEN',
            message: 'This customer still has orders that are not completed or cancelled. Finish or cancel them first.',
            open_orders: open.rows[0].n + (pendingHere ? 1 : 0)
          });
        }
      } else if (!current.archived_at) {
        throw new Rejected(409, { error: 'NOT_ARCHIVED', message: 'This customer is not archived.' });
      }
      const updated = await client.query(
        `UPDATE customers SET archived_at = ${archive ? 'NOW()' : 'NULL'}, archived_by = $2
          WHERE customer_id = $1 RETURNING ${selectList('customers', 'pg')}`,
        [customer_id, archive ? req.user.user_id : null]);
      await writeAudit(client, {
        entity: 'customers', entity_id: customer_id, action: archive ? 'customer_archived' : 'customer_restored', actor: req.user,
        details: { full_name: current.full_name, archived_at_before: current.archived_at }
      });
      return serialize('customers', updated.rows[0]);
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'customers', [customer_id])
      .catch((err) => console.error('⚠️ Could not refresh the local copy of a customer:', err.message));
    res.status(200).json({
      message: archive ? `${customer.full_name} archived. They are hidden from the customer list and kept for the records.` : `${customer.full_name} restored.`,
      source: 'cloud',
      customer
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    if (isConnectionError(err)) return res.status(503).json(NEEDS_CLOUD);
    sendDbError(res, err, archive ? 'archiving a customer' : 'restoring a customer');
  }
};
router.post('/:customer_id/archive', requireRole(ARCHIVE_ROLES), archiveRoute(true));
router.post('/:customer_id/restore', requireRole(ARCHIVE_ROLES), archiveRoute(false));

module.exports = router;

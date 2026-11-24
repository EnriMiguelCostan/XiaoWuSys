// ==========================================
// CUSTOMERS (needed to create orders: every order belongs to a customer)
// GET  /api/customers            -> { source, customers }
// POST /api/customers            -> 201 { message, source, customer }
//      Body: { full_name, contact_number?, platform_source? }
//      contact_number: 11 digits starting with 0 (e.g. 09171234567); spaces/dashes are removed
//      409 DUPLICATE_CUSTOMER when the same name + contact number already exists
// GET  /api/customers?include_archived=true|only   archived customers are hidden unless asked for
//      (only = the archived ones alone, for the "Show archived" view)
// POST /api/customers/:customer_id/archive | restore   (PB 23, D2; Owner / Admin, online only)
//      409 ORDER_STILL_OPEN while the customer has an order that is not Completed / Cancelled
// Migration 015 (client profiles):
//   POST also takes { customer_type?, contact_person?, email?, address?, social_media?, notes? }
//   GET   /api/customers/options                  -> { customer_types }
//   GET   /api/customers/:customer_id             -> { source, customer, orders: [{ ...order, total_paid, remaining,
//         payment_status }], totals: { order_count, open_orders, total_billed, total_paid, balance_due, last_order_at },
//         allowed_actions }
//   PATCH /api/customers/:customer_id             any profile field (works offline too; synced later)
//         409 DUPLICATE_CUSTOMER when the new name + number belong to another customer
// Migration 016 (adviser consultation):
//   the contact person's own details: contact_person_number, contact_person_email, contact_person_social
//   social_media may list several accounts (one per line)
//   GET /api/customers/:customer_id also sends branches, and each order its group
//     ('pending' = waiting for approval, 'current' = approved and in production, 'past' = completed or
//     cancelled) and the branch it is for (null = the main branch, the client's own address)
//   POST   /api/customers/:customer_id/branches             { branch_name, address?, contact_person?, contact_number?, email?, notes? }
//   PATCH  /api/customers/:customer_id/branches/:branch_id  (any of those)
//   POST   /api/customers/:customer_id/branches/:branch_id/archive | restore
//   Branches are changed online only (copied down so an order can name its branch offline).
// ==========================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { LOCAL_NOW } = require('../utils/localSync');
const { createValidator } = require('../utils/validation');
const { selectList, serialize, listRecords, readLocal, sqliteGet, sqliteRun, locateRecord, withPgTransaction, getRecord, withLocalTransaction } = require('../services/records');
const { rolesWith, can } = require('../services/domain/permissions');
const { paymentSummary } = require('../services/domain/payments');
const { withDeadlineFlag } = require('../services/domain/orderLifecycle');
const { offlineUpdateBookkeeping } = require('../utils/localSync');
const { CLOSED_STATUSES } = require('../services/domain/orderLifecycle');
const { writeAudit } = require('../services/auditLog');
const { refreshLocalRows } = require('../services/sync');

const READ_ROLES = rolesWith('view_orders');
const WRITE_ROLES = rolesWith('create_order');
const EDIT_ROLES = rolesWith('edit_customer');
const ARCHIVE_ROLES = rolesWith('manage_accounts');

router.use(verifyToken);

router.get('/', requireRole(READ_ROLES), async (req, res) => {
  const v = createValidator();
  const archivedMode = v.oneOf(req.query.include_archived, 'include_archived', ['true', 'false', 'only'], { required: false }) || 'false';
  if (v.failed()) return v.send(res);
  const includeArchived = archivedMode !== 'false';
  try {
    const result = await listRecords(req, 'customers', {
      orderBy: 'full_name, customer_id', limit: 1000, where: { true: null, only: 'archived_at IS NOT NULL', false: 'archived_at IS NULL' }[archivedMode]
    });
    res.status(200).json({ source: result.source, customers: result.records, include_archived: includeArchived, archived_only: archivedMode === 'only' });
  } catch (err) {
    sendDbError(res, err, 'listing customers');
  }
});

const nameKey = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- migration 015: the client profile ----------
const CUSTOMER_TYPES = ['Individual', 'School', 'Company', 'Organization', 'Government', 'Reseller'];
const PROFILE_FIELDS = ['customer_type', 'contact_person', 'email', 'address', 'social_media', 'notes',
  'contact_person_number', 'contact_person_email', 'contact_person_social'];
const SOCIAL_MAX = 1000; // several accounts, one per line
const readProfile = (v, body) => {
  const out = {};
  if (body.customer_type !== undefined) out.customer_type = v.oneOf(body.customer_type, 'customer_type', CUSTOMER_TYPES, { required: false }) || 'Individual';
  if (body.contact_person !== undefined) out.contact_person = v.optionalString(body.contact_person, 'contact_person', 255);
  if (body.email !== undefined) out.email = v.email(body.email, 'email');
  if (body.address !== undefined) out.address = v.optionalString(body.address, 'address', 1000);
  if (body.social_media !== undefined) out.social_media = v.optionalString(body.social_media, 'social_media', SOCIAL_MAX);
  if (body.notes !== undefined) out.notes = v.optionalString(body.notes, 'notes', 1000);
  // migration 016: the contact person's own phone (mobile or landline), email and social media
  if (body.contact_person_number !== undefined) out.contact_person_number = v.phone(body.contact_person_number, 'contact_person_number');
  if (body.contact_person_email !== undefined) out.contact_person_email = v.email(body.contact_person_email, 'contact_person_email');
  if (body.contact_person_social !== undefined) out.contact_person_social = v.optionalString(body.contact_person_social, 'contact_person_social', SOCIAL_MAX);
  return out;
};

// migration 016: which part of the client's history an order belongs to
const ORDER_GROUPS = { Pending: 'pending', Delayed: 'pending', Completed: 'past', Cancelled: 'past' };
const groupOf = (status) => ORDER_GROUPS[status] || 'current';

router.get('/options', requireRole(READ_ROLES), (req, res) => {
  res.status(200).json({ customer_types: CUSTOMER_TYPES });
});

router.post('/', requireRole(WRITE_ROLES), async (req, res) => {
  const body = req.body || {};
  const v = createValidator();
  const full_name = v.requiredString(body.full_name, 'full_name', 255);
  const contact_number = v.mobileNumber(body.contact_number, 'contact_number');
  const platform_source = v.optionalString(body.platform_source, 'platform_source', 100);
  const profile = readProfile(v, body);
  if (v.failed()) return v.send(res);

  const cleanName = full_name.replace(/\s+/g, ' ');
  const customer_id = `CUST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const profileValues = PROFILE_FIELDS.map((f) => (f === 'customer_type' ? (profile[f] || 'Individual') : (profile[f] || null)));
  const values = [customer_id, cleanName, contact_number, platform_source, ...profileValues];
  const profileCols = PROFILE_FIELDS.join(', ');
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
        `INSERT INTO customers (customer_id, full_name, contact_number, platform_source, ${profileCols})
         VALUES ($1, $2, $3, $4, ${PROFILE_FIELDS.map((_, i) => `$${i + 5}`).join(', ')}) RETURNING ${selectList('customers', 'pg')}`,
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
        `INSERT INTO customers (customer_id, full_name, contact_number, platform_source, ${profileCols}, sync_status, last_modified)
         VALUES (?, ?, ?, ?, ${PROFILE_FIELDS.map(() => '?').join(', ')}, 'pending_insert', ${LOCAL_NOW})`, values);
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
// ---------- migration 015: the client profile and its history ----------
router.get('/:customer_id', requireRole(READ_ROLES), async (req, res) => {
  const { customer_id } = req.params;
  try {
    const { source, record: customer } = await getRecord(req, 'customers', customer_id);
    if (!customer) return res.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'We could not find this customer.' });
    const orders = await listRecords(req, 'order_profiles', {
      filters: [['customer_id', customer_id]], orderBy: 'order_profiles.date_created DESC, order_profiles.order_id', limit: 500
    });
    // migration 016: the client's other branches (archived ones too, so old orders still name theirs)
    const branches = await listRecords(req, 'customer_branches', {
      filters: [['customer_id', customer_id]], orderBy: 'customer_branches.branch_name, customer_branches.branch_id', limit: 200
    });
    const branchById = new Map(branches.records.map((b) => [b.branch_id, b]));
    // Payments of these orders (one query per order would be slow for a school with 100 orders)
    const ids = orders.records.map((o) => o.order_id);
    const paymentsByOrder = new Map(ids.map((id) => [id, []]));
    if (ids.length) {
      const pays = await listRecords(req, 'payments', {
        where: `order_id IN (${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`, limit: 5000
      });
      for (const p of pays.records) if (paymentsByOrder.has(p.order_id)) paymentsByOrder.get(p.order_id).push(p);
    }
    let billedC = 0; let paidC = 0; let dueC = 0; let open = 0;
    const shown = orders.records.map((o) => {
      const s = paymentSummary({ quote: o.total_quote_amount, payments: paymentsByOrder.get(o.order_id) || [] });
      if (o.production_status !== 'Cancelled') {
        billedC += Math.round(s.quote * 100);
        dueC += Math.round(s.remaining * 100);
      }
      paidC += Math.round(s.total_paid * 100);
      if (!['Completed', 'Cancelled'].includes(o.production_status)) open += 1;
      const branch = o.branch_id ? branchById.get(o.branch_id) : null;
      return {
        ...withDeadlineFlag(o), total_paid: s.total_paid, remaining: s.remaining, payment_status: s.payment_status,
        group: groupOf(o.production_status),
        branch_name: branch ? branch.branch_name : null,
        branch_address: branch ? branch.address : customer.address
      };
    });
    const count = (g) => shown.filter((o) => o.group === g).length;
    res.status(200).json({
      source: [source, orders.source, branches.source].includes('local') ? 'local' : 'cloud',
      customer,
      orders: shown,
      branches: branches.records,
      totals: {
        order_count: shown.length,
        open_orders: open,
        pending_orders: count('pending'),
        current_orders: count('current'),
        past_orders: count('past'),
        total_billed: billedC / 100,
        total_paid: paidC / 100,
        balance_due: dueC / 100,
        last_order_at: shown.length ? shown[0].date_created : null
      },
      allowed_actions: {
        edit: can(req.user.role, 'edit_customer') && !customer.archived_at,
        create_order: can(req.user.role, 'create_order') && !customer.archived_at,
        archive: can(req.user.role, 'manage_accounts') && !customer.archived_at,
        restore: can(req.user.role, 'manage_accounts') && Boolean(customer.archived_at),
        manage_branches: can(req.user.role, 'edit_customer') && !customer.archived_at
      }
    });
  } catch (err) {
    sendDbError(res, err, 'reading a customer');
  }
});

router.patch('/:customer_id', requireRole(EDIT_ROLES), async (req, res) => {
  const { customer_id } = req.params;
  const body = req.body || {};
  const v = createValidator();
  const updates = readProfile(v, body);
  if (body.full_name !== undefined) updates.full_name = v.requiredString(body.full_name, 'full_name', 255);
  if (body.contact_number !== undefined) updates.contact_number = v.mobileNumber(body.contact_number, 'contact_number');
  if (body.platform_source !== undefined) updates.platform_source = v.optionalString(body.platform_source, 'platform_source', 100);
  if (Object.keys(updates).length === 0 && !v.failed()) v.errors.push({ field: 'body', message: 'Nothing to change.' });
  if (v.failed()) return v.send(res);
  if (updates.full_name) updates.full_name = updates.full_name.replace(/\s+/g, ' ');

  try {
    const { record: current } = await getRecord(req, 'customers', customer_id);
    if (!current) return res.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'We could not find this customer.' });
    if (current.archived_at) return res.status(409).json({ error: 'RECORD_ARCHIVED', message: 'This customer is archived. Restore them first to change the profile.' });
    const fields = Object.keys(updates).filter((f) => (updates[f] ?? null) !== (current[f] ?? null));
    if (fields.length === 0) return res.status(200).json({ message: 'Nothing changed.', source: 'cloud', customer: current, changed: [] });
    const name = updates.full_name || current.full_name;
    const number = updates.contact_number !== undefined ? updates.contact_number : current.contact_number;
    const located = await locateRecord(req, 'customers', customer_id);

    const inCloud = () => withPgTransaction(req.pgPool, async (client) => {
      if (fields.includes('full_name') || fields.includes('contact_number')) {
        const dup = await client.query(
          `SELECT customer_id, full_name FROM customers
            WHERE LOWER(REGEXP_REPLACE(TRIM(full_name), '\\s+', ' ', 'g')) = $1 AND COALESCE(contact_number, '') = COALESCE($2, '')
              AND customer_id <> $3 LIMIT 1`, [nameKey(name), number, customer_id]);
        if (dup.rows[0]) throw new Rejected(409, { error: 'DUPLICATE_CUSTOMER', message: `${dup.rows[0].full_name} with this number is already saved.` });
      }
      const { rows } = await client.query(
        `UPDATE customers SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE customer_id = $1 RETURNING ${selectList('customers', 'pg')}`,
        [customer_id, ...fields.map((f) => updates[f])]);
      await writeAudit(client, {
        entity: 'customers', entity_id: customer_id, action: 'customer_edited', actor: req.user,
        details: { before: Object.fromEntries(fields.map((f) => [f, current[f]])), after: Object.fromEntries(fields.map((f) => [f, updates[f]])) }
      });
      return { source: 'cloud', customer: serialize('customers', rows[0]) };
    });
    const locally = () => withLocalTransaction(req.localDbPath, async (tx) => {
      await sqliteRun(tx,
        `UPDATE customers SET ${fields.map((f) => `${f} = ?`).join(', ')}, ${offlineUpdateBookkeeping('customers', fields)} WHERE customer_id = ?`,
        [...fields.map((f) => updates[f]), customer_id]);
      return { source: 'local', customer: await readLocal(tx, 'customers', customer_id) };
    });
    let result;
    if (located.location === 'local') result = await locally();
    else {
      try {
        result = await inCloud();
      } catch (err) {
        if (err instanceof Rejected || !isConnectionError(err) || err.commitUnknown) throw err;
        result = await locally();
      }
    }
    if (result.source === 'cloud') await refreshLocalRows(req.pgPool, req.localDb, 'customers', [customer_id]).catch(() => {});
    res.status(200).json({
      message: result.source === 'cloud' ? `${result.customer.full_name}'s profile was updated.` : 'Profile saved on this computer (offline). It will sync when the connection is back.',
      source: result.source, customer: result.customer, changed: fields
    });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    sendDbError(res, err, 'editing a customer');
  }
});

// ---------- migration 016: a client's branches (online only) ----------
const BRANCH_FIELDS = ['branch_name', 'address', 'contact_person', 'contact_number', 'email', 'notes'];
const readBranch = (body, { partial }) => {
  const v = createValidator();
  const out = {};
  const given = (f) => body[f] !== undefined;
  if (!partial || given('branch_name')) out.branch_name = v.requiredString(body.branch_name, 'branch_name', 255);
  if (given('address')) out.address = v.optionalString(body.address, 'address', 1000);
  if (given('contact_person')) out.contact_person = v.optionalString(body.contact_person, 'contact_person', 255);
  if (given('contact_number')) out.contact_number = v.phone(body.contact_number, 'contact_number');
  if (given('email')) out.email = v.email(body.email, 'email');
  if (given('notes')) out.notes = v.optionalString(body.notes, 'notes', 1000);
  if (partial && Object.keys(out).length === 0 && !v.failed()) v.errors.push({ field: 'body', message: 'Nothing to change.' });
  return { v, fields: out };
};
const BRANCH_NEEDS_CLOUD = {
  error: 'BRANCH_REQUIRES_CLOUD',
  message: 'Branches are saved in the cloud so every computer sees the same list. Nothing was saved. Try again when online.'
};
const branchNotFound = () => new Rejected(404, { error: 'BRANCH_NOT_FOUND', message: 'We could not find this branch.' });
router.param('branch_id', (req, res, next, value) => {
  const v = createValidator();
  v.id(value, 'branch_id');
  if (v.failed()) return v.send(res);
  next();
});

const branchRoute = (handler) => async (req, res) => {
  try {
    const located = await locateRecord(req, 'customers', req.params.customer_id);
    if (!located.location) return res.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'We could not find this customer.' });
    if (!located.cloudReachable) return res.status(503).json(BRANCH_NEEDS_CLOUD);
    if (located.location === 'local') {
      return res.status(409).json({ error: 'CUSTOMER_NOT_SYNCED', message: 'This client was saved offline and is not in the cloud yet. Sync first.' });
    }
    const out = await withPgTransaction(req.pgPool, async (client) => {
      const owner = await client.query('SELECT archived_at FROM customers WHERE customer_id = $1 FOR UPDATE', [req.params.customer_id]);
      if (owner.rowCount === 0) throw new Rejected(404, { error: 'CUSTOMER_NOT_FOUND', message: 'We could not find this customer.' });
      if (owner.rows[0].archived_at) throw new Rejected(409, { error: 'RECORD_ARCHIVED', message: 'This client is archived. Restore them first.' });
      return handler(req, client);
    });
    await refreshLocalRows(req.pgPool, req.localDb, 'customer_branches', [out.branch.branch_id]).catch(() => {});
    res.status(out.status || 200).json({ message: out.message, source: 'cloud', branch: out.branch });
  } catch (err) {
    if (err instanceof Rejected) return res.status(err.status).json(err.body);
    if (isConnectionError(err)) return res.status(503).json(BRANCH_NEEDS_CLOUD);
    sendDbError(res, err, 'saving a branch');
  }
};

router.post('/:customer_id/branches', requireRole(EDIT_ROLES), branchRoute(async (req, client) => {
  const { customer_id } = req.params;
  const { v, fields } = readBranch(req.body || {}, { partial: false });
  if (v.failed()) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: v.errors[0].message, details: v.errors });
  const name = fields.branch_name.replace(/\s+/g, ' ');
  const dup = await client.query(
    `SELECT branch_id FROM customer_branches WHERE customer_id = $1 AND LOWER(REGEXP_REPLACE(TRIM(branch_name), '\\s+', ' ', 'g')) = $2`,
    [customer_id, nameKey(name)]);
  if (dup.rowCount > 0) throw new Rejected(409, { error: 'DUPLICATE_BRANCH', message: `This client already has a branch called ${name}.` });
  const branch_id = `BR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const { rows } = await client.query(
    `INSERT INTO customer_branches (branch_id, customer_id, branch_name, address, contact_person, contact_number, email, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${selectList('customer_branches', 'pg')}`,
    [branch_id, customer_id, name, fields.address || null, fields.contact_person || null, fields.contact_number || null,
      fields.email || null, fields.notes || null, req.user.user_id]);
  await writeAudit(client, { entity: 'customer_branches', entity_id: branch_id, action: 'branch_added', actor: req.user, details: { customer_id, branch_name: name } });
  return { status: 201, branch: serialize('customer_branches', rows[0]), message: `Branch ${name} added.` };
}));

router.patch('/:customer_id/branches/:branch_id', requireRole(EDIT_ROLES), branchRoute(async (req, client) => {
  const { customer_id, branch_id } = req.params;
  const { v, fields } = readBranch(req.body || {}, { partial: true });
  if (v.failed()) throw new Rejected(400, { error: 'VALIDATION_FAILED', message: v.errors[0].message, details: v.errors });
  const cur = await client.query(
    `SELECT ${selectList('customer_branches', 'pg')} FROM customer_branches WHERE branch_id = $1 AND customer_id = $2 FOR UPDATE`, [branch_id, customer_id]);
  if (cur.rowCount === 0) throw branchNotFound();
  const current = serialize('customer_branches', cur.rows[0]);
  if (fields.branch_name) fields.branch_name = fields.branch_name.replace(/\s+/g, ' ');
  const cols = BRANCH_FIELDS.filter((f) => fields[f] !== undefined && (fields[f] ?? null) !== (current[f] ?? null));
  if (cols.length === 0) return { branch: current, message: 'Nothing changed.' };
  const { rows } = await client.query(
    `UPDATE customer_branches SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE branch_id = $1 RETURNING ${selectList('customer_branches', 'pg')}`,
    [branch_id, ...cols.map((c) => fields[c] || null)]);
  await writeAudit(client, {
    entity: 'customer_branches', entity_id: branch_id, action: 'branch_edited', actor: req.user,
    details: { customer_id, before: Object.fromEntries(cols.map((c) => [c, current[c]])), after: Object.fromEntries(cols.map((c) => [c, fields[c]])) }
  });
  return { branch: serialize('customer_branches', rows[0]), message: `Branch ${rows[0].branch_name} updated.` };
}));

const branchArchiveRoute = (archive) => branchRoute(async (req, client) => {
  const { customer_id, branch_id } = req.params;
  const { rows } = await client.query(
    `UPDATE customer_branches SET archived_at = ${archive ? 'NOW()' : 'NULL'}, archived_by = $3
      WHERE branch_id = $1 AND customer_id = $2 RETURNING ${selectList('customer_branches', 'pg')}`,
    [branch_id, customer_id, archive ? req.user.user_id : null]);
  if (rows.length === 0) throw branchNotFound();
  await writeAudit(client, {
    entity: 'customer_branches', entity_id: branch_id, action: archive ? 'branch_archived' : 'branch_restored', actor: req.user, details: { customer_id }
  });
  return {
    branch: serialize('customer_branches', rows[0]),
    message: archive ? `Branch ${rows[0].branch_name} archived. Its past orders keep it; new orders cannot choose it.` : `Branch ${rows[0].branch_name} restored.`
  };
});
router.post('/:customer_id/branches/:branch_id/archive', requireRole(EDIT_ROLES), branchArchiveRoute(true));
router.post('/:customer_id/branches/:branch_id/restore', requireRole(EDIT_ROLES), branchArchiveRoute(false));

router.post('/:customer_id/archive', requireRole(ARCHIVE_ROLES), archiveRoute(true));
router.post('/:customer_id/restore', requireRole(ARCHIVE_ROLES), archiveRoute(false));

module.exports = router;

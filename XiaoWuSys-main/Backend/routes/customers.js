// ==========================================
// CUSTOMERS (needed to create orders: every order belongs to a customer)
// GET  /api/customers            -> { source, customers }
// POST /api/customers            -> 201 { message, source, customer }
//      Body: { full_name, contact_number?, platform_source? }
//      409 DUPLICATE_CUSTOMER when the same name + contact number already exists
// ==========================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { LOCAL_NOW } = require('../utils/localSync');
const { createValidator } = require('../utils/validation');
const { selectList, serialize, listRecords, readLocal, sqliteGet, sqliteRun } = require('../services/records');

const READ_ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
const WRITE_ROLES = ['Owner', 'Admin', 'Production'];

router.use(verifyToken);

router.get('/', requireRole(READ_ROLES), async (req, res) => {
  try {
    const result = await listRecords(req, 'customers', { orderBy: 'full_name, customer_id', limit: 1000 });
    res.status(200).json({ source: result.source, customers: result.records });
  } catch (err) {
    sendDbError(res, err, 'listing customers');
  }
});

const nameKey = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

router.post('/', requireRole(WRITE_ROLES), async (req, res) => {
  const body = req.body || {};
  const v = createValidator();
  const full_name = v.requiredString(body.full_name, 'full_name', 255);
  const contact_number = v.optionalString(body.contact_number, 'contact_number', 50);
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

module.exports = router;

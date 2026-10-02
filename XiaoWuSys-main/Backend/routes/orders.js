const express = require('express');
const crypto = require('crypto'); // Built-in Node module for generating UUIDs
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  normalizeRequiredItems,
  evaluateCapacity,
  capacityFailureResponse
} = require('../services/capacity');
const { isConnectionError, sendDbError } = require('../utils/dbErrors');
const { validateDriveLink } = require('../utils/validateDriveLink');
const { LOCAL_NOW, PG_VERSION_FORMAT, offlineUpdateBookkeeping } = require('../utils/localSync');

const VERSION_SQL = `to_char(last_modified, '${PG_VERSION_FORMAT}')`;

// H2: blocks writes to an order someone else holds the edit lock for (Owner prevails)
const requireOrderEditAccess = (req, res, next) => {
  const blocked = req.orderLocks && req.orderLocks.assertCanEdit(req.params.order_id, req.user);
  if (blocked) return res.status(409).json(blocked);
  next();
};

// Protect EVERY route in this file by telling the router to use the middleware first
router.use(verifyToken);

// Statuses staff can log when an order is halted for insufficient inventory (PB 10)
const HALT_RESOLUTIONS = ['Delayed', 'Cancelled'];

// ==========================================
// CREATE ORDER PROFILE (Sprint 6 / PB 6, capacity-gated in Sprint 9 / PB 9 & PB 10)
// Body: { customer_id, production_deadline, required_items: [{ inventory_id, quantity_needed }], resolution? }
//  - No resolution: stock is strictly evaluated; shortages -> 409 and NO order is created.
//  - resolution 'Delayed':   order is recorded as Delayed with the NEW production_deadline.
//  - resolution 'Cancelled': order is recorded as Cancelled (permanent record of the lost sale).
// ==========================================
router.post('/', requireRole(['Admin', 'Production']), async (req, res) => {
  const { customer_id, production_deadline, required_items, resolution } = req.body || {};

  // 1.) Validate required fields
  if (!customer_id || !production_deadline) {
    return res.status(400).json({ error: 'Customer ID and Production Deadline are required.' });
  }
  if (Number.isNaN(Date.parse(production_deadline))) {
    return res.status(400).json({ error: 'Production Deadline must be a valid date.' });
  }
  if (resolution !== undefined && !HALT_RESOLUTIONS.includes(resolution)) {
    return res.status(400).json({ error: `resolution must be one of: ${HALT_RESOLUTIONS.join(', ')}.` });
  }

  let production_status = 'Pending';

  if (resolution) {
    // Staff has acknowledged the capacity alert; log the outcome instead of halting.
    production_status = resolution;
    if (required_items !== undefined) {
      const normalized = normalizeRequiredItems(required_items);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
    }
  } else {
    // 2.) Strict server-side capacity gate: impossible orders are halted here,
    //     regardless of whether the client ran the pre-check.
    const normalized = normalizeRequiredItems(required_items);
    if (normalized.error) {
      return res.status(400).json({ error: normalized.error });
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
      console.warn(`⛔ Order halted (${failure.status}) for customer ${customer_id}: ${failure.body.error}`);
      return res.status(failure.status).json(failure.body);
    }
  }

  // 3.) Generate a universally unique ID to prevent sync collisions
  const order_id = crypto.randomUUID(); 

  try {
    console.log(`📡 Attempting to save Order ${order_id} (${production_status}) to Cloud...`);

    // 4.) Attempt 1: Push to PostgreSQL Cloud
    const newOrder = await req.pgPool.query(
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [order_id, customer_id, production_deadline, production_status]
    );
    
    console.log('✅ Order successfully saved to Cloud!');
    return res.status(201).json(newOrder.rows[0]);

  } catch (error) { // POST /  (create order)
    // C5: only a real connection failure may fall back to the offline cache
    if (!isConnectionError(error)) {
      return sendDbError(res, error, 'order creation');
    }

    console.error('❌ Cloud DB Error:', error.message);
    console.log('🔄 Cloud unavailable. Falling back to Local SQLite Cache...');
    
    const sqliteQuery = `
      INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, sync_status, last_modified) 
      VALUES (?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW})
    `;

    // 5.) Attempt 2: OFFLINE FALLBACK (Save locally as pending_insert)
    req.localDb.run(sqliteQuery, [order_id, customer_id, production_deadline, production_status], function(err) {
      if (err) {
        // H5: FK failures (customer not cached) now surface as 400, disk/lock errors as 500
        return sendDbError(res, err, 'saving order offline');
      }
      
      console.log(`✅ Order ${order_id} securely saved to local cache (pending sync)`);
      
      return res.status(201).json({ 
        message: 'Saved offline. Will sync to cloud when connection is restored.', 
        order_id, 
        production_status,
        status: `${production_status} (Offline Mode)`,
        sync_status: 'pending_insert'
      });
    });
  }
});

// ==========================================
// ENCODE ORDER DETAILS / ITEMS (Sprint 7 / PB 7)
// ==========================================
router.post('/:order_id/items', requireRole(['Admin', 'Production']), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  // Using your custom XiaoMei printing variables
  const { product_type, quantity, size, custom_name, custom_number } = req.body || {};

  // Generate the ID using your custom schema name
  const line_item_id = crypto.randomUUID();

  try {
    // 1. ATTEMPT ONLINE: Save directly to the Neon PostgreSQL database
    const query = `
      INSERT INTO order_items (line_item_id, order_id, product_type, quantity, size, custom_name, custom_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const values = [line_item_id, order_id, product_type, quantity, size, custom_name, custom_number];
    
    // Using your existing global req.pgPool!
    const result = await req.pgPool.query(query, values);
    
    res.status(201).json({ 
      message: "Order item added successfully (Online)", 
      item: result.rows[0] 
    });

  } catch (onlineError) { // POST /:order_id/items
    // C5: only a real connection failure may fall back to the offline cache
    if (!isConnectionError(onlineError)) {
      return sendDbError(res, onlineError, 'adding order item');
    }

    console.error("Cloud DB unreachable. Falling back to SQLite:", onlineError.message);

    // 2. ATTEMPT OFFLINE: Save to the local SQLite database
    const sqliteQuery = `
      INSERT INTO order_items (line_item_id, order_id, product_type, quantity, size, custom_name, custom_number, sync_status, last_modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW});
    `;
    const sqliteValues = [line_item_id, order_id, product_type, quantity, size, custom_name, custom_number];
    
    req.localDb.run(sqliteQuery, sqliteValues, function(offlineError) {
      if (offlineError) {
        return sendDbError(res, offlineError, 'saving order item offline');
      }
      
      res.status(201).json({ 
        message: "Order item saved locally (Offline Mode).",
        item: { line_item_id, order_id, product_type, quantity, size, custom_name, custom_number }
      });
    });
  }
});

// ==========================================
// RECORD ORDER PAYMENT
// ==========================================
router.post('/:order_id/payments', requireRole(['Admin', 'Production']), async (req, res) => {
  const { order_id } = req.params;
  const { amount, payment_type } = req.body || {};

  // Basic validation to ensure cashiers don't submit blank payments
  if (amount === undefined || !payment_type) {
    return res.status(400).json({ error: 'Payment amount and payment_type are required.' });
  }

  // Generate the unique ID for the cloud/local sync collision prevention
  const payment_id = crypto.randomUUID();

  try {
    // 1. ATTEMPT ONLINE: Save directly to the Neon PostgreSQL database
    const query = `
      INSERT INTO payments (payment_id, order_id, amount, payment_type)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const values = [payment_id, order_id, amount, payment_type];
    
    const result = await req.pgPool.query(query, values);
    
    res.status(201).json({ 
      message: "Payment recorded successfully (Online)", 
      payment: result.rows[0] 
    });

  } catch (onlineError) { // POST /:order_id/payments
    // C5: only a real connection failure may fall back to the offline cache
    if (!isConnectionError(onlineError)) {
      return sendDbError(res, onlineError, 'recording payment');
    }

    console.error("Cloud DB unreachable. Saving payment to SQLite:", onlineError.message);

    // 2. ATTEMPT OFFLINE: Save to the local SQLite database
    const sqliteQuery = `
      INSERT INTO payments (payment_id, order_id, amount, payment_type, sync_status, last_modified)
      VALUES (?, ?, ?, ?, 'pending_insert', ${LOCAL_NOW});
    `;
    const sqliteValues = [payment_id, order_id, amount, payment_type];
    
    req.localDb.run(sqliteQuery, sqliteValues, function(offlineError) {
      if (offlineError) {
        return sendDbError(res, offlineError, 'saving payment offline');
      }
      
      res.status(201).json({ 
        message: "Payment saved locally (Offline Mode). It will sync to the cloud when internet is restored.",
        payment: { payment_id, order_id, amount, payment_type }
      });
    });
  }
});

// ==========================================
// LINK DESIGN FILE (Sprint 8 / PB 8)
// Body: { design_drive_link, expected_version? }
//  H6: link must be an https:// drive.google.com or docs.google.com URL
//  H2: 409 ORDER_LOCKED if another user holds the edit lock (Owner prevails)
//  C3: if expected_version is sent and the cloud row changed since, 409 EDIT_CONFLICT
// ==========================================
router.patch('/:order_id/design', requireRole(['Admin', 'Production']), requireOrderEditAccess, async (req, res) => {
  const { order_id } = req.params;
  const { design_drive_link, expected_version } = req.body || {};

  const validation = validateDriveLink(design_drive_link);
  if (validation.error) {
    return res.status(400).json({ error: 'INVALID_DRIVE_LINK', message: validation.error });
  }
  if (expected_version !== undefined && typeof expected_version !== 'string') {
    return res.status(400).json({ error: 'expected_version must be the string returned as "version".' });
  }
  const link = validation.url;

  try {
    // 1. ATTEMPT ONLINE: optimistic update, only if the row is still at expected_version
    const result = await req.pgPool.query(
      `UPDATE order_profiles 
          SET design_drive_link = $1, last_modified = NOW()
        WHERE order_id = $2
          AND ($3::text IS NULL OR ${VERSION_SQL} = $3::text)
        RETURNING *, ${VERSION_SQL} AS version`,
      [link, order_id, expected_version || null]
    );

    if (result.rowCount === 0) {
      const current = await req.pgPool.query(
        `SELECT design_drive_link, production_status, ${VERSION_SQL} AS version FROM order_profiles WHERE order_id = $1`,
        [order_id]
      );
      if (current.rowCount === 0) {
        return res.status(404).json({ error: 'Order not found in cloud database.' });
      }
      return res.status(409).json({
        error: 'EDIT_CONFLICT',
        message: 'This order was changed by someone else. Reload it and apply your change again.',
        current: current.rows[0]
      });
    }

    res.status(200).json({ 
        message: 'Design linked successfully (Online)', 
        order: result.rows[0],
        version: result.rows[0].version
    });

  } catch (onlineError) { // PATCH /:order_id/design
    // C5: only a real connection failure may fall back to the offline cache
    if (!isConnectionError(onlineError)) {
      return sendDbError(res, onlineError, 'linking design file');
    }
    
    console.error('Cloud DB Error. Updating locally...', onlineError.message);
    
    // 2. ATTEMPT OFFLINE: record the field as dirty so sync pushes ONLY this change (C3),
    //    and bump last_modified so an in-flight sync will not mark it synced (H3)
    const sqliteQuery = `
      UPDATE order_profiles 
         SET design_drive_link = ?, ${offlineUpdateBookkeeping('order_profiles', ['design_drive_link'])}
       WHERE order_id = ?;
    `;

    req.localDb.run(sqliteQuery, [link, order_id], function(offlineError) {
      if (offlineError) {
        return sendDbError(res, offlineError, 'linking design file offline');
      }
      
      // Safety check for SQLite: 'this.changes' returns how many rows were updated
      if (this.changes === 0) {
          return res.status(404).json({ error: 'Order not found in local cache.' });
      }

      res.status(200).json({ 
        message: 'Design linked locally (Offline Mode). Will sync when internet is restored.', 
        order_id, 
        design_drive_link: link,
        version: null // cloud version unknown until the next sync
      });
    });
  }
});

module.exports = router;

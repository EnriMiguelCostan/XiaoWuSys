const express = require('express');
const crypto = require('crypto'); // Built-in Node module for generating UUIDs
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

// Protect EVERY route in this file by telling the router to use the middleware first
router.use(verifyToken);

// ==========================================
// CREATE ORDER PROFILE (Sprint 6 / PB 6)
// ==========================================
router.post('/', requireRole(['Admin', 'Production']), async (req, res) => {
  const { customer_id, production_deadline } = req.body;

  // 1.) Validate required fields
  if (!customer_id || !production_deadline) {
    return res.status(400).json({ error: 'Customer ID and Production Deadline are required.' });
  }

  // 2.) Generate a universally unique ID to prevent sync collisions
  const order_id = crypto.randomUUID(); 

  try {
    console.log(`📡 Attempting to save Order ${order_id} to Cloud...`);

    // 3.) Attempt 1: Push to PostgreSQL Cloud
    const newOrder = await req.pgPool.query(
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline) 
       VALUES ($1, $2, $3) RETURNING *`,
      [order_id, customer_id, production_deadline]
    );
    
    console.log('✅ Order successfully saved to Cloud!');
    return res.status(201).json(newOrder.rows[0]);

  } catch (error) {
    console.error('❌ Cloud DB Error:', error.message);
    console.log('🔄 Cloud unavailable. Falling back to Local SQLite Cache...');
    
    const sqliteQuery = `
      INSERT INTO order_profiles (order_id, customer_id, production_deadline, sync_status) 
      VALUES (?, ?, ?, 'pending_insert')
    `;

    // 4.) Attempt 2: OFFLINE FALLBACK (Save locally as pending_insert)
    req.localDb.run(sqliteQuery, [order_id, customer_id, production_deadline], function(err) {
      if (err) {
        // If this hits, the hard drive is full or the database file is locked
        console.error('❌ Local Cache Error:', err.message);
        return res.status(500).json({ error: 'CRITICAL: Both Cloud and Local databases failed.' });
      }
      
      console.log(`✅ Order ${order_id} securely saved to local cache (pending sync)`);
      
      return res.status(201).json({ 
        message: 'Saved offline. Will sync to cloud when connection is restored.', 
        order_id, 
        status: 'Pending (Offline Mode)',
        sync_status: 'pending_insert'
      });
    });
  }
});

// ==========================================
// ENCODE ORDER DETAILS / ITEMS (Sprint 7 / PB 7)
// ==========================================
router.post('/:order_id/items', requireRole(['Admin', 'Production']), async (req, res) => {
  const { order_id } = req.params;
  // Using your custom XiaoMei printing variables
  const { product_type, quantity, size, custom_name, custom_number } = req.body;

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

  } catch (onlineError) {
    console.error("Cloud DB unreachable. Falling back to SQLite:", onlineError.message);

    // 2. ATTEMPT OFFLINE: Save to the local SQLite database
    try {
      const sqliteQuery = `
        INSERT INTO order_items (line_item_id, order_id, product_type, quantity, size, custom_name, custom_number, sync_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_insert');
      `;
      const sqliteValues = [line_item_id, order_id, product_type, quantity, size, custom_name, custom_number];
      
      // Using your existing global req.localDb!
      req.localDb.run(sqliteQuery, sqliteValues, function(offlineError) {
        if (offlineError) {
          console.error("SQLite Error:", offlineError);
          return res.status(500).json({ error: "Critical Failure: Both Cloud and Local databases are unreachable." });
        }
        
        res.status(201).json({ 
          message: "Order item saved locally (Offline Mode).",
          item: { line_item_id, order_id, product_type, quantity, size, custom_name, custom_number }
        });
      });
    } catch (fallbackError) {
      res.status(500).json({ error: "Failed to execute offline fallback." });
    }
  }
});

// ==========================================
// RECORD ORDER PAYMENT
// ==========================================
router.post('/:order_id/payments', requireRole(['Admin', 'Production']), async (req, res) => {
  const { order_id } = req.params;
  const { amount, payment_type } = req.body;

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

  } catch (onlineError) {
    console.error("Cloud DB unreachable. Saving payment to SQLite:", onlineError.message);

    // 2. ATTEMPT OFFLINE: Save to the local SQLite database
    try {
      const sqliteQuery = `
        INSERT INTO payments (payment_id, order_id, amount, payment_type, sync_status)
        VALUES (?, ?, ?, ?, 'pending_insert');
      `;
      const sqliteValues = [payment_id, order_id, amount, payment_type];
      
      req.localDb.run(sqliteQuery, sqliteValues, function(offlineError) {
        if (offlineError) {
          console.error("SQLite Error:", offlineError);
          return res.status(500).json({ error: "Critical Failure: Both Cloud and Local databases are unreachable." });
        }
        
        res.status(201).json({ 
          message: "Payment saved locally (Offline Mode). It will sync to the cloud when internet is restored.",
          payment: { payment_id, order_id, amount, payment_type }
        });
      });
    } catch (fallbackError) {
      res.status(500).json({ error: "Failed to execute offline fallback." });
    }
  }
});

// ==========================================
// LINK DESIGN FILE (Sprint 8 / PB 8)
// ==========================================
router.patch('/:order_id/design', requireRole(['Admin', 'Production']), async (req, res) => {
  const { order_id } = req.params;
  const { design_drive_link } = req.body;

  if (!design_drive_link) {
    return res.status(400).json({ error: 'Google Drive link is required.' });
  }

  try {
    // 1. ATTEMPT ONLINE: Update PostgreSQL in the Cloud
    const query = `
      UPDATE order_profiles 
      SET design_drive_link = $1 
      WHERE order_id = $2 
      RETURNING *;
    `;
    const values = [design_drive_link, order_id];
    
    const result = await req.pgPool.query(query, values);
    
    // Safety check: Did the query actually find an order to update?
    if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Order not found in cloud database.' });
    }

    res.status(200).json({ 
        message: 'Design linked successfully (Online)', 
        order: result.rows[0] 
    });

  } catch (onlineError) {
    console.error('Cloud DB Error. Updating locally...', onlineError.message);
    
    // 2. ATTEMPT OFFLINE: Update SQLite and flag as pending_update
    try {
      const sqliteQuery = `
        UPDATE order_profiles 
        SET design_drive_link = ?, sync_status = 'pending_update'
        WHERE order_id = ?;
      `;
      const sqliteValues = [design_drive_link, order_id];

      req.localDb.run(sqliteQuery, sqliteValues, function(offlineError) {
        if (offlineError) {
          console.error('SQLite Error:', offlineError);
          return res.status(500).json({ error: 'Critical Failure: Both Cloud and Local databases are unreachable.' });
        }
        
        // Safety check for SQLite: 'this.changes' returns how many rows were updated
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Order not found in local cache.' });
        }

        res.status(200).json({ 
          message: 'Design linked locally (Offline Mode). Will sync when internet is restored.', 
          order_id, 
          design_drive_link 
        });
      });
    } catch (fallbackError) {
      res.status(500).json({ error: 'Failed to execute offline fallback.' });
    }
  }
});

module.exports = router;
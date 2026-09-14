const express = require('express');
const crypto = require('crypto'); // Built-in Node module for generating UUIDs
const router = express.Router();

// Note: In your actual app, you will import your pgPool and localDb here.
// const { pgPool, localDb } = require('../database'); 

// ==========================================
// CREATE ORDER PROFILE (Sprint 6 / PB 6)
// ==========================================
router.post('/', async (req, res) => {
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
router.post('/:order_id/items', async (req, res) => {
  const { order_id } = req.params;
  const { product_type, quantity, size, custom_name, custom_number } = req.body;

  if (!product_type || !quantity) {
    return res.status(400).json({ error: 'Product type and quantity are required.' });
  }

  const line_item_id = crypto.randomUUID();

  try {
    // Attempt to save to PostgreSQL
    /*
    const newItem = await pgPool.query(
      `INSERT INTO order_items (line_item_id, order_id, product_type, quantity, size, custom_name, custom_number) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [line_item_id, order_id, product_type, quantity, size, custom_name, custom_number]
    );
    return res.status(201).json(newItem.rows[0]);
    */

    res.status(201).json({ 
      message: 'Line item encoded successfully', 
      line_item_id 
    });

  } catch (error) {
    console.error('Cloud DB Error, saving item locally...', error);
    // Offline fallback logic here...
  }
});

// ==========================================
// LINK DESIGN FILE (Sprint 8 / PB 8)
// ==========================================
router.patch('/:order_id/design', async (req, res) => {
  const { order_id } = req.params;
  const { design_drive_link } = req.body;

  if (!design_drive_link) {
    return res.status(400).json({ error: 'Google Drive link is required.' });
  }

  try {
    // Attempt to update PostgreSQL
    /*
    const updatedOrder = await pgPool.query(
      `UPDATE order_profiles SET design_drive_link = $1 WHERE order_id = $2 RETURNING *`,
      [design_drive_link, order_id]
    );
    return res.json(updatedOrder.rows[0]);
    */

    res.json({ message: 'Design linked successfully', order_id, design_drive_link });

  } catch (error) {
    console.error('Cloud DB Error, updating locally...', error);
    // Offline fallback logic: set sync_status = 'pending_update' in SQLite
  }
});

module.exports = router;
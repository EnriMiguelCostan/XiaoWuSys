const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.use(verifyToken);

// ==========================================
// 1. ADD NEW INVENTORY ITEM
// ==========================================
router.post('/', requireRole(['Admin', 'Production']), async (req, res) => {
  const { item_name, item_category, quantity_available, minimum_threshold, unit_cost } = req.body;

  if (!item_name || !item_category || unit_cost === undefined) {
    return res.status(400).json({ error: 'Name, category, and unit cost are required.' });
  }

  const inventory_id = crypto.randomUUID();

  try {
    const query = `
      INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const values = [inventory_id, item_name, item_category, quantity_available || 0, minimum_threshold || 0, unit_cost];
    
    const result = await req.pgPool.query(query, values);
    res.status(201).json({ message: "Inventory item added (Online)", item: result.rows[0] });

  } catch (onlineError) {
    console.error("Cloud DB unreachable. Saving inventory to SQLite:", onlineError.message);
    try {
      const sqliteQuery = `
        INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost, sync_status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending_insert');
      `;
      const sqliteValues = [inventory_id, item_name, item_category, quantity_available || 0, minimum_threshold || 0, unit_cost];
      
      req.localDb.run(sqliteQuery, sqliteValues, function(offlineError) {
        if (offlineError) return res.status(500).json({ error: "Critical Failure: Both databases unreachable." });
        
        res.status(201).json({ 
          message: "Inventory item saved locally (Offline Mode).", 
          item: { inventory_id, item_name, item_category, quantity_available, minimum_threshold, unit_cost } 
        });
      });
    } catch (fallbackError) {
      res.status(500).json({ error: "Offline fallback failed." });
    }
  }
});

// ==========================================
// 2. RECORD MATERIAL LOSS
// ==========================================
router.post('/:inventory_id/loss', requireRole(['Admin', 'Production']), async (req, res) => {
  const { inventory_id } = req.params;
  const { order_id, quantity_lost, loss_reason, financial_cost } = req.body;

  if (!quantity_lost || !loss_reason) {
    return res.status(400).json({ error: 'Quantity lost and reason are required.' });
  }

  const loss_id = crypto.randomUUID();
  // If no order_id is provided (e.g., general shop damage), set it to null
  const linked_order = order_id || null; 

  try {
    const query = `
      INSERT INTO material_loss (loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const values = [loss_id, linked_order, inventory_id, quantity_lost, loss_reason, financial_cost || 0.00];
    
    const result = await req.pgPool.query(query, values);
    res.status(201).json({ message: "Material loss recorded (Online)", loss: result.rows[0] });

  } catch (onlineError) {
    console.error("Cloud DB unreachable. Saving loss to SQLite:", onlineError.message);
    try {
      const sqliteQuery = `
        INSERT INTO material_loss (loss_id, order_id, inventory_id, quantity_lost, loss_reason, financial_cost, sync_status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending_insert');
      `;
      const sqliteValues = [loss_id, linked_order, inventory_id, quantity_lost, loss_reason, financial_cost || 0.00];
      
      req.localDb.run(sqliteQuery, sqliteValues, function(offlineError) {
        if (offlineError) return res.status(500).json({ error: "Critical Failure: Both databases unreachable." });
        
        res.status(201).json({ 
          message: "Material loss saved locally (Offline Mode).", 
          loss: { loss_id, order_id: linked_order, inventory_id, quantity_lost, loss_reason, financial_cost } 
        });
      });
    } catch (fallbackError) {
      res.status(500).json({ error: "Offline fallback failed." });
    }
  }
});

// ==========================================
// 3. INVENTORY CAPACITY PRE-CHECK (PB 9 & PB 10)
// ==========================================
router.post('/check-capacity', requireRole(['Admin', 'Staff']), async (req, res) => {
  // Expects an array of objects: [{ inventory_id: "...", quantity_needed: 50 }]
  const { required_items } = req.body; 

  if (!required_items || !Array.isArray(required_items) || required_items.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of required_items.' });
  }

  try {
    const shortages = [];
    
    // 1. ATTEMPT ONLINE: Check Neon PostgreSQL DB
    for (const item of required_items) {
      const result = await req.pgPool.query(
        'SELECT item_name, quantity_available FROM inventory_items WHERE inventory_id = $1',
        [item.inventory_id]
      );

      if (result.rows.length > 0) {
        const stock = result.rows[0].quantity_available;
        // Evaluate incoming order quantities against current stock (PB 9)
        if (stock < item.quantity_needed) {
          shortages.push({
            inventory_id: item.inventory_id,
            item_name: result.rows[0].item_name,
            requested: item.quantity_needed,
            available: stock,
            shortfall: item.quantity_needed - stock
          });
        }
      }
    }

    // 2. EVALUATE & RESPOND (PB 10 Trigger)
    if (shortages.length > 0) {
      return res.status(200).json({
        can_fulfill: false,
        message: "CAPACITY ALERT: Impossible order halted. Please offer customer delay or cancel options.",
        shortages: shortages
      });
    }

    return res.status(200).json({
      can_fulfill: true,
      message: "Capacity pre-check passed. Sufficient stock available."
    });

  } catch (onlineError) {
    console.error("Cloud DB unreachable. Checking SQLite offline cache:", onlineError.message);
    
    // 3. OFFLINE FALLBACK: Wrap SQLite in a Promise for a clean loop
    const shortages = [];
    try {
      for (const item of required_items) {
        const row = await new Promise((resolve, reject) => {
          req.localDb.get(
            'SELECT item_name, quantity_available FROM inventory_items WHERE inventory_id = ?',
            [item.inventory_id],
            (err, data) => err ? reject(err) : resolve(data)
          );
        });

        if (row && row.quantity_available < item.quantity_needed) {
          shortages.push({
            inventory_id: item.inventory_id,
            item_name: row.item_name,
            requested: item.quantity_needed,
            available: row.quantity_available,
            shortfall: item.quantity_needed - row.quantity_available
          });
        }
      }

      if (shortages.length > 0) {
        return res.status(200).json({ can_fulfill: false, message: "CAPACITY ALERT (Offline)", shortages });
      }
      return res.status(200).json({ can_fulfill: true, message: "Capacity pre-check passed (Offline)." });

    } catch (offlineError) {
      return res.status(500).json({ error: "Critical Failure: Both databases unreachable for capacity check." });
    }
  }
});

module.exports = router;
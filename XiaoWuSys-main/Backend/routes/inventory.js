const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  computeAvailable,
  normalizeRequiredItems,
  evaluateCapacity,
  capacityFailureResponse
} = require('../services/capacity');

router.use(verifyToken);

// ==========================================
// 0. LIST INVENTORY ITEMS (used by the Create Order item picker)
// ==========================================
router.get('/', requireRole(['Admin', 'Production', 'Staff']), async (req, res) => {
  const withAvailability = (rows) =>
    rows.map((row) => ({ ...row, quantity_available_net: computeAvailable(row) }));

  try {
    const result = await req.pgPool.query(
      `SELECT inventory_id, item_name, item_category, quantity_available, quantity_reserved, minimum_threshold, unit_cost
       FROM inventory_items ORDER BY item_name`
    );
    return res.status(200).json({ source: 'cloud', items: withAvailability(result.rows) });
  } catch (onlineError) {
    console.error('Cloud DB unreachable. Listing inventory from SQLite:', onlineError.message);
    req.localDb.all(
      `SELECT inventory_id, item_name, item_category, quantity_available, quantity_reserved, minimum_threshold, unit_cost
       FROM inventory_items ORDER BY item_name`,
      [],
      (offlineError, rows) => {
        if (offlineError) {
          return res.status(500).json({ error: 'Critical Failure: Both databases unreachable.' });
        }
        return res.status(200).json({ source: 'local', items: withAvailability(rows) });
      }
    );
  }
});

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
// 3. INVENTORY CAPACITY PRE-CHECK (PB 9)
// Body: { required_items: [{ inventory_id, quantity_needed }] }
// 200 -> can fulfill | 409 -> halted (shortages) | 404 -> unknown item | 400 -> bad payload
// ==========================================
router.post('/check-capacity', requireRole(['Admin', 'Production', 'Staff']), async (req, res) => {
  const { required_items } = req.body || {};

  const normalized = normalizeRequiredItems(required_items);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  let evaluation;
  try {
    evaluation = await evaluateCapacity(req, normalized.items);
  } catch (offlineError) {
    console.error('Capacity check failed on both databases:', offlineError.message);
    return res.status(500).json({ error: 'Critical Failure: Both databases unreachable for capacity check.' });
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

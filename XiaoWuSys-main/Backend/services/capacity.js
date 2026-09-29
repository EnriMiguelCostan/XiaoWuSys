// ==========================================
// INVENTORY CAPACITY EVALUATION (Sprint 9 / PB 9)
// Shared by POST /api/inventory/check-capacity and POST /api/orders
// so the halt logic cannot be bypassed by skipping the pre-check.
// ==========================================

// Available stock = what is on hand minus what is already promised to other orders
const computeAvailable = (row) =>
  Math.max(0, Number(row.quantity_available || 0) - Number(row.quantity_reserved || 0));

// Validates the incoming payload and merges duplicate inventory_ids
// (two lines of the same material must be checked against stock together).
const normalizeRequiredItems = (required_items) => {
  if (!Array.isArray(required_items) || required_items.length === 0) {
    return { error: 'Please provide a non-empty array of required_items: [{ inventory_id, quantity_needed }].' };
  }

  const totals = new Map();

  for (let i = 0; i < required_items.length; i++) {
    const item = required_items[i] || {};
    const inventory_id = typeof item.inventory_id === 'string' ? item.inventory_id.trim() : '';
    const raw = item.quantity_needed;
    const quantity_needed = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;

    if (!inventory_id) {
      return { error: `required_items[${i}].inventory_id is required.` };
    }
    if (typeof quantity_needed !== 'number' || !Number.isInteger(quantity_needed) || quantity_needed <= 0) {
      return { error: `required_items[${i}].quantity_needed must be a positive whole number.` };
    }

    totals.set(inventory_id, (totals.get(inventory_id) || 0) + quantity_needed);
  }

  return {
    items: [...totals].map(([inventory_id, quantity_needed]) => ({ inventory_id, quantity_needed }))
  };
};

// Reads stock for the given IDs: Neon first, SQLite cache if the cloud is unreachable.
const fetchStockRows = async (req, inventoryIds) => {
  try {
    const result = await req.pgPool.query(
      `SELECT inventory_id, item_name, quantity_available, quantity_reserved
       FROM inventory_items
       WHERE inventory_id::text = ANY($1::text[])`,
      [inventoryIds]
    );
    return { rows: result.rows, source: 'cloud' };
  } catch (onlineError) {
    console.error('Cloud DB unreachable. Checking capacity against SQLite cache:', onlineError.message);

    const placeholders = inventoryIds.map(() => '?').join(', ');
    const rows = await new Promise((resolve, reject) => {
      req.localDb.all(
        `SELECT inventory_id, item_name, quantity_available, quantity_reserved
         FROM inventory_items
         WHERE inventory_id IN (${placeholders})`,
        inventoryIds,
        (err, data) => (err ? reject(err) : resolve(data))
      );
    });
    return { rows, source: 'local' };
  }
};

// Strictly evaluates normalized items against stock.
// Throws only if BOTH databases fail.
const evaluateCapacity = async (req, items) => {
  const { rows, source } = await fetchStockRows(req, items.map((i) => i.inventory_id));
  const stockById = new Map(rows.map((row) => [String(row.inventory_id), row]));

  const missing = [];
  const shortages = [];

  for (const item of items) {
    const row = stockById.get(item.inventory_id);
    if (!row) {
      missing.push(item.inventory_id);
      continue;
    }

    const available = computeAvailable(row);
    if (item.quantity_needed > available) {
      shortages.push({
        inventory_id: item.inventory_id,
        item_name: row.item_name,
        requested: item.quantity_needed,
        available,
        shortfall: item.quantity_needed - available
      });
    }
  }

  return { source, missing, shortages };
};

// Converts an evaluation into the HTTP error to send, or null if the order can proceed.
const capacityFailureResponse = ({ source, missing, shortages }) => {
  if (missing.length > 0) {
    return {
      status: 404,
      body: {
        error: 'INVENTORY_ITEM_NOT_FOUND',
        message: 'One or more requested inventory items do not exist.',
        missing_inventory_ids: missing,
        source
      }
    };
  }

  if (shortages.length > 0) {
    return {
      status: 409,
      body: {
        error: 'INSUFFICIENT_INVENTORY',
        can_fulfill: false,
        message: 'CAPACITY ALERT: Order exceeds maximum inventory. Order halted. Please delay or cancel.',
        shortages,
        total_shortfall: shortages.reduce((sum, s) => sum + s.shortfall, 0),
        source
      }
    };
  }

  return null;
};

module.exports = {
  computeAvailable,
  normalizeRequiredItems,
  evaluateCapacity,
  capacityFailureResponse
};

// ==========================================
// CONSUMABLES (PB 15): reading usage rates and deductions, and taking consumables from stock
// inside the status-change transaction. The rules (which status sets off which rate, the
// rate x quantity formula, clamping at 0) are in services/domain/consumables.js.
// ==========================================
const crypto = require('crypto');
const { isConnectionError } = require('../utils/dbErrors');
const { selectList, serialize, sqliteAll } = require('./records');
const { plannedDeductions, clampDeduction, triggersFor, CONSUMABLE_TRIGGERS } = require('./domain/consumables');
const { auditCloud } = require('./inventoryAudit');

const REMOVED_ITEM = 'Removed item';
const TRIGGER_ORDER_SQL = `CASE r.trigger_status ${CONSUMABLE_TRIGGERS.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ')} ELSE 9 END`;

// Cloud first, the local copy when the cloud is unreachable (C5) -> { source, rows }
const readBoth = async (req, pgSql, sqliteSql, params) => {
  try {
    const { rows } = await req.pgPool.query(pgSql, params);
    return { source: 'cloud', rows };
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    return { source: 'local', rows: await sqliteAll(req.localDb, sqliteSql, params) };
  }
};

// One blank's usage rates, with each consumable's name and unit
// -> { source, rates: [{ rate_id, consumable_inventory_id, consumable_name, consumable_unit,
//      consumable_in_recycle_bin, quantity_per_piece, trigger_status, version }] }
const loadRates = async (req, productId) => {
  const sql = (dialect) => `
    SELECT ${selectList('consumable_rates', dialect, 'r')}, c.item_name AS consumable_name, c.unit AS consumable_unit,
           CASE WHEN c.deleted_at IS NULL THEN 0 ELSE 1 END AS in_bin
      FROM consumable_rates r LEFT JOIN inventory_items c ON c.inventory_id = r.consumable_inventory_id
     WHERE r.product_inventory_id = ${dialect === 'pg' ? '$1' : '?'}
     ORDER BY ${TRIGGER_ORDER_SQL}, c.item_name, r.rate_id`;
  const { source, rows } = await readBoth(req, sql('pg'), sql('sqlite'), [productId]);
  return {
    source,
    rates: rows.map((row) => ({
      ...serialize('consumable_rates', row),
      consumable_name: row.consumable_name || REMOVED_ITEM,
      consumable_unit: row.consumable_unit || null,
      consumable_in_recycle_bin: Number(row.in_bin) === 1
    }))
  };
};

// What an order's status changes took from stock, oldest first
// -> { source, consumables: [{ log_id, trigger_status, consumable_inventory_id, item_name, unit,
//      quantity_deducted, shortfall, deducted_at }] }
const loadOrderConsumables = async (req, orderId) => {
  const sql = (dialect) => `
    SELECT ${selectList('order_consumables_log', dialect, 'l')}, c.item_name AS item_name, c.unit AS unit
      FROM order_consumables_log l LEFT JOIN inventory_items c ON c.inventory_id = l.consumable_inventory_id
     WHERE l.order_id = ${dialect === 'pg' ? '$1' : '?'}
     ORDER BY l.deducted_at, ${TRIGGER_ORDER_SQL.replace('r.trigger_status', 'l.trigger_status')}, c.item_name, l.log_id`;
  // (rows of one status change share deducted_at: the step, then the name, keep the list stable)
  const { source, rows } = await readBoth(req, sql('pg'), sql('sqlite'), [orderId]);
  return { source, consumables: rows.map((row) => shown(serialize('order_consumables_log', row), row)) };
};

const shown = (log, row) => ({
  log_id: log.log_id,
  trigger_status: log.trigger_status,
  consumable_inventory_id: log.consumable_inventory_id,
  item_name: (row && row.item_name) || REMOVED_ITEM,
  unit: (row && row.unit) || null,
  quantity_deducted: log.quantity_deducted,
  shortfall: log.shortfall,
  deducted_at: log.deducted_at
});

// ---------- Inside the status-change transaction (cloud only) ----------

// Step 1, BEFORE any stock row is locked: what this change has to take, and which consumable
// rows must be locked with the order's materials (all in one ORDER BY inventory_id lock, so two
// status changes can never deadlock).
//   lines: [{ inventory_id, quantity_needed }] the order's materials (summed per item)
// -> { planned: [{ trigger_status, consumable_inventory_id, needed }], ids: [consumable ids] }
const planConsumables = async (client, { order_id, from, to, lines }) => {
  const triggers = triggersFor(from, to);
  const productIds = lines.map((l) => l.inventory_id);
  if (triggers.length === 0 || productIds.length === 0) return { planned: [], ids: [] };
  const rates = await client.query(
    `SELECT product_inventory_id, consumable_inventory_id, quantity_per_piece::text AS quantity_per_piece, trigger_status
       FROM consumable_rates
      WHERE product_inventory_id = ANY($1::text[]) AND trigger_status = ANY($2::text[])`,
    [productIds, triggers]);
  if (rates.rowCount === 0) return { planned: [], ids: [] };
  const done = await client.query(
    'SELECT trigger_status, consumable_inventory_id FROM order_consumables_log WHERE order_id = $1', [order_id]);
  const planned = plannedDeductions({
    items: lines.map((l) => ({ inventory_id: l.inventory_id, quantity: l.quantity_needed })),
    rates: rates.rows,
    triggers,
    done: done.rows
  });
  return { planned, ids: [...new Set(planned.map((p) => p.consumable_inventory_id))] };
};

// Step 2, after the rows are locked: take each consumable (never below 0), record it once in
// order_consumables_log and in the inventory trail. Items in the Recycle Bin or permanently
// deleted are skipped and not recorded, so nothing is marked as taken that was not.
//   rowsById: the locked inventory rows (materials and consumables)
// -> [{ log_id, trigger_status, consumable_inventory_id, item_name, unit, needed, quantity_deducted, shortfall }]
const applyConsumables = async (client, req, { order_id, planned, rowsById }) => {
  const done = [];
  for (const p of planned) {
    const locked = rowsById.get(p.consumable_inventory_id);
    if (!locked || locked.deleted_at || locked.purged_at) continue;
    // Read again: completing the order may have just used some of the same item as a material
    const now = await client.query(
      'SELECT quantity_available, item_name, unit FROM inventory_items WHERE inventory_id = $1', [p.consumable_inventory_id]);
    const row = now.rows[0];
    const before = Number(row.quantity_available);
    const { quantity_deducted, shortfall } = clampDeduction(p.needed, before);
    if (quantity_deducted > 0) {
      // Guarded in SQL as well: stock never goes below 0
      const taken = await client.query(
        `UPDATE inventory_items SET quantity_available = quantity_available - $1
          WHERE inventory_id = $2 AND quantity_available >= $1`, [quantity_deducted, p.consumable_inventory_id]);
      if (taken.rowCount !== 1) throw new Error(`consumable ${p.consumable_inventory_id} changed while locked`);
    }
    const log_id = crypto.randomUUID();
    await client.query(
      `INSERT INTO order_consumables_log (log_id, order_id, trigger_status, consumable_inventory_id, quantity_deducted, shortfall)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [log_id, order_id, p.trigger_status, p.consumable_inventory_id, quantity_deducted, shortfall]);
    await auditCloud(client, req.user, p.consumable_inventory_id, 'stock_subtracted', row.item_name, {
      kind: 'consumable_deducted',
      order_id,
      trigger_status: p.trigger_status,
      needed: p.needed,
      quantity_deducted,
      shortfall,
      quantity_before: before,
      quantity_after: before - quantity_deducted
    });
    done.push({
      log_id, trigger_status: p.trigger_status, consumable_inventory_id: p.consumable_inventory_id,
      item_name: row.item_name, unit: row.unit || null, needed: p.needed, quantity_deducted, shortfall
    });
  }
  return done;
};

// A short plain sentence for the status-change message (empty when nothing was taken)
const consumablesSentence = (taken) => {
  if (taken.length === 0) return '';
  const short = taken.filter((t) => t.shortfall > 0);
  const used = ` Consumables used: ${taken.map((t) => `${t.quantity_deducted} ${t.unit || ''} ${t.item_name}`.replace(/\s+/g, ' ').trim()).join(', ')}.`;
  return used + (short.length
    ? ` Not enough on hand for ${short.map((t) => `${t.item_name} (short by ${t.shortfall})`).join(', ')}: the stock is now 0. Restock and correct the count.`
    : '');
};

module.exports = { loadRates, loadOrderConsumables, planConsumables, applyConsumables, consumablesSentence, REMOVED_ITEM };

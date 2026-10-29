// ==========================================
// STOCK CHECK FOR AN ORDER (pure rules: no HTTP, no SQL) - PB 9
// Tells the screens, before anyone presses Approve or Resume, whether the free stock covers
// the order. Only orders that do not hold their stock yet need it (stock_reserved = false,
// status Pending or Delayed): an order that already holds its reservation is covered.
// The approve / resume routes still re-check on locked rows; this is only advice.
// ==========================================
const { APPROVABLE_STATUSES } = require('./orderLifecycle');

const needsReservation = (order) => Boolean(order) && !order.stock_reserved && APPROVABLE_STATUSES.includes(order.production_status);

// Order items -> [{ inventory_id, quantity_needed }] (lines of the same material added up)
const stockNeeds = (items) => {
  const totals = new Map();
  for (const it of items || []) {
    if (!it.inventory_id) continue;
    totals.set(it.inventory_id, (totals.get(it.inventory_id) || 0) + Number(it.quantity || 0));
  }
  return [...totals].map(([inventory_id, quantity_needed]) => ({ inventory_id, quantity_needed }));
};

// evaluation: { source, missing: [ids], shortages: [{ inventory_id, item_name, requested, available, shortfall }] }
// -> { needs_reservation, sufficient, shortfalls: [{ inventory_id, item_name, needed, free, shortfall, missing }], source }
const buildStockCheck = (order, items, evaluation) => {
  if (!needsReservation(order)) {
    return { needs_reservation: false, sufficient: true, shortfalls: [], source: null };
  }
  const needs = stockNeeds(items);
  const neededById = new Map(needs.map((n) => [n.inventory_id, n.quantity_needed]));
  const nameById = new Map((items || []).filter((i) => i.inventory_id).map((i) => [i.inventory_id, i.product_type]));
  const { source = null, missing = [], shortages = [] } = evaluation || {};
  const shortfalls = [
    ...shortages.map((s) => ({
      inventory_id: s.inventory_id, item_name: s.item_name, needed: s.requested, free: s.available, shortfall: s.shortfall, missing: false
    })),
    ...missing.map((id) => ({
      inventory_id: id, item_name: nameById.get(id) || null, needed: neededById.get(id) || 0, free: 0, shortfall: neededById.get(id) || 0, missing: true
    }))
  ];
  return { needs_reservation: true, sufficient: shortfalls.length === 0, shortfalls, source };
};

module.exports = { needsReservation, stockNeeds, buildStockCheck };

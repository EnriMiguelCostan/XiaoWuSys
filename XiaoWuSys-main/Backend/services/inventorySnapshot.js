// ==========================================
// INVENTORY SNAPSHOT
// Single source for the catalog payload, used by GET /api/inventory AND the Socket.io
// 'inventory_updated' push, so REST and real-time clients always see the same shape.
// ==========================================
const { computeAvailable } = require('./capacity');
const { listRecords, countRecords, ACTIVE_ITEM_SQL, BIN_ITEM_SQL } = require('./records');

// Stock health, computed on the server so every screen uses the same rule:
//   out_of_stock  nothing free to use (available - reserved <= 0)
//   low_stock     free stock at or below minimum_threshold
//   in_stock      otherwise
const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock'];
const stockStatusOf = (net, threshold) => {
  if (net <= 0) return 'out_of_stock';
  if (net <= threshold) return 'low_stock';
  return 'in_stock';
};

const round2 = (n) => Math.round(n * 100) / 100;

// stock_value: what the stock on hand cost (quantity on hand x unit cost), so no screen multiplies money
const withAvailability = (item) => {
  const net = computeAvailable(item);
  return {
    ...item,
    quantity_available_net: net,
    stock_status: stockStatusOf(net, item.minimum_threshold || 0),
    stock_value: round2((item.quantity_available || 0) * (item.unit_cost || 0))
  };
};

// ctx: anything with pgPool + localDb (an Express req, or { pgPool, localDb })
// -> { source, fetched_at, summary, categories, items }
const buildInventorySnapshot = async (ctx, { category, stock_status, search } = {}) => {
  // Only active items; Recycle Bin items are listed separately (paginated) and only counted here
  const { source, records } = await listRecords(ctx, 'inventory_items', { where: ACTIVE_ITEM_SQL, orderBy: 'item_name, inventory_id' });
  let recycleBin = 0;
  try {
    recycleBin = (await countRecords(ctx, 'inventory_items', { where: BIN_ITEM_SQL })).count;
  } catch (err) {
    console.error('⚠️ Could not count Recycle Bin items:', err.message);
  }
  const all = records.map(withAvailability);

  const needle = search ? search.toLowerCase() : null;
  const items = all.filter((item) =>
    (!category || item.item_category === category) &&
    (!stock_status || item.stock_status === stock_status) &&
    (!needle || item.item_name.toLowerCase().includes(needle))
  );

  return {
    source,
    fetched_at: new Date().toISOString(),
    // summary/categories describe the whole catalog, not the filtered list
    summary: summarize(all, recycleBin),
    categories: categoriesOf(all),
    items
  };
};

// summary block of a snapshot, from the whole active catalog (items already withAvailability)
const summarize = (all, recycleBin) => {
  const count = (status) => all.filter((i) => i.stock_status === status).length;
  return {
    total_items: all.length,
    in_stock: count('in_stock'),
    low_stock: count('low_stock'),
    out_of_stock: count('out_of_stock'),
    unsynced: all.filter((i) => i.sync_status !== 'synced').length,
    recycle_bin: recycleBin,
    stock_value: round2(all.reduce((sum, i) => sum + i.quantity_available * i.unit_cost, 0)),
    total_units: all.reduce((sum, i) => sum + i.quantity_available, 0) // on hand, across the active catalog
  };
};
const categoriesOf = (all) => [...new Set(all.map((i) => i.item_category))].sort();

// Same order as the full snapshot (ORDER BY item_name, inventory_id)
const byNameThenId = (a, b) =>
  (a.item_name < b.item_name ? -1 : a.item_name > b.item_name ? 1 : 0) ||
  (a.inventory_id < b.inventory_id ? -1 : a.inventory_id > b.inventory_id ? 1 : 0);

// Egress fix (November 2026): after a stock change only the changed items are read from the
// cloud, not the whole catalog. -> { source, items: [active changed items], removed_ids }
// removed_ids: asked-for items that are no longer active (moved to the Recycle Bin, purged, gone)
const buildInventoryDelta = async (ctx, ids) => {
  const wanted = [...new Set((ids || []).filter(Boolean).map(String))];
  if (wanted.length === 0) return { source: 'cloud', items: [], removed_ids: [] };
  const { source, records } = await listRecords(ctx, 'inventory_items', {
    filters: [['inventory_id', wanted, 'IN']], where: ACTIVE_ITEM_SQL, orderBy: 'item_name, inventory_id'
  });
  const items = records.map(withAvailability);
  const found = new Set(items.map((i) => i.inventory_id));
  return { source, items, removed_ids: wanted.filter((id) => !found.has(id)) };
};

// Applies a delta to a full snapshot -> a new snapshot (the old one is not changed)
const applyInventoryDelta = (snapshot, delta, { recycleBin = snapshot.summary.recycle_bin, fetchedAt = new Date().toISOString() } = {}) => {
  const replaced = new Map(delta.items.map((i) => [i.inventory_id, i]));
  const removed = new Set(delta.removed_ids);
  const all = snapshot.items
    .filter((i) => !removed.has(i.inventory_id) && !replaced.has(i.inventory_id))
    .concat(delta.items)
    .sort(byNameThenId);
  return {
    source: delta.source,
    fetched_at: fetchedAt,
    summary: summarize(all, recycleBin),
    categories: categoriesOf(all),
    items: all
  };
};

module.exports = {
  STOCK_STATUSES, stockStatusOf, withAvailability, buildInventorySnapshot, buildInventoryDelta, applyInventoryDelta,
  countRecycleBin: async (ctx) => (await countRecords(ctx, 'inventory_items', { where: BIN_ITEM_SQL })).count
};

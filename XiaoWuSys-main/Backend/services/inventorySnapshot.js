// ==========================================
// INVENTORY SNAPSHOT
// Single source for the catalog payload, used by GET /api/inventory AND the Socket.io
// 'inventory_updated' push, so REST and real-time clients always see the same shape.
// ==========================================
const { computeAvailable } = require('./capacity');
const { listRecords } = require('./records');

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

const withAvailability = (item) => {
  const net = computeAvailable(item);
  return { ...item, quantity_available_net: net, stock_status: stockStatusOf(net, item.minimum_threshold || 0) };
};

// ctx: anything with pgPool + localDb (an Express req, or { pgPool, localDb })
// -> { source, fetched_at, summary, categories, items }
const buildInventorySnapshot = async (ctx, { category, stock_status, search } = {}) => {
  const { source, records } = await listRecords(ctx, 'inventory_items', { orderBy: 'item_name, inventory_id' });
  const all = records.map(withAvailability);

  const needle = search ? search.toLowerCase() : null;
  const items = all.filter((item) =>
    (!category || item.item_category === category) &&
    (!stock_status || item.stock_status === stock_status) &&
    (!needle || item.item_name.toLowerCase().includes(needle))
  );

  const count = (status) => all.filter((i) => i.stock_status === status).length;
  return {
    source,
    fetched_at: new Date().toISOString(),
    // summary/categories describe the whole catalog, not the filtered list
    summary: {
      total_items: all.length,
      in_stock: count('in_stock'),
      low_stock: count('low_stock'),
      out_of_stock: count('out_of_stock'),
      unsynced: all.filter((i) => i.sync_status !== 'synced').length,
      stock_value: Math.round(all.reduce((sum, i) => sum + i.quantity_available * i.unit_cost, 0) * 100) / 100
    },
    categories: [...new Set(all.map((i) => i.item_category))].sort(),
    items
  };
};

module.exports = { STOCK_STATUSES, stockStatusOf, withAvailability, buildInventorySnapshot };

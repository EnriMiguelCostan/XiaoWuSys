// Order wording shared by every screen. Plain JS (no React) so the future Next.js and mobile
// apps can reuse it.

// The number staff and customers use (PB 6): XM-2026-0123, given by the cloud database.
// An order saved offline gets its number when it syncs.
export const orderNumber = (order) => {
  if (!order) return '—';
  if (order.tracking_no) return order.tracking_no;
  if (order.sync_status && order.sync_status !== 'synced') return 'New order';
  return `#${String(order.order_id || '').slice(0, 8).toUpperCase()}`; // orders read from an older server
};

export const hasOrderNumber = (order) => Boolean(order && order.tracking_no);

export const NUMBER_AFTER_SYNC = 'This order gets its order number when it syncs to the cloud.';

// Accepts "xm-2026-0123" or " XM-2026-0123 " -> 'XM-2026-0123', or null if it is not an order number
export const normalizeOrderNumber = (text) => {
  const value = String(text || '').trim().toUpperCase();
  return /^XM-\d{4}-\d{4,9}$/.test(value) ? value : null;
};

// One line per stock shortfall from GET /api/orders/:id "stock_check" (PB 9)
export const shortfallLines = (stockCheck) => ((stockCheck && stockCheck.shortfalls) || []).map((s) => (s.missing
  ? `${s.item_name || 'A material'} is no longer in the inventory (needs ${s.needed}).`
  : `${s.item_name}: needs ${s.needed}, only ${s.free} free (short by ${s.shortfall}).`));

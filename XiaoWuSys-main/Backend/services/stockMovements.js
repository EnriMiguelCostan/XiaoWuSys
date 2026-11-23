// ==========================================
// STOCK CARD CONTEXT (migration 015)
// The database writes one stock_movements row for every change of inventory_items.
// quantity_available (trigger trg_inventory_items_stock_movement), whichever code made it.
// Before such an UPDATE, a transaction says WHAT the change is, so the stock card can show
// "Stock in SI-2026-0004" or "Used for order XM-2026-0012" instead of a bare number:
//
//   await setMovementContext(client, { type: 'stock_in', reference_type: 'stock_document',
//     reference_id, reference_no, note, actor: req.user, occurred_at, unit_cost });
//
// The setting is local to the transaction (set_config(..., true)), so it never leaks to the
// next request that gets the same pooled connection. Set it again before each kind of change.
// A change made with no context (e.g. an offline edit pushed by the sync) is recorded as 'sync'.
// ==========================================
const SETTING = 'xiaowu.stock_movement';

const setMovementContext = (client, {
  type, reference_type = null, reference_id = null, reference_no = null, note = null, actor = null,
  occurred_at = null, unit_cost = null
}) => client.query('SELECT set_config($1, $2, true)', [SETTING, JSON.stringify({
  type,
  reference_type,
  reference_id,
  reference_no,
  note: note ? String(note).slice(0, 1000) : null,
  performed_by: actor && actor.user_id ? String(actor.user_id) : null,
  performed_role: actor && actor.role ? String(actor.role) : null,
  occurred_at,
  unit_cost: unit_cost === null || unit_cost === undefined ? null : String(unit_cost)
})]);

const clearMovementContext = (client) => client.query('SELECT set_config($1, $2, true)', [SETTING, '']);

module.exports = { setMovementContext, clearMovementContext };

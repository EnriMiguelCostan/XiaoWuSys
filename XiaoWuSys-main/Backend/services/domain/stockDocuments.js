// ==========================================
// STOCK DOCUMENTS (migration 015; pure rules: no HTTP, no SQL)
//
// Every change to the quantity on hand now comes from a record with a number, a date and who
// made it. Staff never type a new quantity by hand any more (the old Add / Subtract buttons):
//
//   stock_in    SI-YYYY-NNNN  a delivery or purchase received (supplier, its receipt number,
//                             what came in, at what cost). Raises the stock and works out the
//                             item's new average unit cost.
//   stock_out   SO-YYYY-NNNN  stock that left without an order using it: returned to the
//                             supplier, used in the shop, a sample, expired... Only free stock
//                             can go out (stock held for orders stays).
//   stock_count SC-YYYY-NNNN  a physical count. The counted quantity becomes the system
//                             quantity, and the difference is recorded. Never below what
//                             open orders hold.
//
// Stock in and stock out can be corrected (edited) or voided; the stock moves by the net
// difference only, so a correction never needs more free stock than the change itself.
// A count is final: a mistake is fixed by counting again.
//
// Money is worked out in integer centavos (services/domain/payments.js).
// ==========================================
const { toCentavos, toPesos } = require('./payments');

const DOCUMENT_TYPES = ['stock_in', 'stock_out', 'stock_count'];
const DOCUMENT_LABELS = { stock_in: 'Stock in', stock_out: 'Stock out', stock_count: 'Stock count' };
const DOCUMENT_PREFIX = { stock_in: 'SI', stock_out: 'SO', stock_count: 'SC' };

// The paper that came with a delivery (stock in)
const REFERENCE_TYPES = [
  'Delivery receipt', 'Sales invoice', 'Official receipt', 'Store receipt (bought at a store or mall)',
  'Purchase order', 'No paper'
];
// Why stock left without an order using it (stock out). Damaged or misprinted stock is recorded
// as waste instead (Record loss), so its cost reaches the waste report and the P&L.
const STOCK_OUT_REASONS = [
  'Returned to supplier', 'Used in the shop (not for an order)', 'Given as a sample or freebie',
  'Expired or spoiled', 'Transferred to another branch', 'Extra used for an order', 'Other'
];
// Reasons that need a note saying what happened
const NOTE_REQUIRED_REASONS = ['Other'];
const LINES_MAX = 100;
const NOTES_MAX = 1000;
const REFERENCE_NO_MAX = 100;

// What a stock card row means, in plain words (stock_movements.movement_type)
const MOVEMENT_LABELS = {
  opening: 'Opening balance',
  stock_in: 'Stock in (received)',
  stock_in_correction: 'Stock in corrected',
  stock_in_void: 'Stock in voided',
  stock_out: 'Stock out',
  stock_out_correction: 'Stock out corrected',
  stock_out_void: 'Stock out voided',
  count: 'Stock count correction',
  order_used: 'Used for an order',
  consumables_used: 'Consumables used for an order',
  loss: 'Waste / loss',
  sync: 'Change saved offline (synced)',
  adjustment: 'Manual adjustment'
};
const MOVEMENT_TYPES = Object.keys(MOVEMENT_LABELS);
const movementLabel = (type) => MOVEMENT_LABELS[type] || 'Stock change';

const isWholeNumber = (n) => typeof n === 'number' && Number.isInteger(n);
const isMoney = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 99999999.99
  && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

// The lines of a document as sent by a screen -> { errors: [{ field, message }], lines }
//   stock_in:    [{ inventory_id, quantity (>= 1), unit_cost (>= 0) }]
//   stock_out:   [{ inventory_id, quantity (>= 1) }]
//   stock_count: [{ inventory_id, counted_quantity (>= 0) }]
// The same item twice is refused (one line per item keeps the stock card readable).
const checkLines = (type, raw) => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { errors: [{ field: 'lines', message: 'Add at least one item.' }], lines: [] };
  }
  if (raw.length > LINES_MAX) {
    return { errors: [{ field: 'lines', message: `At most ${LINES_MAX} items can be recorded at once. Split it into two records.` }], lines: [] };
  }
  const errors = [];
  const seen = new Set();
  const lines = raw.map((r, i) => {
    const row = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    const at = `Item ${i + 1}`;
    const id = typeof row.inventory_id === 'string' && /^[A-Za-z0-9_.:@-]{1,50}$/.test(row.inventory_id) ? row.inventory_id : null;
    if (!id) errors.push({ field: `lines[${i}].inventory_id`, message: `${at}: choose the item.` });
    else if (seen.has(id)) errors.push({ field: `lines[${i}].inventory_id`, message: `${at}: this item is already on the list. Put the whole quantity on one line.` });
    if (id) seen.add(id);
    const line = { inventory_id: id };
    if (type === 'stock_count') {
      if (!isWholeNumber(row.counted_quantity) || row.counted_quantity < 0 || row.counted_quantity > 2147483647) {
        errors.push({ field: `lines[${i}].counted_quantity`, message: `${at}: enter the counted quantity as a whole number (0 or more).` });
      }
      line.counted_quantity = row.counted_quantity;
    } else {
      if (!isWholeNumber(row.quantity) || row.quantity < 1 || row.quantity > 2147483647) {
        errors.push({ field: `lines[${i}].quantity`, message: `${at}: the quantity must be a whole number of at least 1.` });
      }
      line.quantity = row.quantity;
      if (type === 'stock_in') {
        if (!isMoney(row.unit_cost)) {
          errors.push({ field: `lines[${i}].unit_cost`, message: `${at}: enter the cost of one unit in pesos (0 or more, up to 2 decimals).` });
        }
        line.unit_cost = row.unit_cost;
      }
    }
    return line;
  });
  return { errors, lines };
};

// ---------- Average unit cost (moving average) ----------
// Bringing in addQty at addCost each: the new cost of one unit is what everything on hand cost,
// divided by the new quantity. Nothing on hand (or a count at 0): the new delivery's cost.
//   -> centavos
const averageAfterAddC = ({ onHand, costC, addQty, addCostC }) => {
  const before = Math.max(0, onHand);
  if (addQty <= 0) return costC;
  if (before === 0) return addCostC;
  return Math.round((before * costC + addQty * addCostC) / (before + addQty));
};

// Taking back removeQty that came in at removeCostC (a voided or corrected stock in): the
// average without them. Nothing left: the cost stays as it was (there is nothing to value).
//   -> centavos
const averageAfterRemoveC = ({ onHand, costC, removeQty, removeCostC }) => {
  const left = onHand - removeQty;
  if (removeQty <= 0) return costC;
  if (left <= 0) return costC;
  const value = onHand * costC - removeQty * removeCostC;
  if (value <= 0) return 0;
  return Math.round(value / left);
};

// The effect on each item of replacing oldLines by newLines (either may be empty: a new
// document has no old lines; a void has no new lines).
//   items: Map inventory_id -> { quantity_available, quantity_reserved, unit_cost, item_name }
//   -> { changes: [{ inventory_id, delta, new_unit_cost, needs_free }], problems: [{ inventory_id, item_name, needed, free }] }
// delta: + raises the stock, - lowers it. needs_free: how much free stock (on hand - reserved)
// the change takes; a change that needs more than is free is a problem (nothing is applied).
const plannedChanges = (type, oldLines, newLines, items) => {
  const ids = [...new Set([...oldLines, ...newLines].map((l) => l.inventory_id))].sort();
  const changes = [];
  const problems = [];
  for (const id of ids) {
    const item = items.get(id);
    if (!item) continue;
    const oldQty = oldLines.filter((l) => l.inventory_id === id).reduce((s, l) => s + l.quantity, 0);
    const newQty = newLines.filter((l) => l.inventory_id === id).reduce((s, l) => s + l.quantity, 0);
    let delta;
    let costC = toCentavos(item.unit_cost);
    if (type === 'stock_in') {
      delta = newQty - oldQty;
      // Take the old delivery out of the average, then put the new one in
      let onHand = Number(item.quantity_available);
      for (const l of oldLines.filter((x) => x.inventory_id === id)) {
        costC = averageAfterRemoveC({ onHand, costC, removeQty: l.quantity, removeCostC: toCentavos(l.unit_cost) });
        onHand -= l.quantity;
      }
      for (const l of newLines.filter((x) => x.inventory_id === id)) {
        costC = averageAfterAddC({ onHand, costC, addQty: l.quantity, addCostC: toCentavos(l.unit_cost) });
        onHand += l.quantity;
      }
    } else {
      delta = oldQty - newQty; // stock out: what is put back minus what is taken now
    }
    const free = Number(item.quantity_available) - Number(item.quantity_reserved || 0);
    const needs = delta < 0 ? -delta : 0;
    if (needs > free) problems.push({ inventory_id: id, item_name: item.item_name, needed: needs, free: Math.max(0, free) });
    changes.push({ inventory_id: id, delta, new_unit_cost: toPesos(costC), needs_free: needs });
  }
  return { changes, problems };
};

// A physical count: the counted quantity becomes the system quantity.
//   items: Map as above. -> { lines: [{ inventory_id, system_quantity, counted_quantity, difference,
//   unit_cost }], problems: [{ inventory_id, item_name, counted, reserved }], value_difference }
// Counting below what open orders hold is refused: those orders would be promised stock that
// is not there. Delay or cancel them first (or the count is wrong).
const countResult = (lines, items) => {
  const out = [];
  const problems = [];
  let valueC = 0;
  for (const l of lines) {
    const item = items.get(l.inventory_id);
    if (!item) continue;
    const system = Number(item.quantity_available);
    const reserved = Number(item.quantity_reserved || 0);
    if (l.counted_quantity < reserved) {
      problems.push({ inventory_id: l.inventory_id, item_name: item.item_name, counted: l.counted_quantity, reserved });
    }
    const difference = l.counted_quantity - system;
    valueC += Math.abs(difference) * toCentavos(item.unit_cost);
    out.push({
      inventory_id: l.inventory_id, system_quantity: system, counted_quantity: l.counted_quantity, difference,
      unit_cost: toPesos(toCentavos(item.unit_cost))
    });
  }
  return { lines: out, problems, value_difference: toPesos(valueC) };
};

// Total cost of a document's lines (stock in: what was paid; stock out: what left, at cost)
const linesTotal = (lines) => toPesos(lines.reduce((s, l) => s + Number(l.quantity) * toCentavos(l.unit_cost), 0));

// What may be done to a saved document, for this role (the routes check again)
//   can(role, capability) is passed in so this file stays free of the permissions table
const documentActions = (doc, role, can) => {
  const open = doc && !doc.voided_at;
  const editCap = doc && doc.document_type === 'stock_in' ? 'receive_stock' : 'issue_stock';
  return {
    edit: Boolean(open && doc.document_type !== 'stock_count' && can(role, editCap)),
    void: Boolean(open && doc.document_type !== 'stock_count' && can(role, 'void_stock_document')),
    print: Boolean(doc)
  };
};

module.exports = {
  DOCUMENT_TYPES, DOCUMENT_LABELS, DOCUMENT_PREFIX, REFERENCE_TYPES, STOCK_OUT_REASONS, NOTE_REQUIRED_REASONS,
  LINES_MAX, NOTES_MAX, REFERENCE_NO_MAX, MOVEMENT_LABELS, MOVEMENT_TYPES, movementLabel,
  checkLines, averageAfterAddC, averageAfterRemoveC, plannedChanges, countResult, linesTotal, documentActions
};

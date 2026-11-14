// ==========================================
// CONSUMABLES USED BY AN ORDER (PB 15; pure rules: no HTTP, no SQL)
//
// A blank (e.g. "White Shirt L") has usage rates: how much of each consumable one piece uses
// (ml of ink, sheets of transfer paper...) and at which status it is taken from stock:
//   'Pressing'   taken when the order leaves Printing for Pressing, or for Completed when the
//                order skips Pressing (tarpaulins, stickers)
//   'Completed'  taken when the order is Completed
// needed per consumable = ceil(sum over the order's items of quantity x quantity_per_piece),
// worked out in integer thousandths (rates have 3 decimals), so 0.1 + 0.2 never becomes 0.30000004.
//
// Exactly once: every (trigger, consumable) already in the order's log is skipped, so a retried
// request or a repeated transition never takes the same consumable twice.
// An estimate never blocks real work (steering §5): when the stock on hand is smaller than the
// estimate, only what is there is taken (stock stops at 0) and the rest is recorded as a shortfall.
// ==========================================

const CONSUMABLE_TRIGGERS = ['Pressing', 'Completed'];
const RATE_DECIMALS = 3;
const RATE_SCALE = 10 ** RATE_DECIMALS;
const RATE_MAX = 9999999.999; // NUMERIC(10,3)

// Which rates a status change sets off, oldest first
const triggersFor = (from, to) => {
  if (to === 'Pressing' && from === 'Printing') return ['Pressing'];
  if (to === 'Completed' && (from === 'Printing' || from === 'Pressing')) return ['Pressing', 'Completed'];
  return [];
};

const toThousandths = (rate) => Math.round(Number(rate) * RATE_SCALE);

// items: [{ inventory_id, quantity }]   the order's lines (unlinked lines use nothing)
// rates: [{ product_inventory_id, consumable_inventory_id, quantity_per_piece, trigger_status }]
// triggers: from triggersFor()
// done: [{ trigger_status, consumable_inventory_id }] already in the order's log
// -> [{ trigger_status, consumable_inventory_id, needed }]   sorted by trigger, then consumable id
const plannedDeductions = ({ items, rates, triggers, done = [] }) => {
  if (!triggers || triggers.length === 0) return [];
  const already = new Set(done.map((d) => `${d.trigger_status}|${d.consumable_inventory_id}`));
  const qtyByProduct = new Map();
  for (const i of items || []) {
    if (!i.inventory_id) continue;
    qtyByProduct.set(i.inventory_id, (qtyByProduct.get(i.inventory_id) || 0) + Number(i.quantity));
  }
  // "trigger|consumable" -> total in thousandths of a unit (BigInt: quantity x rate can pass 2^53)
  const thousandths = new Map();
  for (const r of rates || []) {
    if (!triggers.includes(r.trigger_status)) continue;
    const qty = qtyByProduct.get(r.product_inventory_id);
    if (!qty) continue;
    const key = `${r.trigger_status}|${r.consumable_inventory_id}`;
    if (already.has(key)) continue;
    thousandths.set(key, (thousandths.get(key) || 0n) + BigInt(qty) * BigInt(toThousandths(r.quantity_per_piece)));
  }
  const scale = BigInt(RATE_SCALE);
  return [...thousandths]
    .map(([key, total]) => {
      const [trigger_status, consumable_inventory_id] = key.split('|');
      return { trigger_status, consumable_inventory_id, needed: Number((total + scale - 1n) / scale) }; // rounded up
    })
    .filter((d) => d.needed > 0)
    .sort((a, b) => CONSUMABLE_TRIGGERS.indexOf(a.trigger_status) - CONSUMABLE_TRIGGERS.indexOf(b.trigger_status)
      || (a.consumable_inventory_id < b.consumable_inventory_id ? -1 : a.consumable_inventory_id > b.consumable_inventory_id ? 1 : 0));
};

// What can actually be taken from what is on hand -> { quantity_deducted, shortfall }
const clampDeduction = (needed, onHand) => {
  const available = Math.max(0, Number(onHand) || 0);
  const quantity_deducted = Math.min(available, needed);
  return { quantity_deducted, shortfall: needed - quantity_deducted };
};

// Checks one usage-rate list for a blank (PUT /api/inventory/:id/consumable-rates).
// rates: the request body's list; productId: the blank
// -> { errors: [{ field, message }], rates: [{ consumable_inventory_id, quantity_per_piece, trigger_status }] }
// idPattern: utils/validation ID_PATTERN (passed in so this file stays free of other modules)
const RATES_MAX = 50;
const checkRateList = (rates, productId, idPattern) => {
  const errors = [];
  if (!Array.isArray(rates)) {
    return { errors: [{ field: 'rates', message: 'Usage rates must be a list (it may be empty).' }], rates: [] };
  }
  if (rates.length > RATES_MAX) {
    return { errors: [{ field: 'rates', message: `A blank can have at most ${RATES_MAX} usage rates.` }], rates: [] };
  }
  const clean = [];
  const seen = new Set();
  rates.forEach((r, i) => {
    const row = `Row ${i + 1}`;
    const field = (f) => `rates[${i}].${f}`;
    if (!r || typeof r !== 'object') { errors.push({ field: `rates[${i}]`, message: `${row}: is not a usage rate.` }); return; }
    const { consumable_inventory_id: id, quantity_per_piece: q, trigger_status: trigger = 'Pressing' } = r;
    if (typeof id !== 'string' || !idPattern.test(id)) {
      errors.push({ field: field('consumable_inventory_id'), message: `${row}: choose the consumable from the list.` });
      return;
    }
    if (id === productId) {
      errors.push({ field: field('consumable_inventory_id'), message: `${row}: an item cannot use itself up.` });
      return;
    }
    if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) {
      errors.push({ field: field('quantity_per_piece'), message: `${row}: the amount per piece must be a number above 0, like 1 or 0.25.` });
      return;
    }
    if (Math.abs(Math.round(q * RATE_SCALE) - q * RATE_SCALE) > 1e-6) {
      errors.push({ field: field('quantity_per_piece'), message: `${row}: the amount per piece can have at most ${RATE_DECIMALS} decimals, like 0.125.` });
      return;
    }
    if (q > RATE_MAX) {
      errors.push({ field: field('quantity_per_piece'), message: `${row}: the amount per piece is too large.` });
      return;
    }
    if (!CONSUMABLE_TRIGGERS.includes(trigger)) {
      errors.push({ field: field('trigger_status'), message: `${row}: choose when it is used: ${CONSUMABLE_TRIGGERS.join(' or ')}.` });
      return;
    }
    const key = `${id}|${trigger}`;
    if (seen.has(key)) {
      errors.push({ field: field('consumable_inventory_id'), message: `${row}: this consumable is already listed for the same step.` });
      return;
    }
    seen.add(key);
    clean.push({ consumable_inventory_id: id, quantity_per_piece: Math.round(q * RATE_SCALE) / RATE_SCALE, trigger_status: trigger });
  });
  return { errors, rates: clean };
};

module.exports = {
  CONSUMABLE_TRIGGERS, RATE_DECIMALS, RATES_MAX, triggersFor, plannedDeductions, clampDeduction, checkRateList
};

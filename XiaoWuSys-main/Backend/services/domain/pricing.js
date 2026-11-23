// ==========================================
// QUOTES, VOLUME PRICES AND DISCOUNTS (PB 11 / PB 12; pure rules: no HTTP, no SQL)
//
// All money is worked out in integer centavos (₱150.00 -> 15000), like services/domain/payments.js.
//
//   Volume tiers, on the order's TOTAL quantity (every line together):
//     100 pieces or more   10% off each piece's selling price
//     50 to 99 pieces       5% off
//     fewer than 50         the selling price
//   unit price  = selling price less the tier, rounded to the nearest centavo
//   line total  = unit price x quantity
//   subtotal    = sum of the line totals
//   discount    = an amount, or a percentage of the subtotal (rounded to the centavo), never more
//                 than the subtotal; a reason is required whenever there is one
//   total quote = subtotal - discount (never below 0)
// ==========================================
const { toCentavos, toPesos, pesoText } = require('./payments');

const VOLUME_TIERS = [
  { min_quantity: 100, percent_off: 10, label: 'Bulk price (100 pieces or more): 10% off' },
  { min_quantity: 50, percent_off: 5, label: 'Bulk price (50 pieces or more): 5% off' },
  { min_quantity: 0, percent_off: 0, label: 'Regular price' }
];
const DISCOUNT_REASON_MAX = 150; // printed on the quote; matches Web/lib/input-limits.ts DISCOUNT_LIMITS

const tierFor = (totalQuantity) => VOLUME_TIERS.find((t) => totalQuantity >= t.min_quantity);

// Selling price less the tier, to the nearest centavo (half up). Integer math only.
const unitPriceCentavos = (sellingCentavos, percentOff) => Math.round((sellingCentavos * (100 - percentOff)) / 100);

// items: [{ line_item_id, product_type, quantity, inventory_id, item_name, selling_price }]
//   (item_name / selling_price come from the linked catalog item; null when not linked)
// -> { problem } or { total_quantity, tier, lines: [{ line_item_id, product_type, quantity, selling_price,
//      unit_price, line_total }], subtotal_amount }
const priceLines = (items) => {
  if (!items || items.length === 0) {
    return { problem: { status: 422, body: { error: 'NO_ITEMS', message: 'This order has no items yet. Add the items first, then calculate the quote.' } } };
  }
  const unlinked = items.filter((i) => !i.inventory_id);
  if (unlinked.length > 0) {
    return {
      problem: {
        status: 422,
        body: {
          error: 'ITEMS_NOT_LINKED_TO_STOCK',
          message: `Link every item to a catalog item so its price is known: ${[...new Set(unlinked.map((i) => i.product_type))].join(', ')}.`,
          unlinked_line_item_ids: unlinked.map((i) => i.line_item_id)
        }
      }
    };
  }
  const unpriced = items.filter((i) => toCentavos(i.selling_price) <= 0);
  if (unpriced.length > 0) {
    const names = [...new Set(unpriced.map((i) => i.item_name || i.product_type))];
    return {
      problem: {
        status: 422,
        body: {
          error: 'SELLING_PRICE_MISSING',
          message: `Set a selling price in the Catalog first for: ${names.join(', ')}.`,
          inventory_ids: [...new Set(unpriced.map((i) => i.inventory_id))]
        }
      }
    };
  }

  const total_quantity = items.reduce((sum, i) => sum + Number(i.quantity), 0);
  const tier = tierFor(total_quantity);
  let subtotalC = 0;
  const lines = items.map((i) => {
    const unitC = unitPriceCentavos(toCentavos(i.selling_price), tier.percent_off);
    const lineC = unitC * Number(i.quantity);
    subtotalC += lineC;
    return {
      line_item_id: i.line_item_id,
      product_type: i.product_type,
      size: i.size || null,
      quantity: Number(i.quantity),
      selling_price: toPesos(toCentavos(i.selling_price)),
      unit_price: toPesos(unitC),
      line_total: toPesos(lineC)
    };
  });
  return { total_quantity, tier, lines, subtotal_amount: toPesos(subtotalC), subtotalC };
};

// The discount for a subtotal, from what the Owner asked for or what the order already has.
//   requested: { amount?, percent?, reason? }   (amount and percent are never both sent)
//   existing:  { amount, reason }
// -> { problem } or { discountC, reason, percent }
const resolveDiscount = (subtotalC, requested, existing) => {
  let discountC;
  let reason;
  let percent = null;
  if (requested.percent !== undefined && requested.percent !== null) {
    percent = requested.percent;
    discountC = Math.round((subtotalC * Math.round(percent * 100)) / 10000);
    reason = requested.reason;
  } else if (requested.amount !== undefined && requested.amount !== null) {
    discountC = toCentavos(requested.amount);
    reason = requested.reason;
  } else {
    discountC = toCentavos(existing.amount);
    reason = requested.reason !== undefined && requested.reason !== null ? requested.reason : existing.reason;
  }
  if (discountC > subtotalC) {
    return {
      problem: {
        status: 422,
        body: {
          error: 'DISCOUNT_TOO_LARGE',
          message: `The discount (${pesoText(toPesos(discountC))}) is more than the subtotal (${pesoText(toPesos(subtotalC))}). Enter a smaller discount.`,
          subtotal_amount: toPesos(subtotalC)
        }
      }
    };
  }
  if (discountC > 0 && !(reason && String(reason).trim())) {
    return {
      problem: {
        status: 400,
        body: {
          error: 'VALIDATION_FAILED',
          message: 'Reason for the discount is required. Write why the price is lower (for example "Loyal school customer").',
          details: [{ field: 'discount_reason', message: 'Reason for the discount is required.' }]
        }
      }
    };
  }
  return { discountC, reason: discountC > 0 ? String(reason).trim() : null, percent };
};

// Labor / services and incidental charges (migration 015, adviser consultation): a quote is
//   materials (the priced lines) + labor and services + incidental charges - discount
// Incidental charges cover what cannot be seen yet (reprints, small design changes): an amount,
// or a percentage of materials + labor (e.g. a ₱60,000 job quoted at ₱65,000 is about 8.33%).
// Neither sent: the order's current amounts are kept, like the discount.
//   requested: { labor?, incidental?, incidental_percent? }   existing: { labor, incidental }
// -> { problem } or { laborC, incidentalC, incidentalPercent }
const INCIDENTAL_PERCENT_MAX = 50;
const resolveCharges = (materialsC, requested = {}, existing = {}) => {
  const given = (x) => x !== undefined && x !== null;
  const laborC = toCentavos(given(requested.labor) ? requested.labor : existing.labor || 0);
  let incidentalC;
  let incidentalPercent = null;
  if (given(requested.incidental_percent)) {
    incidentalPercent = requested.incidental_percent;
    incidentalC = Math.round(((materialsC + laborC) * Math.round(incidentalPercent * 100)) / 10000);
  } else {
    incidentalC = toCentavos(given(requested.incidental) ? requested.incidental : existing.incidental || 0);
  }
  if (laborC < 0 || incidentalC < 0) {
    return { problem: { status: 400, body: { error: 'VALIDATION_FAILED', message: 'Labor and incidental charges cannot be below ₱0.' } } };
  }
  return { laborC, incidentalC, incidentalPercent };
};

// Everything the quote route needs -> { problem } or { quote }
//   quote: { total_quantity, tier: { percent_off, label }, lines, subtotal_amount (materials),
//            labor_amount, incidental_amount, incidental_percent, gross_amount, discount_amount,
//            discount_percent, discount_reason, total_quote_amount }
// The discount (an amount, or a percentage) is taken from the gross amount: materials + labor +
// incidental charges. With no labor or incidental charges that is the materials subtotal, as before.
const computeQuote = ({ items, requested = {}, existing = { amount: 0, reason: null } }) => {
  const priced = priceLines(items);
  if (priced.problem) return { problem: priced.problem };
  const charges = resolveCharges(priced.subtotalC, requested, existing);
  if (charges.problem) return { problem: charges.problem };
  const grossC = priced.subtotalC + charges.laborC + charges.incidentalC;
  const discount = resolveDiscount(grossC, requested, existing);
  if (discount.problem) return { problem: discount.problem };
  const totalC = Math.max(0, grossC - discount.discountC);
  return {
    quote: {
      total_quantity: priced.total_quantity,
      tier: { min_quantity: priced.tier.min_quantity, percent_off: priced.tier.percent_off, label: priced.tier.label },
      lines: priced.lines,
      subtotal_amount: priced.subtotal_amount,
      labor_amount: toPesos(charges.laborC),
      incidental_amount: toPesos(charges.incidentalC),
      incidental_percent: charges.incidentalPercent,
      gross_amount: toPesos(grossC),
      discount_amount: toPesos(discount.discountC),
      discount_percent: discount.percent,
      discount_reason: discount.reason,
      total_quote_amount: toPesos(totalC)
    }
  };
};

// The quote as screens and the printed quotation show it -> { has_quote, subtotal_amount (materials),
// labor_amount, incidental_amount, gross_amount, discount_amount, discount_reason, adjustment_amount,
// adjustment_reason, total_quote_amount }.
//   total = materials + labor + incidental - discount - adjustment (a price cut after approval)
// When the stored breakdown does not add up to the quote (an order priced before migration 011,
// or a quote typed in offline on an older server), the quote is shown as its own subtotal with no
// other parts, so the numbers always agree.
const quoteBreakdown = (order) => {
  const totalC = Math.max(0, toCentavos(order && order.total_quote_amount));
  const subtotalC = toCentavos(order && order.subtotal_amount);
  const laborC = toCentavos(order && order.labor_amount);
  const incidentalC = toCentavos(order && order.incidental_amount);
  const discountC = toCentavos(order && order.discount_amount);
  const adjustmentC = toCentavos(order && order.adjustment_amount);
  const grossC = subtotalC + laborC + incidentalC;
  const consistent = grossC > 0 && grossC - discountC - adjustmentC === totalC;
  return {
    has_quote: totalC > 0 || (consistent && adjustmentC > 0),
    subtotal_amount: toPesos(consistent ? subtotalC : totalC),
    labor_amount: toPesos(consistent ? laborC : 0),
    incidental_amount: toPesos(consistent ? incidentalC : 0),
    gross_amount: toPesos(consistent ? grossC : totalC),
    discount_amount: toPesos(consistent ? discountC : 0),
    discount_reason: consistent && discountC > 0 ? (order.discount_reason || null) : null,
    adjustment_amount: toPesos(consistent ? adjustmentC : 0),
    adjustment_reason: consistent && adjustmentC > 0 ? (order.adjustment_reason || null) : null,
    total_quote_amount: toPesos(totalC)
  };
};

// ---------- A price cut after approval (late delivery, production error) ----------
// The Owner lowers the bill with a reason. It cannot take the bill below ₱0, and only one
// adjustment is kept per order (a new one replaces the old: amount = the whole cut so far).
//   -> { problem } | { adjustmentC, totalC }
const ADJUSTMENT_REASON_MAX = 500;
const resolveAdjustment = (order, { amount, reason }) => {
  const b = quoteBreakdown(order);
  const beforeC = toCentavos(b.total_quote_amount) + toCentavos(b.adjustment_amount); // the bill before any cut
  const adjustmentC = toCentavos(amount);
  if (adjustmentC > beforeC) {
    return {
      problem: {
        status: 422,
        body: {
          error: 'ADJUSTMENT_TOO_LARGE',
          message: `The price cut (${pesoText(toPesos(adjustmentC))}) is more than the bill (${pesoText(toPesos(beforeC))}).`,
          bill_before_adjustment: toPesos(beforeC)
        }
      }
    };
  }
  if (adjustmentC > 0 && !(reason && String(reason).trim())) {
    return {
      problem: {
        status: 400,
        body: {
          error: 'VALIDATION_FAILED', message: 'Reason for the price cut is required (for example "Delivered 3 days late").',
          details: [{ field: 'adjustment_reason', message: 'Reason for the price cut is required.' }]
        }
      }
    };
  }
  return { adjustmentC, totalC: beforeC - adjustmentC };
};

// The priced lines of a SAVED quote, for the customer quotation: each item's stored unit price
// and its line total. null when the stored prices do not add up to the subtotal (a quote typed in
// by hand, or items added after the quote was calculated): the quotation then shows the items
// without prices and only the totals, so it never shows numbers that disagree.
//   items: the order's items ({ line_item_id, product_type, size, custom_name, custom_number, quantity, price })
//   breakdown: quoteBreakdown(order)
const quoteLines = (items, breakdown) => {
  if (!items || items.length === 0 || !breakdown || breakdown.subtotal_amount <= 0) return null;
  let sumC = 0;
  const lines = items.map((i) => {
    const unitC = toCentavos(i.price);
    const lineC = unitC * Number(i.quantity);
    sumC += lineC;
    return {
      line_item_id: i.line_item_id,
      product_type: i.product_type,
      size: i.size || null,
      custom_name: i.custom_name || null,
      custom_number: i.custom_number || null,
      quantity: Number(i.quantity),
      unit_price: toPesos(unitC),
      line_total: toPesos(lineC)
    };
  });
  if (items.some((i) => toCentavos(i.price) <= 0) || sumC !== toCentavos(breakdown.subtotal_amount)) return null;
  return lines;
};

// The breakdown columns written when the Owner types a quote by hand: it is its own subtotal
const manualQuoteColumns = (total) => ({
  subtotal_amount: total, discount_amount: 0, discount_reason: null, labor_amount: 0, incidental_amount: 0
});

module.exports = {
  VOLUME_TIERS, DISCOUNT_REASON_MAX, INCIDENTAL_PERCENT_MAX, ADJUSTMENT_REASON_MAX, tierFor, unitPriceCentavos, priceLines,
  resolveDiscount, resolveCharges, computeQuote, quoteBreakdown, quoteLines, manualQuoteColumns, resolveAdjustment
};

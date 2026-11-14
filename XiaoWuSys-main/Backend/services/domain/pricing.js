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
const DISCOUNT_REASON_MAX = 500;

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

// Everything the quote route needs -> { problem } or { quote }
//   quote: { total_quantity, tier: { percent_off, label }, lines, subtotal_amount, discount_amount,
//            discount_percent, discount_reason, total_quote_amount }
const computeQuote = ({ items, requested = {}, existing = { amount: 0, reason: null } }) => {
  const priced = priceLines(items);
  if (priced.problem) return { problem: priced.problem };
  const discount = resolveDiscount(priced.subtotalC, requested, existing);
  if (discount.problem) return { problem: discount.problem };
  const totalC = Math.max(0, priced.subtotalC - discount.discountC);
  return {
    quote: {
      total_quantity: priced.total_quantity,
      tier: { min_quantity: priced.tier.min_quantity, percent_off: priced.tier.percent_off, label: priced.tier.label },
      lines: priced.lines,
      subtotal_amount: priced.subtotal_amount,
      discount_amount: toPesos(discount.discountC),
      discount_percent: discount.percent,
      discount_reason: discount.reason,
      total_quote_amount: toPesos(totalC)
    }
  };
};

// The quote as screens and the printed quotation show it -> { has_quote, subtotal_amount,
// discount_amount, discount_reason, total_quote_amount }. When the stored breakdown does not add
// up to the quote (an order priced before migration 011, or a quote typed in offline on an older
// server), the quote is shown as its own subtotal with no discount, so the three numbers always agree.
const quoteBreakdown = (order) => {
  const totalC = Math.max(0, toCentavos(order && order.total_quote_amount));
  const subtotalC = toCentavos(order && order.subtotal_amount);
  const discountC = toCentavos(order && order.discount_amount);
  const consistent = subtotalC > 0 && subtotalC - discountC === totalC;
  return {
    has_quote: totalC > 0,
    subtotal_amount: toPesos(consistent ? subtotalC : totalC),
    discount_amount: toPesos(consistent ? discountC : 0),
    discount_reason: consistent && discountC > 0 ? (order.discount_reason || null) : null,
    total_quote_amount: toPesos(totalC)
  };
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
const manualQuoteColumns = (total) => ({ subtotal_amount: total, discount_amount: 0, discount_reason: null });

module.exports = {
  VOLUME_TIERS, DISCOUNT_REASON_MAX, tierFor, unitPriceCentavos, priceLines, resolveDiscount, computeQuote,
  quoteBreakdown, quoteLines, manualQuoteColumns
};

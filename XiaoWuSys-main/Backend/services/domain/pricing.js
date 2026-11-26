// ==========================================
// QUOTES, VOLUME PRICES AND DISCOUNTS (PB 11 / PB 12; migration 017; pure rules: no HTTP, no SQL)
//
// All money is worked out in integer centavos (₱150.00 -> 15000), like services/domain/payments.js.
//
// Each catalog item is priced one of two ways (inventory_items.print_pricing, migration 017):
//   'included'  the selling price is the FINISHED piece (sublimation jersey set, mug, lanyard,
//               tarpaulin per sq ft, sticker sheet): printing is part of the item
//   'per_area'  the selling price is the BLANK (T-shirt, polo, hoodie, tote) and every print area
//               on the order line adds its charge (PRINT_SIZES), e.g. front A4 + back A3
//
//   Volume tiers, on the order's TOTAL quantity (every line together), Davao-style "by the dozen":
//     100 pieces or more   15% off      50 to 99   10% off      12 to 49   5% off      1 to 11  regular
//   The tier comes off the PRINT charges of a per-area item (the blank is sold at its price: its
//   margin is thin) and off the whole price of an included item.
//   unit price  = blank + print charges less the tier (per area), or selling price less the tier
//   line total  = unit price x quantity;   materials (subtotal) = sum of the line totals
//
//   total quote = materials + labor - discount + incidental charges
//     discount     an amount or a % of (materials + labor), never more than that, reason required.
//                  It is taken BEFORE the incidental charges: a discount is a lower price for the
//                  work, never a discount on the allowance for reprints and changes.
//     incidental   an allowance for what cannot be seen yet (reprints, small design changes, rush
//                  handling): an amount or a % of (materials + labor), at most INCIDENTAL_PERCENT_MAX.
//   A discount that takes the total below what the blanks cost the shop is refused
//   (DISCOUNT_BELOW_COST). Warnings (never block): a discount above DISCOUNT_GUIDE_PERCENT, or
//   catalog prices that are already below cost without any discount.
// ==========================================
const { toCentavos, toPesos, pesoText } = require('./payments');

const VOLUME_TIERS = [
  { min_quantity: 100, percent_off: 15, label: 'Bulk price (100 pieces or more): 15% off the printing' },
  { min_quantity: 50, percent_off: 10, label: 'Bulk price (50 pieces or more): 10% off the printing' },
  { min_quantity: 12, percent_off: 5, label: 'Dozen price (12 pieces or more): 5% off the printing' },
  { min_quantity: 0, percent_off: 0, label: 'Regular price' }
];

// ---------- Print areas (migration 017): what each print on a blank costs per piece ----------
// 2026 Davao prices for DTF on cotton (sublimation jerseys, mugs and tarpaulins are 'included')
const PRINT_SIZES = {
  Small: { label: 'Small logo (up to 4 x 4 in)', price: 50 },
  A4: { label: 'A4 (about 8 x 11 in)', price: 100 },
  A3: { label: 'A3 (about 11 x 16 in)', price: 160 },
  Name: { label: 'Name and number', price: 40 }
};
const PRINT_PLACEMENTS = ['Front', 'Back', 'Left chest', 'Right chest', 'Left sleeve', 'Right sleeve', 'Other'];
const PRINT_AREAS_MAX = 6;
const PRINT_PRICING = ['included', 'per_area'];
// Text or array -> { areas } | { error }
const parsePrintAreas = (value) => {
  if (value === undefined || value === null || value === '') return { areas: [] };
  let list = value;
  if (typeof value === 'string') {
    try { list = JSON.parse(value); } catch { return { error: 'Print areas could not be read. Choose them again.' }; }
  }
  if (!Array.isArray(list)) return { error: 'Print areas must be a list, like [{ "placement": "Front", "size": "A4" }].' };
  if (list.length > PRINT_AREAS_MAX) return { error: `At most ${PRINT_AREAS_MAX} print areas per item.` };
  const areas = [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || !PRINT_PLACEMENTS.includes(a.placement) || !PRINT_SIZES[a.size]) {
      return { error: `Each print area needs a placement (${PRINT_PLACEMENTS.join(', ')}) and a size (${Object.keys(PRINT_SIZES).join(', ')}).` };
    }
    areas.push({ placement: a.placement, size: a.size });
  }
  return { areas };
};
const printChargeCentavos = (areas) => areas.reduce((sum, a) => sum + toCentavos(PRINT_SIZES[a.size].price), 0);
const DISCOUNT_GUIDE_PERCENT = 30;
const DISCOUNT_REASON_MAX = 150; // printed on the quote; matches Web/lib/input-limits.ts DISCOUNT_LIMITS

const tierFor = (totalQuantity) => VOLUME_TIERS.find((t) => totalQuantity >= t.min_quantity);

// Selling price less the tier, to the nearest centavo (half up). Integer math only.
const unitPriceCentavos = (sellingCentavos, percentOff) => Math.round((sellingCentavos * (100 - percentOff)) / 100);

// items: [{ line_item_id, product_type, quantity, inventory_id, item_name, selling_price }]
//   (item_name / selling_price come from the linked catalog item; null when not linked)
// -> { problem } or { total_quantity, tier, lines: [{ line_item_id, product_type, quantity, selling_price,
//      unit_price, line_total }], subtotal_amount }
const priceLines = (items, { tierQuantity = null } = {}) => {
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

  const badAreas = items.map((i) => ({ i, parsed: parsePrintAreas(i.print_areas) })).find((x) => x.parsed.error);
  if (badAreas) {
    return { problem: { status: 400, body: { error: 'VALIDATION_FAILED', message: `${badAreas.i.product_type}: ${badAreas.parsed.error}` } } };
  }

  const total_quantity = items.reduce((sum, i) => sum + Number(i.quantity), 0);
  // add-ons after approval are priced at the tier of the whole order (tierQuantity)
  const tier = tierFor(tierQuantity !== null ? tierQuantity : total_quantity);
  let subtotalC = 0;
  let costC = 0;
  const lines = items.map((i) => {
    const perArea = i.print_pricing === 'per_area';
    const areas = perArea ? parsePrintAreas(i.print_areas).areas : [];
    const blankC = toCentavos(i.selling_price);
    const printC = printChargeCentavos(areas);
    const unitC = perArea ? blankC + unitPriceCentavos(printC, tier.percent_off) : unitPriceCentavos(blankC, tier.percent_off);
    const lineC = unitC * Number(i.quantity);
    subtotalC += lineC;
    costC += toCentavos(i.unit_cost || 0) * Number(i.quantity);
    return {
      line_item_id: i.line_item_id,
      product_type: i.product_type,
      size: i.size || null,
      quantity: Number(i.quantity),
      print_pricing: perArea ? 'per_area' : 'included',
      print_areas: areas,
      selling_price: toPesos(blankC),
      print_charge: toPesos(printC),
      unit_price: toPesos(unitC),
      line_total: toPesos(lineC)
    };
  });
  return { total_quantity, tier, lines, subtotal_amount: toPesos(subtotalC), subtotalC, costC };
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
const INCIDENTAL_PERCENT_MAX = 20;
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
  // An allowance, not a second price: at most INCIDENTAL_PERCENT_MAX of materials + labor
  const capC = Math.round(((materialsC + laborC) * INCIDENTAL_PERCENT_MAX) / 100);
  if (incidentalC > capC) {
    return {
      problem: {
        status: 422,
        body: {
          error: 'INCIDENTAL_TOO_LARGE',
          message: `Incidental charges can be at most ${INCIDENTAL_PERCENT_MAX}% of materials and labor (${pesoText(toPesos(capC))}). `
            + 'A bigger extra is real work: add it as labor or as items instead.',
          incidental_max: toPesos(capC)
        }
      }
    };
  }
  return { laborC, incidentalC, incidentalPercent };
};

// Everything the quote route needs -> { problem } or { quote }
//   quote: { total_quantity, tier: { percent_off, label }, lines, subtotal_amount (materials),
//            labor_amount, incidental_amount, incidental_percent, gross_amount, discount_amount,
//            discount_percent, discount_reason, total_quote_amount, cost_amount, warnings }
// gross_amount = materials + labor + incidental (what the bill would be without a discount).
// The discount (an amount, or a percentage) is taken from materials + labor, then the incidental
// charges are added: total = materials + labor - discount + incidental.
const computeQuote = ({ items, requested = {}, existing = { amount: 0, reason: null } }) => {
  const priced = priceLines(items);
  if (priced.problem) return { problem: priced.problem };
  const charges = resolveCharges(priced.subtotalC, requested, existing);
  if (charges.problem) return { problem: charges.problem };
  const workC = priced.subtotalC + charges.laborC;
  const discount = resolveDiscount(workC, requested, existing);
  if (discount.problem) return { problem: discount.problem };
  const grossC = workC + charges.incidentalC;
  const totalC = Math.max(0, workC - discount.discountC + charges.incidentalC);
  // A discount may never take the bill below what the blanks cost the shop (selling at a loss)
  if (discount.discountC > 0 && priced.costC > 0 && totalC < priced.costC) {
    const maxC = Math.max(0, workC + charges.incidentalC - priced.costC);
    return {
      problem: {
        status: 422,
        body: {
          error: 'DISCOUNT_BELOW_COST',
          message: `With this discount the total (${pesoText(toPesos(totalC))}) is less than what the blanks cost the shop (${pesoText(toPesos(priced.costC))}). `
            + `The discount can be at most ${pesoText(toPesos(maxC))}.`,
          max_discount: toPesos(maxC),
          cost_amount: toPesos(priced.costC)
        }
      }
    };
  }
  const warnings = [];
  if (workC > 0 && discount.discountC * 100 > workC * DISCOUNT_GUIDE_PERCENT) {
    warnings.push({
      code: 'DISCOUNT_ABOVE_GUIDE',
      message: `The discount is more than ${DISCOUNT_GUIDE_PERCENT}% of the work. Make sure the shop still earns from this job.`
    });
  }
  if (priced.costC > 0 && totalC < priced.costC) {
    warnings.push({
      code: 'BELOW_COST',
      message: `The total (${pesoText(toPesos(totalC))}) is less than what the blanks cost the shop (${pesoText(toPesos(priced.costC))}).`
    });
  }
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
      total_quote_amount: toPesos(totalC),
      cost_amount: toPesos(priced.costC),
      warnings
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
  PRINT_SIZES, PRINT_PLACEMENTS, PRINT_AREAS_MAX, PRINT_PRICING, DISCOUNT_GUIDE_PERCENT, parsePrintAreas, printChargeCentavos,
  VOLUME_TIERS, DISCOUNT_REASON_MAX, INCIDENTAL_PERCENT_MAX, ADJUSTMENT_REASON_MAX, tierFor, unitPriceCentavos, priceLines,
  resolveDiscount, resolveCharges, computeQuote, quoteBreakdown, quoteLines, manualQuoteColumns, resolveAdjustment
};

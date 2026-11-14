// Batch M6, part 2 (rules only, no database): volume quotes and discounts (PB 11 / PB 12) and
// consumable deductions (PB 15). The routes that use them are tested in m6-part2.test.js
// (offline) and m6-part2.pg.test.js (real PostgreSQL).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeQuote, quoteBreakdown, quoteLines, tierFor, unitPriceCentavos, manualQuoteColumns } = require('../services/domain/pricing');
const { triggersFor, plannedDeductions, clampDeduction, checkRateList } = require('../services/domain/consumables');
const { ID_PATTERN } = require('../utils/validation');

const line = (id, quantity, selling_price, extra = {}) => ({
  line_item_id: id, product_type: 'Jersey', quantity, inventory_id: `i-${id}`, item_name: `Blank ${id}`, selling_price, ...extra
});

describe('Volume quote (PB 11)', () => {
  it('picks the tier from the TOTAL quantity of the order', () => {
    assert.equal(tierFor(49).percent_off, 0);
    assert.equal(tierFor(50).percent_off, 5);
    assert.equal(tierFor(99).percent_off, 5);
    assert.equal(tierFor(100).percent_off, 10);
    // 30 + 30 pieces of two different blanks: 60 in all, so both lines get the 5% tier
    const { quote } = computeQuote({ items: [line('a', 30, 150), line('b', 30, 200)] });
    assert.deepEqual([quote.total_quantity, quote.tier.percent_off], [60, 5]);
    assert.deepEqual(quote.lines.map((l) => [l.unit_price, l.line_total]), [[142.5, 4275], [190, 5700]]);
    assert.deepEqual([quote.subtotal_amount, quote.discount_amount, quote.total_quote_amount], [9975, 0, 9975]);
  });

  it('rounds each unit price to the centavo and multiplies in centavos (no float drift)', () => {
    assert.equal(unitPriceCentavos(9999, 10), 8999); // ₱99.99 less 10% = ₱89.991 -> ₱89.99
    assert.equal(unitPriceCentavos(1005, 5), 955); // ₱10.05 less 5% = ₱9.5475 -> ₱9.55
    const { quote } = computeQuote({ items: [line('a', 100, 0.1), line('b', 3, 0.2)] });
    assert.deepEqual(quote.lines.map((l) => l.unit_price), [0.09, 0.18]);
    assert.equal(quote.subtotal_amount, 9.54, '100 x 0.09 + 3 x 0.18');
  });

  it('refuses to price items that are not linked, or whose blank has no selling price', () => {
    assert.equal(computeQuote({ items: [] }).problem.body.error, 'NO_ITEMS');
    const unlinked = computeQuote({ items: [line('a', 5, 100), { ...line('b', 5, 100), inventory_id: null, product_type: 'Mug' }] });
    assert.deepEqual([unlinked.problem.status, unlinked.problem.body.error, unlinked.problem.body.unlinked_line_item_ids], [422, 'ITEMS_NOT_LINKED_TO_STOCK', ['b']]);
    const unpriced = computeQuote({ items: [line('a', 5, 100), line('b', 5, '0.00')] });
    assert.equal(unpriced.problem.body.error, 'SELLING_PRICE_MISSING');
    assert.match(unpriced.problem.body.message, /Blank b/);
  });
});

describe('Discounts (PB 12)', () => {
  const items = [line('a', 10, 100)]; // subtotal ₱1,000.00

  it('takes an amount or a percentage of the subtotal, and needs a reason', () => {
    const byAmount = computeQuote({ items, requested: { amount: 150, reason: 'Loyal school' } }).quote;
    assert.deepEqual([byAmount.discount_amount, byAmount.total_quote_amount, byAmount.discount_reason], [150, 850, 'Loyal school']);
    const byPercent = computeQuote({ items: [line('a', 3, 33.33)], requested: { percent: 12.5, reason: 'Promo' } }).quote;
    assert.deepEqual([byPercent.subtotal_amount, byPercent.discount_amount, byPercent.discount_percent], [99.99, 12.5, 12.5], '12.5% of ₱99.99 = ₱12.49875 -> ₱12.50');
    assert.equal(byPercent.total_quote_amount, 87.49);
    const noReason = computeQuote({ items, requested: { amount: 50 } });
    assert.deepEqual([noReason.problem.status, noReason.problem.body.details[0].field], [400, 'discount_reason']);
    const blank = computeQuote({ items, requested: { amount: 50, reason: '   ' } });
    assert.equal(blank.problem.status, 400, 'spaces are not a reason');
  });

  it('never lets the discount pass the subtotal; 100% leaves a quote of 0', () => {
    const tooMuch = computeQuote({ items, requested: { amount: 1000.01, reason: 'x' } });
    assert.deepEqual([tooMuch.problem.status, tooMuch.problem.body.error], [422, 'DISCOUNT_TOO_LARGE']);
    assert.equal(computeQuote({ items, requested: { percent: 100, reason: 'Sponsor' } }).quote.total_quote_amount, 0);
  });

  it('keeps the order’s current discount when re-pricing, and 0 removes it', () => {
    const kept = computeQuote({ items: [line('a', 20, 100)], existing: { amount: 100, reason: 'Loyal' } }).quote;
    assert.deepEqual([kept.subtotal_amount, kept.discount_amount, kept.discount_reason, kept.total_quote_amount], [2000, 100, 'Loyal', 1900]);
    const removed = computeQuote({ items, requested: { amount: 0 }, existing: { amount: 100, reason: 'Loyal' } }).quote;
    assert.deepEqual([removed.discount_amount, removed.discount_reason], [0, null]);
    const stale = computeQuote({ items: [line('a', 1, 50)], existing: { amount: 100, reason: 'Loyal' } });
    assert.equal(stale.problem.body.error, 'DISCOUNT_TOO_LARGE', 'items removed since: the old discount no longer fits');
  });

  it('shows a breakdown that always adds up', () => {
    assert.deepEqual(quoteBreakdown({ total_quote_amount: 850, subtotal_amount: 1000, discount_amount: 150, discount_reason: 'Loyal' }),
      { has_quote: true, subtotal_amount: 1000, discount_amount: 150, discount_reason: 'Loyal', total_quote_amount: 850 });
    // Priced before migration 011 (no breakdown stored): the quote is its own subtotal
    assert.deepEqual(quoteBreakdown({ total_quote_amount: 500, subtotal_amount: 0, discount_amount: 0, discount_reason: null }),
      { has_quote: true, subtotal_amount: 500, discount_amount: 0, discount_reason: null, total_quote_amount: 500 });
    assert.equal(quoteBreakdown({ total_quote_amount: 0 }).has_quote, false);
    assert.deepEqual(manualQuoteColumns(720), { subtotal_amount: 720, discount_amount: 0, discount_reason: null });
    const breakdown = quoteBreakdown({ total_quote_amount: 900, subtotal_amount: 1000, discount_amount: 100, discount_reason: 'x' });
    const items = [{ line_item_id: 'a', product_type: 'Jersey', quantity: 4, price: 150 }, { line_item_id: 'b', product_type: 'Mug', quantity: 2, price: 200 }];
    assert.deepEqual(quoteLines(items, breakdown).map((l) => l.line_total), [600, 400]);
    assert.equal(quoteLines([...items, { line_item_id: 'c', product_type: 'Cap', quantity: 1, price: 0 }], breakdown), null, 'an item added after pricing');
    assert.equal(quoteLines(items, quoteBreakdown({ total_quote_amount: 1200 })), null, 'a typed quote that the prices do not match');
  });
});

describe('Consumables (PB 15)', () => {
  const rates = [
    { product_inventory_id: 'shirt-s', consumable_inventory_id: 'ink', quantity_per_piece: '0.250', trigger_status: 'Pressing' },
    { product_inventory_id: 'shirt-l', consumable_inventory_id: 'ink', quantity_per_piece: '0.300', trigger_status: 'Pressing' },
    { product_inventory_id: 'shirt-s', consumable_inventory_id: 'paper', quantity_per_piece: '1', trigger_status: 'Pressing' },
    { product_inventory_id: 'shirt-l', consumable_inventory_id: 'paper', quantity_per_piece: '1', trigger_status: 'Pressing' },
    { product_inventory_id: 'shirt-s', consumable_inventory_id: 'thread', quantity_per_piece: '0.1', trigger_status: 'Completed' },
    { product_inventory_id: 'mug', consumable_inventory_id: 'ink', quantity_per_piece: '5', trigger_status: 'Pressing' }
  ];
  const items = [{ inventory_id: 'shirt-s', quantity: 10 }, { inventory_id: 'shirt-l', quantity: 5 }, { inventory_id: null, quantity: 99 }];

  it('sets off the Pressing rates when leaving Printing, and both kinds on Completed', () => {
    assert.deepEqual(triggersFor('Printing', 'Pressing'), ['Pressing']);
    assert.deepEqual(triggersFor('Printing', 'Completed'), ['Pressing', 'Completed'], 'Pressing skipped: its rates are taken now');
    assert.deepEqual(triggersFor('Pressing', 'Completed'), ['Pressing', 'Completed']);
    for (const [from, to] of [['Approved', 'Printing'], ['Printing', 'Cancelled'], ['Pressing', 'Cancelled'], ['Delayed', 'Pending']]) {
      assert.deepEqual(triggersFor(from, to), [], `${from} -> ${to}`);
    }
  });

  it('adds mixed sizes and several consumables, rounding each total up', () => {
    assert.deepEqual(plannedDeductions({ items, rates, triggers: ['Pressing'] }), [
      { trigger_status: 'Pressing', consumable_inventory_id: 'ink', needed: 4 },    // 10 x 0.25 + 5 x 0.3 = 4.0
      { trigger_status: 'Pressing', consumable_inventory_id: 'paper', needed: 15 }
    ]);
    const done = plannedDeductions({ items, rates, triggers: ['Pressing', 'Completed'] });
    assert.deepEqual(done.map((d) => [d.consumable_inventory_id, d.needed]), [['ink', 4], ['paper', 15], ['thread', 1]], '10 x 0.1 = 1.0, not 1.0000001');
    const odd = plannedDeductions({ items: [{ inventory_id: 'shirt-s', quantity: 3 }], rates, triggers: ['Completed'] });
    assert.deepEqual(odd.map((d) => d.needed), [1], '0.3 rounds up to 1');
  });

  it('never plans a consumable twice for the same order and step', () => {
    const again = plannedDeductions({ items, rates, triggers: ['Pressing', 'Completed'], done: [
      { trigger_status: 'Pressing', consumable_inventory_id: 'ink' }, { trigger_status: 'Pressing', consumable_inventory_id: 'paper' }
    ] });
    assert.deepEqual(again.map((d) => [d.trigger_status, d.consumable_inventory_id]), [['Completed', 'thread']]);
    assert.deepEqual(plannedDeductions({ items: [], rates, triggers: ['Pressing'] }), []);
  });

  it('takes only what is on hand and records the rest as a shortfall', () => {
    assert.deepEqual(clampDeduction(10, 25), { quantity_deducted: 10, shortfall: 0 });
    assert.deepEqual(clampDeduction(10, 3), { quantity_deducted: 3, shortfall: 7 });
    assert.deepEqual(clampDeduction(10, 0), { quantity_deducted: 0, shortfall: 10 });
    assert.deepEqual(clampDeduction(4, -2), { quantity_deducted: 0, shortfall: 4 }, 'never below 0, even from a bad count');
  });

  it('checks a usage-rate list row by row, in plain words', () => {
    const ok = checkRateList([{ consumable_inventory_id: 'ink', quantity_per_piece: 0.125 }, { consumable_inventory_id: 'ink', quantity_per_piece: 2, trigger_status: 'Completed' }], 'shirt', ID_PATTERN);
    assert.deepEqual(ok, { errors: [], rates: [
      { consumable_inventory_id: 'ink', quantity_per_piece: 0.125, trigger_status: 'Pressing' },
      { consumable_inventory_id: 'ink', quantity_per_piece: 2, trigger_status: 'Completed' }
    ] });
    const bad = checkRateList([
      { consumable_inventory_id: 'shirt', quantity_per_piece: 1 },
      { consumable_inventory_id: 'ink', quantity_per_piece: '1' },
      { consumable_inventory_id: 'ink', quantity_per_piece: 0.0001 },
      { consumable_inventory_id: 'ink', quantity_per_piece: 1, trigger_status: 'Printing' },
      { consumable_inventory_id: 'paper', quantity_per_piece: 1 },
      { consumable_inventory_id: 'paper', quantity_per_piece: 2 }
    ], 'shirt', ID_PATTERN);
    assert.deepEqual(bad.errors.map((e) => e.message.split(':')[0]), ['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 6']);
    assert.match(bad.errors[0].message, /cannot use itself up/);
    assert.equal(checkRateList('ink', 'shirt', ID_PATTERN).errors[0].field, 'rates');
    assert.equal(checkRateList(Array(51).fill({ consumable_inventory_id: 'ink', quantity_per_piece: 1 }), 'shirt', ID_PATTERN).errors.length, 1);
  });
});

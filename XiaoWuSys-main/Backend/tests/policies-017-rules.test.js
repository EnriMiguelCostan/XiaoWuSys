// Migration 017: shop policies (cancellation fee, refunds, late delivery, add-ons), production
// progress per item and print-based quotes. Pure rules: no server, no database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  cancellationTerms, refundLimits, lateDeliveryCut, addOnCheck, productionProgress, checkProgressUpdate
} = require('../services/domain/orderPolicies');
const { computeQuote, parsePrintAreas } = require('../services/domain/pricing');
const { allowedActions, STATUS_TRANSITIONS, quoteLocked, completionCheck, fulfillmentSummary, capabilityForTransition } = require('../services/domain/orderLifecycle');
const { can } = require('../services/domain/permissions');

describe('Cancellation fee by stage', () => {
  const at = (status, extra = {}) => cancellationTerms({ status, bill: 10000, paidNet: 5000, ...extra });

  it('keeps nothing before approval, a layout fee after, the downpayment once printing, everything once made', () => {
    assert.deepEqual([at('Pending').fee, at('Pending').suggested_refund], [0, 5000]);
    assert.deepEqual([at('Approved').fee, at('Approved').kept, at('Approved').suggested_refund], [1000, 1000, 4000], '10% of ₱10,000');
    assert.equal(cancellationTerms({ status: 'Approved', bill: 800, paidNet: 400 }).fee, 150, 'at least ₱150');
    assert.deepEqual([at('Printing').fee, at('Printing').suggested_refund], [5000, 0], 'the 50% downpayment');
    assert.deepEqual([at('Printing', { paidNet: 7000 }).suggested_refund], [2000], 'paid above the downpayment comes back');
    assert.deepEqual([at('Ready', { paidNet: 7000 }).kept, at('Ready', { paidNet: 7000 }).suggested_refund], [7000, 0]);
  });

  it("refunds everything when it was the shop's fault", () => {
    const fault = at('Ready', { shopFault: true });
    assert.deepEqual([fault.fee, fault.suggested_refund, fault.shop_fault], [0, 5000, true]);
  });

  it('lets an Admin refund up to the suggestion and the Owner up to what was paid', () => {
    assert.deepEqual(refundLimits({ status: 'Cancelled', bill: 10000, paidNet: 5000, cancellationFee: 1000 }), { owner_max: 5000, admin_max: 4000, suggested: 4000 });
    assert.deepEqual(refundLimits({ status: 'Completed', bill: 1000, paidNet: 1200 }), { owner_max: 200, admin_max: 200, suggested: 200 }, 'overpaid');
  });
});

describe('Late delivery price cut', () => {
  const order = { production_deadline: '2026-11-10 00:00:00', production_status: 'Ready', total_quote_amount: 10000, adjustment_amount: 0 };

  it('gives 1 day of grace, then 2% a day, at most 10%', () => {
    assert.equal(lateDeliveryCut({ order, today: '2026-11-11' }).amount, 0, 'one day late: grace');
    assert.deepEqual([lateDeliveryCut({ order, today: '2026-11-13' }).percent, lateDeliveryCut({ order, today: '2026-11-13' }).amount], [4, 400], '3 days late');
    const week = lateDeliveryCut({ order, today: '2026-11-20' });
    assert.deepEqual([week.percent, week.amount, week.full_refund_eligible], [10, 1000, true], '10 days late: capped, may cancel');
  });

  it("suggests nothing when the client caused the delay", () => {
    const r = lateDeliveryCut({ order: { ...order, client_delay_reason: 'Design sent late' }, today: '2026-11-20' });
    assert.deepEqual([r.amount, r.client_caused], [0, true]);
  });

  it('cuts only the late batches when the order is delivered in planned batches', () => {
    const plans = [{ plan_id: 'a', batch_no: 1, planned_quantity: 50, planned_date: '2026-11-05' }, { plan_id: 'b', batch_no: 2, planned_quantity: 50, planned_date: '2026-11-10' }];
    const deliveries = [{ plan_id: 'a', quantity: 50, delivered_at: '2026-11-05' }, { plan_id: 'b', quantity: 50, delivered_at: '2026-11-14' }];
    const r = lateDeliveryCut({ order: { ...order, production_status: 'Completed' }, plans, deliveries, piecesOrdered: 100, today: '2026-11-24' });
    assert.equal(r.amount, 300, 'batch 2 (half the bill) 4 days late: 6% of ₱5,000');
    assert.deepEqual(r.batches.map((b) => b.days_late), [0, 4]);
  });
});

describe('Items added after approval', () => {
  const base = { deadline: '2026-12-20', today: '2026-11-25', existingPieces: 100, addPieces: 10, isManager: true };

  it('is free before approval, for managers while Approved / Printing, and refused after', () => {
    assert.deepEqual(addOnCheck({ ...base, status: 'Pending', isManager: false }), { addOn: false, deadlineReview: false });
    assert.equal(addOnCheck({ ...base, status: 'Pending', isManager: false, deadline: '2026-11-27' }).body.error, 'ADD_ON_NEEDS_DEADLINE',
      'the deadline rule holds before approval too');
    assert.equal(addOnCheck({ ...base, status: 'Approved', isManager: false }).body.error, 'ADD_ON_NEEDS_MANAGER');
    assert.deepEqual(addOnCheck({ ...base, status: 'Printing' }), { addOn: true, deadlineReview: false });
    assert.equal(addOnCheck({ ...base, status: 'Pressing' }).body.error, 'ADD_ON_CLOSED');
    assert.equal(addOnCheck({ ...base, status: 'Ready' }).body.error, 'ADD_ON_CLOSED');
  });

  it('needs a later deadline (or a reason) close to the deadline or for a big add-on', () => {
    assert.equal(addOnCheck({ ...base, status: 'Approved', deadline: '2026-11-27' }).body.error, 'ADD_ON_NEEDS_DEADLINE');
    assert.equal(addOnCheck({ ...base, status: 'Approved', addPieces: 30 }).body.error, 'ADD_ON_NEEDS_DEADLINE', '30% more');
    assert.equal(addOnCheck({ ...base, status: 'Approved', addPieces: 30, newDeadline: '2026-12-27' }).addOn, true);
    assert.equal(addOnCheck({ ...base, status: 'Approved', addPieces: 30, newDeadline: '2026-12-10' }).body.error, 'ADD_ON_NEEDS_DEADLINE', 'earlier is not later');
    assert.equal(addOnCheck({ ...base, status: 'Approved', addPieces: 30, keepReason: 'Same design, 2 hours of work' }).deadlineReview, true);
  });
});

describe('Production progress per item', () => {
  const lines = [
    { line_item_id: 'shirt', product_type: 'White T-Shirt', quantity: 10, qty_printed: 10, qty_pressed: 4, requires_pressing: true },
    { line_item_id: 'mug', product_type: 'Mug', quantity: 5, qty_printed: 5, qty_pressed: 0, requires_pressing: false },
    { line_item_id: 'ink', product_type: 'Ink', quantity: 30, is_consumable: true }
  ];

  it('counts what is printed, pressed and ready (consumables left out)', () => {
    const p = productionProgress(lines);
    assert.deepEqual([p.pieces, p.printed, p.pressed, p.ready, p.all_printed, p.all_ready, p.needs_pressing], [15, 15, 4, 9, true, false, true]);
  });

  it('never presses more than was printed, never prints more than ordered, keeps handed-over pieces ready', () => {
    assert.equal(checkProgressUpdate({ lines, sent: [{ line_item_id: 'shirt', printed: 11 }] }).problem.body.error, 'PROGRESS_TOO_HIGH');
    assert.equal(checkProgressUpdate({ lines, sent: [{ line_item_id: 'shirt', pressed: 11 }] }).problem.body.error, 'PROGRESS_TOO_HIGH', '11 pressed but 10 printed');
    const fresh = [{ line_item_id: 'cap', product_type: 'Cap', quantity: 5, qty_printed: 0, qty_pressed: 0, requires_pressing: true }];
    assert.equal(checkProgressUpdate({ lines: fresh, sent: [{ line_item_id: 'cap', pressed: 1 }] }).problem.body.error, 'PROGRESS_TOO_HIGH', 'nothing printed yet: nothing to press');
    assert.equal(checkProgressUpdate({ lines, sent: [{ line_item_id: 'shirt', pressed: 1 }] }).problem.body.error, 'PROGRESS_CANNOT_DECREASE');
    assert.equal(checkProgressUpdate({ lines, sent: [{ line_item_id: 'mug', printed: 4 }] }).problem.body.error, 'PROGRESS_CANNOT_DECREASE');
    const ok = checkProgressUpdate({ lines, sent: [{ line_item_id: 'shirt', pressed: 10 }, { line_item_id: 'mug', pressed: 5 }] });
    assert.deepEqual(ok.updates.find((u) => u.line_item_id === 'mug'), { line_item_id: 'mug', printed: 5, pressed: 0 }, 'a mug is never pressed');
    assert.equal(ok.after.all_ready, true);
    assert.equal(checkProgressUpdate({ lines, sent: [{ line_item_id: 'ink', printed: 1 }] }).problem.status, 400);
  });
});

describe('Status buttons follow the progress', () => {
  const ctx = (progress, extra = {}) => ({ needs_pressing: progress.needs_pressing, progress, ...extra });

  it('presses T-shirts before Ready, and completes only from Ready', () => {
    assert.deepEqual(STATUS_TRANSITIONS.Printing, ['Pressing', 'Ready', 'Cancelled']);
    assert.deepEqual(STATUS_TRANSITIONS.Pressing, ['Ready', 'Cancelled']);
    const shirts = allowedActions({ production_status: 'Printing' }, 'Staff', null, ctx({ needs_pressing: true, all_printed: false, all_ready: false, ready: 0 }));
    assert.deepEqual(shirts.statuses, ['Pressing'], 'Staff cannot cancel an approved order; no Ready before pressing');
    assert.equal(shirts.status_needs_confirm.Pressing, true, 'not everything is printed yet: ask first');
    const mugs = allowedActions({ production_status: 'Printing' }, 'Admin', null, ctx({ needs_pressing: false, all_printed: true, all_ready: true, ready: 5 }));
    assert.deepEqual(mugs.statuses, ['Ready', 'Cancelled']);
    assert.equal(mugs.status_needs_confirm.Ready, false);
    assert.equal(completionCheck({ order: { production_status: 'Pressing' }, summary: { quote: 1, remaining: 0 }, fulfillment: fulfillmentSummary({}) }).missing[0].code, 'NOT_READY');
  });

  it('lets anyone cancel before approval and only the Owner or an Admin after', () => {
    assert.equal(capabilityForTransition('Cancelled', 'Pending'), 'cancel_order');
    assert.equal(capabilityForTransition('Cancelled', 'Approved'), 'cancel_approved_order');
    assert.ok(allowedActions({ production_status: 'Pending' }, 'Staff').cancel);
    assert.ok(!allowedActions({ production_status: 'Approved' }, 'Staff').cancel);
    assert.ok(allowedActions({ production_status: 'Approved' }, 'Admin').cancel);
  });

  it('records waste and hands pieces over only once printing has started, and only ready pieces', () => {
    assert.equal(allowedActions({ production_status: 'Approved' }, 'Staff').log_loss, false);
    assert.equal(allowedActions({ production_status: 'Printing' }, 'Staff').log_loss, true);
    const fulfillment = fulfillmentSummary({ pieces_ordered: 20, deliveries: [{ quantity: 5 }] });
    const a = allowedActions({ production_status: 'Approved' }, 'Staff', null, { fulfillment, progress: { ready: 20 } });
    assert.deepEqual([a.record_delivery, a.max_delivery], [false, 0]);
    const p = allowedActions({ production_status: 'Printing' }, 'Staff', null, { fulfillment, progress: { ready: 12, needs_pressing: false } });
    assert.deepEqual([p.record_delivery, p.max_delivery], [true, 7], '12 ready, 5 handed over');
  });

  it('locks the price from printing on', () => {
    assert.equal(quoteLocked('Approved', 0), false);
    assert.equal(quoteLocked('Printing', 0), true);
  });

  it("limits an Admin's refunds and price cuts to the policy, not the Owner's", () => {
    const order = { production_status: 'Ready', total_quote_amount: 1000, adjustment_amount: 0 };
    const summary = { quote: 1000, remaining: 0, total_paid: 1000 };
    const admin = allowedActions(order, 'Admin', summary, { max_refund: 500, admin_max_refund: 300, late_cut_amount: 40 });
    const owner = allowedActions(order, 'Owner', summary, { max_refund: 500, admin_max_refund: 300, late_cut_amount: 40 });
    assert.deepEqual([admin.max_refund, owner.max_refund], [300, 500]);
    assert.deepEqual([admin.max_adjustment, owner.max_adjustment], [40, 1000]);
    assert.equal(allowedActions(order, 'Admin', summary, { late_cut_amount: 0 }).adjust_price, false, 'not late: the Owner decides');
    assert.ok(can('Admin', 'refund_payment') && !can('Admin', 'refund_above_policy') && can('Owner', 'refund_above_policy'));
  });
});

describe('Print-based quotes', () => {
  const shirt = (qty, areas) => ({
    line_item_id: 's', product_type: 'White T-Shirt', quantity: qty, inventory_id: 'w', item_name: 'White T-Shirt',
    selling_price: 160, unit_cost: 95, print_pricing: 'per_area', print_areas: JSON.stringify(areas)
  });

  it('adds each print area to the blank, and takes the tier off the printing only', () => {
    const one = computeQuote({ items: [shirt(5, [{ placement: 'Front', size: 'A4' }])] }).quote;
    assert.deepEqual([one.lines[0].print_charge, one.lines[0].unit_price], [100, 260], '₱160 blank + ₱100 A4');
    const both = computeQuote({ items: [shirt(100, [{ placement: 'Front', size: 'A4' }, { placement: 'Back', size: 'A3' }])] }).quote;
    assert.equal(both.lines[0].unit_price, 381, '₱160 + (₱100 + ₱160) less 15% = ₱160 + ₱221');
    const mug = computeQuote({ items: [{ line_item_id: 'm', product_type: 'Mug', quantity: 100, inventory_id: 'm', selling_price: 180, print_pricing: 'included' }] }).quote;
    assert.equal(mug.lines[0].unit_price, 153, 'included: the whole price less 15%');
  });

  it('takes the discount before the incidental charges, and caps the incidental charges', () => {
    const q = computeQuote({ items: [shirt(10, [])], requested: { labor: 400, percent: 10, reason: 'Repeat', incidental_percent: 5 } }).quote;
    // materials ₱1,600 + labor ₱400 = ₱2,000; discount 10% = ₱200; incidental 5% of ₱2,000 = ₱100
    assert.deepEqual([q.subtotal_amount, q.discount_amount, q.incidental_amount, q.total_quote_amount], [1600, 200, 100, 1900]);
    const big = computeQuote({ items: [shirt(10, [])], requested: { incidental: 500 } });
    assert.equal(big.problem.body.error, 'INCIDENTAL_TOO_LARGE', 'more than 20% of ₱1,600');
  });

  it('warns about a big discount, and refuses one that sells below cost', () => {
    const q = computeQuote({ items: [shirt(10, [])], requested: { percent: 35, reason: 'Sponsor' } }).quote;
    assert.deepEqual(q.warnings.map((w) => w.code), ['DISCOUNT_ABOVE_GUIDE'], '₱1,040 is still above the ₱950 the blanks cost');
    const below = computeQuote({ items: [shirt(10, [])], requested: { percent: 50, reason: 'Sponsor' } });
    assert.deepEqual([below.problem.body.error, below.problem.body.max_discount], ['DISCOUNT_BELOW_COST', 650]);
    const cheap = computeQuote({ items: [{ ...shirt(10, []), selling_price: 90 }] }).quote;
    assert.deepEqual(cheap.warnings.map((w) => w.code), ['BELOW_COST'], 'a catalog price below cost only warns');
  });

  it('checks the print areas', () => {
    assert.ok(parsePrintAreas([{ placement: 'Front', size: 'A5' }]).error);
    assert.ok(parsePrintAreas('not json').error);
    assert.deepEqual(parsePrintAreas(null), { areas: [] });
  });
});

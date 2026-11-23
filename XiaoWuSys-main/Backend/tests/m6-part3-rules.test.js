// Batch M6 part 3, rules only (no HTTP, no SQL): waste reason codes and diagnostics (PB 18 /
// PB 19), the dashboard waste summary (PB 20), payment voids (PB 23) and the true-cost P&L (PB 22).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  REASON_CODES, inferReasonCode, clusterMates, wasRushed, isLossAnomaly, classifyWaste, replacementWarning, baselineOf
} = require('../services/domain/wasteDiagnostics');
const { wasteSummary } = require('../services/domain/wasteReport');
const { checkPaymentVoid, voidStatusOf, paymentSummary } = require('../services/domain/payments');
const { computePnl, defaultPeriod, shopDayOf } = require('../services/domain/pnl');
const { allowedActions } = require('../services/domain/orderLifecycle');

const at = (hhmm, day = '2026-11-10') => `${day}T${hhmm}:00`; // server UTC text

describe('Waste diagnostics (PB 18 / PB 19)', () => {
  it('has the six standard reasons, each with its default cause, and reads old free text', () => {
    assert.deepEqual(Object.keys(REASON_CODES), [
      'misprint_alignment', 'sizing_encoding_error', 'heat_press_scorch', 'printer_head_banding', 'supplier_defect', 'damaged_in_storage'
    ]);
    assert.deepEqual(Object.values(REASON_CODES).map((r) => r.category),
      ['Human Error', 'Human Error', 'Machine Failure', 'Machine Failure', 'Product Defect', 'Human Error']);
    assert.equal(inferReasonCode('Scorched by the heat press'), 'heat_press_scorch');
    assert.equal(inferReasonCode('pinhole from supplier'), 'supplier_defect');
    assert.equal(inferReasonCode('Misprint, logo off-center'), 'misprint_alignment');
    assert.equal(inferReasonCode('wrong size printed'), 'sizing_encoding_error');
    assert.equal(inferReasonCode('Water damaged'), 'damaged_in_storage');
    assert.equal(inferReasonCode('Test reason'), null, 'unknown text stays unclassified');
    assert.equal(inferReasonCode(''), null);
  });

  it('finds machine-step losses within 60 minutes of each other (any order, any operator)', () => {
    const loss = { loss_id: 'n', production_stage: 'Pressing', date_recorded: at('10:00') };
    const nearby = [
      { loss_id: 'a', production_stage: 'Printing', date_recorded: at('09:00') },  // exactly 60 min: in
      { loss_id: 'b', production_stage: 'Printing', date_recorded: at('08:59') },  // 61 min: out
      { loss_id: 'c', production_stage: 'Pending', date_recorded: at('10:01') },   // not a machine step
      { loss_id: 'n', production_stage: 'Pressing', date_recorded: at('10:00') }   // itself
    ];
    assert.deepEqual(clusterMates(loss, nearby), ['a']);
    assert.deepEqual(clusterMates({ ...loss, production_stage: 'Approved' }, nearby), [], 'only losses during Printing / Pressing');
  });

  it('spots an order that left Printing in under 5 minutes', () => {
    const h = (from, to, hhmmss) => ({ from_status: from, to_status: to, changed_at: `2026-11-10T${hhmmss}` });
    assert.equal(wasRushed([h('Approved', 'Printing', '10:00:00'), h('Printing', 'Pressing', '10:04:59')]), true);
    assert.equal(wasRushed([h('Approved', 'Printing', '10:00:00'), h('Printing', 'Completed', '10:05:00')]), false, '5 minutes is not rushed');
    assert.equal(wasRushed([h('Printing', 'Completed', '10:01:00'), h('Approved', 'Printing', '10:00:00')]), true, 'any input order');
    assert.equal(wasRushed([h('Approved', 'Printing', '10:00:00')]), false);
  });

  it('flags an item whose losses are more than 2 standard deviations above the other items (exact maths)', () => {
    // others: mean 3, sample sd 1 -> limit 5
    assert.equal(isLossAnomaly(5, [2, 3, 4]), false, 'on the limit is not above it');
    assert.equal(isLossAnomaly(6, [2, 3, 4]), true);
    assert.equal(isLossAnomaly(60, [2, 3]), false, 'needs at least 3 other items as a baseline');
    assert.equal(isLossAnomaly(3, [2, 2, 2]), true, 'no spread: anything above the average stands out');
    assert.equal(isLossAnomaly(2, [2, 2, 2]), false);
    assert.equal(isLossAnomaly(1, [5, 9, 30]), false, 'below the average is never an anomaly');
    assert.deepEqual(baselineOf([2, 3, 4]), { items: 3, mean: 3, sd: 1 });
    assert.equal(baselineOf([1, 2]), null);
  });

  it('names one cause, in a fixed order of evidence', () => {
    const base = { loss_id: 'n', inventory_id: 'shirt', production_stage: 'Printing', date_recorded: at('10:00'), quantity_lost: 1 };
    const mate = [{ loss_id: 'm', production_stage: 'Pressing', date_recorded: at('10:30') }];
    const flat = [{ inventory_id: 'shirt', quantity: 1 }, { inventory_id: 'a', quantity: 1 }, { inventory_id: 'b', quantity: 1 }, { inventory_id: 'c', quantity: 1 }];
    const spike = [{ inventory_id: 'shirt', quantity: 40 }, { inventory_id: 'a', quantity: 2 }, { inventory_id: 'b', quantity: 3 }, { inventory_id: 'c', quantity: 4 }];
    const rushed = [{ from_status: 'Approved', to_status: 'Printing', changed_at: at('09:00') }, { from_status: 'Printing', to_status: 'Pressing', changed_at: '2026-11-10T09:02:00' }];

    const supplier = classifyWaste({ loss: { ...base, reason_code: 'supplier_defect' }, nearby: mate, itemTotals: spike });
    assert.deepEqual([supplier.loss_category, supplier.rule, supplier.is_statistical_anomaly], ['Product Defect', 'supplier_code', true],
      'a stated supplier defect wins; the statistics still flag the item');
    const cluster = classifyWaste({ loss: { ...base, reason_code: 'misprint_alignment' }, nearby: mate, itemTotals: flat });
    assert.deepEqual([cluster.loss_category, cluster.rule, cluster.cluster_with], ['Machine Failure', 'machine_cluster', ['m']],
      'a cluster escalates even a human reason');
    const stats = classifyWaste({ loss: { ...base, reason_code: 'misprint_alignment' }, itemTotals: spike, history: rushed });
    assert.deepEqual([stats.loss_category, stats.rule, stats.is_statistical_anomaly], ['Product Defect', 'statistical', true]);
    const rush = classifyWaste({ loss: { ...base, reason_code: 'heat_press_scorch' }, itemTotals: flat, history: rushed });
    assert.deepEqual([rush.loss_category, rush.rule], ['Human Error', 'rushed_step']);
    const code = classifyWaste({ loss: { ...base, reason_code: 'printer_head_banding' }, itemTotals: flat });
    assert.deepEqual([code.loss_category, code.rule, code.is_statistical_anomaly], ['Machine Failure', 'reason_code', false]);
    const none = classifyWaste({ loss: { ...base, reason_code: null, production_stage: null }, itemTotals: flat });
    assert.deepEqual([none.loss_category, none.rule], [null, null]);
  });

  it('warns, without blocking, when no free stock is left to replace ruined pieces', () => {
    assert.equal(replacementWarning({ item_name: 'Jersey', quantity_available: 5, quantity_reserved: 4 }), null);
    const w = replacementWarning({ item_name: 'Jersey', quantity_available: 4, quantity_reserved: 4 }, { forOrder: true });
    assert.equal(w.code, 'REPLACEMENT_STOCK_DEPLETED');
    assert.equal(w.free, 0);
    assert.match(w.message, /may delay this order/);
    assert.equal(replacementWarning({ item_name: 'Ink', quantity_available: 1, quantity_reserved: 3 }).free, -2);
  });

  it('summarises this month’s waste by cause, with costs only for finance accounts', () => {
    const losses = [
      { loss_id: '1', date_recorded: '2026-11-03T01:00:00', quantity_lost: 2, financial_cost: 240.5, loss_category: 'Machine Failure', is_statistical_anomaly: false },
      { loss_id: '2', date_recorded: '2026-10-31T17:00:00', quantity_lost: 1, financial_cost: 0.1, loss_category: null, is_statistical_anomaly: true }, // Nov 1 in Manila
      { loss_id: '3', date_recorded: '2026-10-31T15:00:00', quantity_lost: 9, financial_cost: 999, loss_category: 'Human Error', is_statistical_anomaly: false } // Oct 31
    ];
    const s = wasteSummary({ losses, month: '2026-11', showCosts: true, orderLabel: () => null });
    assert.deepEqual([s.total_cost_this_month, s.total_items_this_month, s.count_this_month], [240.6, 3, 2]);
    assert.deepEqual(s.by_category.map((c) => [c.category, c.count, c.cost]),
      [['Machine Failure', 1, 240.5], ['Human Error', 0, 0], ['Product Defect', 0, 0], ['Not classified', 1, 0.1]]);
    assert.deepEqual(s.anomalies.map((a) => a.loss_id), ['2']);
    const hidden = wasteSummary({ losses, month: '2026-11', showCosts: false });
    assert.deepEqual([hidden.costs_visible, hidden.total_cost_this_month, hidden.by_category[0].cost, hidden.recent[0].financial_cost], [false, null, null, null]);
    assert.equal(hidden.total_items_this_month, 3, 'counts are for everyone');
  });
});

describe('Payment voids (PB 23)', () => {
  const ok = { status: 'Pending', quote: 1000, paidSynced: 600, payment: { amount: 600, voided: false } };
  it('refuses voids, double voids, and breaking the downpayment of an order in production unless confirmed', () => {
    assert.equal(checkPaymentVoid(ok), null);
    assert.equal(checkPaymentVoid({ ...ok, payment: { amount: -600 } }).body.error, 'PAYMENT_NOT_VOIDABLE');
    assert.equal(checkPaymentVoid({ ...ok, payment: { amount: 600, voided: true } }).body.error, 'PAYMENT_ALREADY_VOIDED');
    for (const status of ['Approved', 'Printing', 'Pressing']) {
      const r = checkPaymentVoid({ ...ok, status });
      assert.deepEqual([r.status, r.body.error, r.body.required, r.body.paid_after], [409, 'VOID_BREAKS_DOWNPAYMENT', 500, 0], status);
      assert.equal(checkPaymentVoid({ ...ok, status, confirmBreak: true }), null, 'the Owner may confirm');
    }
    // 1100 paid, voiding 600 leaves 500 = exactly 50%: allowed
    assert.equal(checkPaymentVoid({ ...ok, status: 'Printing', paidSynced: 1100 }), null);
    // a quote of 999.99 needs 500.00 (rounded up to the centavo); 499.99 left is short
    assert.equal(checkPaymentVoid({ status: 'Approved', quote: 999.99, paidSynced: 1099.99, payment: { amount: 600 } }).body.error, 'VOID_BREAKS_DOWNPAYMENT');
    for (const status of ['Completed', 'Cancelled', 'Delayed']) assert.equal(checkPaymentVoid({ ...ok, status }), null, status);
  });

  it('marks which payments are voided, which entries are voids, and which can still be voided', () => {
    const payments = [
      { payment_id: 'p1', amount: 600, receipt_no: 'AR-2026-0001', sync_status: 'synced' },
      { payment_id: 'p2', amount: 200, receipt_no: 'AR-2026-0002', sync_status: 'synced' },
      { payment_id: 'v1', amount: -600, receipt_no: 'AR-2026-0003', voids_payment_id: 'p1', sync_status: 'synced' },
      { payment_id: 'p3', amount: 50, receipt_no: null, sync_status: 'pending_insert' }
    ];
    const s = voidStatusOf(payments);
    assert.deepEqual(s.get('p1'), { voided: true, voided_by_receipt_no: 'AR-2026-0003', is_void: false, voids_receipt_no: null, can_void: false });
    assert.equal(s.get('p2').can_void, true);
    assert.deepEqual([s.get('v1').is_void, s.get('v1').voids_receipt_no, s.get('v1').can_void], [true, 'AR-2026-0001', false]);
    assert.equal(s.get('p3').can_void, false, 'a payment saved offline is voided after it syncs');
    const totals = paymentSummary({ quote: 1000, payments });
    assert.deepEqual([totals.total_paid, totals.remaining, totals.payment_status], [250, 750, 'Partial'], 'the reversal nets the void out');
  });

  it('offers the void button to the Owner only', () => {
    const order = { production_status: 'Printing', total_quote_amount: 1000 };
    assert.deepEqual(['Owner', 'Admin', 'Staff', 'Production'].map((r) => allowedActions(order, r).void_payment), [true, false, false, false]);
    assert.deepEqual(['Owner', 'Admin', 'Staff', 'Production'].map((r) => allowedActions(order, r).log_loss), [true, true, true, false]);
  });
});

describe('True-cost P&L (PB 22)', () => {
  it('defaults to this month so far in shop time', () => {
    assert.deepEqual(defaultPeriod(new Date('2026-11-30T16:30:00Z')), { from: '2026-12-01', to: '2026-12-01' }, 'already Dec 1 in Manila');
    assert.deepEqual(defaultPeriod(new Date('2026-11-15T03:00:00Z')), { from: '2026-11-01', to: '2026-11-15' });
    assert.equal(shopDayOf('2026-10-31T16:00:00'), '2026-11-01');
    assert.equal(shopDayOf(null), null);
  });

  it('adds up income, cost of goods, waste and overheads in centavos', () => {
    const p = computePnl({
      from: '2026-11-01',
      to: '2026-11-30',
      payments: [
        { payment_date: '2026-11-02T02:00:00', amount: 1000.10 },
        { payment_date: '2026-11-03T02:00:00', amount: 0.2 },
        { payment_date: '2026-11-04T02:00:00', amount: -0.1 },        // a void
        { payment_date: '2026-10-31T15:59:59', amount: 5000 }          // Oct 31 in Manila: outside
      ],
      orders: [
        { order_id: 'o1', production_status: 'Completed', date_created: '2026-11-01T01:00:00', discount_amount: 100 },
        { order_id: 'o2', production_status: 'Cancelled', date_created: '2026-11-01T01:00:00', discount_amount: 50 },
        { order_id: 'o3', production_status: 'Completed', date_created: '2026-10-01T01:00:00', discount_amount: 70 }
      ],
      orderItems: [
        { order_id: 'o1', inventory_id: 'shirt', quantity: 3 },
        { order_id: 'o1', inventory_id: null, quantity: 9 },
        { order_id: 'o3', inventory_id: 'shirt', quantity: 100 }
      ],
      completions: [
        { order_id: 'o1', changed_at: '2026-11-20T01:00:00' },
        { order_id: 'o3', changed_at: '2026-10-20T01:00:00' }        // completed last month: not counted
      ],
      consumablesLog: [
        { consumable_inventory_id: 'ink', quantity_deducted: 7, deducted_at: '2026-11-19T01:00:00' },
        { consumable_inventory_id: 'ink', quantity_deducted: 1, deducted_at: '2026-12-01T01:00:00' }
      ],
      losses: [
        { financial_cost: 120.3, loss_category: 'Machine Failure', date_recorded: '2026-11-05T00:00:00' },
        { financial_cost: 10, loss_category: null, date_recorded: '2026-11-06T00:00:00' }
      ],
      overheads: [
        { category: 'Rent', amount: 8000, expense_date: '2026-11-01T00:00:00' },
        { category: 'Electricity & Utilities', amount: 1500.55, expense_date: '2026-11-30T00:00:00' },
        { category: 'Rent', amount: 8000, expense_date: '2026-12-01T00:00:00' }
      ],
      unitCosts: new Map([['shirt', 120.33], ['ink', 0.07]])
    });
    assert.equal(p.gross_income, 1000.2, 'no float drift: 1000.10 + 0.20 - 0.10');
    assert.equal(p.voids_in_period, 0.1);
    assert.equal(p.discounts_given, 100);
    assert.equal(p.cogs_blanks, 360.99);
    assert.equal(p.cogs_consumables, 0.49);
    assert.equal(p.total_cogs, 361.48);
    assert.deepEqual([p.waste_cost, p.waste_by_category], [130.3, [{ category: 'Machine Failure', amount: 120.3 }, { category: 'Not classified', amount: 10 }]]);
    assert.deepEqual([p.overhead_cost, p.overhead_by_category], [9500.55, [{ category: 'Rent', amount: 8000 }, { category: 'Electricity & Utilities', amount: 1500.55 }]]);
    assert.equal(p.total_expenses, 9992.33);
    assert.equal(p.net_profit, -8992.13);
    assert.equal(p.profitable, false);
    assert.deepEqual(p.counts, { payments: 3, orders_completed: 1, losses: 2 });
  });

  it('is profitable at exactly zero', () => {
    const p = computePnl({ from: '2026-11-01', to: '2026-11-30' });
    assert.deepEqual([p.net_profit, p.profitable], [0, true]);
  });
});

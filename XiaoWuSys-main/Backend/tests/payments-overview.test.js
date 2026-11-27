// The Payments page overview (services/domain/paymentsOverview.js). Pure rules: no server, no database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { paymentsOverview, receivedBreakdown } = require('../services/domain/paymentsOverview');

const dayOf = (t) => (t ? String(t).slice(0, 10) : null);
const pay = (order_id, payment_date, amount, extra = {}) => ({ order_id, payment_date, amount, is_refund: false, voids_payment_id: null, ...extra });
const order = (order_id, date_created, total_quote_amount, production_status = 'Pending') => ({ order_id, date_created, total_quote_amount, production_status });

const orders = [
  order('A', '2026-10-20 09:00:00', 10000),
  order('B', '2026-11-02 09:00:00', 8000),
  order('C', '2026-11-05 09:00:00', 5000, 'Cancelled'),
  order('D', '2025-03-01 09:00:00', 2000)
];
const payments = [
  pay('A', '2026-10-21 10:00:00', 5000),
  pay('A', '2026-11-03 10:00:00', 5000), // an October order's balance, paid in November
  pay('B', '2026-11-02 10:00:00', 4000),
  pay('C', '2026-11-05 10:00:00', 2500),
  pay('C', '2026-11-09 10:00:00', -2000, { is_refund: true }),
  pay('B', '2026-11-04 10:00:00', 100),
  pay('B', '2026-11-04 11:00:00', -100, { voids_payment_id: 'x' }),
  pay('D', '2025-03-02 10:00:00', 2000)
];

describe('Payments overview', () => {
  const o = paymentsOverview({ payments, orders, dayOf, year: '2026', currentYear: '2026' });
  const nov = o.months.find((m) => m.month === '2026-11');

  it('counts received, refunded, voided and net by the day the money moved', () => {
    assert.deepEqual([nov.received, nov.refunded, nov.voided, nov.net, nov.payments], [11600, 2000, 100, 9500, 4]);
  });

  it('counts orders and their quotes by the day they were made, without cancelled ones', () => {
    assert.deepEqual([nov.orders, nov.billed], [1, 8000]);
    assert.deepEqual([o.months.find((m) => m.month === '2026-10').orders, o.year_totals.orders, o.year_totals.billed], [1, 2, 18000]);
  });

  it('lists the 12 months of the year and every year from the first with data', () => {
    assert.equal(o.months.length, 12);
    assert.deepEqual(o.years.map((y) => y.year), ['2025', '2026']);
    assert.equal(o.years[0].received, 2000);
    assert.equal(o.year_totals.net, o.years[1].net);
    assert.deepEqual([o.all_totals.received, o.all_totals.orders], [18600, 3]);
  });

  it('gives bar heights against the tallest bar', () => {
    assert.equal(nov.net_bar, 100);
    assert.equal(o.months.find((m) => m.month === '2026-10').net_bar, 53, '5000 of 9500');
    assert.equal(o.months.find((m) => m.month === '2026-01').net_bar, 0);
    assert.deepEqual([nov.orders_bar, o.years[0].orders_bar], [100, 50]);
  });
});

describe('Which orders a month’s money was for', () => {
  it('splits received into this month’s orders, cancelled ones and earlier orders', () => {
    const b = receivedBreakdown({ payments, ordersById: new Map(orders.map((x) => [x.order_id, x])), dayOf, month: '2026-11' });
    assert.deepEqual(b, { for_this_months_orders: 4100, for_cancelled_orders: 2500, for_earlier_orders: 5000 });
  });
});

// The Payments page overview: money in by month (for one year) and by year, with the orders
// made in each, and the heights of the page's bar charts. Pure: no server, no database.
//
//   received  payments dated in the period, for any order (an older order's balance included)
//   refunded  refunds dated in the period;  voided: payments cancelled as a mistake
//   net       received - refunded - voided
//   orders    orders created in the period that are not cancelled;  billed: their quotes
//
// received and billed count different things, so they do not match: money for an order made
// earlier is received now, and an order made now may be paid later. The month's own page breaks
// "received" down by which orders the money was for (receivedBreakdown).
const { toCentavos, toPesos } = require('./payments');

const kind = (p) => (p.is_refund ? 'refund' : p.voids_payment_id ? 'void' : 'payment');

const emptyC = () => ({ receivedC: 0, refundedC: 0, voidedC: 0, count: 0, orders: 0, billedC: 0 });

const add = (t, p) => {
  const c = toCentavos(p.amount);
  const k = kind(p);
  if (k === 'refund') t.refundedC += -c;
  else if (k === 'void') t.voidedC += -c;
  else {
    t.receivedC += c;
    t.count += 1;
  }
};

const toRow = (key, t) => ({
  [key.name]: key.value,
  received: toPesos(t.receivedC),
  refunded: toPesos(t.refundedC),
  voided: toPesos(t.voidedC),
  net: toPesos(t.receivedC - t.refundedC - t.voidedC),
  payments: t.count,
  orders: t.orders,
  billed: toPesos(t.billedC)
});

/** Bar heights (0-100, whole numbers) against the tallest bar in the set; negative nets draw no bar */
const withBars = (rows) => {
  const tallestNet = Math.max(0, ...rows.map((r) => r.net));
  const tallestOrders = Math.max(0, ...rows.map((r) => r.orders));
  return rows.map((r) => ({
    ...r,
    net_bar: tallestNet > 0 && r.net > 0 ? Math.max(1, Math.round((r.net / tallestNet) * 100)) : 0,
    orders_bar: tallestOrders > 0 && r.orders > 0 ? Math.max(1, Math.round((r.orders / tallestOrders) * 100)) : 0
  }));
};

/**
 * @param payments  [{ amount, is_refund, voids_payment_id, payment_date, order_id }]
 * @param orders    [{ order_id, date_created, production_status, total_quote_amount }]
 * @param dayOf     text -> 'YYYY-MM-DD' in shop time (pnl.shopDayOf)
 * @param year      'YYYY' shown month by month;  currentYear: 'YYYY' (the years list ends there)
 */
function paymentsOverview({ payments, orders, dayOf, year, currentYear }) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const perMonth = new Map(months.map((m) => [m, emptyC()]));
  const perYear = new Map();
  const yearTotal = (y) => {
    if (!perYear.has(y)) perYear.set(y, emptyC());
    return perYear.get(y);
  };

  for (const p of payments) {
    const day = dayOf(p.payment_date);
    if (!day) continue;
    add(yearTotal(day.slice(0, 4)), p);
    const m = perMonth.get(day.slice(0, 7));
    if (m) add(m, p);
  }
  for (const o of orders) {
    if (o.production_status === 'Cancelled') continue;
    const day = dayOf(o.date_created);
    if (!day) continue;
    const quoteC = toCentavos(o.total_quote_amount);
    for (const t of [yearTotal(day.slice(0, 4)), perMonth.get(day.slice(0, 7))]) {
      if (!t) continue;
      t.orders += 1;
      t.billedC += quoteC;
    }
  }

  // Every year from the first one with data up to this year (and the year shown), none skipped
  const known = [...perYear.keys(), currentYear, year].filter((y) => /^\d{4}$/.test(y)).sort();
  const years = [];
  for (let y = Number(known[0]); y <= Number(known[known.length - 1]); y += 1) years.push(String(y));

  const all = emptyC();
  for (const t of perYear.values()) for (const k of Object.keys(all)) all[k] += t[k];

  return {
    year,
    months: withBars(months.map((m) => toRow({ name: 'month', value: m }, perMonth.get(m)))),
    year_totals: toRow({ name: 'year', value: year }, perYear.get(year) || emptyC()),
    years: withBars(years.map((y) => toRow({ name: 'year', value: y }, perYear.get(y) || emptyC()))),
    all_totals: toRow({ name: 'years', value: years.length ? `${years[0]}-${years[years.length - 1]}` : '' }, all)
  };
}

/**
 * Which orders a month's received money was for: orders made that month (still going or since
 * cancelled) and orders made before. The three add up to the month's received.
 */
function receivedBreakdown({ payments, ordersById, dayOf, month }) {
  const c = { this_month: 0, this_month_cancelled: 0, earlier: 0 };
  for (const p of payments) {
    if (kind(p) !== 'payment' || (dayOf(p.payment_date) || '').slice(0, 7) !== month) continue;
    const o = ordersById.get(p.order_id);
    const made = o ? (dayOf(o.date_created) || '').slice(0, 7) : '';
    const key = made === month ? (o.production_status === 'Cancelled' ? 'this_month_cancelled' : 'this_month') : 'earlier';
    c[key] += toCentavos(p.amount);
  }
  return { for_this_months_orders: toPesos(c.this_month), for_cancelled_orders: toPesos(c.this_month_cancelled), for_earlier_orders: toPesos(c.earlier) };
}

module.exports = { paymentsOverview, receivedBreakdown };

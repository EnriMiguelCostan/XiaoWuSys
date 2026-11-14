// ==========================================
// TRUE-COST PROFIT & LOSS (PB 22; pure rules: no HTTP, no SQL)
//
// For a period of shop days [from, to] (both included, Asia/Manila), everything in integer
// centavos and returned in pesos:
//   gross_income      payments received in the period, minus voids (negative reversing entries)
//   discounts_given   discounts on orders created in the period that were not cancelled (shown
//                     for information: the income already reflects them)
//   cogs_blanks       order items x their item's unit cost, for orders COMPLETED in the period
//                     (completion date from the status history)
//   cogs_consumables  consumables taken from stock in the period x their unit cost
//   waste_cost        material losses recorded in the period (their stored cost), by cause
//   overhead_cost     overhead expenses dated in the period, by category
//   total_expenses = cogs_blanks + cogs_consumables + waste_cost + overhead_cost
//   net_profit     = gross_income - total_expenses        profitable = net_profit >= 0
// Unit costs are today's catalog costs (the catalog keeps no cost history).
// Server timestamps (payment_date, changed_at, deducted_at, date_recorded) are UTC; an
// expense_date is already a shop day.
// ==========================================
const { localDateTime } = require('../../utils/validation');
const { toCentavos, toPesos } = require('./payments');
const { categoryLabel } = require('./wasteDiagnostics');

// The kinds of overhead the Owner records each month (PB 22)
const OVERHEAD_CATEGORIES = [
  'Rent', 'Electricity & Utilities', 'Salaries & Wages', 'Outsourced Printing / Embroidery', 'Equipment Maintenance', 'Other'
];

const shopDayOf = (utcText) => {
  if (!utcText) return null;
  const text = String(utcText).replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(ms) ? localDateTime(new Date(ms)).slice(0, 10) : null;
};
const inPeriod = (day, from, to) => Boolean(day) && day >= from && day <= to;

// First day of the month and today, in shop time -> { from, to }
const defaultPeriod = (now = new Date()) => {
  const today = localDateTime(now).slice(0, 10);
  return { from: `${today.slice(0, 7)}-01`, to: today };
};

// { key: centavos } -> [{ <name>: key, amount }] largest first, then by name
const breakdown = (map, name) => [...map.entries()]
  .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  .map(([key, c]) => ({ [name]: key, amount: toPesos(c) }));

const computePnl = ({
  from, to, payments = [], orders = [], orderItems = [], completions = [], consumablesLog = [], losses = [],
  overheads = [], unitCosts = new Map()
}) => {
  const costC = (inventory_id) => toCentavos(unitCosts.get(inventory_id) || 0);

  let incomeC = 0;
  let voidsC = 0;
  let paymentCount = 0;
  for (const p of payments) {
    if (!inPeriod(shopDayOf(p.payment_date), from, to)) continue;
    const c = toCentavos(p.amount);
    incomeC += c;
    if (c < 0) voidsC += -c;
    paymentCount += 1;
  }

  let discountsC = 0;
  for (const o of orders) {
    if (o.production_status === 'Cancelled' || !inPeriod(shopDayOf(o.date_created), from, to)) continue;
    discountsC += toCentavos(o.discount_amount);
  }

  // An order counts once, on the day it (last) reached Completed
  const completedOn = new Map();
  for (const h of completions) {
    const day = shopDayOf(h.changed_at);
    if (day && (!completedOn.has(h.order_id) || day > completedOn.get(h.order_id))) completedOn.set(h.order_id, day);
  }
  const completedIds = new Set([...completedOn].filter(([, day]) => inPeriod(day, from, to)).map(([id]) => id));
  let blanksC = 0;
  for (const it of orderItems) {
    if (!completedIds.has(it.order_id) || !it.inventory_id) continue;
    blanksC += costC(it.inventory_id) * (Number(it.quantity) || 0);
  }

  let consumablesC = 0;
  for (const l of consumablesLog) {
    if (!inPeriod(shopDayOf(l.deducted_at), from, to)) continue;
    consumablesC += costC(l.consumable_inventory_id) * (Number(l.quantity_deducted) || 0);
  }

  let wasteC = 0;
  let wasteCount = 0;
  const wasteBy = new Map();
  for (const l of losses) {
    if (!inPeriod(shopDayOf(l.date_recorded), from, to)) continue;
    const c = toCentavos(l.financial_cost);
    wasteC += c;
    wasteCount += 1;
    const key = categoryLabel(l.loss_category);
    wasteBy.set(key, (wasteBy.get(key) || 0) + c);
  }

  let overheadC = 0;
  const overheadBy = new Map();
  for (const e of overheads) {
    if (!inPeriod(String(e.expense_date || '').slice(0, 10), from, to)) continue;
    const c = toCentavos(e.amount);
    overheadC += c;
    overheadBy.set(e.category, (overheadBy.get(e.category) || 0) + c);
  }

  const cogsC = blanksC + consumablesC;
  const expensesC = cogsC + wasteC + overheadC;
  const netC = incomeC - expensesC;
  return {
    period: { from, to },
    gross_income: toPesos(incomeC),
    voids_in_period: toPesos(voidsC),
    discounts_given: toPesos(discountsC),
    cogs_blanks: toPesos(blanksC),
    cogs_consumables: toPesos(consumablesC),
    total_cogs: toPesos(cogsC),
    waste_cost: toPesos(wasteC),
    waste_by_category: breakdown(wasteBy, 'category'),
    overhead_cost: toPesos(overheadC),
    overhead_by_category: breakdown(overheadBy, 'category'),
    total_expenses: toPesos(expensesC),
    net_profit: toPesos(netC),
    profitable: netC >= 0,
    counts: { payments: paymentCount, orders_completed: completedIds.size, losses: wasteCount }
  };
};

module.exports = { computePnl, defaultPeriod, shopDayOf, OVERHEAD_CATEGORIES };

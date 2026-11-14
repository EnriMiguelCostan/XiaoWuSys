// ==========================================
// WASTE SUMMARY FOR THE DASHBOARD (PB 20; pure rules: no HTTP, no SQL)
// Money in integer centavos, returned in pesos. Costs are only filled in for accounts that may
// see finances (view_finance); everyone else gets the counts and causes with costs set to null.
// ==========================================
const { toCentavos, toPesos } = require('./payments');
const { LOSS_CATEGORIES, NOT_CLASSIFIED, categoryLabel } = require('./wasteDiagnostics');
const { shopDayOf } = require('./pnl');

const RECENT_SHOWN = 10;
const ANOMALIES_SHOWN = 10;

//   losses: shown losses (services/waste.js shownLoss), newest first
//   month:  'YYYY-MM' (shop time)
//   orderLabel: (order_id) -> 'XM-2026-0123' | 'New order' | null
// -> { month, costs_visible, total_cost_this_month, total_items_this_month, count_this_month,
//      by_category: [{ category, count, quantity, cost }], anomalies: [...], recent: [...] }
const wasteSummary = ({ losses = [], month, showCosts = false, orderLabel = () => null }) => {
  const money = (c) => (showCosts ? toPesos(c) : null);
  const brief = (l) => ({
    loss_id: l.loss_id,
    date_recorded: l.date_recorded,
    item_name: l.item_name,
    unit: l.unit,
    quantity_lost: l.quantity_lost,
    reason_label: l.reason_label || l.loss_reason,
    category_label: categoryLabel(l.loss_category),
    production_stage: l.production_stage,
    is_statistical_anomaly: Boolean(l.is_statistical_anomaly),
    order_label: l.order_id ? orderLabel(l.order_id) : null,
    financial_cost: money(toCentavos(l.financial_cost)),
    sync_status: l.sync_status
  });

  const inMonth = losses.filter((l) => (shopDayOf(l.date_recorded) || '').slice(0, 7) === month);
  const groups = new Map([...LOSS_CATEGORIES, NOT_CLASSIFIED].map((c) => [c, { count: 0, quantity: 0, costC: 0 }]));
  let costC = 0;
  let items = 0;
  for (const l of inMonth) {
    const g = groups.get(categoryLabel(l.loss_category)) || groups.get(NOT_CLASSIFIED);
    const c = toCentavos(l.financial_cost);
    g.count += 1;
    g.quantity += Number(l.quantity_lost) || 0;
    g.costC += c;
    costC += c;
    items += Number(l.quantity_lost) || 0;
  }
  return {
    month,
    costs_visible: showCosts,
    total_cost_this_month: money(costC),
    total_items_this_month: items,
    count_this_month: inMonth.length,
    by_category: [...groups].map(([category, g]) => ({ category, count: g.count, quantity: g.quantity, cost: money(g.costC) })),
    anomalies: losses.filter((l) => l.is_statistical_anomaly).slice(0, ANOMALIES_SHOWN).map(brief),
    recent: losses.slice(0, RECENT_SHOWN).map(brief)
  };
};

module.exports = { wasteSummary };

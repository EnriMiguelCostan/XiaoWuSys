// ==========================================
// ORDER CONTEXT (migration 015)
// What the order screens and the status rules need besides the order row itself, read the same
// way online and offline (cloud first, this computer's copy when the cloud is unreachable):
//   materials       the order's items with their catalog facts (garment? consumable?)
//   print_details   sizes / names / numbers / texts (order_print_details)
//   deliveries      batches handed over (order_deliveries)
//   fulfillment     pieces ordered / handed over (orderLifecycle.fulfillmentSummary)
//   completion      what is still missing before "Completed" (orderLifecycle.completionCheck)
//   has_garments    whether the order has a garment (print details with sizes)
//   needs_pressing  migration 016: whether the Pressing step applies (the order has a T-shirt)
//   delivery_plans  migration 016: batches planned ahead (also inside fulfillment.plans)
//   max_refund      what may be refunded now (payments.maxRefund); admin_max_refund (migration 017)
//   progress        migration 017: pieces printed / pressed / ready per item (orderPolicies.productionProgress)
//   cancel_terms    migration 017: the cancellation fee and suggested refund (now, or as cancelled)
//   late_cut        migration 017: the suggested late-delivery price cut (orderPolicies.lateDeliveryCut)
// ==========================================
const { isConnectionError } = require('../utils/dbErrors');
const { listRecords, userNames, sqliteAll } = require('./records');
const { fulfillmentSummary, completionCheck } = require('./domain/orderLifecycle');
const { maxRefund, needsVerification } = require('./domain/payments');
const { localDateTime } = require('../utils/validation');
const { productionProgress, cancellationTerms, refundLimits, lateDeliveryCut } = require('./domain/orderPolicies');

const CONSUMABLE_CATEGORY = 'consumable';

// inventory_id -> { item_name, item_category, has_sizes, requires_pressing, unit } (cloud first)
const truthy = (v) => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const catalogFacts = async (req, ids) => {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const shape = (r) => [r.inventory_id, {
    item_name: r.item_name, item_category: r.item_category, unit: r.unit,
    has_sizes: truthy(r.has_sizes),
    requires_pressing: truthy(r.requires_pressing)
  }];
  try {
    const { rows } = await req.pgPool.query(
      'SELECT inventory_id, item_name, item_category, unit, has_sizes, requires_pressing FROM inventory_items WHERE inventory_id = ANY($1::text[])', [wanted]);
    const found = new Map(rows.map(shape));
    // Items created offline and not synced yet
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length) {
      const local = await sqliteAll(req.localDb,
        `SELECT inventory_id, item_name, item_category, unit, has_sizes, requires_pressing FROM inventory_items WHERE inventory_id IN (${missing.map(() => '?').join(', ')})`,
        missing).catch(() => []);
      for (const r of local) found.set(...shape(r));
    }
    return found;
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const rows = await sqliteAll(req.localDb,
      `SELECT inventory_id, item_name, item_category, unit, has_sizes, requires_pressing FROM inventory_items WHERE inventory_id IN (${wanted.map(() => '?').join(', ')})`,
      wanted);
    return new Map(rows.map(shape));
  }
};

const isConsumable = (facts) => Boolean(facts) && String(facts.item_category || '').trim().toLowerCase() === CONSUMABLE_CATEGORY;

// The order's materials with their facts -> [{ ...item, item_category, has_sizes, is_consumable, unit }]
const describeMaterials = (items, facts) => items.map((i) => {
  const f = facts.get(i.inventory_id) || null;
  return {
    ...i,
    item_category: f ? f.item_category : null,
    unit: f ? f.unit : null,
    has_sizes: Boolean(f && f.has_sizes),
    requires_pressing: Boolean(f && f.requires_pressing),
    is_consumable: isConsumable(f)
  };
});

const piecesOf = (materials) => materials.filter((m) => !m.is_consumable).reduce((s, m) => s + Number(m.quantity || 0), 0);

// -> { source, materials, print_details, deliveries, delivery_plans, fulfillment, completion, has_garments, needs_pressing,
//      max_refund, unverified }
//   order, items (order_items records), view (loadPaymentView result) are already loaded by the caller
const loadOrderContext = async (req, order, items, view) => {
  const [facts, prints, deliveries, plans] = await Promise.all([
    catalogFacts(req, items.map((i) => i.inventory_id)),
    listRecords(req, 'order_print_details', {
      filters: [['order_id', order.order_id]], orderBy: 'order_print_details.created_at, order_print_details.print_detail_id'
    }),
    listRecords(req, 'order_deliveries', { filters: [['order_id', order.order_id]], orderBy: 'batch_no, delivery_id' }),
    listRecords(req, 'order_delivery_plans', { filters: [['order_id', order.order_id]], orderBy: 'batch_no, plan_id' })
  ]);
  const materials = describeMaterials(items, facts);
  const names = await userNames(req, [...deliveries.records.map((d) => d.recorded_by), ...plans.records.map((p) => p.ready_by)]);
  const fulfillment = fulfillmentSummary({
    pieces_ordered: piecesOf(materials), deliveries: deliveries.records, plans: plans.records, today: localDateTime(new Date()).slice(0, 10)
  });
  fulfillment.plans = fulfillment.plans.map((p) => ({ ...p, ready_by_name: (p.ready_by && names.get(p.ready_by)) || null }));
  const unverified = (view ? view.payments : []).filter((p) => needsVerification(p) && !p.voided).length;
  const completion = completionCheck({ order, summary: view ? view.summary : null, fulfillment, unverified });
  const byLine = new Map(materials.map((m) => [m.line_item_id, m]));
  return {
    source: [prints.source, deliveries.source, plans.source].includes('local') ? 'local' : 'cloud',
    materials,
    print_details: prints.records.map((p) => ({
      ...p,
      material_name: p.line_item_id && byLine.get(p.line_item_id) ? byLine.get(p.line_item_id).product_type : null,
      on_garment: Boolean(p.line_item_id && byLine.get(p.line_item_id) && byLine.get(p.line_item_id).has_sizes)
    })),
    deliveries: deliveries.records.map((d) => {
      const plan = d.plan_id ? fulfillment.plans.find((p) => p.plan_id === d.plan_id) : null;
      return { ...d, recorded_by_name: (d.recorded_by && names.get(d.recorded_by)) || 'Not recorded', plan_batch_no: plan ? plan.batch_no : null };
    }),
    delivery_plans: fulfillment.plans,
    fulfillment,
    completion,
    has_garments: materials.some((m) => m.has_sizes),
    needs_pressing: materials.some((m) => m.requires_pressing),
    unverified,
    max_refund: view ? maxRefund({ status: order.production_status, quote: view.summary.quote, paidNet: view.summary.total_paid }) : 0,
    ...policyContext(order, materials, view, fulfillment, deliveries.records, plans.records)
  };
};

// A server UTC timestamp -> the shop day ('YYYY-MM-DD'), or null
const shopDayOfUtc = (text) => {
  if (!text) return null;
  const t = String(text).replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(t) ? t : `${t}Z`);
  return Number.isFinite(ms) ? localDateTime(new Date(ms)).slice(0, 10) : null;
};

// migration 017: progress, cancellation terms, refund limits and the late-delivery suggestion
const policyContext = (order, materials, view, fulfillment, deliveries, plans) => {
  const today = localDateTime(new Date()).slice(0, 10);
  const paid = view ? view.summary.total_paid : 0;
  const bill = view ? view.summary.quote : Number(order.total_quote_amount || 0);
  const cancelled = order.production_status === 'Cancelled';
  const limits = refundLimits({ status: order.production_status, bill, paidNet: paid, cancellationFee: order.cancellation_fee });
  const terms = cancelled
    ? {
      stage: order.cancelled_stage || null, fee: Number(order.cancellation_fee || 0), kept: Math.min(Number(order.cancellation_fee || 0), Number(paid || 0)),
      paid, suggested_refund: limits.suggested, shop_fault: Boolean(order.cancel_shop_fault), rule: null
    }
    : cancellationTerms({ status: order.production_status, bill, paidNet: paid });
  const late = lateDeliveryCut({
    order, deliveries: deliveries.map((d) => ({ ...d, delivered_at: shopDayOfUtc(d.delivered_at) })),
    plans, piecesOrdered: fulfillment.pieces_ordered, today
  });
  return {
    progress: productionProgress(materials),
    cancel_terms: terms,
    admin_max_refund: limits.admin_max,
    late_cut: late,
    late_cut_amount: late.amount
  };
};

module.exports = { catalogFacts, describeMaterials, piecesOf, isConsumable, loadOrderContext, CONSUMABLE_CATEGORY };

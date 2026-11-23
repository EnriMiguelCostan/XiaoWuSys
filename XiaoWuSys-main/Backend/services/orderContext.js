// ==========================================
// ORDER CONTEXT (migration 015)
// What the order screens and the status rules need besides the order row itself, read the same
// way online and offline (cloud first, this computer's copy when the cloud is unreachable):
//   materials       the order's items with their catalog facts (garment? consumable?)
//   print_details   sizes / names / numbers / texts (order_print_details)
//   deliveries      batches handed over (order_deliveries)
//   fulfillment     pieces ordered / handed over (orderLifecycle.fulfillmentSummary)
//   completion      what is still missing before "Completed" (orderLifecycle.completionCheck)
//   has_garments    whether the Pressing step applies
//   max_refund      what may be refunded now (payments.maxRefund)
// ==========================================
const { isConnectionError } = require('../utils/dbErrors');
const { listRecords, userNames, sqliteAll } = require('./records');
const { fulfillmentSummary, completionCheck } = require('./domain/orderLifecycle');
const { maxRefund, needsVerification } = require('./domain/payments');

const CONSUMABLE_CATEGORY = 'consumable';

// inventory_id -> { item_name, item_category, has_sizes, unit } (cloud first)
const catalogFacts = async (req, ids) => {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const shape = (r) => [r.inventory_id, {
    item_name: r.item_name, item_category: r.item_category, unit: r.unit,
    has_sizes: r.has_sizes === true || r.has_sizes === 1 || r.has_sizes === '1' || r.has_sizes === 't'
  }];
  try {
    const { rows } = await req.pgPool.query(
      'SELECT inventory_id, item_name, item_category, unit, has_sizes FROM inventory_items WHERE inventory_id = ANY($1::text[])', [wanted]);
    const found = new Map(rows.map(shape));
    // Items created offline and not synced yet
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length) {
      const local = await sqliteAll(req.localDb,
        `SELECT inventory_id, item_name, item_category, unit, has_sizes FROM inventory_items WHERE inventory_id IN (${missing.map(() => '?').join(', ')})`,
        missing).catch(() => []);
      for (const r of local) found.set(...shape(r));
    }
    return found;
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const rows = await sqliteAll(req.localDb,
      `SELECT inventory_id, item_name, item_category, unit, has_sizes FROM inventory_items WHERE inventory_id IN (${wanted.map(() => '?').join(', ')})`,
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
    is_consumable: isConsumable(f)
  };
});

const piecesOf = (materials) => materials.filter((m) => !m.is_consumable).reduce((s, m) => s + Number(m.quantity || 0), 0);

// -> { source, materials, print_details, deliveries, fulfillment, completion, has_garments, max_refund, unverified }
//   order, items (order_items records), view (loadPaymentView result) are already loaded by the caller
const loadOrderContext = async (req, order, items, view) => {
  const [facts, prints, deliveries] = await Promise.all([
    catalogFacts(req, items.map((i) => i.inventory_id)),
    listRecords(req, 'order_print_details', {
      filters: [['order_id', order.order_id]], orderBy: 'order_print_details.created_at, order_print_details.print_detail_id'
    }),
    listRecords(req, 'order_deliveries', { filters: [['order_id', order.order_id]], orderBy: 'batch_no, delivery_id' })
  ]);
  const materials = describeMaterials(items, facts);
  const names = await userNames(req, deliveries.records.map((d) => d.recorded_by));
  const fulfillment = fulfillmentSummary({ pieces_ordered: piecesOf(materials), deliveries: deliveries.records });
  const unverified = (view ? view.payments : []).filter((p) => needsVerification(p) && !p.voided).length;
  const completion = completionCheck({ order, summary: view ? view.summary : null, fulfillment, unverified });
  const byLine = new Map(materials.map((m) => [m.line_item_id, m]));
  return {
    source: [prints.source, deliveries.source].includes('local') ? 'local' : 'cloud',
    materials,
    print_details: prints.records.map((p) => ({
      ...p,
      material_name: p.line_item_id && byLine.get(p.line_item_id) ? byLine.get(p.line_item_id).product_type : null,
      on_garment: Boolean(p.line_item_id && byLine.get(p.line_item_id) && byLine.get(p.line_item_id).has_sizes)
    })),
    deliveries: deliveries.records.map((d) => ({ ...d, recorded_by_name: (d.recorded_by && names.get(d.recorded_by)) || 'Not recorded' })),
    fulfillment,
    completion,
    has_garments: materials.some((m) => m.has_sizes),
    unverified,
    max_refund: view ? maxRefund({ status: order.production_status, quote: view.summary.quote, paidNet: view.summary.total_paid }) : 0
  };
};

module.exports = { catalogFacts, describeMaterials, piecesOf, isConsumable, loadOrderContext, CONSUMABLE_CATEGORY };

// The demo history (scripts/history/generate.js) follows the app's own rules: no database needed.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { generateHistory } = require('../scripts/history/generate');
const { STATUS_TRANSITIONS } = require('../services/domain/orderLifecycle');
const { PRODUCTION_STATUSES, PAYMENT_TYPES } = require('../utils/validation');
const { REASON_CODES } = require('../services/domain/wasteDiagnostics');
const { STOCK_OUT_REASONS, REFERENCE_TYPES, MOVEMENT_TYPES } = require('../services/domain/stockDocuments');
const { OVERHEAD_CATEGORIES } = require('../services/domain/pnl');

const USERS = [
  { user_id: 'u-owner', role: 'Owner' }, { user_id: 'u-admin', role: 'Admin' },
  { user_id: 'u-staff', role: 'Staff' }, { user_id: 'u-production', role: 'Production' }
];
const NOW = new Date('2026-11-24T07:00:00Z');
const c = (pesos) => Math.round(Number(pesos) * 100);
const ms = (text) => Date.parse(`${String(text).replace(' ', 'T')}Z`);

describe('Demo history (2020 to today)', () => {
  let out;
  let T;
  before(() => {
    out = generateHistory({ users: USERS, now: NOW });
    T = out.tables;
  });

  it('is the same every time for the same seed and day', () => {
    const again = generateHistory({ users: USERS, now: NOW });
    assert.deepEqual(again.summary, out.summary);
    assert.equal(again.tables.payments[100].receipt_no, T.payments[100].receipt_no);
  });

  it('has 20 to 40 orders in every full month since January 2020', () => {
    const perMonth = new Map();
    for (const o of T.order_profiles) {
      const ym = new Date(ms(o.date_created) + 8 * 3600e3).toISOString().slice(0, 7);
      perMonth.set(ym, (perMonth.get(ym) || 0) + 1);
    }
    assert.equal([...perMonth.keys()].sort()[0], '2020-01');
    for (const [ym, n] of perMonth) {
      if (ym === '2026-11') continue; // this month so far
      assert.ok(n >= 20 && n <= 40, `${ym}: ${n} orders`);
    }
  });

  it('numbers orders, receipts and stock documents per year, in date order, with no gaps', () => {
    const check = (rows, field, dateField, prefix) => {
      const byYear = new Map();
      for (const r of [...rows].sort((a, b) => ms(a[dateField]) - ms(b[dateField]))) {
        const m = new RegExp(`^${prefix}-(\\d{4})-(\\d{4,})$`).exec(r[field]);
        assert.ok(m, `${r[field]}`);
        const n = (byYear.get(m[1]) || 0) + 1;
        byYear.set(m[1], n);
        assert.equal(Number(m[2]), n, `${r[field]} is out of order`);
      }
    };
    check(T.order_profiles, 'tracking_no', 'date_created', 'XM');
    check(T.payments, 'receipt_no', 'payment_date', 'AR');
    for (const [type, prefix] of [['stock_in', 'SI'], ['stock_out', 'SO'], ['stock_count', 'SC']]) {
      check(T.stock_documents.filter((d) => d.document_type === type), 'document_no', 'occurred_at', prefix);
    }
  });

  it('keeps every value inside what the database allows', () => {
    for (const o of T.order_profiles) assert.ok(PRODUCTION_STATUSES.includes(o.production_status));
    for (const p of T.payments) assert.ok(PAYMENT_TYPES.includes(p.payment_type), p.payment_type);
    for (const l of T.material_loss) assert.equal(l.loss_category, REASON_CODES[l.reason_code].category);
    for (const d of T.stock_documents.filter((x) => x.document_type === 'stock_out')) assert.ok(STOCK_OUT_REASONS.includes(d.reason));
    for (const d of T.stock_documents.filter((x) => x.reference_type)) assert.ok(REFERENCE_TYPES.includes(d.reference_type));
    for (const m of T.stock_movements) assert.ok(MOVEMENT_TYPES.includes(m.movement_type), m.movement_type);
    for (const e of T.overhead_expenses) assert.ok(OVERHEAD_CATEGORIES.includes(e.category), e.category);
    const nowText = NOW.toISOString().slice(0, 19).replace('T', ' ');
    for (const [table, field] of [['order_profiles', 'date_created'], ['payments', 'payment_date'], ['order_status_history', 'changed_at'],
      ['stock_movements', 'occurred_at'], ['material_loss', 'date_recorded'], ['order_deliveries', 'delivered_at']]) {
      for (const r of T[table]) assert.ok(r[field] <= nowText, `${table}.${field} ${r[field]} is in the future`);
    }
  });

  it('adds up every quote the way the app does', () => {
    for (const o of T.order_profiles) {
      if (c(o.total_quote_amount) === 0) continue;
      assert.equal(c(o.subtotal_amount) + c(o.labor_amount) + c(o.incidental_amount) - c(o.discount_amount), c(o.total_quote_amount), o.tracking_no);
      const lines = T.order_items.filter((i) => i.order_id === o.order_id);
      assert.equal(lines.reduce((s, i) => s + c(i.price) * i.quantity, 0), c(o.subtotal_amount), o.tracking_no);
      if (c(o.discount_amount) > 0) assert.ok(o.discount_reason);
    }
  });

  it('moves every order through allowed steps, in time order, with T-shirts only being pressed', () => {
    const itemById = new Map(T.inventory_items.map((i) => [i.inventory_id, i]));
    const byOrder = new Map();
    for (const h of T.order_status_history) byOrder.set(h.order_id, [...(byOrder.get(h.order_id) || []), h]);
    for (const o of T.order_profiles) {
      const steps = byOrder.get(o.order_id) || [];
      let last = ms(o.date_created);
      for (const h of steps) {
        const legal = h.to_status === 'Approved' ? ['Pending', 'Delayed'].includes(h.from_status) : (STATUS_TRANSITIONS[h.from_status] || []).includes(h.to_status);
        assert.ok(legal, `${o.tracking_no}: ${h.from_status} -> ${h.to_status}`);
        assert.ok(ms(h.changed_at) >= last, `${o.tracking_no}: steps out of order`);
        last = ms(h.changed_at);
        if (h.to_status === 'Approved') assert.ok(['Owner', 'Admin'].includes(h.changed_role), 'only the Owner or an Admin approves');
      }
      const final = steps.length ? steps[steps.length - 1].to_status : o.production_status;
      assert.equal(final, o.production_status, o.tracking_no);
      if (steps.some((h) => h.to_status === 'Pressing')) {
        assert.ok(T.order_items.some((i) => i.order_id === o.order_id && itemById.get(i.inventory_id).requires_pressing), `${o.tracking_no} pressed without a T-shirt`);
      }
    }
  });

  it('takes the downpayment before approval, and the full bill by completion', () => {
    const approvals = new Map(T.order_status_history.filter((h) => h.to_status === 'Approved').map((h) => [h.order_id, ms(h.changed_at)]));
    for (const o of T.order_profiles) {
      const pays = T.payments.filter((p) => p.order_id === o.order_id);
      const totalC = c(o.total_quote_amount);
      for (const p of pays) assert.ok(ms(p.payment_date) >= ms(o.date_created), `${o.tracking_no}: paid before it existed`);
      if (approvals.has(o.order_id) && totalC > 0) {
        const before = pays.filter((p) => ms(p.payment_date) <= approvals.get(o.order_id)).reduce((s, p) => s + c(p.amount), 0);
        assert.ok(before >= Math.ceil(totalC / 2), `${o.tracking_no}: approved without half paid`);
      }
      const paid = pays.reduce((s, p) => s + c(p.amount), 0);
      if (o.production_status === 'Completed') assert.equal(paid, totalC, `${o.tracking_no}: completed but not fully paid`);
      else if (o.production_status !== 'Cancelled') assert.ok(paid <= totalC, `${o.tracking_no}: overpaid`);
      else assert.ok(paid >= 0, `${o.tracking_no}: refunded more than was paid`);
      for (const p of pays.filter((x) => x.is_refund)) assert.ok(c(p.amount) < 0 && p.refund_reason);
    }
  });

  it('hands over every piece of a completed order, batch by batch when planned', () => {
    const pieces = new Map();
    const consumable = new Set(T.inventory_items.filter((i) => i.item_category === 'Consumable').map((i) => i.inventory_id));
    for (const i of T.order_items) if (!consumable.has(i.inventory_id)) pieces.set(i.order_id, (pieces.get(i.order_id) || 0) + i.quantity);
    for (const o of T.order_profiles) {
      const delivered = T.order_deliveries.filter((d) => d.order_id === o.order_id).reduce((s, d) => s + d.quantity, 0);
      const plans = T.order_delivery_plans.filter((p) => p.order_id === o.order_id);
      if (plans.length) assert.equal(plans.reduce((s, p) => s + p.planned_quantity, 0), pieces.get(o.order_id), `${o.tracking_no}: plan`);
      if (o.production_status === 'Completed') assert.equal(delivered, pieces.get(o.order_id), `${o.tracking_no}: not all handed over`);
      else assert.ok(delivered <= pieces.get(o.order_id));
      for (const d of T.order_deliveries.filter((x) => x.order_id === o.order_id && x.plan_id)) {
        const plan = plans.find((p) => p.plan_id === d.plan_id);
        assert.ok(plan && plan.ready_at && plan.ready_at <= d.delivered_at, `${o.tracking_no}: handed over before it was ready`);
      }
    }
  });

  it('keeps the stock card, the catalog and the open orders in agreement', () => {
    for (const item of T.inventory_items) {
      const moves = T.stock_movements.filter((m) => m.inventory_id === item.inventory_id);
      let balance = 0;
      for (const m of moves) {
        balance += m.quantity_change;
        assert.equal(m.balance_after, balance, `${item.item_name}: running balance`);
        assert.ok(balance >= 0, `${item.item_name} went below zero`);
      }
      assert.equal(item.quantity_available, balance, `${item.item_name}: on hand`);
      const held = T.order_profiles.filter((o) => o.stock_reserved)
        .reduce((s, o) => s + T.order_items.filter((i) => i.order_id === o.order_id && i.inventory_id === item.inventory_id).reduce((a, i) => a + i.quantity, 0), 0);
      assert.equal(item.quantity_reserved, held, `${item.item_name}: reserved`);
      assert.ok(item.quantity_available >= item.quantity_reserved, `${item.item_name}: holds more than it has`);
    }
    const sorted = [...T.stock_movements].sort((a, b) => ms(a.created_at) - ms(b.created_at));
    assert.deepEqual(sorted.map((m) => m.movement_id), T.stock_movements.map((m) => m.movement_id), 'the stock card is in time order');
  });

  it('records the blank cost of completed orders, and each consumable once per step', () => {
    for (const o of T.order_profiles) {
      const lines = T.order_items.filter((i) => i.order_id === o.order_id);
      if (o.production_status === 'Completed') assert.ok(lines.every((i) => i.unit_cost !== null), o.tracking_no);
      else assert.ok(lines.every((i) => i.unit_cost === null), o.tracking_no);
    }
    const keys = T.order_consumables_log.map((l) => `${l.order_id}|${l.trigger_status}|${l.consumable_inventory_id}`);
    assert.equal(new Set(keys).size, keys.length, 'exactly once');
  });

  it('has a believable shop around the orders', () => {
    const s = out.summary;
    assert.ok(s.customers >= 150 && s.customers <= 700, `${s.customers} clients`);
    assert.ok(s.branches > 0 && T.order_profiles.some((o) => o.branch_id));
    assert.ok(s.waste_records > 100 && s.stock_documents > 200);
    assert.ok(T.order_profiles.some((o) => o.production_status === 'Cancelled') && T.payments.some((p) => p.is_refund));
    assert.ok(T.order_delivery_plans.length > 0 && T.order_print_details.length > 0);
    const open = T.order_profiles.filter((o) => !['Completed', 'Cancelled'].includes(o.production_status));
    assert.ok(open.length >= 5, `${open.length} open orders`);
    // every month has rent and wages
    const months = new Set(T.overhead_expenses.filter((e) => e.category === 'Rent').map((e) => e.expense_date.slice(0, 7)));
    assert.equal(months.size, (2026 - 2020) * 12 + 11);
  });
});

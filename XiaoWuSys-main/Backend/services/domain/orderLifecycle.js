// ==========================================
// ORDER LIFECYCLE (pure rules: no HTTP, no SQL)
//
//   Pending  -> Cancelled             (Pending -> Approved only through Approve: Owner or Admin)
//   Approved -> Printing | Cancelled
//   Printing -> Pressing | Ready | Cancelled   (migration 017: Pressing when the order has an item
//                                       that needs the heat press, and only once everything is
//                                       printed; Ready straight from Printing only when nothing
//                                       needs pressing)
//   Pressing -> Ready | Cancelled              (once everything is pressed)
//   Ready    -> Completed | Cancelled          (production done, waiting to be handed over and paid;
//                                       Completed = handed over and paid: the order is closed)
//   Delayed  -> Pending (reserves stock) | Cancelled
//   Completed / Cancelled are final.
//
// allowedActions() tells a client which buttons to show for an order and a role, so screens
// never re-implement these rules. The server still checks every action when it is sent.
// ==========================================
const { can } = require('./permissions');
const { paymentSummary, paymentBlockedReason } = require('./payments');
const { localDateTime } = require('../../utils/validation');

const STATUS_TRANSITIONS = {
  Pending: ['Cancelled'],
  Approved: ['Printing', 'Cancelled'],
  Printing: ['Pressing', 'Ready', 'Cancelled'],
  Pressing: ['Ready', 'Cancelled'],
  Ready: ['Completed', 'Cancelled'],
  Delayed: ['Pending', 'Cancelled'],
  Completed: [],
  Cancelled: []
};

const CLOSED_STATUSES = ['Completed', 'Cancelled'];
const EDITABLE_STATUSES = ['Pending', 'Approved', 'Printing', 'Pressing', 'Ready', 'Delayed'];
// The quote is frozen from approval on: the 50% downpayment was checked against it
const QUOTE_FROZEN_STATUSES = ['Approved', 'Printing', 'Pressing', 'Ready', 'Completed', 'Cancelled'];
const QUOTE_EDITABLE_STATUSES = EDITABLE_STATUSES.filter((s) => !QUOTE_FROZEN_STATUSES.includes(s));
const APPROVABLE_STATUSES = ['Pending', 'Delayed'];
// Production has started (or finished) in these statuses
const IN_PRODUCTION_STATUSES = ['Printing', 'Pressing', 'Ready'];

// Migration 016 (adviser: "remove the requirement for quoting when it is optional"): an order may
// be approved without a quote. Its price can then still be set later, until the order is closed.
// So the quote is locked when the order is closed, or approved WITH a quote (the downpayment was
// checked against that amount).
// Migration 017: and from the moment printing starts, the price is final (an order is never
// printed without an agreed price), so Start Printing needs a quote.
const quoteLocked = (status, quote) =>
  CLOSED_STATUSES.includes(status) || IN_PRODUCTION_STATUSES.includes(status)
  || (QUOTE_FROZEN_STATUSES.includes(status) && Number(quote || 0) > 0);

// Which capability a status change needs. Migration 017: anyone may cancel an order that is not
// approved yet (nothing is kept); after approval the cancellation fee applies (Owner or Admin).
const capabilityForTransition = (to, from = null) => {
  if (to !== 'Cancelled') return 'change_status';
  return from && APPROVABLE_STATUSES.includes(from) ? 'cancel_order' : 'cancel_approved_order';
};

const canTransition = (from, to) => (STATUS_TRANSITIONS[from] || []).includes(to);

// -> { approve, statuses: [...], edit_deadline, edit_quote, generate_quote, apply_discount,
//      link_design, add_items, record_payment, max_payment, payment_blocked_reason, print_receipt,
//      print_quote }
// Based on role, status and the payment totals (paymentSummary). Whether the cloud is
// reachable is reported separately (the response's "source" and the order's sync_status).
//   generate_quote  PB 11: work out the quote from the catalog prices (Owner, before approval)
//   apply_discount  PB 12: lower it with a discount and a reason (Owner, before approval)
//   record_payment  PB 21: never on a Cancelled order, never without a quote, never once fully paid
//   max_payment     the remaining balance, so a screen can limit its amount field
//   print_quote     the customer quotation can be printed once the order has a quote
//   void_payment    PB 23: the Owner may void (reverse) a payment; each payment also says can_void
//   log_loss        PB 18: record a misprint / material loss against this order while it is open
//   archive_order   PB 23 / D2: hide a closed order from the everyday lists (Owner, Admin; kept forever)
//   restore_order   bring an archived order back. While archived, nothing else may change it.
const ARCHIVED_REASON = 'This order is archived. Restore it first if you need to change it.';
const isArchived = (record) => Boolean(record && record.archived_at);

// ---------- Migration 015: deliveries and what "Completed" means ----------
// Pieces can be handed over (in batches) once printing has started, while it is open, and only
// as many as are ready (migration 017: printed, and pressed when they need it).
const DELIVERY_STATUSES = ['Printing', 'Pressing', 'Ready'];
const DELIVERY_METHODS = ['Pick-up', 'Delivery', 'Courier'];

// Migration 016: batches planned ahead (order_delivery_plans). A planned batch is
//   'Delivered'          every planned piece of it was handed over
//   'Partly delivered'   some of it was handed over
//   'Ready'              marked ready to go (ready_at), nothing handed over yet
//   'In production'      not ready yet
// and overdue when its planned date has passed and it is not fully delivered.
const PLAN_STATES = ['In production', 'Ready', 'Partly delivered', 'Delivered'];
const planSummary = (plan, deliveries = [], today = null) => {
  const delivered = deliveries.filter((d) => d.plan_id === plan.plan_id).reduce((s, d) => s + Number(d.quantity || 0), 0);
  const planned = Number(plan.planned_quantity || 0);
  const state = delivered >= planned && planned > 0 ? 'Delivered'
    : delivered > 0 ? 'Partly delivered'
      : plan.ready_at ? 'Ready' : 'In production';
  const due = plan.planned_date ? String(plan.planned_date).slice(0, 10) : null;
  return {
    ...plan,
    delivered,
    remaining: Math.max(0, planned - delivered),
    state,
    can_deliver: state === 'Ready' || state === 'Partly delivered',
    overdue: Boolean(today && due && due < today && state !== 'Delivered')
  };
};

// pieces_ordered: the order's pieces (its materials, consumables left out); deliveries: its batches;
// plans (migration 016): the batches planned ahead
// -> { pieces_ordered, pieces_delivered, pieces_remaining, batches, state: 'none' | 'partial' | 'complete', label,
//      plans: [planSummary], pieces_planned, pieces_unplanned, plans_open }
const fulfillmentSummary = ({ pieces_ordered = 0, deliveries = [], plans = [], today = null }) => {
  const delivered = deliveries.reduce((s, d) => s + Number(d.quantity || 0), 0);
  const remaining = Math.max(0, pieces_ordered - delivered);
  const state = delivered === 0 ? 'none' : remaining === 0 ? 'complete' : 'partial';
  const shownPlans = [...plans].sort((a, b) => Number(a.batch_no) - Number(b.batch_no)).map((p) => planSummary(p, deliveries, today));
  const planned = shownPlans.reduce((s, p) => s + Number(p.planned_quantity || 0), 0);
  return {
    pieces_ordered,
    pieces_delivered: delivered,
    pieces_remaining: remaining,
    batches: deliveries.length,
    state,
    label: state === 'none' ? 'Not handed over yet' : state === 'complete' ? 'All pieces handed over' : `${delivered} of ${pieces_ordered} pieces handed over`,
    plans: shownPlans,
    pieces_planned: planned,
    pieces_unplanned: Math.max(0, pieces_ordered - planned),
    plans_open: shownPlans.filter((p) => p.state !== 'Delivered').length
  };
};

// The delivery status the Orders list shows (adviser: "add statuses for orders")
//   'Not delivered' | 'Partly delivered' | 'Delivered'   (null for an order with no pieces)
const deliveryStatus = (fulfillment) => {
  if (!fulfillment || !fulfillment.pieces_ordered) return null;
  return fulfillment.state === 'complete' ? 'Delivered' : fulfillment.state === 'partial' ? 'Partly delivered' : 'Not delivered';
};

// What an order still needs before it may be marked Completed:
//   1. production is done (it is Printing, Pressing or Ready; the status rules allow the move);
//   2. nothing is left to pay (the Owner may complete with a balance due, and must confirm it);
//   3. when it is delivered in batches, every piece has been handed over. With no batch recorded
//      the whole order is handed over at once, and that hand-over is recorded on completion.
// -> { ready, missing: [{ code, message }], warnings: [{ code, message }], auto_handover, balance_due }
const completionCheck = ({ order, summary, fulfillment, unverified = 0 }) => {
  const missing = [];
  const warnings = [];
  const status = order && order.production_status;
  if (status !== 'Ready') {
    missing.push({ code: 'NOT_READY', message: 'Mark the order Ready first: every piece printed (and pressed where needed).' });
  }
  const remaining = summary ? Number(summary.remaining) : 0;
  if (summary && summary.quote > 0 && remaining > 0) {
    missing.push({
      code: 'BALANCE_DUE',
      message: `₱${remaining.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is still unpaid. Record the final payment first.`
    });
  }
  const f = fulfillment || fulfillmentSummary({});
  if (f.batches > 0 && f.pieces_remaining > 0) {
    missing.push({
      code: 'PIECES_NOT_DELIVERED',
      message: `${f.pieces_remaining} of ${f.pieces_ordered} pieces are not handed over yet. Record the last batch first.`
    });
  }
  // migration 016: every batch planned ahead must be delivered first
  const openPlans = (f.plans || []).filter((p) => p.state !== 'Delivered');
  if (openPlans.length > 0) {
    missing.push({
      code: 'BATCHES_NOT_DELIVERED',
      message: `Planned batch${openPlans.length === 1 ? '' : 'es'} ${openPlans.map((p) => `#${p.batch_no}`).join(', ')} `
        + `${openPlans.length === 1 ? 'is' : 'are'} not delivered yet. Record ${openPlans.length === 1 ? 'its' : 'their'} hand-over first.`
    });
  }
  if (unverified > 0) {
    warnings.push({ code: 'UNVERIFIED_PAYMENTS', message: `${unverified} non-cash payment(s) are not verified yet.` });
  }
  return {
    ready: missing.length === 0,
    missing,
    warnings,
    auto_handover: f.batches === 0 && f.pieces_ordered > 0 && (f.plans || []).length === 0,
    balance_due: summary && summary.quote > 0 ? Math.max(0, remaining) : 0
  };
};

// context (migration 015, all optional so older callers keep working):
//   has_garments  the order has a garment (print details with sizes)
//   needs_pressing (migration 016) the order has a T-shirt: only then is the Pressing step offered
//   fulfillment   fulfillmentSummary() of the order
//   completion    completionCheck() of the order
//   max_refund    services/domain/payments.js maxRefund() of the order
const allowedActions = (order, role, summary = null, context = {}) => {
  if (isArchived(order)) {
    // Read-only: printing stays, every change waits for a restore
    return {
      approve: false, statuses: [], edit_deadline: false, edit_quote: false, generate_quote: false, apply_discount: false,
      link_design: false, add_items: false, record_payment: false, max_payment: 0,
      payment_blocked_reason: can(role, 'record_payment') ? ARCHIVED_REASON : null,
      print_receipt: can(role, 'view_orders'), print_quote: can(role, 'view_orders') && Number(order.total_quote_amount) > 0,
      void_payment: false, log_loss: false, archive_order: false, restore_order: can(role, 'manage_accounts'),
      edit_description: false, add_print_details: false, record_delivery: false, max_delivery: 0, complete_blocked_reason: null,
      complete_with_balance: false, refund_payment: false, max_refund: 0, verify_payment: false, edit_payment: false, adjust_price: false,
      approve_without_quote: false, plan_deliveries: false, manage_design_files: false,
      cancel: false, update_progress: false, max_adjustment: 0, status_needs_confirm: {}
    };
  }
  const status = order && order.production_status;
  const editable = EDITABLE_STATUSES.includes(status);
  const totals = summary || paymentSummary({ quote: order ? order.total_quote_amount : 0, payments: [] });
  const blocked = paymentBlockedReason(order, totals);
  const mayPay = Boolean(status) && can(role, 'record_payment');
  const quoteOpen = EDITABLE_STATUSES.includes(status) && !quoteLocked(status, order && order.total_quote_amount);
  const pressing = context.needs_pressing !== undefined ? context.needs_pressing : context.has_garments;
  const progress = context.progress || null;
  const statuses = (STATUS_TRANSITIONS[status] || [])
    .filter((to) => can(role, capabilityForTransition(to, status)))
    // Pressing is the heat press for T-shirts (migration 016): everything else skips it, and an
    // order with such an item is pressed before it is Ready (migration 017)
    .filter((to) => to !== 'Pressing' || pressing !== false)
    .filter((to) => !(to === 'Ready' && status === 'Printing' && pressing === true));
  const completion = context.completion || null;
  const fulfillment = context.fulfillment || null;
  const completeBlocked = statuses.includes('Completed') && completion && !completion.ready
    ? completion.missing.map((m) => m.message).join(' ')
    : null;
  const onlyBalanceMissing = Boolean(completion) && completion.missing.length > 0 && completion.missing.every((m) => m.code === 'BALANCE_DUE');
  return {
    approve: can(role, 'approve_order') && APPROVABLE_STATUSES.includes(status),
    // migration 016: the quote is optional; with none, approving skips the 50% downpayment check
    approve_without_quote: can(role, 'approve_order') && APPROVABLE_STATUSES.includes(status) && !(Number(totals.quote) > 0),
    statuses,
    edit_deadline: editable && can(role, 'edit_order'),
    edit_quote: quoteOpen && can(role, 'set_quote'),
    generate_quote: quoteOpen && can(role, 'set_quote'),
    apply_discount: quoteOpen && can(role, 'set_quote') && can(role, 'apply_discount'),
    link_design: editable && can(role, 'edit_order'),
    // migration 017: before approval anyone; Approved / Printing the Owner or an Admin (add-ons)
    add_items: ['Pending', 'Delayed'].includes(status) ? can(role, 'edit_order')
      : ['Approved', 'Printing'].includes(status) && can(role, 'add_items_after_approval'),
    record_payment: mayPay && !blocked,
    max_payment: mayPay && !blocked ? totals.remaining : 0,
    payment_blocked_reason: mayPay ? blocked : null,
    print_receipt: can(role, 'view_orders'),
    print_quote: can(role, 'view_orders') && Number(order && order.total_quote_amount) > 0,
    void_payment: Boolean(status) && can(role, 'void_order'),
    // migration 017: waste is recorded once printing has started (a loss before that is stock out)
    log_loss: IN_PRODUCTION_STATUSES.includes(status) && can(role, 'edit_inventory'),
    archive_order: CLOSED_STATUSES.includes(status) && can(role, 'manage_accounts'),
    restore_order: false,
    // migration 015
    edit_description: editable && can(role, 'edit_order'),
    add_print_details: editable && can(role, 'edit_order'),
    record_delivery: DELIVERY_STATUSES.includes(status) && can(role, 'record_delivery') && deliverable(fulfillment, progress) > 0,
    max_delivery: DELIVERY_STATUSES.includes(status) ? deliverable(fulfillment, progress) : 0,
    complete_blocked_reason: completeBlocked,
    complete_with_balance: statuses.includes('Completed') && onlyBalanceMissing && can(role, 'complete_with_balance'),
    refund_payment: can(role, 'refund_payment') && refundMax(role, context) > 0,
    max_refund: can(role, 'refund_payment') ? refundMax(role, context) : 0,
    verify_payment: can(role, 'verify_payment'),
    edit_payment: can(role, 'edit_payment'),
    adjust_price: can(role, 'adjust_price') && ['Approved', 'Printing', 'Pressing', 'Ready', 'Completed'].includes(status)
      && (Number(totals.quote) > 0 || Number(order && order.adjustment_amount) > 0)
      && (can(role, 'price_cut_above_policy') || Number(context.late_cut_amount || 0) > 0 || Number(order && order.adjustment_amount) > 0),
    max_adjustment: !can(role, 'adjust_price') || !['Approved', 'Printing', 'Pressing', 'Ready', 'Completed'].includes(status) ? 0
      : can(role, 'price_cut_above_policy') ? Number(totals.quote || 0) + Number((order && order.adjustment_amount) || 0)
        : Number(context.late_cut_amount || 0),
    // migration 016: batches planned ahead (number of pieces per batch, date, ready or not)
    // (can be planned from the start; a batch is marked ready once the job order is approved)
    plan_deliveries: editable && can(role, 'record_delivery'),
    // migration 016: design files uploaded from the computer
    manage_design_files: editable && can(role, 'edit_order'),
    // migration 017
    cancel: statuses.includes('Cancelled'),
    update_progress: ['Printing', 'Pressing'].includes(status) && can(role, 'change_status'),
    status_needs_confirm: progress ? {
      Pressing: statuses.includes('Pressing') && !progress.all_printed,
      Ready: statuses.includes('Ready') && !progress.all_ready
    } : {}
  };
};

// Pieces that may be handed over now: not yet handed over, and ready (migration 017)
const deliverable = (fulfillment, progress) => {
  if (!fulfillment) return 0;
  const remaining = Number(fulfillment.pieces_remaining || 0);
  if (!progress) return remaining;
  return Math.max(0, Math.min(remaining, Number(progress.ready || 0) - Number(fulfillment.pieces_delivered || 0)));
};
// The largest refund this role may record (migration 017: an Admin up to the policy's suggestion)
const refundMax = (role, context) => {
  const ownerMax = Number(context.max_refund || 0);
  if (can(role, 'refund_above_policy')) return ownerMax;
  const adminMax = context.admin_max_refund === undefined ? ownerMax : Number(context.admin_max_refund || 0);
  return Math.min(ownerMax, adminMax);
};

// ---------- PB 16: how close an open order is to its deadline ----------
// Counted in whole calendar days on the shop's wall clock (Asia/Manila), because deadlines are
// dates staff read off a calendar:
//   overdue      the deadline day has passed
//   urgent_24h   due today or tomorrow
//   warning_72h  due in 2 or 3 days
//   normal       later than that
//   null         Completed / Cancelled orders (nothing left to chase)
const DEADLINE_FLAGS = ['overdue', 'urgent_24h', 'warning_72h', 'normal'];
const URGENT_DAYS = 1;
const WARNING_DAYS = 3;

const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// The shop-time dates the flags are measured against -> { today, urgent_until, warning_until } ('YYYY-MM-DD')
const deadlineWindows = (now = new Date()) => {
  const today = localDateTime(now).slice(0, 10);
  return { today, urgent_until: addDays(today, URGENT_DAYS), warning_until: addDays(today, WARNING_DAYS) };
};

const deadlineFlag = (order, now = new Date()) => {
  if (!order || !order.production_deadline || CLOSED_STATUSES.includes(order.production_status)) return null;
  const due = String(order.production_deadline).slice(0, 10);
  const { today, urgent_until, warning_until } = deadlineWindows(now);
  if (due < today) return 'overdue';
  if (due <= urgent_until) return 'urgent_24h';
  if (due <= warning_until) return 'warning_72h';
  return 'normal';
};

// An order as the screens get it: the stored fields plus the server's deadline decision
const withDeadlineFlag = (order, now = new Date()) => (order ? { ...order, deadline_flag: deadlineFlag(order, now) } : order);

module.exports = {
  DEADLINE_FLAGS,
  deadlineWindows,
  deadlineFlag,
  withDeadlineFlag,
  STATUS_TRANSITIONS,
  CLOSED_STATUSES,
  EDITABLE_STATUSES,
  QUOTE_FROZEN_STATUSES,
  QUOTE_EDITABLE_STATUSES,
  APPROVABLE_STATUSES,
  IN_PRODUCTION_STATUSES,
  quoteLocked,
  PLAN_STATES,
  planSummary,
  deliveryStatus,
  capabilityForTransition,
  canTransition,
  allowedActions,
  isArchived,
  ARCHIVED_REASON,
  DELIVERY_STATUSES,
  DELIVERY_METHODS,
  fulfillmentSummary,
  completionCheck,
  deliverable,
  refundMax
};

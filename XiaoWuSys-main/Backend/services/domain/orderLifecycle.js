// ==========================================
// ORDER LIFECYCLE (pure rules: no HTTP, no SQL)
//
//   Pending  -> Cancelled             (Pending -> Approved only through the Owner's Approve)
//   Approved -> Printing | Cancelled
//   Printing -> Pressing | Completed | Cancelled   (Pressing is optional: apparel is pressed,
//                                                   tarpaulins and stickers go straight to Completed)
//   Pressing -> Completed | Cancelled
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
  Printing: ['Pressing', 'Completed', 'Cancelled'],
  Pressing: ['Completed', 'Cancelled'],
  Delayed: ['Pending', 'Cancelled'],
  Completed: [],
  Cancelled: []
};

const CLOSED_STATUSES = ['Completed', 'Cancelled'];
const EDITABLE_STATUSES = ['Pending', 'Approved', 'Printing', 'Pressing', 'Delayed'];
// The quote is frozen from approval on: the 50% downpayment was checked against it
const QUOTE_FROZEN_STATUSES = ['Approved', 'Printing', 'Pressing', 'Completed', 'Cancelled'];
const QUOTE_EDITABLE_STATUSES = EDITABLE_STATUSES.filter((s) => !QUOTE_FROZEN_STATUSES.includes(s));
const APPROVABLE_STATUSES = ['Pending', 'Delayed'];

// Which capability a status change needs. Cancelling an existing order is a void (Owner only).
const capabilityForTransition = (to) => (to === 'Cancelled' ? 'void_order' : 'change_status');

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
// Pieces can be handed over (in batches) once the job order is approved, while it is open.
const DELIVERY_STATUSES = ['Approved', 'Printing', 'Pressing'];
const DELIVERY_METHODS = ['Pick-up', 'Delivery', 'Courier'];

// pieces_ordered: the order's pieces (its materials, consumables left out); deliveries: its batches
// -> { pieces_ordered, pieces_delivered, pieces_remaining, batches, state: 'none' | 'partial' | 'complete', label }
const fulfillmentSummary = ({ pieces_ordered = 0, deliveries = [] }) => {
  const delivered = deliveries.reduce((s, d) => s + Number(d.quantity || 0), 0);
  const remaining = Math.max(0, pieces_ordered - delivered);
  const state = delivered === 0 ? 'none' : remaining === 0 ? 'complete' : 'partial';
  return {
    pieces_ordered,
    pieces_delivered: delivered,
    pieces_remaining: remaining,
    batches: deliveries.length,
    state,
    label: state === 'none' ? 'Not handed over yet' : state === 'complete' ? 'All pieces handed over' : `${delivered} of ${pieces_ordered} pieces handed over`
  };
};

// What an order still needs before it may be marked Completed:
//   1. production is done (it is Printing or Pressing; the status rules allow the move);
//   2. nothing is left to pay (the Owner may complete with a balance due, and must confirm it);
//   3. when it is delivered in batches, every piece has been handed over. With no batch recorded
//      the whole order is handed over at once, and that hand-over is recorded on completion.
// -> { ready, missing: [{ code, message }], warnings: [{ code, message }], auto_handover, balance_due }
const completionCheck = ({ order, summary, fulfillment, unverified = 0 }) => {
  const missing = [];
  const warnings = [];
  const status = order && order.production_status;
  if (!['Printing', 'Pressing'].includes(status)) {
    missing.push({ code: 'NOT_IN_PRODUCTION', message: 'Printing must have started before the order can be completed.' });
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
  if (unverified > 0) {
    warnings.push({ code: 'UNVERIFIED_PAYMENTS', message: `${unverified} non-cash payment(s) are not verified yet.` });
  }
  return {
    ready: missing.length === 0,
    missing,
    warnings,
    auto_handover: f.batches === 0 && f.pieces_ordered > 0,
    balance_due: summary && summary.quote > 0 ? Math.max(0, remaining) : 0
  };
};

// context (migration 015, all optional so older callers keep working):
//   has_garments  the order has a garment: only then is the Pressing step offered
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
      complete_with_balance: false, refund_payment: false, max_refund: 0, verify_payment: false, edit_payment: false, adjust_price: false
    };
  }
  const status = order && order.production_status;
  const editable = EDITABLE_STATUSES.includes(status);
  const totals = summary || paymentSummary({ quote: order ? order.total_quote_amount : 0, payments: [] });
  const blocked = paymentBlockedReason(order, totals);
  const mayPay = Boolean(status) && can(role, 'record_payment');
  const quoteOpen = QUOTE_EDITABLE_STATUSES.includes(status);
  const statuses = (STATUS_TRANSITIONS[status] || [])
    .filter((to) => can(role, capabilityForTransition(to)))
    // Pressing is the heat press for garments: tarpaulins, mugs and stickers go straight to Completed
    .filter((to) => to !== 'Pressing' || context.has_garments !== false);
  const completion = context.completion || null;
  const fulfillment = context.fulfillment || null;
  const completeBlocked = statuses.includes('Completed') && completion && !completion.ready
    ? completion.missing.map((m) => m.message).join(' ')
    : null;
  const onlyBalanceMissing = Boolean(completion) && completion.missing.length > 0 && completion.missing.every((m) => m.code === 'BALANCE_DUE');
  return {
    approve: can(role, 'approve_order') && APPROVABLE_STATUSES.includes(status),
    statuses,
    edit_deadline: editable && can(role, 'edit_order'),
    edit_quote: quoteOpen && can(role, 'set_quote'),
    generate_quote: quoteOpen && can(role, 'set_quote'),
    apply_discount: quoteOpen && can(role, 'set_quote') && can(role, 'apply_discount'),
    link_design: editable && can(role, 'edit_order'),
    add_items: editable && can(role, 'edit_order'),
    record_payment: mayPay && !blocked,
    max_payment: mayPay && !blocked ? totals.remaining : 0,
    payment_blocked_reason: mayPay ? blocked : null,
    print_receipt: can(role, 'view_orders'),
    print_quote: can(role, 'view_orders') && Number(order && order.total_quote_amount) > 0,
    void_payment: Boolean(status) && can(role, 'void_order'),
    log_loss: editable && can(role, 'edit_inventory'),
    archive_order: CLOSED_STATUSES.includes(status) && can(role, 'manage_accounts'),
    restore_order: false,
    // migration 015
    edit_description: editable && can(role, 'edit_order'),
    add_print_details: editable && can(role, 'edit_order'),
    record_delivery: DELIVERY_STATUSES.includes(status) && can(role, 'record_delivery') && Boolean(fulfillment) && fulfillment.pieces_remaining > 0,
    max_delivery: DELIVERY_STATUSES.includes(status) && fulfillment ? fulfillment.pieces_remaining : 0,
    complete_blocked_reason: completeBlocked,
    complete_with_balance: statuses.includes('Completed') && onlyBalanceMissing && can(role, 'complete_with_balance'),
    refund_payment: can(role, 'refund_payment') && Number(context.max_refund || 0) > 0,
    max_refund: can(role, 'refund_payment') ? Number(context.max_refund || 0) : 0,
    verify_payment: can(role, 'verify_payment'),
    edit_payment: can(role, 'edit_payment'),
    adjust_price: can(role, 'set_quote') && ['Approved', 'Printing', 'Pressing', 'Completed'].includes(status)
      && (Number(totals.quote) > 0 || Number(order && order.adjustment_amount) > 0)
  };
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
  capabilityForTransition,
  canTransition,
  allowedActions,
  isArchived,
  ARCHIVED_REASON,
  DELIVERY_STATUSES,
  DELIVERY_METHODS,
  fulfillmentSummary,
  completionCheck
};

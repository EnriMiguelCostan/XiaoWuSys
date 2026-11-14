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
const allowedActions = (order, role, summary = null) => {
  const status = order && order.production_status;
  const editable = EDITABLE_STATUSES.includes(status);
  const totals = summary || paymentSummary({ quote: order ? order.total_quote_amount : 0, payments: [] });
  const blocked = paymentBlockedReason(order, totals);
  const mayPay = Boolean(status) && can(role, 'record_payment');
  const quoteOpen = QUOTE_EDITABLE_STATUSES.includes(status);
  return {
    approve: can(role, 'approve_order') && APPROVABLE_STATUSES.includes(status),
    statuses: (STATUS_TRANSITIONS[status] || []).filter((to) => can(role, capabilityForTransition(to))),
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
    print_quote: can(role, 'view_orders') && Number(order && order.total_quote_amount) > 0
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
  allowedActions
};

// ==========================================
// ORDER LIFECYCLE (pure rules: no HTTP, no SQL)
//
//   Pending  -> Cancelled             (Pending -> Approved only through the Owner's Approve)
//   Approved -> Printing | Cancelled
//   Printing -> Completed | Cancelled
//   Delayed  -> Pending (reserves stock) | Cancelled
//   Completed / Cancelled are final.
//
// allowedActions() tells a client which buttons to show for an order and a role, so screens
// never re-implement these rules. The server still checks every action when it is sent.
// ==========================================
const { can } = require('./permissions');
const { paymentSummary, paymentBlockedReason } = require('./payments');

const STATUS_TRANSITIONS = {
  Pending: ['Cancelled'],
  Approved: ['Printing', 'Cancelled'],
  Printing: ['Completed', 'Cancelled'],
  Delayed: ['Pending', 'Cancelled'],
  Completed: [],
  Cancelled: []
};

const CLOSED_STATUSES = ['Completed', 'Cancelled'];
const EDITABLE_STATUSES = ['Pending', 'Approved', 'Printing', 'Delayed'];
// The quote is frozen from approval on: the 50% downpayment was checked against it
const QUOTE_FROZEN_STATUSES = ['Approved', 'Printing', 'Completed', 'Cancelled'];
const QUOTE_EDITABLE_STATUSES = EDITABLE_STATUSES.filter((s) => !QUOTE_FROZEN_STATUSES.includes(s));
const APPROVABLE_STATUSES = ['Pending', 'Delayed'];

// Which capability a status change needs. Cancelling an existing order is a void (Owner only).
const capabilityForTransition = (to) => (to === 'Cancelled' ? 'void_order' : 'change_status');

const canTransition = (from, to) => (STATUS_TRANSITIONS[from] || []).includes(to);

// -> { approve, statuses: [...], edit_deadline, edit_quote, link_design, add_items,
//      record_payment, max_payment, payment_blocked_reason, print_receipt }
// Based on role, status and the payment totals (paymentSummary). Whether the cloud is
// reachable is reported separately (the response's "source" and the order's sync_status).
//   record_payment  PB 21: never on a Cancelled order, never without a quote, never once fully paid
//   max_payment     the remaining balance, so a screen can limit its amount field
const allowedActions = (order, role, summary = null) => {
  const status = order && order.production_status;
  const editable = EDITABLE_STATUSES.includes(status);
  const totals = summary || paymentSummary({ quote: order ? order.total_quote_amount : 0, payments: [] });
  const blocked = paymentBlockedReason(order, totals);
  const mayPay = Boolean(status) && can(role, 'record_payment');
  return {
    approve: can(role, 'approve_order') && APPROVABLE_STATUSES.includes(status),
    statuses: (STATUS_TRANSITIONS[status] || []).filter((to) => can(role, capabilityForTransition(to))),
    edit_deadline: editable && can(role, 'edit_order'),
    edit_quote: QUOTE_EDITABLE_STATUSES.includes(status) && can(role, 'set_quote'),
    link_design: editable && can(role, 'edit_order'),
    add_items: editable && can(role, 'edit_order'),
    record_payment: mayPay && !blocked,
    max_payment: mayPay && !blocked ? totals.remaining : 0,
    payment_blocked_reason: mayPay ? blocked : null,
    print_receipt: can(role, 'view_orders')
  };
};

module.exports = {
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

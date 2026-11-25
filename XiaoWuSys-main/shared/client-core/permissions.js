// What this account may do, as told by the server (login and GET /api/auth/me).
// Plain JS on purpose: no React, so the Next.js and mobile apps can reuse it.
// This only decides which buttons to show; the server checks every action.

export const can = (user, capability) =>
  Boolean(user) && Array.isArray(user.capabilities) && user.capabilities.includes(capability);

// Buttons for one order, from GET /api/orders/:id "allowed_actions". Missing -> nothing allowed.
export const NO_ORDER_ACTIONS = Object.freeze({
  approve: false, statuses: [], edit_deadline: false, edit_quote: false, generate_quote: false, apply_discount: false,
  link_design: false, add_items: false, record_payment: false, max_payment: 0, payment_blocked_reason: null,
  print_receipt: false, print_quote: false, void_payment: false, log_loss: false, archive_order: false, restore_order: false,
  // migration 015
  edit_description: false, add_print_details: false, record_delivery: false, max_delivery: 0, complete_blocked_reason: null,
  complete_with_balance: false, refund_payment: false, max_refund: 0, verify_payment: false, edit_payment: false, adjust_price: false,
  // migration 016
  approve_without_quote: false, plan_deliveries: false, manage_design_files: false,
  // migration 017
  cancel: false, update_progress: false, max_adjustment: 0, add_items_needs_deadline_check: false, status_needs_confirm: {}
});

export const orderActions = (detail) => ({ ...NO_ORDER_ACTIONS, ...(detail && detail.allowed_actions) });

// What each role may do, in plain words for the Accounts screen. Display text only, keyed by the
// role names the server sends in "assignable_roles"; it never decides who may do what.
export const ROLE_HELP = Object.freeze({
  Owner: 'Everything, including quotes, discounts, refunds and price cuts beyond the shop policy, and managing Owners',
  Admin: 'Approves job orders, cancels them, adds items after approval, refunds and late-delivery price cuts up to the shop policy, manages non-Owner accounts; no quotes or discounts',
  Staff: 'Creates orders (the Owner or an Admin approves them) and cancels them before approval, payments, production progress, waste, deliveries and stock in / out',
  Production: 'Creates orders (the Owner or an Admin approves them) and cancels them before approval, payments, production progress, waste, deliveries and stock in / out'
});

/** Plain-words description of a role from the server, or '' for a role this version doesn't know. */
export const roleHelp = (role) => (role && Object.hasOwn(ROLE_HELP, role) ? ROLE_HELP[role] : '');

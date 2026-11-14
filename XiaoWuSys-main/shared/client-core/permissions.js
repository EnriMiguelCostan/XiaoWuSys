// What this account may do, as told by the server (login and GET /api/auth/me).
// Plain JS on purpose: no React, so the Next.js and mobile apps can reuse it.
// This only decides which buttons to show; the server checks every action.

export const can = (user, capability) =>
  Boolean(user) && Array.isArray(user.capabilities) && user.capabilities.includes(capability);

// Buttons for one order, from GET /api/orders/:id "allowed_actions". Missing -> nothing allowed.
export const NO_ORDER_ACTIONS = Object.freeze({
  approve: false, statuses: [], edit_deadline: false, edit_quote: false, generate_quote: false, apply_discount: false,
  link_design: false, add_items: false, record_payment: false, max_payment: 0, payment_blocked_reason: null,
  print_receipt: false, print_quote: false
});

export const orderActions = (detail) => ({ ...NO_ORDER_ACTIONS, ...(detail && detail.allowed_actions) });

// What each role may do, in plain words for the Accounts screen. Display text only, keyed by the
// role names the server sends in "assignable_roles"; it never decides who may do what.
export const ROLE_HELP = Object.freeze({
  Owner: 'Everything, including approving job orders and managing Owners',
  Admin: 'Everything except approving job orders; manages non-Owner accounts',
  Production: 'Catalog, stock and orders (no account management)',
  Staff: 'View the catalog and orders only'
});

/** Plain-words description of a role from the server, or '' for a role this version doesn't know. */
export const roleHelp = (role) => (role && Object.hasOwn(ROLE_HELP, role) ? ROLE_HELP[role] : '');

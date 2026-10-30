// What this account may do, as told by the server (login and GET /api/auth/me).
// Plain JS on purpose: no React, so the Next.js and mobile apps can reuse it.
// This only decides which buttons to show; the server checks every action.

export const can = (user, capability) =>
  Boolean(user) && Array.isArray(user.capabilities) && user.capabilities.includes(capability);

// Buttons for one order, from GET /api/orders/:id "allowed_actions". Missing -> nothing allowed.
export const NO_ORDER_ACTIONS = Object.freeze({
  approve: false, statuses: [], edit_deadline: false, edit_quote: false, link_design: false, add_items: false,
  record_payment: false, max_payment: 0, payment_blocked_reason: null, print_receipt: false
});

export const orderActions = (detail) => ({ ...NO_ORDER_ACTIONS, ...(detail && detail.allowed_actions) });

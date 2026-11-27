// ==========================================
// WHO MAY DO WHAT (pure rules: no HTTP, no SQL)
// One table of capabilities, used by the routes (requireRole) and returned to the screens,
// so a client (the Next.js screens in Web/, a future mobile app) never keeps its own copy.
// The role always comes from the verified login token.
// ==========================================

const ALL_ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
// Adviser consultation (November 2026): Staff and Production both do the day-to-day work
// (create and edit orders, record payments, run the stock). Only the Owner / Admin manage.
const WRITE_ROLES = ['Owner', 'Admin', 'Staff', 'Production'];
const MANAGER_ROLES = ['Owner', 'Admin'];
const OWNER_ONLY = ['Owner'];

// Owner-only financial decisions (SIA 1 "Authority Limits", UAC PB 2): only the Owner sets
// or changes a quote, gives discounts and voids (cancels) an order. Approving a job order is
// for the Owner or an Admin (adviser consultation, second round).
const CAPABILITIES = {
  view_orders: ALL_ROLES,
  create_order: WRITE_ROLES,
  edit_order: WRITE_ROLES,        // deadline, design link, description, print details
  change_status: WRITE_ROLES,     // Start Printing, Mark Completed, Resume
  record_payment: WRITE_ROLES,
  record_delivery: WRITE_ROLES,   // migration 015: a batch delivered / picked up
  set_quote: OWNER_ONLY,
  apply_discount: OWNER_ONLY,     // reserved for PB 12
  void_order: OWNER_ONLY,         // void (reverse) a payment, delete an expense
  // migration 017 (shop policies): cancelling. Anyone may cancel before approval (nothing is kept);
  // once approved, the cancellation fee applies, so only the Owner or an Admin cancels.
  cancel_order: WRITE_ROLES,
  cancel_approved_order: MANAGER_ROLES,
  // Adviser consultation (second round): Staff and Production create orders; the Owner or an
  // Admin approves them
  approve_order: MANAGER_ROLES,
  refund_payment: MANAGER_ROLES,  // migration 015 / 017: money given back; an Admin up to the policy's suggestion
  refund_above_policy: OWNER_ONLY,  // migration 017: refunding more than the policy suggests (goodwill)
  adjust_price: MANAGER_ROLES,    // migration 017: a price cut after approval; an Admin up to the late-delivery suggestion
  price_cut_above_policy: OWNER_ONLY, // migration 017: a bigger price cut than the late-delivery rule
  add_items_after_approval: MANAGER_ROLES, // migration 017: add-ons to an approved order (priced on their own)
  complete_with_balance: OWNER_ONLY, // migration 015: hand over an order before it is fully paid
  verify_payment: MANAGER_ROLES,  // migration 015: confirm a non-cash payment arrived
  edit_payment: MANAGER_ROLES,    // migration 015: correct a payment's date / reference / payer
  view_finance: MANAGER_ROLES,
  manage_accounts: MANAGER_ROLES,
  edit_inventory: WRITE_ROLES,    // add and edit items, record losses, move to / restore from the Recycle Bin
  purge_inventory: MANAGER_ROLES, // permanent delete / empty the Recycle Bin
  // migration 015: the inventory system
  view_stock: ALL_ROLES,          // stock in / out / counts, stock card, suppliers (read)
  receive_stock: WRITE_ROLES,     // stock in (deliveries) and corrections to them
  issue_stock: WRITE_ROLES,       // stock out (returns, shop use, samples...) and corrections
  count_stock: MANAGER_ROLES,     // physical count that sets the system count
  void_stock_document: MANAGER_ROLES,
  manage_suppliers: WRITE_ROLES,  // add / edit supplier profiles
  archive_supplier: MANAGER_ROLES,
  edit_customer: WRITE_ROLES      // client profile
};

// Who outranks whom (PB 5): a higher rank may take over an edit lock and replace a lower
// rank's conflicting edit. An unknown or missing role ranks below everyone.
// Staff and Production share a rank (November 2026): neither overrides the other.
const ROLE_RANK = { Owner: 4, Admin: 3, Staff: 2, Production: 2 };
const rankOf = (role) => ROLE_RANK[role] || 0;
// May "role" replace a conflicting change last made by "lastEditedRole"? Strictly higher only.
const outranks = (role, lastEditedRole) => rankOf(role) > rankOf(lastEditedRole);

const rolesWith = (capability) => {
  const roles = CAPABILITIES[capability];
  if (!roles) throw new Error(`Unknown capability: ${capability}`);
  return roles;
};

const can = (role, capability) => rolesWith(capability).includes(role);

const capabilitiesFor = (role) => Object.keys(CAPABILITIES).filter((c) => CAPABILITIES[c].includes(role)).sort();

module.exports = {
  CAPABILITIES, ALL_ROLES, WRITE_ROLES, MANAGER_ROLES, ROLE_RANK, rankOf, outranks, rolesWith, can, capabilitiesFor
};

// ==========================================
// WHO MAY DO WHAT (pure rules: no HTTP, no SQL)
// One table of capabilities, used by the routes (requireRole) and returned to the screens,
// so a client (today's Vite app, the future Next.js / mobile apps) never keeps its own copy.
// The role always comes from the verified login token.
// ==========================================

const ALL_ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
const WRITE_ROLES = ['Owner', 'Admin', 'Production'];
const MANAGER_ROLES = ['Owner', 'Admin'];
const OWNER_ONLY = ['Owner'];

// Owner-only financial decisions (SIA 1 "Authority Limits", UAC PB 2): only the Owner sets
// or changes a quote, gives discounts, voids (cancels) an order and approves job orders.
const CAPABILITIES = {
  view_orders: ALL_ROLES,
  create_order: WRITE_ROLES,
  edit_order: WRITE_ROLES,        // deadline, design link, print details
  change_status: WRITE_ROLES,     // Start Printing, Mark Completed, Resume
  record_payment: WRITE_ROLES,
  set_quote: OWNER_ONLY,
  apply_discount: OWNER_ONLY,     // reserved for PB 12
  void_order: OWNER_ONLY,         // cancel an existing order (releases its stock)
  approve_order: OWNER_ONLY,
  view_finance: MANAGER_ROLES,
  manage_accounts: MANAGER_ROLES
};

const rolesWith = (capability) => {
  const roles = CAPABILITIES[capability];
  if (!roles) throw new Error(`Unknown capability: ${capability}`);
  return roles;
};

const can = (role, capability) => rolesWith(capability).includes(role);

const capabilitiesFor = (role) => Object.keys(CAPABILITIES).filter((c) => CAPABILITIES[c].includes(role)).sort();

module.exports = { CAPABILITIES, ALL_ROLES, WRITE_ROLES, MANAGER_ROLES, rolesWith, can, capabilitiesFor };

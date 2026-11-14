// What the server decided this account / this order allows. The client only shows or hides.

/** Capability names from services/domain/permissions.js (CAPABILITIES) */
export type Capability =
  | 'view_orders' | 'create_order' | 'edit_order' | 'change_status' | 'record_payment'
  | 'set_quote' | 'apply_discount' | 'void_order' | 'approve_order'
  | 'view_finance' | 'manage_accounts'
  | 'edit_inventory' | 'purge_inventory'
  | (string & {});

export interface SessionUser {
  user_id: string;
  username: string;
  /** Display only. Never compare it: use can(user, capability). */
  role: string;
  capabilities: Capability[];
}

export function can(user: Pick<SessionUser, 'capabilities'> | null | undefined, capability: Capability): boolean;

/** GET /api/orders/:id "allowed_actions" (orderLifecycle.allowedActions) */
export interface OrderActions {
  approve: boolean;
  statuses: string[];
  edit_deadline: boolean;
  edit_quote: boolean;
  /** PB 11: work out the quote from the catalog prices (POST /api/orders/:id/quote) */
  generate_quote: boolean;
  /** PB 12: lower the calculated quote with a discount and a reason */
  apply_discount: boolean;
  link_design: boolean;
  add_items: boolean;
  record_payment: boolean;
  max_payment: number;
  payment_blocked_reason: string | null;
  print_receipt: boolean;
  /** The customer quotation can be printed (the order has a quote) */
  print_quote: boolean;
  [key: string]: unknown;
}

export const NO_ORDER_ACTIONS: Readonly<OrderActions>;

export function orderActions(detail: { allowed_actions?: Partial<OrderActions> } | null | undefined): OrderActions;

/** Display text for the Accounts screen, keyed by the server's role names. Never used to decide. */
export const ROLE_HELP: Readonly<Record<string, string>>;

/** Plain-words description of a role from the server, or '' for an unknown role. */
export function roleHelp(role: string | null | undefined): string;

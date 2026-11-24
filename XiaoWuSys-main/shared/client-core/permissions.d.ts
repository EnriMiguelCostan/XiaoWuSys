// What the server decided this account / this order allows. The client only shows or hides.

/** Capability names from services/domain/permissions.js (CAPABILITIES) */
export type Capability =
  | 'view_orders' | 'create_order' | 'edit_order' | 'change_status' | 'record_payment'
  | 'set_quote' | 'apply_discount' | 'void_order' | 'approve_order'
  | 'view_finance' | 'manage_accounts'
  | 'edit_inventory' | 'purge_inventory'
  // migration 015
  | 'record_delivery' | 'refund_payment' | 'complete_with_balance' | 'verify_payment' | 'edit_payment'
  | 'view_stock' | 'receive_stock' | 'issue_stock' | 'count_stock' | 'void_stock_document'
  | 'manage_suppliers' | 'archive_supplier' | 'edit_customer'
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
  /** PB 23: the Owner may void (reverse) payments; each payment also says can_void */
  void_payment: boolean;
  /** PB 18: record a misprint / material loss against this order (open orders, catalog editors) */
  log_loss: boolean;
  /** PB 23 / D2: archive a closed order (Owner, Admin) */
  archive_order: boolean;
  /** bring an archived order back (Owner, Admin); an archived order allows nothing else */
  restore_order: boolean;
  // migration 015
  /** change the order's description / instructions */
  edit_description: boolean;
  /** add / change / remove print details (sizes, names, numbers, texts) */
  add_print_details: boolean;
  /** record a batch handed to the customer; max_delivery = pieces still to hand over */
  record_delivery: boolean;
  max_delivery: number;
  /** why "Mark completed" cannot be used yet (null = it can), in plain words */
  complete_blocked_reason: string | null;
  /** the Owner may complete it with a balance due (after confirming) */
  complete_with_balance: boolean;
  /** the Owner may refund up to max_refund */
  refund_payment: boolean;
  max_refund: number;
  /** Owner / Admin: mark a non-cash payment as received; correct a payment's details */
  verify_payment: boolean;
  edit_payment: boolean;
  /** the Owner may cut the price after approval (late delivery, production error) */
  adjust_price: boolean;
  // migration 016
  /** Owner / Admin: approve an order that has no quote (the 50% downpayment check is skipped) */
  approve_without_quote: boolean;
  /** plan delivery batches ahead (pieces per batch, date) and mark a batch ready */
  plan_deliveries: boolean;
  /** attach / remove design files uploaded from the computer */
  manage_design_files: boolean;
  [key: string]: unknown;
}

export const NO_ORDER_ACTIONS: Readonly<OrderActions>;

export function orderActions(detail: { allowed_actions?: Partial<OrderActions> } | null | undefined): OrderActions;

/** Display text for the Accounts screen, keyed by the server's role names. Never used to decide. */
export const ROLE_HELP: Readonly<Record<string, string>>;

/** Plain-words description of a role from the server, or '' for an unknown role. */
export function roleHelp(role: string | null | undefined): string;

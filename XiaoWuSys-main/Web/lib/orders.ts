// Shapes of the orders and customers API (Backend/routes/orders.js, routes/customers.js).
// Types and display lists only: every total, status and permission is decided by the server.
import type { OrderActions } from '@xiaowu/client-core/permissions';

export type ProductionStatus = 'Pending' | 'Approved' | 'Printing' | 'Pressing' | 'Ready' | 'Completed' | 'Delayed' | 'Cancelled';

/** The server's PRODUCTION_STATUSES, for the status filter. Migration 016 adds 'Ready'
 *  (production done, waiting to be picked up or delivered). */
export const ORDER_STATUSES: ProductionStatus[] = ['Pending', 'Approved', 'Printing', 'Pressing', 'Ready', 'Completed', 'Delayed', 'Cancelled'];

/** Migration 016: GET /api/orders "delivery_status", decided by the server */
export type DeliveryStatus = 'Not delivered' | 'Partly delivered' | 'Delivered';

/** PB 16: how close an open order is to its deadline, decided by the server
 *  (orderLifecycle.deadlineFlag, shop time). null for Completed / Cancelled orders. */
export type DeadlineFlag = 'overdue' | 'urgent_24h' | 'warning_72h' | 'normal';

/** Fallback list only: the payment form uses GET /api/orders/options (payment_methods), which
 *  also says which details each method needs. */
export const PAYMENT_TYPES = ['Cash', 'GCash', 'Maya', 'PayPal', 'Bank Transfer', 'Cheque', 'Credit/Debit Card', 'Other'] as const;

export interface Customer {
  customer_id: string;
  full_name: string;
  contact_number: string | null;
  platform_source: string | null;
  // migration 015: client profile
  customer_type?: string | null;
  contact_person?: string | null;
  email?: string | null;
  address?: string | null;
  social_media?: string | null;
  notes?: string | null;
  archived_at?: string | null;
  // migration 016: the contact person's own details (apart from the client's)
  contact_person_number?: string | null;
  contact_person_email?: string | null;
  contact_person_social?: string | null;
}

/** Migration 016: one of a client's other branches (the client's own address is the main branch) */
export interface CustomerBranch {
  branch_id: string;
  customer_id: string;
  branch_name: string;
  address: string | null;
  contact_person: string | null;
  contact_number: string | null;
  email: string | null;
  notes: string | null;
  archived_at: string | null;
}

/** Migration 016: a design file uploaded from the computer (kept in the cloud) */
export interface DesignFile {
  file_id: string;
  order_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  notes: string | null;
  uploaded_by_name: string | null;
  /** UTC */
  uploaded_at: string;
  /** a real PNG / JPEG / GIF / WebP image: may be shown in the page */
  previewable: boolean;
}

export interface Order {
  order_id: string;
  tracking_no: string | null;
  customer_id: string;
  date_created: string;
  production_deadline: string;
  production_status: ProductionStatus | string;
  total_quote_amount: number;
  design_drive_link: string | null;
  stock_reserved?: boolean | number;
  approved_at?: string | null;
  sync_status: string;
  /** opaque text from the server: send it back as expected_version, never interpret it */
  version?: string | null;
  deadline_flag?: DeadlineFlag | string | null;
  /** PB 23: why the Owner cancelled the order (null when none was given) */
  cancellation_reason?: string | null;
  /** migration 017: the fee kept on cancelling, the stage, the shop's fault; the client's delay */
  cancellation_fee?: number | null;
  cancelled_stage?: string | null;
  cancel_shop_fault?: boolean;
  client_delay_reason?: string | null;
  /** PB 23 / D2: archived (hidden from the list, read-only until restored, kept forever). UTC. */
  archived_at?: string | null;
  archived_by?: string | null;
  /** migration 015: what to do, in the customer's words */
  order_description?: string | null;
  labor_amount?: number;
  incidental_amount?: number;
  adjustment_amount?: number;
  adjustment_reason?: string | null;
  /** GET /api/orders (migration 015): the server's payment figures for the list */
  total_paid?: number;
  remaining?: number;
  payment_status?: string;
  /** migration 016: the client's branch making this order (null = the main branch) */
  branch_id?: string | null;
  /** GET /api/orders (migration 016): hand-over progress for the list */
  delivery_status?: DeliveryStatus | string | null;
  pieces_ordered?: number;
  pieces_delivered?: number;
}

/** migration 015: a size / name / number (garments) or a text (anything else) to print */
export interface PrintDetail {
  print_detail_id: string;
  order_id: string;
  line_item_id: string | null;
  print_type: string;
  quantity: number;
  size: string | null;
  custom_name: string | null;
  custom_number: string | null;
  notes: string | null;
  material_name: string | null;
  on_garment: boolean;
  sync_status: string;
}

/** migration 015: a batch handed to the customer */
export interface Delivery {
  delivery_id: string;
  batch_no: number;
  quantity: number;
  /** UTC */
  delivered_at: string;
  method: string;
  received_by_name: string | null;
  notes: string | null;
  recorded_by_name: string;
  /** migration 016: the planned batch these pieces belong to */
  plan_id?: string | null;
  plan_batch_no?: number | null;
}

/** Migration 016: a delivery batch planned ahead, as the server summarises it */
export interface DeliveryPlan {
  plan_id: string;
  order_id: string;
  batch_no: number;
  planned_quantity: number;
  /** 'YYYY-MM-DD' or null */
  planned_date: string | null;
  /** UTC; null = still in production */
  ready_at: string | null;
  ready_by_name?: string | null;
  notes: string | null;
  delivered: number;
  remaining: number;
  state: 'In production' | 'Ready' | 'Partly delivered' | 'Delivered' | string;
  /** the batch may be handed over now (it is ready, and pieces of it are left) */
  can_deliver: boolean;
  /** its planned date has passed and it is not fully delivered */
  overdue: boolean;
}

export interface Fulfillment {
  pieces_ordered: number;
  pieces_delivered: number;
  pieces_remaining: number;
  batches: number;
  state: 'none' | 'partial' | 'complete' | string;
  label: string;
  /** migration 016 */
  plans?: DeliveryPlan[];
  pieces_planned?: number;
  pieces_unplanned?: number;
  plans_open?: number;
}

/** What the order still needs before "Completed" (the server's completionCheck) */
export interface Completion {
  ready: boolean;
  missing: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  auto_handover: boolean;
  balance_due: number;
}

/** GET /api/orders/options */
export interface PaymentMethodForm {
  value: string;
  verify: boolean;
  fields: { name: string; label: string; required: boolean; type: 'text' | 'date' | string; max: number | null; hint: string | null; placeholder?: string | null }[];
}
export interface OrderOptions {
  payment_methods: PaymentMethodForm[];
  refund_reasons: string[];
  delivery_methods: string[];
  garment_sizes: string[];
  print_limits: { print_type: number; name: number; number_digits: number; quantity: number; notes: number; bulk_rows: number };
  /** migration 017 (absent on an older server) */
  print_sizes?: { size: string; label: string; price: number }[];
  print_placements?: string[];
  volume_tiers?: { min_quantity: number; percent_off: number; label: string }[];
}

/** PB 14: one status change, oldest first in OrderDetail.status_history */
export interface StatusChange {
  history_id: string;
  from_status: string | null;
  to_status: string;
  changed_by_name: string;
  changed_role: string | null;
  /** UTC, like date_created */
  changed_at: string;
}

/** "order_updated" socket event (Backend/services/orderEvents.js): only a hint to reload */
export interface OrderUpdated {
  order_id: string;
  tracking_no: string | null;
  production_status: string | null;
  version: string | null;
}

export interface OrderItem {
  line_item_id: string;
  inventory_id: string | null;
  product_type: string;
  quantity: number;
  size: string | null;
  custom_name: string | null;
  custom_number: string | null;
  /** PB 11: unit price set when the Owner calculated the quote (0 before) */
  price?: number;
  /** migration 015: catalog facts of the material */
  item_category?: string | null;
  unit?: string | null;
  has_sizes?: boolean;
  /** migration 016: a T-shirt, so the order goes through Pressing */
  requires_pressing?: boolean;
  is_consumable?: boolean;
  /** migration 017: JSON list of print areas; pieces printed / pressed; added to an approved order */
  print_areas?: string | null;
  qty_printed?: number;
  qty_pressed?: number;
  added_after_approval?: boolean;
}

/** PB 11 / PB 12: the quote as the server shows it (GET /api/orders/:id "quote"). The three
 *  figures always agree; lines is null when the item prices do not add up to the subtotal. */
export interface QuoteLine {
  line_item_id: string;
  product_type: string;
  size: string | null;
  custom_name: string | null;
  custom_number: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
}
export interface QuoteBreakdown {
  has_quote: boolean;
  /** materials */
  subtotal_amount: number;
  /** migration 015: labor / services, incidental charges, materials + both, a price cut after approval */
  labor_amount?: number;
  incidental_amount?: number;
  gross_amount?: number;
  adjustment_amount?: number;
  adjustment_reason?: string | null;
  discount_amount: number;
  discount_reason: string | null;
  total_quote_amount: number;
  lines?: QuoteLine[] | null;
}

/** POST /api/orders/:id/quote "calculation": the server's volume pricing (preview or saved) */
export interface QuoteCalculation {
  total_quantity: number;
  tier: { min_quantity: number; percent_off: number; label: string };
  lines: (QuoteLine & { selling_price: number; print_pricing?: 'included' | 'per_area'; print_areas?: PrintArea[]; print_charge?: number })[];
  subtotal_amount: number;
  labor_amount?: number;
  incidental_amount?: number;
  incidental_percent?: number | null;
  gross_amount?: number;
  discount_amount: number;
  discount_percent: number | null;
  discount_reason: string | null;
  total_quote_amount: number;
  /** migration 017: what the blanks cost the shop; never-blocking warnings (big discount, below cost) */
  cost_amount?: number;
  warnings?: { code: string; message: string }[];
}

/** PB 15: what the order's status changes took from stock (GET /api/orders/:id) */
export interface ConsumableUsed {
  log_id?: string;
  trigger_status: string;
  consumable_inventory_id: string;
  item_name: string;
  unit: string | null;
  quantity_deducted: number;
  /** more was needed than was on hand: the stock stopped at 0 */
  shortfall: number;
  deducted_at?: string;
}

export interface Payment {
  payment_id: string;
  amount: number;
  payment_type: string;
  payment_date: string;
  receipt_no: string | null;
  received_by_name: string | null;
  paid_to_date?: number;
  remaining_after?: number;
  status_after?: string;
  sync_status: string;
  /** PB 23, decided by the server (voidStatusOf): a reversal was recorded for this payment */
  voided?: boolean;
  voided_by_receipt_no?: string | null;
  /** this entry is itself a void (a negative reversing entry) */
  is_void?: boolean;
  voids_receipt_no?: string | null;
  void_reason?: string | null;
  /** the Owner may still void it (also needs allowed_actions.void_payment) */
  can_void?: boolean;
  // migration 015
  payer_name?: string | null;
  reference_no?: string | null;
  bank_name?: string | null;
  account_name?: string | null;
  cheque_no?: string | null;
  cheque_date?: string | null;
  payment_notes?: string | null;
  is_refund?: boolean;
  refund_reason?: string | null;
  verified_at?: string | null;
  verified_by?: string | null;
  /** UTC, when it was typed in (payment_date is when it was paid) */
  recorded_at?: string | null;
  needs_verification?: boolean;
}

/** PB 18 / PB 19: a misprint or material loss as the server shows it */
export interface MaterialLoss {
  loss_id: string;
  order_id: string | null;
  inventory_id: string | null;
  item_name: string;
  unit: string | null;
  quantity_lost: number;
  loss_reason: string;
  reason_code: string | null;
  reason_label: string | null;
  /** 'Machine Failure' | 'Human Error' | 'Product Defect' | 'Not classified' */
  category_label: string;
  production_stage: string | null;
  is_statistical_anomaly: boolean;
  financial_cost: number | null;
  /** UTC, like date_created */
  date_recorded: string;
  sync_status: string;
  /** migration 016: the print line it ruined (one of the order's print_details) */
  print_detail_id?: string | null;
}

/** POST /api/inventory/:id/loss: the server's diagnosis and the replacement warning (never blocking) */
export interface LossResponse {
  message?: string;
  source?: string;
  loss?: MaterialLoss;
  item?: { item_name: string; quantity_available: number };
  diagnosis?: { rule: string | null; note: string; cluster_with: string[]; escalated: string[] };
  replacement_warning?: { code: string; message: string } | null;
}

/** Computed by the server (services/domain/payments.js paymentSummary) */
export interface OrderTotals {
  item_count: number;
  total_quantity: number;
  total_paid: number;
  balance: number;
  remaining: number;
  overpaid_by: number;
  payment_status: 'Unpaid' | 'Partial' | 'Fully Paid' | 'Overpaid' | string;
  downpayment?: { required: number; paid_synced: number; met: boolean };
  /** migration 015 */
  pieces?: number;
  total_refunded?: number;
  max_refund?: number;
}

export interface StockCheck {
  sufficient: boolean;
  shortfalls?: { missing?: boolean; item_name?: string; needed: number; free?: number; shortfall?: number }[];
}

/** GET /api/orders/:id */
export interface OrderDetail {
  source: 'cloud' | 'local';
  order: Order;
  items: OrderItem[];
  payments: Payment[];
  totals: OrderTotals;
  allowed_actions?: Partial<OrderActions>;
  stock_check?: StockCheck | null;
  /** absent on an older server */
  status_history?: StatusChange[];
  /** PB 11 / PB 12 (absent on an older server) */
  quote?: QuoteBreakdown;
  /** PB 15 (absent on an older server) */
  consumables_deducted?: ConsumableUsed[];
  /** PB 18: misprints / losses recorded against this order, newest first (absent on an older server) */
  material_losses?: MaterialLoss[];
  /** migration 015 (absent on an older server) */
  print_details?: PrintDetail[];
  deliveries?: Delivery[];
  fulfillment?: Fulfillment;
  completion?: Completion;
  has_garments?: boolean;
  /** migration 016 (absent on an older server) */
  needs_pressing?: boolean;
  delivery_plans?: DeliveryPlan[];
  branch?: CustomerBranch | null;
  design_files?: DesignFile[];
  /** false: the cloud cannot be reached, so the design files cannot be listed right now */
  design_files_available?: boolean;
  /** migration 017 (absent on an older server) */
  progress?: ProductionProgress;
  cancel_terms?: CancelTerms;
  late_cut?: LateCut;
}

/** Migration 017: pieces printed / pressed / ready per item (consumables left out) */
export interface ProgressLine {
  line_item_id: string;
  product_type: string;
  size?: string | null;
  quantity: number;
  needs_pressing: boolean;
  printed: number;
  pressed: number;
  ready: number;
}
export interface ProductionProgress {
  lines: ProgressLine[];
  pieces: number;
  printed: number;
  pressed: number;
  ready: number;
  press_pieces: number;
  all_printed: boolean;
  all_ready: boolean;
  needs_pressing: boolean;
}
/** Migration 017: what the shop keeps if the order is cancelled now (or kept, once cancelled) */
export interface CancelTerms {
  stage: string | null;
  rule: string | null;
  fee: number;
  kept: number;
  paid: number;
  suggested_refund: number;
  shop_fault: boolean;
}
/** Migration 017: the late-delivery price cut the shop policy suggests */
export interface LateCut {
  applies: boolean;
  client_caused: boolean;
  days_late: number;
  percent: number;
  amount: number;
  full_refund_eligible: boolean;
  batches: { batch_no: number; planned_date: string; done_day: string; days_late: number; percent: number; amount: number }[];
  note: string;
}
/** Migration 017: a print area on an order line (per-area items) */
export interface PrintArea {
  placement: string;
  size: string;
}

/** GET /api/orders */
export interface OrderList {
  source: 'cloud' | 'local';
  orders: Order[];
  limit: number;
  offset: number;
  unsynced?: number;
}

/** 409 INSUFFICIENT_INVENTORY rows (services/capacity.js), as sent by create and approve */
export interface Shortage {
  inventory_id: string;
  item_name?: string;
  requested: number;
  available: number;
  shortfall?: number;
}

// Server-side sort options (GET /api/orders?sort=&dir=)
//   priority (PB 16): overdue first, then due today / tomorrow, then within 3 days; the server ranks them
export type OrderSortKey = 'date_created' | 'production_deadline' | 'total_quote_amount' | 'production_status' | 'priority';
export interface OrderSort {
  key: OrderSortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_ORDER_SORT: OrderSort = { key: 'date_created', dir: 'desc' };
export const ORDER_SORT_OPTIONS: (OrderSort & { label: string })[] = [
  { key: 'date_created', dir: 'desc', label: 'Newest first' },
  { key: 'date_created', dir: 'asc', label: 'Oldest first' },
  { key: 'priority', dir: 'asc', label: 'Most urgent first' },
  { key: 'production_deadline', dir: 'asc', label: 'Deadline: soonest first' },
  { key: 'production_deadline', dir: 'desc', label: 'Deadline: latest first' },
  { key: 'total_quote_amount', dir: 'desc', label: 'Quote: highest first' },
  { key: 'total_quote_amount', dir: 'asc', label: 'Quote: lowest first' },
  { key: 'production_status', dir: 'asc', label: 'Status (workflow order)' },
];
export const SORT_FIRST_DIR: Record<OrderSortKey, 'asc' | 'desc'> = {
  date_created: 'desc',
  production_deadline: 'asc',
  total_quote_amount: 'desc',
  production_status: 'asc',
  priority: 'asc',
};

/** "3 x Jersey print (M, DELA CRUZ, #7)" */
export const lineText = (it: Pick<OrderItem, 'quantity' | 'product_type' | 'size' | 'custom_name' | 'custom_number'>) => {
  const extra = [it.size, it.custom_name, it.custom_number && `#${it.custom_number}`].filter(Boolean).join(', ');
  return `${it.quantity} x ${it.product_type}${extra ? ` (${extra})` : ''}`;
};

export const RECEIPT_AFTER_SYNC = 'Given after sync';

/** PB 18: the server's standard loss reasons (REASON_CODES in services/domain/wasteDiagnostics.js).
 *  A display list, like PAYMENT_TYPES: the server checks the code and decides the cause.
 *  The one list for every "record a loss" form (Order details > Log Loss and Catalog > Adjust
 *  Stock > Subtract Stock), so both screens show the same Title Case labels. */
export const LOSS_REASONS: { code: string; label: string }[] = [
  { code: 'misprint_alignment', label: 'Misprint / Alignment Error' },
  { code: 'sizing_encoding_error', label: 'Sizing / Encoding Error' },
  { code: 'damaged_in_storage', label: 'Damaged in Storage' },
  { code: 'heat_press_scorch', label: 'Heat Press Scorch' },
  { code: 'printer_head_banding', label: 'Printer Head Banding' },
  { code: 'supplier_defect', label: 'Supplier Defect' },
];

/** Statuses where the job order still waits for approval by the Owner or an Admin (display only: the
 *  approval panel; the server decides whether approving is allowed). */
export const AWAITING_APPROVAL: readonly string[] = ['Pending', 'Delayed'];

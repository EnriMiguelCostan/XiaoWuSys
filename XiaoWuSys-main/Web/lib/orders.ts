// Shapes of the orders and customers API (Backend/routes/orders.js, routes/customers.js).
// Types and display lists only: every total, status and permission is decided by the server.
import type { OrderActions } from '@xiaowu/client-core/permissions';

export type ProductionStatus = 'Pending' | 'Approved' | 'Printing' | 'Pressing' | 'Completed' | 'Delayed' | 'Cancelled';

/** The server's PRODUCTION_STATUSES, for the status filter. */
export const ORDER_STATUSES: ProductionStatus[] = ['Pending', 'Approved', 'Printing', 'Pressing', 'Completed', 'Delayed', 'Cancelled'];

/** PB 16: how close an open order is to its deadline, decided by the server
 *  (orderLifecycle.deadlineFlag, shop time). null for Completed / Cancelled orders. */
export type DeadlineFlag = 'overdue' | 'urgent_24h' | 'warning_72h' | 'normal';

export const PAYMENT_TYPES = ['Cash', 'GCash', 'Bank Transfer'] as const;

export interface Customer {
  customer_id: string;
  full_name: string;
  contact_number: string | null;
  platform_source: string | null;
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

/** Statuses where the job order still waits for the Owner's approval (display only: the
 *  approval panel; the server decides whether approving is allowed). */
export const AWAITING_APPROVAL: readonly string[] = ['Pending', 'Delayed'];

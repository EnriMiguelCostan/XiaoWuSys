// Shape of GET /api/reports/dashboard (Backend/routes/reports.js). Every figure is computed by
// the server (balances, totals, suggested restock amounts); the screen only shows them.

/** One order line in the dashboard lists ("brief" in reports.js) */
export interface DashboardOrder {
  order_id: string;
  tracking_no: string | null;
  sync_status: string;
  customer_name: string;
  production_status: string;
  production_deadline: string;
  total_quote_amount: number;
  total_paid: number;
  balance: number;
  payment_status: string;
  /** overpaid list only */
  overpaid_by?: number;
}

export interface RestockItem {
  inventory_id: string;
  item_name: string;
  item_category: string;
  unit: string;
  supplier: string | null;
  stock_status: string;
  quantity_available: number;
  quantity_reserved: number;
  free: number;
  minimum_threshold: number;
  suggested_order: number;
}

export interface Dashboard {
  source: 'cloud' | 'local';
  generated_at: string;
  /** shop date, YYYY-MM-DD */
  today: string;
  orders: {
    total: number;
    open: number;
    by_status: Record<string, number>;
    overdue: DashboardOrder[];
    due_this_week: DashboardOrder[];
    unpaid: DashboardOrder[];
    unpaid_count: number;
    outstanding_balance: number;
    /** empty unless the account may see finances */
    overpaid: DashboardOrder[];
    overpaid_total: number;
  };
  /** oldest first, current month last */
  income_by_month: { month: string; amount: number }[];
  top_materials: { inventory_id: string; item_name: string; unit: string; quantity: number; orders: number }[];
  inventory: {
    summary: { total_items: number; in_stock: number; low_stock: number; out_of_stock: number; recycle_bin: number; stock_value: number };
    restock: RestockItem[];
  };
}

/** '2026-11' -> 'Nov 2026' (display only) */
export const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'short', year: 'numeric' });

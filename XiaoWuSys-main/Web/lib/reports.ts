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
  /** PB 16, decided by the server: overdue | urgent_24h | warning_72h | normal | null */
  deadline_flag?: string | null;
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
  /** PB 20 (absent on an older server). Costs are null unless costs_visible (view_finance). */
  waste?: WasteSummary;
}

/** One loss in the dashboard waste card (wasteReport.js "brief") */
export interface WasteLoss {
  loss_id: string;
  date_recorded: string;
  item_name: string;
  unit: string | null;
  quantity_lost: number;
  reason_label: string;
  category_label: string;
  production_stage: string | null;
  is_statistical_anomaly: boolean;
  order_label: string | null;
  financial_cost: number | null;
  sync_status: string;
}

export interface WasteSummary {
  /** 'YYYY-MM', shop time */
  month: string;
  costs_visible: boolean;
  total_cost_this_month: number | null;
  total_items_this_month: number;
  count_this_month: number;
  by_category: { category: string; count: number; quantity: number; cost: number | null }[];
  anomalies: WasteLoss[];
  recent: WasteLoss[];
}

/** PB 22: GET /api/reports/overheads */
export interface OverheadExpense {
  expense_id: string;
  /** a shop day at 00:00 (Manila wall time, not UTC) */
  expense_date: string;
  category: string;
  description: string;
  amount: number;
  recorded_by_name: string;
  sync_status: string;
  /** the server allows removing it (Owner, synced) */
  can_delete: boolean;
}
export interface OverheadList {
  source: 'cloud' | 'local';
  period: { from: string; to: string };
  expenses: OverheadExpense[];
  total: number;
  by_category: { category: string; amount: number }[];
  categories: string[];
  can_delete: boolean;
}

/** PB 22: GET /api/reports/pnl (Owner only). Every figure is the server's (services/domain/pnl.js). */
export interface ProfitAndLoss {
  source: 'cloud' | 'local';
  generated_at: string;
  period: { from: string; to: string };
  gross_income: number;
  voids_in_period: number;
  discounts_given: number;
  cogs_blanks: number;
  cogs_consumables: number;
  total_cogs: number;
  waste_cost: number;
  waste_by_category: { category: string; amount: number }[];
  overhead_cost: number;
  overhead_by_category: { category: string; amount: number }[];
  total_expenses: number;
  net_profit: number;
  profitable: boolean;
  counts: { payments: number; orders_completed: number; losses: number };
  notes: string[];
}

/** '2026-11' -> 'Nov 2026' (display only) */
export const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'short', year: 'numeric' });

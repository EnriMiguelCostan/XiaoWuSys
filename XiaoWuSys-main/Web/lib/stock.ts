// Shapes of the inventory-system API (migration 015): Backend/routes/stock.js and routes/suppliers.js.
// Types only: every quantity, cost, number and permission comes from the server and is only shown.

export type StockDocumentType = 'stock_in' | 'stock_out' | 'stock_count';

/** GET /api/stock/options: what the forms may offer, as the server decides */
export interface StockOptions {
  document_types: { value: StockDocumentType; label: string; prefix: string }[];
  reference_types: string[];
  stock_out_reasons: string[];
  note_required_reasons: string[];
  movement_types: { value: string; label: string }[];
  lines_max: number;
  can_record: Record<StockDocumentType, boolean>;
  can_void: boolean;
}

export interface StockDocument {
  document_id: string;
  document_type: StockDocumentType;
  /** SI-2026-0001 / SO-… / SC-…, given by the cloud database */
  document_no: string | null;
  label: string;
  /** 'Recorded' | 'Corrected' | 'Voided' */
  status: string;
  reason: string | null;
  supplier_id: string | null;
  supplier_name?: string | null;
  order_id: string | null;
  reference_type: string | null;
  reference_no: string | null;
  /** UTC */
  occurred_at: string;
  notes: string | null;
  total_cost: number;
  recorded_by_name?: string;
  edited_by_name?: string | null;
  voided_by_name?: string | null;
  edited_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  line_count?: number;
  total_quantity?: number;
  version?: string | null;
  allowed_actions: { edit: boolean; void: boolean; print: boolean };
}

export interface StockDocumentLine {
  line_id: string;
  line_no: number;
  inventory_id: string;
  item_name: string | null;
  unit: string | null;
  /** stock in / out: moved; count: counted */
  quantity: number;
  /** count only: what the system had */
  system_quantity: number | null;
  difference?: number | null;
  unit_cost: number;
  line_total?: number;
}

export interface StockDocumentDetail {
  source: 'cloud';
  document: StockDocument;
  lines: StockDocumentLine[];
  supplier: Supplier | null;
  history: { action: string; by_name: string; role: string | null; at: string; reason: string | null }[];
}

export interface StockDocumentList {
  source: 'cloud';
  documents: StockDocument[];
  total: number;
  limit: number;
  offset: number;
}

/** One row of the stock card (GET /api/stock/movements) */
export interface StockMovement {
  movement_id: string;
  inventory_id: string;
  item_name: string | null;
  movement_type: string;
  label: string;
  direction: 'in' | 'out';
  quantity_change: number;
  balance_after: number;
  unit_cost: number | null;
  reference_type: string | null;
  reference_id: string | null;
  reference_no: string | null;
  note: string | null;
  performed_by_name: string;
  /** UTC */
  occurred_at: string | null;
  created_at: string;
}

export interface Supplier {
  supplier_id: string;
  supplier_name: string;
  contact_person: string | null;
  contact_number: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at?: string | null;
  /** cloud only (null offline) */
  item_count?: number | null;
  delivery_count?: number | null;
  last_delivery_at?: string | null;
  total_purchased?: number | null;
}

export interface SupplierActions {
  edit: boolean;
  archive: boolean;
  restore: boolean;
  record_stock_in: boolean;
}

/** Where each kind of record lives on screen */
export const STOCK_PAGE: Record<StockDocumentType, string> = {
  stock_in: '/inventory/stock-in',
  stock_out: '/inventory/stock-out',
  stock_count: '/inventory/stock-count',
};

// Date-and-time input values ('YYYY-MM-DDTHH:MM') on the shop's clock. Form display only: the
// server converts what is typed back to UTC and refuses a time in the future.
const shopInputValue = (date: Date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

/** "now" on the shop's clock, as a datetime input value (form default only) */
export const nowForInput = () => shopInputValue(new Date());

/** A UTC 'YYYY-MM-DDTHH:MM:SS' from the server, as a datetime input value on the shop's clock */
export const utcToInput = (utc: string) => shopInputValue(new Date(`${utc.replace(' ', 'T')}Z`));

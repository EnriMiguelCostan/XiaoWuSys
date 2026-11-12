export interface OrderRef {
  order_id?: string;
  tracking_no?: string | null;
  sync_status?: string | null;
}

export function orderNumber(order: OrderRef | null | undefined): string;
export function hasOrderNumber(order: OrderRef | null | undefined): boolean;
export const NUMBER_AFTER_SYNC: string;
export function normalizeOrderNumber(text: string | null | undefined): string | null;

export interface StockShortfall {
  missing?: boolean;
  item_name?: string;
  needed: number;
  free?: number;
  shortfall?: number;
}

export function shortfallLines(stockCheck: { shortfalls?: StockShortfall[] } | null | undefined): string[];

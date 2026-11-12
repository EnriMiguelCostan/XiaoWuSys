import type { OrderRef } from './orders.js';

export const RECEIPT_TITLE: string;
export const RECEIPT_FOOTER: string;
export const PROVISIONAL_RECEIPT_NO: string;

export function escapeHtml(value: unknown): string;

export interface ReceiptArgs {
  payment: {
    amount: number;
    payment_type: string;
    payment_date?: string | null;
    receipt_no?: string | null;
    received_by_name?: string | null;
    paid_to_date?: number;
    remaining_after?: number;
    status_after?: string;
  };
  order: OrderRef & { total_quote_amount: number };
  customer?: { full_name?: string | null } | null;
}

export function receiptLines(args: ReceiptArgs): { provisional: boolean; receiptNo: string; lines: [string, string][]; totals: [string, string][] };
export function receiptText(args: ReceiptArgs): string;
export function receiptHtml(args: ReceiptArgs): string;

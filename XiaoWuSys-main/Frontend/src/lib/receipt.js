// Printable payment acknowledgement (PB 21). Plain JS (no React, no DOM) so the future
// Next.js and mobile apps can reuse it: it only builds text / HTML from what the API returned.
// This is an acknowledgement of payment, not an Official Receipt (team decision D1).
import { orderNumber } from './orders';

export const RECEIPT_TITLE = 'XiaoMei Printshop: Payment Acknowledgement';
export const RECEIPT_FOOTER = 'This is an acknowledgement of payment, not an Official Receipt.';
export const PROVISIONAL_RECEIPT_NO = 'Receipt number given when the system is back online';

export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Server times (payment_date) are UTC without a zone mark: shown in shop time, no zone code
const shopDateTime = (utcText) => {
  if (!utcText) return '—';
  const d = new Date(`${String(utcText).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(utcText);
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
};

// Everything the acknowledgement shows, as label/value lines. payment comes from
// GET /api/orders/:id (it carries received_by_name, paid_to_date, remaining_after, status_after).
export const receiptLines = ({ payment, order, customer }) => {
  const provisional = !payment.receipt_no;
  return {
    provisional,
    receiptNo: payment.receipt_no || PROVISIONAL_RECEIPT_NO,
    lines: [
      ['Order', orderNumber(order)],
      ['Customer', (customer && customer.full_name) || 'Walk-in customer'],
      ['Date and time', shopDateTime(payment.payment_date)],
      ['Amount received', peso(payment.amount)],
      ['Payment type', payment.payment_type],
      ['Received by', payment.received_by_name || 'Not recorded']
    ],
    totals: [
      ['Order total (quote)', peso(order.total_quote_amount)],
      ['Total paid so far', peso(payment.paid_to_date ?? payment.amount)],
      ['Remaining balance', peso(payment.remaining_after ?? 0)],
      ['Payment status', payment.status_after || '—']
    ]
  };
};

// Plain text version (for copying into Messenger)
export const receiptText = (args) => {
  const r = receiptLines(args);
  return [RECEIPT_TITLE, `Receipt no.: ${r.receiptNo}`, ...r.lines.map(([k, v]) => `${k}: ${v}`), '',
    ...r.totals.map(([k, v]) => `${k}: ${v}`), '', RECEIPT_FOOTER].join('\n');
};

// Full HTML page for the browser's print window. Every value is escaped.
export const receiptHtml = (args) => {
  const r = receiptLines(args);
  const row = ([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(RECEIPT_TITLE)}</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#111;max-width:520px}h1{font-size:18px;margin:0 0 4px}
.no{font-size:14px;margin:0 0 12px}.no.prov{color:#92400e}table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{border-bottom:1px solid #ccc;padding:6px;text-align:left;font-size:13px}th{width:45%;color:#333;font-weight:normal}
td{font-weight:bold}.foot{margin-top:18px;font-size:12px;border-top:1px solid #333;padding-top:8px}
.sign{margin-top:36px;border-top:1px solid #333;width:60%;font-size:12px;padding-top:4px}@media print{button{display:none}}</style></head><body>
<h1>${escapeHtml(RECEIPT_TITLE)}</h1>
<p class="no${r.provisional ? ' prov' : ''}"><b>Receipt no.:</b> ${escapeHtml(r.receiptNo)}</p>
<table><tbody>${r.lines.map(row).join('')}</tbody></table>
<table><tbody>${r.totals.map(row).join('')}</tbody></table>
<div class="sign">Received by (signature)</div>
<p class="foot">${escapeHtml(RECEIPT_FOOTER)}</p>
<p><button onclick="window.print()">Print</button></p></body></html>`;
};

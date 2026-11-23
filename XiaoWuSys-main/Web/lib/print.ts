// Printing and copying for orders (steering: lib/print.ts). Browser-only: call from handlers.
// Wording and the receipt layout come from @xiaowu/client-core; every number shown is a value
// the server returned (totals, payments), never computed here.
import { formatDateTime, formatMobile, peso, todayInManila } from '@xiaowu/client-core/format';
import { hasOrderNumber } from '@xiaowu/client-core/orders';
import { escapeHtml, receiptHtml } from '@xiaowu/client-core/receipt';
import { lineText, type Customer, type OrderDetail, type Payment } from '@/lib/orders';
import type { ProfitAndLoss } from '@/lib/reports';
import type { StockDocumentDetail } from '@/lib/stock';

// Opens a print window with the given HTML. false when the browser blocked the pop-up.
const printHtml = (html: string, size: string) => {
  const w = window.open('', '_blank', size);
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
};

/** Payment acknowledgement (provisional until the receipt number arrives with sync). */
export const printReceipt = (detail: OrderDetail, payment: Payment, customer: Customer | undefined) =>
  printHtml(receiptHtml({ payment, order: detail.order, customer }), 'width=600,height=800');

/** Job order for the production team. */
export const printJobOrder = (detail: OrderDetail, customer: Customer | undefined) => {
  const { order, items, totals, payments } = detail;
  const label = hasOrderNumber(order) ? String(order.tracking_no) : '(number given after sync)';
  // Materials (stock) and print details (sizes, names, numbers, texts) are separate lists (migration 015)
  const rows = items
    .map((it) => `<tr><td>${escapeHtml(it.product_type)}</td><td>${escapeHtml(it.unit || '')}</td><td class="n">${escapeHtml(it.quantity)}</td></tr>`)
    .join('');
  const prints = (detail.print_details ?? [])
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.print_type)}${p.material_name ? ` (${escapeHtml(p.material_name)})` : ''}</td><td>${escapeHtml(p.size || '')}</td>` +
        `<td>${escapeHtml(p.custom_name || '')}</td><td>${escapeHtml(p.custom_number || '')}</td><td>${escapeHtml(p.notes || '')}</td><td class="n">${escapeHtml(p.quantity)}</td></tr>`
    )
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Job Order ${escapeHtml(label)}</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{border:1px solid #999;padding:6px;text-align:left;font-size:13px;overflow-wrap:anywhere}td.n,th.n{text-align:right}.meta{font-size:13px;margin:2px 0;overflow-wrap:anywhere}.sign{margin-top:40px;display:flex;gap:40px}
.sign div{flex:1;border-top:1px solid #333;padding-top:4px;font-size:12px}@media print{button{display:none}}</style></head><body>
<h1>XiaoMei Printshop — Job Order ${escapeHtml(label)}</h1>
<p class="meta"><b>Customer:</b> ${escapeHtml(customer?.full_name || order.customer_id)} ${customer?.contact_number ? `· ${escapeHtml(formatMobile(customer.contact_number))}` : ''}</p>
<p class="meta"><b>Status:</b> ${escapeHtml(order.production_status)} · <b>Deadline:</b> ${escapeHtml(formatDateTime(order.production_deadline, { withTime: false }))}</p>
${order.design_drive_link ? `<p class="meta"><b>Design file:</b> ${escapeHtml(order.design_drive_link)}</p>` : ''}
${order.order_description ? `<p class="meta" style="white-space:pre-wrap"><b>Instructions:</b> ${escapeHtml(order.order_description)}</p>` : ''}
<table><thead><tr><th>Material</th><th>Unit</th><th class="n">Qty</th></tr></thead><tbody>${rows}</tbody></table>
${prints ? `<table><thead><tr><th>Print</th><th>Size</th><th>Name / text</th><th>No.</th><th>Notes</th><th class="n">Qty</th></tr></thead><tbody>${prints}</tbody></table>` : ''}
<p class="meta"><b>Quote:</b> ${escapeHtml(peso(order.total_quote_amount))} · <b>Paid:</b> ${escapeHtml(peso(totals.total_paid))} (${payments.length} payment(s)) · <b>Balance:</b> ${escapeHtml(peso(totals.remaining))}${totals.payment_status ? ` · <b>Payment:</b> ${escapeHtml(totals.payment_status)}` : ''}</p>
<div class="sign"><div>Prepared by</div><div>Printed by</div><div>Released to customer</div></div>
<p><button onclick="window.print()">Print</button></p></body></html>`;
  return printHtml(html, 'width=800,height=900');
};

/** Migration 015: a stock in / stock out / count record, as the server returned it. */
export const printStockDocument = (detail: StockDocumentDetail) => {
  const { document: d, lines } = detail;
  const count = d.document_type === 'stock_count';
  const body = lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.item_name || l.inventory_id)}</td><td>${escapeHtml(l.unit || '')}</td>` +
        (count
          ? `<td class="n">${escapeHtml(l.system_quantity ?? '')}</td><td class="n">${escapeHtml(l.quantity)}</td><td class="n">${escapeHtml(l.difference ?? '')}</td>`
          : `<td class="n">${escapeHtml(l.quantity)}</td><td class="n">${escapeHtml(peso(l.unit_cost))}</td><td class="n">${escapeHtml(peso(l.line_total ?? 0))}</td>`) +
        '</tr>'
    )
    .join('');
  const head = count
    ? '<th class="n">System had</th><th class="n">Counted</th><th class="n">Difference</th>'
    : '<th class="n">Qty</th><th class="n">Unit cost</th><th class="n">Amount</th>';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(d.document_no || d.label)}</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{border:1px solid #999;padding:6px;text-align:left;font-size:13px;overflow-wrap:anywhere}td.n,th.n{text-align:right}.meta{font-size:13px;margin:2px 0}
.sign{margin-top:40px;display:flex;gap:40px}.sign div{flex:1;border-top:1px solid #333;padding-top:4px;font-size:12px}@media print{button{display:none}}</style></head><body>
<h1>XiaoMei Printshop — ${escapeHtml(d.label)} ${escapeHtml(d.document_no || '')}</h1>
<p class="meta"><b>Date:</b> ${escapeHtml(formatDateTime(d.occurred_at, { utc: true }))} · <b>Status:</b> ${escapeHtml(d.status)}</p>
${d.supplier_name ? `<p class="meta"><b>Supplier:</b> ${escapeHtml(d.supplier_name)}</p>` : ''}
${d.reference_no ? `<p class="meta"><b>${escapeHtml(d.reference_type || 'Reference')}:</b> ${escapeHtml(d.reference_no)}</p>` : ''}
${d.reason && !count ? `<p class="meta"><b>Reason:</b> ${escapeHtml(d.reason)}</p>` : ''}
${d.notes ? `<p class="meta"><b>Notes:</b> ${escapeHtml(d.notes)}</p>` : ''}
<table><thead><tr><th>Item</th><th>Unit</th>${head}</tr></thead><tbody>${body}</tbody></table>
${count ? '' : `<p class="meta"><b>Total:</b> ${escapeHtml(peso(d.total_cost))}</p>`}
${d.voided_at ? `<p class="meta"><b>VOIDED:</b> ${escapeHtml(d.void_reason || '')}</p>` : ''}
<div class="sign"><div>Recorded by: ${escapeHtml(d.recorded_by_name || '')}</div><div>Checked by</div><div>Received / released by</div></div>
<p><button onclick="window.print()">Print</button></p></body></html>`;
  return printHtml(html, 'width=800,height=900');
};

/**
 * PB 11 / PB 12: the official customer quotation (not the production job order). Every price is
 * the server's: detail.quote (subtotal, discount and reason, total) and quote.lines (unit price and
 * line total per item). When the server sends no lines (a quote typed in by hand) the items are
 * listed without prices and only the totals are shown, so the paper never disagrees with itself.
 */
export const printOfficialQuote = (detail: OrderDetail, customer: Customer | undefined) => {
  const { order, items, totals } = detail;
  const quote = detail.quote;
  const label = hasOrderNumber(order) ? String(order.tracking_no) : '(number given after sync)';
  const lines = quote?.lines ?? null;
  const detailsOf = (it: { size: string | null; custom_name: string | null; custom_number: string | null }) =>
    [it.size, it.custom_name, it.custom_number && `#${it.custom_number}`].filter(Boolean).join(', ');
  const rows = lines
    ? lines
        .map(
          (l) =>
            `<tr><td>${escapeHtml(l.product_type)}</td><td>${escapeHtml(detailsOf(l))}</td><td class="n">${escapeHtml(l.quantity)}</td>` +
            `<td class="n">${escapeHtml(peso(l.unit_price))}</td><td class="n">${escapeHtml(peso(l.line_total))}</td></tr>`
        )
        .join('')
    : items
        .map(
          (it) =>
            `<tr><td>${escapeHtml(it.product_type)}</td><td>${escapeHtml(detailsOf(it))}</td><td class="n">${escapeHtml(it.quantity)}</td><td class="n"></td><td class="n"></td></tr>`
        )
        .join('');
  const subtotal = quote ? quote.subtotal_amount : order.total_quote_amount;
  const total = quote ? quote.total_quote_amount : order.total_quote_amount;
  const discount = quote?.discount_amount
    ? `<tr><td colspan="4" class="n">Discount${quote.discount_reason ? ` (${escapeHtml(quote.discount_reason)})` : ''}</td><td class="n">−${escapeHtml(peso(quote.discount_amount))}</td></tr>`
    : '';
  const downpayment = totals.downpayment?.required
    ? `<p class="meta"><b>Downpayment to start production:</b> ${escapeHtml(peso(totals.downpayment.required))} (half of the total quote)</p>`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Quotation ${escapeHtml(label)}</title>
<style>body{font-family:Arial,sans-serif;margin:32px;color:#111}h1{font-size:22px;margin:0}h2{font-size:14px;font-weight:normal;margin:2px 0 16px;color:#444}
table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #999;padding:6px;text-align:left;font-size:13px;overflow-wrap:anywhere}
td.n,th.n{text-align:right;white-space:nowrap}tfoot td{font-weight:bold}.meta{font-size:13px;margin:2px 0;overflow-wrap:anywhere}
.note{font-size:12px;color:#444;margin-top:16px}.sign{margin-top:48px;display:flex;gap:40px}.sign div{flex:1;border-top:1px solid #333;padding-top:4px;font-size:12px}
@media print{button{display:none}}</style></head><body>
<h1>XiaoMei Printshop</h1>
<h2>Customer Quotation ${escapeHtml(label)}</h2>
<p class="meta"><b>Prepared for:</b> ${escapeHtml(customer?.full_name || 'Customer')}${customer?.contact_number ? ` · ${escapeHtml(formatMobile(customer.contact_number))}` : ''}</p>
<p class="meta"><b>Date:</b> ${escapeHtml(formatDateTime(todayInManila(), { withTime: false }))} · <b>Needed by:</b> ${escapeHtml(formatDateTime(order.production_deadline, { withTime: false }))}</p>
<table><thead><tr><th>Item</th><th>Details</th><th class="n">Qty</th><th class="n">Price each</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="4" class="n">Subtotal</td><td class="n">${escapeHtml(peso(subtotal))}</td></tr>${discount}
<tr><td colspan="4" class="n">Total</td><td class="n">${escapeHtml(peso(total))}</td></tr></tfoot></table>
${downpayment}
<p class="note">This is a price quotation, not an Official Receipt or an invoice. Prices may change if the items, quantities or design change.</p>
<div class="sign"><div>Prepared by (XiaoMei Printshop)</div><div>Accepted by (customer)</div></div>
<p><button onclick="window.print()">Print</button></p></body></html>`;
  return printHtml(html, 'width=800,height=900');
};

/**
 * PB 22: the Owner's true-cost Profit & Loss statement for a period. Every figure is the server's
 * (GET /api/reports/pnl); this only lays them out for paper.
 */
export const printPnlReport = (pnl: ProfitAndLoss) => {
  const row = (label: string, value: number, cls = '') =>
    `<tr class="${cls}"><td>${escapeHtml(label)}</td><td class="n">${escapeHtml(peso(value))}</td></tr>`;
  const section = (title: string) => `<tr class="h"><td colspan="2">${escapeHtml(title)}</td></tr>`;
  const period = `${formatDateTime(pnl.period.from, { withTime: false })} to ${formatDateTime(pnl.period.to, { withTime: false })}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Profit and Loss ${escapeHtml(pnl.period.from)} to ${escapeHtml(pnl.period.to)}</title>
<style>body{font-family:Arial,sans-serif;margin:32px;color:#111}h1{font-size:22px;margin:0}h2{font-size:14px;font-weight:normal;margin:2px 0 16px;color:#444}
table{width:100%;border-collapse:collapse;margin:12px 0}td{border-bottom:1px solid #ccc;padding:6px;font-size:13px;overflow-wrap:anywhere}td.n{text-align:right;white-space:nowrap}
tr.h td{font-weight:bold;background:#f2f2f2;border-bottom:1px solid #999}tr.t td{font-weight:bold}tr.net td{font-weight:bold;font-size:15px;border-top:2px solid #111}
.note{font-size:12px;color:#444;margin:4px 0}@media print{button{display:none}}</style></head><body>
<h1>XiaoMei Printshop</h1>
<h2>Profit and Loss Statement · ${escapeHtml(period)}</h2>
<table>
${section('Income')}
${row('Payments received (after voids)', pnl.gross_income)}
${pnl.voids_in_period ? row('Of which: voided payments taken off', pnl.voids_in_period) : ''}
${pnl.discounts_given ? row('Discounts given (already taken off the quotes)', pnl.discounts_given) : ''}
${section('Cost of goods')}
${row('Blanks used (completed orders)', pnl.cogs_blanks)}
${row('Consumables used', pnl.cogs_consumables)}
${row('Total cost of goods', pnl.total_cogs, 't')}
${section('Material waste')}
${pnl.waste_by_category.map((w) => row(w.category, w.amount)).join('')}
${row('Total material waste', pnl.waste_cost, 't')}
${section('Overheads')}
${pnl.overhead_by_category.map((o) => row(o.category, o.amount)).join('')}
${row('Total overheads', pnl.overhead_cost, 't')}
${row('Total expenses', pnl.total_expenses, 't')}
${row(pnl.profitable ? 'Net profit' : 'Net loss', pnl.net_profit, 'net')}
</table>
${pnl.notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}
<p class="note">Prepared ${escapeHtml(formatDateTime(pnl.generated_at.slice(0, 19), { utc: true }))}. For the shop's own records; not a tax filing.</p>
<p><button onclick="window.print()">Print</button></p></body></html>`;
  return printHtml(html, 'width=800,height=900');
};

/** Text the staff paste into Messenger / Facebook to update the customer. */
export const messengerSummary = (detail: OrderDetail, customer: Customer | undefined) => {
  const { order, items, totals } = detail;
  return [
    `Hi ${customer?.full_name || ''}! Here is your XiaoMei Printshop order${hasOrderNumber(order) ? ` ${order.tracking_no}` : ''}:`,
    ...items.map((it) => `• ${lineText(it)}`),
    `Deadline: ${formatDateTime(order.production_deadline, { withTime: false })}`,
    `Total: ${peso(order.total_quote_amount)}`,
    `Paid: ${peso(totals.total_paid)}${totals.payment_status ? ` (${totals.payment_status})` : ''}`,
    `Balance: ${peso(totals.remaining)}`,
    `Status: ${order.production_status}`,
    order.design_drive_link ? `Design: ${order.design_drive_link}` : null,
    'Thank you!',
  ]
    .filter(Boolean)
    .join('\n');
};

/** Copies text, with a fallback for plain-http LAN addresses where the Clipboard API is off. */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
};

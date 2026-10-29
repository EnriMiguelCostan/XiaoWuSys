import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, ClipboardList, X, ChevronLeft, ChevronRight, CloudOff, Printer, CircleCheck, CircleX, RotateCcw, Wallet, ShieldCheck, TriangleAlert, ArrowUp, ArrowDown, ArrowUpDown, Pencil, Copy, Link2, Shirt, Search
} from 'lucide-react';
import { createApi, errorText, peso, formatDateTime, copyText, todayInManila } from './api';
import { ResultDialog, ConfirmDialog } from './Dialogs';
import { orderActions } from './lib/permissions';
import { orderNumber, hasOrderNumber, normalizeOrderNumber, shortfallLines, NUMBER_AFTER_SYNC } from './lib/orders';

// Orders tab: every order profile, newest first, with its materials, payments and status.
//   GET   /api/orders?status=&limit=&offset=      list
//   GET   /api/orders/:id                         detail (items, payments, totals)
//   POST  /api/orders/:id/approve                 Owner only: Pending/Delayed -> Approved (PB 13)
//   PATCH /api/orders/:id/status                  Approved -> Printing -> Completed, Cancel, resume Delayed
//   POST  /api/orders/:id/payments                record a payment
// Status changes move stock (reserve on approval, release on Cancel, consume on Complete),
// and the Catalog updates by itself through the real-time push.
// Which buttons appear comes from the server ("allowed_actions" on each order), so this
// screen keeps no copy of the role or status rules.

const PAGE_SIZE = 20;
const PAYMENT_TYPES = ['Cash', 'GCash', 'Bank Transfer'];
// Statuses that show the approval progress box (display only; the server decides who may approve)
const AWAITING_APPROVAL = ['Pending', 'Delayed'];

// Sort options (the server sorts, see GET /api/orders?sort=&dir=)
const SORT_OPTIONS = [
  { key: 'date_created', dir: 'desc', label: 'Newest first' },
  { key: 'date_created', dir: 'asc', label: 'Oldest first' },
  { key: 'production_deadline', dir: 'asc', label: 'Deadline: soonest first' },
  { key: 'production_deadline', dir: 'desc', label: 'Deadline: latest first' },
  { key: 'total_quote_amount', dir: 'desc', label: 'Quote: highest first' },
  { key: 'total_quote_amount', dir: 'asc', label: 'Quote: lowest first' },
  { key: 'production_status', dir: 'asc', label: 'Status (workflow order)' }
];
const DEFAULT_SORT = { key: 'date_created', dir: 'desc' };
const SORT_DEFAULT_DIR = { date_created: 'desc', production_deadline: 'asc', total_quote_amount: 'desc', production_status: 'asc' };

const ORDER_STATUS_META = {
  Pending: { bg: '#e0e7ff', color: '#3730a3' },
  Approved: { bg: '#ccfbf1', color: '#115e59' },
  Printing: { bg: '#dbeafe', color: '#1e40af' },
  Completed: { bg: '#dcfce7', color: '#166534' },
  Delayed: { bg: '#fef3c7', color: '#92400e' },
  Cancelled: { bg: '#fee2e2', color: '#991b1b' }
};

// Label and icon for each status button. WHICH buttons appear comes from the server
// (allowed_actions.statuses); Approve is its own Owner-only button.
const ACTION_META = {
  Printing: { label: 'Start Printing', Icon: Printer },
  Completed: { label: 'Mark Completed', Icon: CircleCheck },
  Pending: { label: 'Resume (reserve stock)', Icon: RotateCcw },
  Cancelled: { label: 'Cancel Order', Icon: CircleX, danger: true }
};
const statusAction = (to) => ({ to, label: to, Icon: CircleCheck, ...ACTION_META[to] });
const EMPTY_PRINT_LINE = { product_type: 'Jersey print', quantity: '1', size: '', custom_name: '', custom_number: '' };
const lineText = (it) => {
  const extra = [it.size, it.custom_name, it.custom_number && `#${it.custom_number}`].filter(Boolean).join(', ');
  return `${it.quantity} x ${it.product_type}${extra ? ` (${extra})` : ''}`;
};
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Text the staff can paste into Messenger / Facebook to update the customer
const messengerSummary = (detail, customer) => {
  const { order, items, totals } = detail;
  return [
    `Hi ${customer?.full_name || ''}! Here is your XiaoMei Printshop order${hasOrderNumber(order) ? ` ${order.tracking_no}` : ''}:`,
    ...items.map((it) => `• ${lineText(it)}`),
    `Deadline: ${formatDateTime(order.production_deadline, { withTime: false })}`,
    `Total: ${peso(order.total_quote_amount)}`,
    `Paid: ${peso(totals.total_paid)}`,
    `Balance: ${peso(totals.balance)}`,
    `Status: ${order.production_status}`,
    order.design_drive_link ? `Design: ${order.design_drive_link}` : null,
    'Thank you!'
  ].filter(Boolean).join('\n');
};

// Printable job order for the production team (opens the browser's print window)
const printJobOrder = (detail, customer) => {
  const { order, items, totals, payments } = detail;
  const label = hasOrderNumber(order) ? order.tracking_no : '(number given after sync)';
  const w = window.open('', '_blank', 'width=800,height=900');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Job Order ${escapeHtml(label)}</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{border:1px solid #999;padding:6px;text-align:left;font-size:13px}td.n,th.n{text-align:right}.meta{font-size:13px;margin:2px 0}.sign{margin-top:40px;display:flex;gap:40px}
.sign div{flex:1;border-top:1px solid #333;padding-top:4px;font-size:12px}@media print{button{display:none}}</style></head><body>
<h1>XiaoMei Printshop — Job Order ${escapeHtml(label)}</h1>
<p class="meta"><b>Customer:</b> ${escapeHtml(customer?.full_name || order.customer_id)} ${customer?.contact_number ? `· ${escapeHtml(customer.contact_number)}` : ''}</p>
<p class="meta"><b>Status:</b> ${escapeHtml(order.production_status)} · <b>Deadline:</b> ${escapeHtml(formatDateTime(order.production_deadline, { withTime: false }))}</p>
${order.design_drive_link ? `<p class="meta"><b>Design file:</b> ${escapeHtml(order.design_drive_link)}</p>` : ''}
<table><thead><tr><th>Item / material</th><th>Size</th><th>Name</th><th>No.</th><th class="n">Qty</th></tr></thead><tbody>
${items.map((it) => `<tr><td>${escapeHtml(it.product_type)}</td><td>${escapeHtml(it.size || '')}</td><td>${escapeHtml(it.custom_name || '')}</td><td>${escapeHtml(it.custom_number || '')}</td><td class="n">${escapeHtml(it.quantity)}</td></tr>`).join('')}
</tbody></table>
<p class="meta"><b>Quote:</b> ${escapeHtml(peso(order.total_quote_amount))} · <b>Paid:</b> ${escapeHtml(peso(totals.total_paid))} (${payments.length} payment(s)) · <b>Balance:</b> ${escapeHtml(peso(totals.balance))}</p>
<div class="sign"><div>Prepared by</div><div>Printed by</div><div>Released to customer</div></div>
<p><button onclick="window.print()">Print</button></p></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
};
const toCentavos = (n) => Math.round(Number(n || 0) * 100);

// What the server will check before approving (§4.4), worked out from the loaded detail so
// the button can explain itself. The server stays the real check.
// Money is compared in integer centavos, like the backend; offline payments do not count.
const approvalReadiness = (detail) => {
  const { order, items, payments } = detail;
  const quoteC = toCentavos(order.total_quote_amount);
  const requiredC = Math.ceil(quoteC / 2);
  const paidC = payments.filter((p) => p.sync_status === 'synced').reduce((sum, p) => sum + toCentavos(p.amount), 0);
  const offlinePayments = payments.filter((p) => p.sync_status !== 'synced').length;
  const unlinked = items.filter((i) => !i.inventory_id).length;
  const problems = [];
  if (order.sync_status !== 'synced' || detail.source === 'local') problems.push('Approval needs an internet connection, and the order must be synced to the cloud.');
  if (quoteC <= 0) problems.push('Set a quote amount for this order first.');
  else if (paidC < requiredC) problems.push(`A 50% downpayment is required: ${peso((requiredC - paidC) / 100)} more to go.`);
  if (offlinePayments > 0) problems.push(`${offlinePayments} payment(s) saved offline do not count until they sync.`);
  if (items.length === 0) problems.push('Add at least one material to this order.');
  else if (unlinked > 0) problems.push(`${unlinked} item(s) are not linked to a stock item.`);
  // PB 9: the server's stock check for orders that still have to reserve their materials
  if (detail.stock_check && !detail.stock_check.sufficient) {
    problems.push(...shortfallLines(detail.stock_check).map((line) => `Not enough stock: ${line}`));
  }
  return {
    quoteC, requiredC, paidC,
    percent: requiredC > 0 ? Math.min(100, Math.floor((paidC / requiredC) * 100)) : 0,
    blocking: problems.filter((p) => !p.includes('do not count until')),
    notes: problems
  };
};

export default function OrdersPage({ apiBase, token, onUnauthorized, refreshKey, onStockChanged, inventoryKey }) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);

  const [statusFilter, setStatusFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [numberFilter, setNumberFilter] = useState('');  // PB 6: find by order number
  const [numberDraft, setNumberDraft] = useState('');
  const [numberError, setNumberError] = useState('');
  const [sort, setSort] = useState(DEFAULT_SORT); // { key, dir }: sorted by the server across all pages
  const [page, setPage] = useState(0);
  const [list, setList] = useState({ orders: [], source: null, unsynced: 0 });
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [customers, setCustomers] = useState({});
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => { setLoading(true); setTick((t) => t + 1); }, []);

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [detailTick, setDetailTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState(null); // { to, label }
  const [payment, setPayment] = useState({ amount: '', payment_type: 'Cash' });
  const [result, setResult] = useState(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [shortageAlert, setShortageAlert] = useState(null); // { message, shortages, total_shortfall }
  const [editDetails, setEditDetails] = useState(null);     // { deadline, quote } while editing
  const [designDraft, setDesignDraft] = useState(null);     // string while editing the design link
  const [printLine, setPrintLine] = useState(null);         // EMPTY_PRINT_LINE shape while adding

  // Customers (names for the list)
  useEffect(() => {
    let cancelled = false;
    api('GET', '/customers').then(({ ok, data }) => {
      if (!cancelled && ok) setCustomers(Object.fromEntries((data.customers || []).map((c) => [c.customer_id, c])));
    });
    return () => { cancelled = true; };
  }, [api, refreshKey, tick]);

  // Orders page
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({
      limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), sort: sort.key, dir: sort.dir
    });
    if (statusFilter) qs.set('status', statusFilter);
    if (customerFilter) qs.set('customer_id', customerFilter);
    if (numberFilter) qs.set('tracking_no', numberFilter);
    api('GET', `/orders?${qs}`).then(({ ok, data }) => {
      if (cancelled) return;
      setLoading(false);
      if (!ok) { setListError(errorText(data, 'Could not load orders.')); return; }
      setListError('');
      setList({ orders: data.orders || [], source: data.source, unsynced: data.unsynced || 0 });
    });
    return () => { cancelled = true; };
  }, [api, page, statusFilter, customerFilter, numberFilter, sort, refreshKey, tick]);

  // Any filter / sort change starts again at page 1
  const changeFilter = (setter) => (value) => { setter(value); setPage(0); setLoading(true); };
  const setStatus = changeFilter(setStatusFilter);
  const setCustomer = changeFilter(setCustomerFilter);
  const setNumber = changeFilter(setNumberFilter);
  const setSortTo = changeFilter(setSort);
  const findNumber = (e) => {
    e.preventDefault();
    if (numberDraft.trim() === '') { setNumberError(''); setNumber(''); return; }
    const value = normalizeOrderNumber(numberDraft);
    if (!value) { setNumberError('An order number looks like XM-2026-0123.'); return; }
    setNumberError('');
    setNumberDraft(value);
    setNumber(value);
  };
  // Column header click: same column flips the direction, a new column starts at its natural direction
  const sortByColumn = (key) => setSortTo(sort.key === key
    ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: SORT_DEFAULT_DIR[key] });
  const filtersActive = statusFilter || customerFilter || numberFilter || sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir;
  const clearFilters = () => {
    setStatusFilter(''); setCustomerFilter(''); setNumberFilter(''); setNumberDraft(''); setNumberError('');
    setSort(DEFAULT_SORT); setPage(0); setLoading(true);
  };

  // Closes the detail pop-up on Escape (only when no inner dialog is open)
  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy && !result && !confirmApprove && !pendingAction && !shortageAlert) {
        setSelectedId(null); setDetail(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, busy, result, confirmApprove, pendingAction, shortageAlert]);

  // Selected order detail
  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    api('GET', `/orders/${encodeURIComponent(selectedId)}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (!ok) { setDetailError(errorText(data, 'Could not load this order.')); return; }
      setDetailError('');
      setDetail(data);
    });
    return () => { cancelled = true; };
  }, [api, selectedId, detailTick, refreshKey, inventoryKey]);

  const resetEditors = () => { setEditDetails(null); setDesignDraft(null); setPrintLine(null); };
  const openOrder = (id) => {
    resetEditors(); setDetail(null); setDetailError(''); setSelectedId(id); setPayment({ amount: '', payment_type: 'Cash' }); };
  const closeOrder = () => { setSelectedId(null); setDetail(null); };
  const customerName = (id) => customers[id]?.full_name || id || '—';

  const changeStatus = async (action) => {
    setBusy(true);
    const { ok, data } = await api('PATCH', `/orders/${encodeURIComponent(selectedId)}/status`, {
      status: action.to, expected_version: detail?.order?.version || undefined
    });
    setBusy(false);
    setPendingAction(null);
    if (!ok) {
      const shortages = (data.shortages || []).map((x) => `• ${x.item_name}: needs ${x.requested}, only ${x.available} free`).join('\n');
      setResult({ type: 'error', title: 'Status not changed', message: errorText(data, 'Could not change the status.') + (shortages ? `\n${shortages}` : '') });
    } else {
      setResult({ type: 'success', title: `Order ${action.to}`, message: data.message });
      if ((data.stock_changes || []).length > 0 && onStockChanged) onStockChanged();
    }
    setDetailTick((t) => t + 1);
    reload();
  };

  const reloadDetail = () => { setResult(null); setDetailTick((t) => t + 1); reload(); };

  // PB 13: Owner approves the job order; the server re-checks everything in one transaction
  const approveOrder = async () => {
    setBusy(true);
    const { ok, status, data } = await api('POST', `/orders/${encodeURIComponent(selectedId)}/approve`, {
      expected_version: detail?.order?.version || ''
    });
    setBusy(false);
    setConfirmApprove(false);

    if (ok) {
      const held = (data.reserved || []).map((x) => `• ${x.item_name || x.inventory_id}: ${x.quantity}`).join('\n');
      setResult({
        type: 'success',
        title: 'Job order approved',
        message: (data.newly_reserved ? 'Materials reserved:\n' : 'Materials were already reserved when the order was created:\n') + held
      });
      setDetailTick((t) => t + 1); // keep the success dialog open (reloadDetail() would clear it)
      reload();
      return;
    }

    const err = data.error;
    if (status === 409 && err === 'INSUFFICIENT_INVENTORY') {
      setShortageAlert({ message: data.message, shortages: data.shortages || [], total_shortfall: data.total_shortfall });
      return;
    }
    if (status === 402) {
      setResult({
        type: 'warning',
        title: 'Downpayment required',
        message: `${peso(data.remaining)} more is needed before this job order can be approved.\n`
          + `Paid ${peso(data.total_paid)} of the ${peso(data.required_downpayment)} required (50% of ${peso(data.total_quote_amount)}).`
          + (data.unsynced_payments > 0 ? `\n${data.unsynced_payments} payment(s) saved offline do not count yet. Sync, then try again.` : '')
      });
      return;
    }
    if (status === 409 && (err === 'EDIT_CONFLICT' || err === 'ALREADY_APPROVED')) {
      setResult({
        type: 'warning',
        title: err === 'ALREADY_APPROVED' ? 'Already approved' : 'Order changed, reload',
        message: err === 'ALREADY_APPROVED'
          ? 'Someone already approved this job order. Reload to see its current state.'
          : 'This order was changed by someone else after you opened it. Reload it, check it again, then approve.'
      });
      setDetailTick((t) => t + 1);
      return;
    }
    if (status === 409 && err === 'ORDER_LOCKED') {
      const until = data.lock?.expiresAt ? ` until ${formatDateTime(data.lock.expiresAt.replace('Z', ''), { utc: true })} at the latest` : '';
      setResult({
        type: 'warning',
        title: 'Order is being edited',
        message: `A ${data.lock?.role || 'another'} user is editing this order right now${until}. Try again when they finish.`
      });
      return;
    }
    if (status === 503 || status === 0) {
      setResult({ type: 'error', title: 'Approval needs an internet connection', message: errorText(data, 'Nothing was changed. Try again when the connection is back.') });
      return;
    }
    if (status === 403) {
      setResult({ type: 'error', title: 'Owner only', message: 'Only the Owner can approve job orders.' });
      return;
    }
    if (status === 422 && err === 'ITEMS_NOT_LINKED_TO_STOCK') {
      const n = (data.unlinked_line_item_ids || []).length;
      setResult({ type: 'warning', title: 'Materials not linked to stock', message: n ? `${n} item(s) on this order are not linked to a stock item, so their stock cannot be reserved.` : errorText(data, 'Add materials first.') });
      return;
    }
    setResult({ type: 'error', title: 'Not approved', message: errorText(data, 'Could not approve this job order.') });
  };

  const addPayment = async (e) => {
    e.preventDefault();
    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
      return setResult({ type: 'error', title: 'Check the amount', message: 'Amount must be greater than 0, with at most 2 decimal places.' });
    }
    setBusy(true);
    const { ok, data } = await api('POST', `/orders/${encodeURIComponent(selectedId)}/payments`, {
      amount: Math.round(amount * 100) / 100, payment_type: payment.payment_type
    });
    setBusy(false);
    if (!ok) return setResult({ type: 'error', title: 'Payment not saved', message: errorText(data, 'Could not record the payment.') });
    setResult({ type: 'success', title: 'Payment recorded', message: `${peso(amount)} (${payment.payment_type}) recorded. ${data.source === 'local' ? 'Saved offline; it will sync later.' : ''}` });
    setPayment({ amount: '', payment_type: payment.payment_type });
    setDetailTick((t) => t + 1);
  };

  // ---- Edit deadline / quote ----
  const saveDetails = async (e) => {
    e.preventDefault();
    const body = {};
    if (actions.edit_deadline && editDetails.deadline && editDetails.deadline !== String(detail.order.production_deadline).slice(0, 10)) body.production_deadline = editDetails.deadline;
    if (actions.edit_quote) {
      const q = editDetails.quote.trim() === '' ? 0 : Number(editDetails.quote);
      if (!Number.isFinite(q) || q < 0 || Math.abs(Math.round(q * 100) - q * 100) > 1e-6) {
        return setResult({ type: 'error', title: 'Please check the quote', message: 'The quote must be a peso amount of 0 or more, like 1500 or 1500.50.' });
      }
      if (q !== detail.order.total_quote_amount) body.total_quote_amount = Math.round(q * 100) / 100;
    }
    if (Object.keys(body).length === 0) { setEditDetails(null); return setResult({ type: 'warning', title: 'No changes', message: 'Nothing was changed, so nothing was saved.' }); }
    setBusy(true);
    const { ok, data } = await api('PATCH', `/orders/${encodeURIComponent(selectedId)}/details`, { ...body, expected_version: detail.order.version || undefined });
    setBusy(false);
    if (!ok) return setResult({ type: data.error === 'EDIT_CONFLICT' ? 'warning' : 'error', title: 'Not saved', message: errorText(data, 'The order details were not saved.') });
    setEditDetails(null);
    setResult({ type: 'success', title: 'Order updated', message: data.message });
    setDetailTick((t) => t + 1);
    reload();
  };

  // ---- Design link (Google Drive) ----
  const saveDesign = async (e) => {
    e.preventDefault();
    setBusy(true);
    const { ok, data } = await api('PATCH', `/orders/${encodeURIComponent(selectedId)}/design`, {
      design_drive_link: designDraft.trim(), expected_version: detail.order.version || undefined
    });
    setBusy(false);
    if (!ok) return setResult({ type: 'error', title: 'Design link not saved', message: errorText(data, 'The design link was not saved.') });
    setDesignDraft(null);
    setResult({ type: 'success', title: 'Design linked', message: data.message });
    setDetailTick((t) => t + 1);
  };

  // ---- Print details (size, name, number per piece) ----
  const savePrintLine = async (e) => {
    e.preventDefault();
    const qty = Number(printLine.quantity);
    if (!Number.isInteger(qty) || qty < 1) return setResult({ type: 'error', title: 'Check the quantity', message: 'The quantity must be a whole number of at least 1.' });
    setBusy(true);
    const { ok, data } = await api('POST', `/orders/${encodeURIComponent(selectedId)}/items`, {
      product_type: printLine.product_type.trim(), quantity: qty,
      size: printLine.size.trim() || undefined, custom_name: printLine.custom_name.trim() || undefined, custom_number: printLine.custom_number.trim() || undefined
    });
    setBusy(false);
    if (!ok) return setResult({ type: 'error', title: 'Not added', message: errorText(data, 'The print detail was not added.') });
    setPrintLine({ ...EMPTY_PRINT_LINE, product_type: printLine.product_type });
    setDetailTick((t) => t + 1);
  };

  const copySummary = async () => {
    const ok = await copyText(messengerSummary(detail, customers[detail.order.customer_id]));
    setResult(ok
      ? { type: 'success', title: 'Copied for Messenger', message: 'The order summary was copied. Paste it into the customer\u2019s Messenger chat.' }
      : { type: 'error', title: 'Could not copy', message: 'Your browser blocked copying.' });
  };
  const printOrder = () => {
    if (!printJobOrder(detail, customers[detail.order.customer_id])) {
      setResult({ type: 'error', title: 'Could not open the print window', message: 'Allow pop-ups for this site, then try again.' });
    }
  };

  const order = detail?.order;
  const actions = orderActions(detail);
  const hasNext = list.orders.length === PAGE_SIZE;
  const readiness = order && AWAITING_APPROVAL.includes(order.production_status) ? approvalReadiness(detail) : null;
  const stockShort = Boolean(detail?.stock_check && !detail.stock_check.sufficient);
  const footerActions = order ? actions.statuses.map(statusAction) : [];

  return (
    <div style={o.root}>
      <div style={o.topBar}>
        <div>
          <h2 style={{ fontSize: '1.25rem', margin: 0, color: '#08060d', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ClipboardList size={20} /> Order Profiles
          </h2>
          <p style={o.meta}>Every order created in Create Order appears here. Click an order to open its details.</p>
        </div>
        <button type="button" onClick={reload} style={o.btn} disabled={loading}><RefreshCw size={16} /> {loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      {/* Filter and sort controls */}
      <div style={o.toolbar} role="search" aria-label="Filter and sort orders">
        <label style={o.control}>
          <span style={o.controlLabel}>Status</span>
          <select value={statusFilter} onChange={(e) => setStatus(e.target.value)} style={o.select} aria-label="Filter by status">
            <option value="" style={o.option}>All statuses</option>
            {Object.keys(ORDER_STATUS_META).map((st) => <option key={st} value={st} style={o.option}>{st}</option>)}
          </select>
        </label>
        <label style={o.control}>
          <span style={o.controlLabel}>Customer</span>
          <select value={customerFilter} onChange={(e) => setCustomer(e.target.value)} style={o.select} aria-label="Filter by customer">
            <option value="" style={o.option}>All customers</option>
            {Object.values(customers)
              .sort((a, b) => a.full_name.localeCompare(b.full_name))
              .map((c) => <option key={c.customer_id} value={c.customer_id} style={o.option}>{c.full_name}</option>)}
          </select>
        </label>
        <label style={o.control}>
          <span style={o.controlLabel}>Sort by</span>
          <select value={`${sort.key}:${sort.dir}`} aria-label="Sort orders" style={o.select}
            onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSortTo({ key, dir }); }}>
            {SORT_OPTIONS.map((opt) => <option key={`${opt.key}:${opt.dir}`} value={`${opt.key}:${opt.dir}`} style={o.option}>{opt.label}</option>)}
            {!SORT_OPTIONS.some((opt) => opt.key === sort.key && opt.dir === sort.dir) && (
              <option value={`${sort.key}:${sort.dir}`} style={o.option}>Custom (column header)</option>
            )}
          </select>
        </label>
        <form onSubmit={findNumber} style={o.control} role="search" aria-label="Find an order by its number">
          <span style={o.controlLabel}>Order number</span>
          <span style={{ display: 'flex', gap: '0.35rem' }}>
            <input value={numberDraft} onChange={(e) => setNumberDraft(e.target.value)} placeholder="XM-2026-0123"
              aria-label="Order number" aria-invalid={Boolean(numberError)} style={{ ...o.input, flex: 1 }} />
            <button type="submit" style={o.btn} aria-label="Find order"><Search size={14} /></button>
          </span>
          {numberError && <span style={{ ...o.meta, color: '#b91c1c' }}>{numberError}</span>}
        </form>
        {filtersActive && (
          <button type="button" onClick={clearFilters} style={o.clearBtn}>Clear filters</button>
        )}
      </div>

      {list.source === 'local' && (
        <div style={{ ...o.banner, background: '#fef3c7', color: '#92400e' }}>
          <CloudOff size={16} /> Offline mode: showing orders from the local cache.
        </div>
      )}
      {listError && <div style={{ ...o.banner, background: '#fee2e2', color: '#991b1b' }}>{listError}</div>}

      <div style={o.tableWrap}>
        <table style={o.table}>
          <thead>
            <tr>
              <th style={o.th} scope="col">Order</th>
              <th style={o.th} scope="col">Customer</th>
              <SortTh label="Created" k="date_created" sort={sort} onSort={sortByColumn} />
              <SortTh label="Deadline" k="production_deadline" sort={sort} onSort={sortByColumn} />
              <SortTh label="Status" k="production_status" sort={sort} onSort={sortByColumn} />
              <SortTh label="Quote" k="total_quote_amount" sort={sort} onSort={sortByColumn} align="right" />
            </tr>
          </thead>
          <tbody>
            {!loading && list.orders.length === 0 && !listError && (
              <tr><td colSpan={6} style={o.emptyCell}>
                {numberFilter ? `No order has the number ${numberFilter}.`
                  : statusFilter || customerFilter ? 'No orders match these filters.' : 'No orders yet. Create one in the Create Order tab.'}
              </td></tr>
            )}
            {list.orders.map((ord) => {
              const meta = ORDER_STATUS_META[ord.production_status] || ORDER_STATUS_META.Pending;
              return (
                <tr key={ord.order_id} onClick={() => openOrder(ord.order_id)} style={o.row} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') openOrder(ord.order_id); }}>
                  <td style={o.td}><code style={o.code}>{orderNumber(ord)}</code>{ord.sync_status !== 'synced' && <span style={o.pending}>pending sync</span>}</td>
                  <td style={o.td}>{customerName(ord.customer_id)}</td>
                  <td style={o.td}>{formatDateTime(ord.date_created, { utc: true })}</td>
                  <td style={o.td}>{formatDateTime(ord.production_deadline, { withTime: false })}</td>
                  <td style={o.td}><span style={{ ...o.badge, background: meta.bg, color: meta.color }}>{ord.production_status}</span></td>
                  <td style={o.tdNum}>{peso(ord.total_quote_amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(page > 0 || hasNext) && (
        <div style={o.pager}>
          <button type="button" style={o.btn} onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}><ChevronLeft size={14} /> Prev</button>
          <span style={o.meta}>Page {page + 1}</span>
          <button type="button" style={o.btn} onClick={() => setPage((p) => p + 1)} disabled={!hasNext}>Next <ChevronRight size={14} /></button>
        </div>
      )}

      {/* Order detail window */}
      {selectedId && (
        <div style={o.overlay} onClick={busy ? undefined : closeOrder}>
          <section role="dialog" aria-modal="true" aria-labelledby="order-detail-title" style={o.modal} onClick={(e) => e.stopPropagation()}>
            <div style={o.modalHead}>
              <h3 id="order-detail-title" style={{ margin: 0, fontSize: '1.15rem', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                Order <code style={o.code}>{order ? orderNumber(order) : '…'}</code>
                {order && (
                  <span style={{ ...o.badge, background: (ORDER_STATUS_META[order.production_status] || ORDER_STATUS_META.Pending).bg, color: (ORDER_STATUS_META[order.production_status] || ORDER_STATUS_META.Pending).color }}>
                    {order.production_status}
                  </span>
                )}
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                {order && (
                  <>
                    <button type="button" onClick={copySummary} style={o.headBtn} title="Copy a summary to paste in Messenger"><Copy size={14} /> Copy for Messenger</button>
                    <button type="button" onClick={printOrder} style={o.headBtn} title="Print a job order for production"><Printer size={14} /> Print</button>
                  </>
                )}
                <button type="button" onClick={closeOrder} style={o.close} aria-label="Close" disabled={busy}><X size={18} /></button>
              </div>
            </div>

            {detailError && <p style={{ ...o.banner, background: '#fee2e2', color: '#991b1b' }}>{detailError}</p>}
            {!detail && !detailError && <p style={o.meta}>Loading…</p>}

            {order && (
              <div style={{ overflowY: 'auto' }}>
                <div style={o.infoGrid}>
                  <Info label="Customer" value={customerName(order.customer_id)} sub={customers[order.customer_id]?.contact_number} />
                  <Info label="Stock" value={order.stock_reserved ? 'Reserved' : 'Not reserved'}
                    sub={order.stock_reserved ? 'Materials are held for this order' : 'Reserved on approval / resume'} />
                  <Info label="Created" value={formatDateTime(order.date_created, { utc: true })} />
                  <Info label="Deadline" value={formatDateTime(order.production_deadline, { withTime: false })} />
                  <Info label="Quote" value={peso(order.total_quote_amount)} />
                  <Info label="Paid / Balance" value={`${peso(detail.totals.total_paid)} / ${peso(detail.totals.balance)}`} />
                  {order.approved_at && (
                    <Info label="Approved" value={formatDateTime(order.approved_at, { utc: true })} sub="by the Owner" />
                  )}
                </div>
                <p style={{ ...o.meta, margin: '0.25rem 0 1rem' }}>
                  {hasOrderNumber(order) ? <>Order number <strong>{order.tracking_no}</strong>. </> : `${NUMBER_AFTER_SYNC} `}
                  Internal ID: <code style={o.code}>{order.order_id}</code>
                </p>

                {/* Edit deadline / quote (the quote by the Owner only) */}
                {(actions.edit_deadline || actions.edit_quote) && (
                  editDetails ? (
                    <form onSubmit={saveDetails} style={o.editBox}>
                      {actions.edit_deadline && (
                        <label style={o.control}>
                          <span style={o.controlLabel}>Deadline</span>
                          <input type="date" min={todayInManila()} value={editDetails.deadline} required style={o.input}
                            onChange={(e) => setEditDetails({ ...editDetails, deadline: e.target.value })} />
                        </label>
                      )}
                      {actions.edit_quote && (
                        <label style={o.control}>
                          <span style={o.controlLabel}>Quote (₱)</span>
                          <input type="number" min="0" step="0.01" inputMode="decimal" value={editDetails.quote} style={o.input}
                            onChange={(e) => setEditDetails({ ...editDetails, quote: e.target.value })} />
                        </label>
                      )}
                      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-end' }}>
                        <button type="button" style={o.btn} onClick={() => setEditDetails(null)} disabled={busy}>Cancel</button>
                        <button type="submit" style={o.btnPrimary} disabled={busy}>Save</button>
                      </div>
                      {!actions.edit_quote && (
                        <p style={{ ...o.meta, flexBasis: '100%' }}>
                          {['Pending', 'Delayed'].includes(order.production_status)
                            ? 'Only the Owner can change the quote.'
                            : 'The quote cannot change after approval, because the downpayment was based on it.'}
                        </p>
                      )}
                    </form>
                  ) : (
                    <button type="button" style={o.linkBtn} onClick={() => setEditDetails({
                      deadline: String(order.production_deadline).slice(0, 10) < todayInManila() ? todayInManila() : String(order.production_deadline).slice(0, 10),
                      quote: String(order.total_quote_amount ?? 0)
                    })}>
                      <Pencil size={14} /> {actions.edit_quote ? 'Edit deadline / quote' : 'Edit deadline'}
                    </button>
                  )
                )}

                {/* Design file */}
                <div style={o.designRow}>
                  <Link2 size={16} color="#475569" />
                  {designDraft !== null ? (
                    <form onSubmit={saveDesign} style={{ display: 'flex', gap: '0.4rem', flex: 1, flexWrap: 'wrap' }}>
                      <input type="url" value={designDraft} onChange={(e) => setDesignDraft(e.target.value)} required autoFocus
                        placeholder="https://drive.google.com/…" style={{ ...o.input, flex: '1 1 240px' }} />
                      <button type="button" style={o.btn} onClick={() => setDesignDraft(null)} disabled={busy}>Cancel</button>
                      <button type="submit" style={o.btnPrimary} disabled={busy}>Save link</button>
                    </form>
                  ) : (
                    <>
                      {order.design_drive_link
                        ? <a href={order.design_drive_link} target="_blank" rel="noopener noreferrer" style={o.link}>Open design file (Google Drive)</a>
                        : <span style={o.meta}>No design file linked yet.</span>}
                      {actions.link_design && (
                        <button type="button" style={o.linkBtn} onClick={() => setDesignDraft(order.design_drive_link || '')}>
                          {order.design_drive_link ? 'Change' : 'Link design file'}
                        </button>
                      )}
                    </>
                  )}
                </div>

                <h4 style={o.h4}>Materials ({detail.totals.item_count} line{detail.totals.item_count === 1 ? '' : 's'}, {detail.totals.total_quantity} total)</h4>
                {detail.items.length === 0 ? <p style={o.meta}>No materials on this order.</p> : (
                  <table style={o.table}>
                    <thead><tr><th style={o.th}>Material</th><th style={o.th}>Details</th><th style={o.thNum}>Qty</th></tr></thead>
                    <tbody>
                      {detail.items.map((it) => (
                        <tr key={it.line_item_id}>
                          <td style={o.td}>
                            {it.product_type}
                            {!it.inventory_id && <span style={o.unlinked}>not linked to stock</span>}
                          </td>
                          <td style={o.td}>{[it.size, it.custom_name, it.custom_number].filter(Boolean).join(' · ') || '—'}</td>
                          <td style={o.tdNum}>{it.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td style={o.tfoot} colSpan={2}>Total quantity</td>
                        <td style={o.tfootNum}>{detail.totals.total_quantity}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}

                {actions.add_items && (
                  printLine ? (
                    <form onSubmit={savePrintLine} style={o.editBox}>
                      <label style={{ ...o.control, flex: '2 1 160px' }}>
                        <span style={o.controlLabel}>What</span>
                        <input value={printLine.product_type} required maxLength={100} style={o.input}
                          onChange={(e) => setPrintLine({ ...printLine, product_type: e.target.value })} />
                      </label>
                      <label style={{ ...o.control, flex: '0 1 70px' }}>
                        <span style={o.controlLabel}>Qty</span>
                        <input type="number" min="1" step="1" value={printLine.quantity} required style={o.input}
                          onChange={(e) => setPrintLine({ ...printLine, quantity: e.target.value })} />
                      </label>
                      <label style={{ ...o.control, flex: '0 1 80px' }}>
                        <span style={o.controlLabel}>Size</span>
                        <input value={printLine.size} maxLength={50} placeholder="M" style={o.input}
                          onChange={(e) => setPrintLine({ ...printLine, size: e.target.value })} />
                      </label>
                      <label style={{ ...o.control, flex: '1 1 120px' }}>
                        <span style={o.controlLabel}>Name</span>
                        <input value={printLine.custom_name} maxLength={255} placeholder="DELA CRUZ" style={o.input}
                          onChange={(e) => setPrintLine({ ...printLine, custom_name: e.target.value })} />
                      </label>
                      <label style={{ ...o.control, flex: '0 1 70px' }}>
                        <span style={o.controlLabel}>No.</span>
                        <input value={printLine.custom_number} maxLength={50} placeholder="7" style={o.input}
                          onChange={(e) => setPrintLine({ ...printLine, custom_number: e.target.value })} />
                      </label>
                      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-end' }}>
                        <button type="button" style={o.btn} onClick={() => setPrintLine(null)} disabled={busy}>Done</button>
                        <button type="submit" style={o.btnPrimary} disabled={busy}>Add</button>
                      </div>
                      <p style={{ ...o.meta, flexBasis: '100%' }}>Print details (sizes, names, numbers) do not use stock. Add one line per piece, or one line per size with its quantity.</p>
                    </form>
                  ) : (
                    <button type="button" style={o.linkBtn} onClick={() => setPrintLine(EMPTY_PRINT_LINE)}>
                      <Shirt size={14} /> Add print details (size / name / number)
                    </button>
                  )
                )}

                <h4 style={o.h4}>Payments</h4>
                {detail.payments.length === 0 ? <p style={o.meta}>No payments yet.</p> : (
                  <table style={o.table}>
                    <thead><tr><th style={o.th}>Date</th><th style={o.th}>Type</th><th style={o.thNum}>Amount</th></tr></thead>
                    <tbody>
                      {detail.payments.map((p) => (
                        <tr key={p.payment_id}>
                          <td style={o.td}>
                            {formatDateTime(p.payment_date, { utc: true })}
                            {p.sync_status !== 'synced' && <span style={o.pending}>offline</span>}
                          </td>
                          <td style={o.td}>{p.payment_type}</td>
                          <td style={o.tdNum}>{peso(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td style={o.tfoot} colSpan={2}>Total paid</td>
                        <td style={o.tfootNum}>{peso(detail.totals.total_paid)}</td>
                      </tr>
                      <tr>
                        <td style={{ ...o.tfoot, borderTop: 'none', fontWeight: 'normal' }} colSpan={2}>Balance</td>
                        <td style={{ ...o.tfootNum, borderTop: 'none', color: detail.totals.balance > 0 ? '#b91c1c' : '#166534' }}>{peso(detail.totals.balance)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
                {actions.record_payment && (
                  <form onSubmit={addPayment} style={o.payForm}>
                    <input type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="Amount (₱)" required
                      value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} style={{ ...o.input, flex: 2 }} />
                    <select value={payment.payment_type} onChange={(e) => setPayment({ ...payment, payment_type: e.target.value })} style={{ ...o.input, flex: 1 }}>
                      {PAYMENT_TYPES.map((t) => <option key={t} value={t} style={o.option}>{t}</option>)}
                    </select>
                    <button type="submit" style={o.btnPrimary} disabled={busy}><Wallet size={16} /> Add Payment</button>
                  </form>
                )}

                {readiness && (
                  <section style={o.approvalBox} aria-labelledby="approval-title">
                    <h4 id="approval-title" style={{ ...o.h4, margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <ShieldCheck size={18} color="#115e59" /> Job order approval
                    </h4>
                    {readiness.quoteC > 0 ? (
                      <>
                        <p style={o.progressText}>
                          {peso(readiness.paidC / 100)} of {peso(readiness.requiredC / 100)} required (50%)
                        </p>
                        <div style={o.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readiness.percent}
                          aria-label="Downpayment progress">
                          <div style={{ ...o.progressFill, width: `${readiness.percent}%`, background: readiness.paidC >= readiness.requiredC ? '#10b981' : '#f59e0b' }} />
                        </div>
                      </>
                    ) : (
                      <p style={o.progressText}>No quote yet</p>
                    )}
                    <p style={{ ...o.meta, margin: '0.4rem 0 0' }}>
                      {order.stock_reserved ? 'Materials are already reserved for this order.' : 'Approving will reserve this order\u2019s materials.'}
                    </p>
                    {readiness.notes.length > 0 && (
                      <ul style={o.problemList}>
                        {readiness.notes.map((n) => <li key={n}>{n}</li>)}
                      </ul>
                    )}
                    {!actions.approve && (
                      <p style={{ ...o.meta, marginTop: '0.6rem' }}>Waiting for the Owner to approve this job order before printing can start.</p>
                    )}
                  </section>
                )}

                {order.sync_status !== 'synced' && (
                  <p style={{ ...o.meta, marginTop: '0.75rem' }}>This order was saved offline. Status changes are available once it syncs.</p>
                )}
              </div>
            )}

            {/* Actions stay visible at the bottom of the pop-up while the details scroll */}
            {order && ((readiness && actions.approve) || footerActions.length > 0) && (
              <div style={o.modalFoot}>
                {readiness && actions.approve && (
                  <button type="button" style={{ ...o.btnApprove, ...(readiness.blocking.length || busy ? o.btnDisabled : {}) }}
                    disabled={busy || readiness.blocking.length > 0}
                    title={readiness.blocking[0] || 'Approve this job order'}
                    onClick={() => setConfirmApprove(true)}>
                    <ShieldCheck size={16} /> Approve Job Order
                  </button>
                )}
                {readiness && actions.approve && readiness.blocking.length > 0 && (
                  <span style={o.footHint}>{readiness.blocking[0]}</span>
                )}
                {footerActions.length > 0 && (
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginLeft: 'auto' }}>
                    {footerActions.map((action) => {
                      // PB 9: Resume reserves stock, so it is greyed out while the free stock is short
                      const blocked = action.to === 'Pending' && stockShort;
                      return (
                        <button key={action.to} type="button" disabled={busy || blocked}
                          title={blocked ? `Not enough stock to resume: ${shortfallLines(detail.stock_check)[0] || ''}` : action.label}
                          onClick={() => (action.danger ? setPendingAction(action) : changeStatus(action))}
                          style={{ ...(action.danger ? o.btnDanger : o.btnPrimary), ...(blocked ? o.btnDisabled : {}) }}>
                          <action.Icon size={16} /> {action.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingAction)}
        title="Cancel this order?"
        message={order?.stock_reserved ? 'The order will be marked Cancelled and its reserved materials returned to stock.' : 'The order will be marked Cancelled.'}
        confirmLabel="Cancel Order"
        danger
        busy={busy}
        onConfirm={() => changeStatus(pendingAction)}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={confirmApprove}
        title="Approve this job order?"
        message={order?.stock_reserved
          ? 'The order moves to Approved and printing can start. Its materials are already reserved.'
          : 'The order moves to Approved and its materials are reserved from stock now.'}
        confirmLabel="Approve Job Order"
        busy={busy}
        onConfirm={approveOrder}
        onCancel={() => setConfirmApprove(false)}
      />

      {shortageAlert && (
        <div style={{ ...o.overlay, zIndex: 100 }} onClick={() => setShortageAlert(null)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="approve-shortage-title" style={o.shortageCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <TriangleAlert size={22} color="#92400e" />
              <h3 id="approve-shortage-title" style={{ fontSize: '1.15rem', margin: 0, color: '#92400e' }}>Not enough stock to approve</h3>
            </div>
            <p style={{ fontSize: '0.875rem', color: '#334155', margin: '0 0 0.75rem' }}>
              {shortageAlert.message || 'Not enough free stock to approve this job order. Nothing was reserved.'}
            </p>
            <table style={o.table}>
              <thead>
                <tr>
                  <th style={o.th}>Material</th>
                  <th style={o.thNum}>Requested</th>
                  <th style={o.thNum}>Available</th>
                  <th style={o.thNum}>Shortfall</th>
                </tr>
              </thead>
              <tbody>
                {shortageAlert.shortages.map((s) => (
                  <tr key={s.inventory_id}>
                    <td style={o.td}>{s.item_name || s.inventory_id}</td>
                    <td style={o.tdNum}>{s.requested}</td>
                    <td style={o.tdNum}>{s.available}</td>
                    <td style={{ ...o.tdNum, color: '#991b1b', fontWeight: 'bold' }}>-{s.shortfall ?? Math.max(0, s.requested - s.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
              <button type="button" style={o.btnPrimary} onClick={() => setShortageAlert(null)} autoFocus>OK</button>
            </div>
          </div>
        </div>
      )}

      <ResultDialog result={result} onClose={() => setResult(null)}
        actionLabel={result?.title === 'Order changed, reload' || result?.title === 'Already approved' ? 'Reload order' : undefined}
        onAction={reloadDetail} />
    </div>
  );
}

// Sortable column header: a real <th> with aria-sort, its label is a button
function SortTh({ label, k, sort, onSort, align = 'left' }) {
  const active = sort.key === k;
  const Arrow = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th scope="col" style={align === 'right' ? o.thNum : o.th}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(k)} style={{ ...o.sortBtn, justifyContent: align === 'right' ? 'flex-end' : 'flex-start', ...(active ? { color: '#4f46e5' } : {}) }}>
        {label} <Arrow size={12} style={active ? undefined : { opacity: 0.4 }} />
      </button>
    </th>
  );
}

function Info({ label, value, sub }) {
  return (
    <div style={o.info}>
      <span style={o.infoLabel}>{label}</span>
      <span style={o.infoValue}>{value}</span>
      {sub && <span style={o.meta}>{sub}</span>}
    </div>
  );
}

const control = { color: '#0f172a', backgroundColor: '#fff', colorScheme: 'light' };

const o = {
  root: { textAlign: 'left' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' },
  meta: { fontSize: '0.8rem', color: '#64748b', margin: '0.25rem 0 0' },
  banner: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem', borderRadius: '0.375rem', marginBottom: '1rem', fontSize: '0.875rem' },
  select: { ...control, width: '100%', padding: '0.5rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', fontSize: '0.875rem' },
  tfoot: { padding: '0.6rem', color: '#0f172a', fontWeight: 'bold', borderTop: '2px solid #e2e8f0' },
  tfootNum: { padding: '0.6rem', color: '#0f172a', fontWeight: 'bold', borderTop: '2px solid #e2e8f0', textAlign: 'right', whiteSpace: 'nowrap' },
  option: { color: '#0f172a', backgroundColor: '#fff' },
  input: { ...control, padding: '0.55rem 0.7rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', fontSize: '0.875rem', minWidth: 0 },
  btn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.875rem' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', background: '#4f46e5', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', color: '#fff', fontWeight: 'bold', fontSize: '0.85rem' },
  btnDanger: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', background: '#fff', border: '1px solid #fecaca', borderRadius: '0.375rem', cursor: 'pointer', color: '#b91c1c', fontWeight: 'bold', fontSize: '0.85rem' },
  tableWrap: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', marginBottom: '0.5rem' },
  th: { textAlign: 'left', padding: '0.6rem', borderBottom: '1px solid #e2e8f0', color: '#334155', whiteSpace: 'nowrap' },
  thNum: { textAlign: 'right', padding: '0.6rem', borderBottom: '1px solid #e2e8f0', color: '#334155' },
  td: { padding: '0.6rem', borderBottom: '1px solid #f1f5f9', color: '#0f172a' },
  tdNum: { padding: '0.6rem', borderBottom: '1px solid #f1f5f9', color: '#0f172a', textAlign: 'right', whiteSpace: 'nowrap' },
  row: { cursor: 'pointer' },
  emptyCell: { padding: '2rem', textAlign: 'center', color: '#64748b' },
  code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.8rem', background: '#f1f5f9', padding: '0.1rem 0.35rem', borderRadius: '0.25rem', color: '#334155' },
  badge: { display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.7rem', fontWeight: 'bold', textTransform: 'uppercase' },
  pending: { marginLeft: '0.4rem', padding: '0.05rem 0.4rem', background: '#e0e7ff', color: '#4f46e5', borderRadius: '999px', fontSize: '0.65rem', fontWeight: 'bold' },
  pager: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.75rem' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 },
  modal: { background: '#fff', borderRadius: '0.5rem', borderTop: '4px solid #4f46e5', padding: '1.25rem', width: '100%', maxWidth: '680px', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.25)', textAlign: 'left' },
  modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  close: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  infoGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' },
  info: { display: 'flex', flexDirection: 'column', gap: '0.15rem', padding: '0.6rem', background: '#f8fafc', borderRadius: '0.375rem' },
  infoLabel: { fontSize: '0.7rem', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' },
  infoValue: { fontSize: '0.95rem', color: '#0f172a', fontWeight: 'bold' },
  h4: { fontSize: '0.95rem', margin: '1rem 0 0.5rem', color: '#0f172a' },
  payForm: { display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' },
  toolbar: { display: 'flex', alignItems: 'flex-end', gap: '0.75rem', flexWrap: 'wrap', padding: '0.75rem', marginBottom: '1rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.5rem' },
  control: { display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: '1 1 170px', minWidth: 0 },
  controlLabel: { fontSize: '0.7rem', fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em' },
  clearBtn: { padding: '0.5rem 0.75rem', background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.85rem' },
  sortBtn: { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', width: '100%', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', font: 'inherit', fontWeight: 'bold' },
  unlinked: { marginLeft: '0.4rem', padding: '0.05rem 0.4rem', background: '#fef3c7', color: '#92400e', borderRadius: '999px', fontSize: '0.65rem', fontWeight: 'bold' },
  approvalBox: { marginTop: '1rem', padding: '0.85rem', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: '0.5rem' },
  progressText: { margin: 0, fontSize: '0.9rem', fontWeight: 'bold', color: '#0f172a' },
  progressTrack: { height: '8px', background: '#e2e8f0', borderRadius: '999px', overflow: 'hidden', marginTop: '0.4rem' },
  progressFill: { height: '100%', borderRadius: '999px', transition: 'width 0.3s' },
  problemList: { margin: '0.5rem 0 0', paddingLeft: '1.1rem', fontSize: '0.8rem', color: '#92400e', lineHeight: 1.5 },
  modalFoot: { display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid #e2e8f0' },
  footHint: { fontSize: '0.78rem', color: '#92400e', flex: '1 1 180px' },
  btnApprove: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', background: '#0f766e', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', color: '#fff', fontWeight: 'bold', fontSize: '0.85rem' },
  btnDisabled: { background: '#94a3b8', cursor: 'not-allowed' },
  headBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.6rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#334155', fontWeight: 'bold', fontSize: '0.75rem' },
  linkBtn: { display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.25rem 0', background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.82rem' },
  editBox: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end', padding: '0.75rem', margin: '0.25rem 0 0.75rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '0.5rem' },
  designRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', margin: '0.5rem 0 0.25rem' },
  link: { color: '#2563eb', fontWeight: 'bold', fontSize: '0.85rem' },
  shortageCard: { background: '#fff', borderRadius: '0.5rem', borderTop: '4px solid #f59e0b', padding: '1.25rem', width: '100%', maxWidth: '520px', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.25)', textAlign: 'left' }
};

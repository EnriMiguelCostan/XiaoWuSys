import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, ClipboardList, X, ChevronLeft, ChevronRight, CloudOff, Printer, CircleCheck, CircleX, RotateCcw, Wallet,
  ShieldCheck, TriangleAlert, ArrowUp, ArrowDown, ArrowUpDown
} from 'lucide-react';
import { createApi, errorText, peso, formatDateTime } from './api';
import { ResultDialog, ConfirmDialog } from './Dialogs';

// Orders tab: every order profile, newest first, with its materials, payments and status.
//   GET   /api/orders?status=&limit=&offset=      list
//   GET   /api/orders/:id                         detail (items, payments, totals)
//   POST  /api/orders/:id/approve                 Owner only: Pending/Delayed -> Approved (PB 13)
//   PATCH /api/orders/:id/status                  Approved -> Printing -> Completed, Cancel, resume Delayed
//   POST  /api/orders/:id/payments                record a payment
// Status changes move stock (reserve on approval, release on Cancel, consume on Complete),
// and the Catalog updates by itself through the real-time push.

const PAGE_SIZE = 20;
const WRITE_ROLES = ['Owner', 'Admin', 'Production'];
const PAYMENT_TYPES = ['Cash', 'GCash', 'Bank Transfer'];
const APPROVABLE = ['Pending', 'Delayed'];

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

// Must match STATUS_TRANSITIONS in Backend/routes/orders.js.
// Pending -> Approved is not a status change: it is the Owner-only Approve Job Order button.
const ACTIONS = {
  Pending: [{ to: 'Cancelled', label: 'Cancel Order', Icon: CircleX, danger: true }],
  Approved: [{ to: 'Printing', label: 'Start Printing', Icon: Printer }, { to: 'Cancelled', label: 'Cancel Order', Icon: CircleX, danger: true }],
  Printing: [{ to: 'Completed', label: 'Mark Completed', Icon: CircleCheck }, { to: 'Cancelled', label: 'Cancel Order', Icon: CircleX, danger: true }],
  Delayed: [{ to: 'Pending', label: 'Resume (reserve stock)', Icon: RotateCcw }, { to: 'Cancelled', label: 'Cancel Order', Icon: CircleX, danger: true }],
  Completed: [],
  Cancelled: []
};

const shortId = (id) => (id ? String(id).slice(0, 8).toUpperCase() : '—');
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
  return {
    quoteC, requiredC, paidC,
    percent: requiredC > 0 ? Math.min(100, Math.floor((paidC / requiredC) * 100)) : 0,
    blocking: problems.filter((p) => !p.includes('do not count until')),
    notes: problems
  };
};

export default function OrdersPage({ apiBase, token, userRole, onUnauthorized, refreshKey, onStockChanged }) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);
  const canWrite = WRITE_ROLES.includes(userRole);
  const isOwner = userRole === 'Owner'; // UI only; the server enforces Owner-only approval

  const [statusFilter, setStatusFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
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
    api('GET', `/orders?${qs}`).then(({ ok, data }) => {
      if (cancelled) return;
      setLoading(false);
      if (!ok) { setListError(errorText(data, 'Could not load orders.')); return; }
      setListError('');
      setList({ orders: data.orders || [], source: data.source, unsynced: data.unsynced || 0 });
    });
    return () => { cancelled = true; };
  }, [api, page, statusFilter, customerFilter, sort, refreshKey, tick]);

  // Any filter / sort change starts again at page 1
  const changeFilter = (setter) => (value) => { setter(value); setPage(0); setLoading(true); };
  const setStatus = changeFilter(setStatusFilter);
  const setCustomer = changeFilter(setCustomerFilter);
  const setSortTo = changeFilter(setSort);
  // Column header click: same column flips the direction, a new column starts at its natural direction
  const sortByColumn = (key) => setSortTo(sort.key === key
    ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: SORT_DEFAULT_DIR[key] });
  const filtersActive = statusFilter || customerFilter || sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir;
  const clearFilters = () => { setStatusFilter(''); setCustomerFilter(''); setSort(DEFAULT_SORT); setPage(0); setLoading(true); };

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
  }, [api, selectedId, detailTick, refreshKey]);

  const openOrder = (id) => { setDetail(null); setDetailError(''); setSelectedId(id); setPayment({ amount: '', payment_type: 'Cash' }); };
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

  const order = detail?.order;
  const hasNext = list.orders.length === PAGE_SIZE;
  const readiness = order && APPROVABLE.includes(order.production_status) ? approvalReadiness(detail) : null;

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
                {statusFilter || customerFilter ? 'No orders match these filters.' : 'No orders yet. Create one in the Create Order tab.'}
              </td></tr>
            )}
            {list.orders.map((ord) => {
              const meta = ORDER_STATUS_META[ord.production_status] || ORDER_STATUS_META.Pending;
              return (
                <tr key={ord.order_id} onClick={() => openOrder(ord.order_id)} style={o.row} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') openOrder(ord.order_id); }}>
                  <td style={o.td}><code style={o.code}>#{shortId(ord.order_id)}</code>{ord.sync_status !== 'synced' && <span style={o.pending}>pending sync</span>}</td>
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
                Order <code style={o.code}>#{shortId(selectedId)}</code>
                {order && (
                  <span style={{ ...o.badge, background: (ORDER_STATUS_META[order.production_status] || ORDER_STATUS_META.Pending).bg, color: (ORDER_STATUS_META[order.production_status] || ORDER_STATUS_META.Pending).color }}>
                    {order.production_status}
                  </span>
                )}
              </h3>
              <button type="button" onClick={closeOrder} style={o.close} aria-label="Close" disabled={busy}><X size={18} /></button>
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
                <p style={{ ...o.meta, margin: '0.25rem 0 1rem' }}>Full order ID: <code style={o.code}>{order.order_id}</code></p>

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
                {canWrite && order.production_status !== 'Cancelled' && (
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
                    {!isOwner && (
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
            {order && ((readiness && isOwner) || (canWrite && (ACTIONS[order.production_status] || []).length > 0)) && (
              <div style={o.modalFoot}>
                {readiness && isOwner && (
                  <button type="button" style={{ ...o.btnApprove, ...(readiness.blocking.length || busy ? o.btnDisabled : {}) }}
                    disabled={busy || readiness.blocking.length > 0}
                    title={readiness.blocking[0] || 'Approve this job order'}
                    onClick={() => setConfirmApprove(true)}>
                    <ShieldCheck size={16} /> Approve Job Order
                  </button>
                )}
                {readiness && isOwner && readiness.blocking.length > 0 && (
                  <span style={o.footHint}>{readiness.blocking[0]}</span>
                )}
                {canWrite && (
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginLeft: 'auto' }}>
                    {(ACTIONS[order.production_status] || []).map((action) => (
                      <button key={action.to} type="button" disabled={busy}
                        onClick={() => (action.danger ? setPendingAction(action) : changeStatus(action))}
                        style={action.danger ? o.btnDanger : o.btnPrimary}>
                        <action.Icon size={16} /> {action.label}
                      </button>
                    ))}
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
  shortageCard: { background: '#fff', borderRadius: '0.5rem', borderTop: '4px solid #f59e0b', padding: '1.25rem', width: '100%', maxWidth: '520px', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.25)', textAlign: 'left' }
};

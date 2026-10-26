import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ClipboardList, X, ChevronLeft, ChevronRight, CloudOff, Printer, CircleCheck, CircleX, RotateCcw, Wallet } from 'lucide-react';
import { createApi, errorText, peso, formatDateTime } from './api';
import { ResultDialog, ConfirmDialog } from './Dialogs';

// Orders tab: every order profile, newest first, with its materials, payments and status.
//   GET   /api/orders?status=&limit=&offset=      list
//   GET   /api/orders/:id                         detail (items, payments, totals)
//   PATCH /api/orders/:id/status                  Pending -> Printing -> Completed, Cancel, resume Delayed
//   POST  /api/orders/:id/payments                record a payment
// Status changes move stock (release on Cancel, consume on Complete), and the Catalog
// updates by itself through the real-time push.

const PAGE_SIZE = 20;
const WRITE_ROLES = ['Owner', 'Admin', 'Production'];
const PAYMENT_TYPES = ['Cash', 'GCash', 'Bank Transfer'];

export const ORDER_STATUS_META = {
  Pending: { bg: '#e0e7ff', color: '#3730a3' },
  Printing: { bg: '#dbeafe', color: '#1e40af' },
  Completed: { bg: '#dcfce7', color: '#166534' },
  Delayed: { bg: '#fef3c7', color: '#92400e' },
  Cancelled: { bg: '#fee2e2', color: '#991b1b' }
};

// Must match STATUS_TRANSITIONS in Backend/routes/orders.js
const ACTIONS = {
  Pending: [{ to: 'Printing', label: 'Start Printing', Icon: Printer }, { to: 'Cancelled', label: 'Cancel Order', Icon: CircleX, danger: true }],
  Printing: [{ to: 'Completed', label: 'Mark Completed', Icon: CircleCheck }, { to: 'Cancelled', label: 'Cancel Order', Icon: CircleX, danger: true }],
  Delayed: [{ to: 'Pending', label: 'Resume (reserve stock)', Icon: RotateCcw }, { to: 'Cancelled', label: 'Cancel Order', Icon: CircleX, danger: true }],
  Completed: [],
  Cancelled: []
};

const shortId = (id) => (id ? String(id).slice(0, 8).toUpperCase() : '—');

export default function OrdersPage({ apiBase, token, userRole, onUnauthorized, refreshKey, onStockChanged }) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);
  const canWrite = WRITE_ROLES.includes(userRole);

  const [statusFilter, setStatusFilter] = useState('');
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
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    if (statusFilter) qs.set('status', statusFilter);
    api('GET', `/orders?${qs}`).then(({ ok, data }) => {
      if (cancelled) return;
      setLoading(false);
      if (!ok) { setListError(errorText(data, 'Could not load orders.')); return; }
      setListError('');
      setList({ orders: data.orders || [], source: data.source, unsynced: data.unsynced || 0 });
    });
    return () => { cancelled = true; };
  }, [api, page, statusFilter, refreshKey, tick]);

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

  return (
    <div style={o.root}>
      <div style={o.topBar}>
        <div>
          <h2 style={{ fontSize: '1.25rem', margin: 0, color: '#08060d', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ClipboardList size={20} /> Order Profiles
          </h2>
          <p style={o.meta}>Every order created in Create Order appears here, newest first. Click an order to see its details.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }} style={o.select} aria-label="Filter by status">
            <option value="" style={o.option}>All statuses</option>
            {Object.keys(ORDER_STATUS_META).map((st) => <option key={st} value={st} style={o.option}>{st}</option>)}
          </select>
          <button type="button" onClick={reload} style={o.btn} disabled={loading}><RefreshCw size={16} /> {loading ? 'Loading…' : 'Refresh'}</button>
        </div>
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
              <th style={o.th}>Order</th>
              <th style={o.th}>Customer</th>
              <th style={o.th}>Created</th>
              <th style={o.th}>Deadline</th>
              <th style={o.th}>Status</th>
              <th style={o.thNum}>Quote</th>
            </tr>
          </thead>
          <tbody>
            {!loading && list.orders.length === 0 && !listError && (
              <tr><td colSpan={6} style={o.emptyCell}>No orders yet{statusFilter ? ` with status ${statusFilter}` : ''}. Create one in the Create Order tab.</td></tr>
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
              <h3 id="order-detail-title" style={{ margin: 0, fontSize: '1.15rem', color: '#0f172a' }}>
                Order <code style={o.code}>#{shortId(selectedId)}</code>
              </h3>
              <button type="button" onClick={closeOrder} style={o.close} aria-label="Close" disabled={busy}><X size={18} /></button>
            </div>

            {detailError && <p style={{ ...o.banner, background: '#fee2e2', color: '#991b1b' }}>{detailError}</p>}
            {!detail && !detailError && <p style={o.meta}>Loading…</p>}

            {order && (
              <div style={{ overflowY: 'auto' }}>
                <div style={o.infoGrid}>
                  <Info label="Customer" value={customerName(order.customer_id)} sub={customers[order.customer_id]?.contact_number} />
                  <Info label="Status" value={<span style={{ ...o.badge, background: (ORDER_STATUS_META[order.production_status] || ORDER_STATUS_META.Pending).bg, color: (ORDER_STATUS_META[order.production_status] || ORDER_STATUS_META.Pending).color }}>{order.production_status}</span>}
                    sub={order.stock_reserved ? 'Materials reserved' : 'No stock reserved'} />
                  <Info label="Created" value={formatDateTime(order.date_created, { utc: true })} />
                  <Info label="Deadline" value={formatDateTime(order.production_deadline, { withTime: false })} />
                  <Info label="Quote" value={peso(order.total_quote_amount)} />
                  <Info label="Paid / Balance" value={`${peso(detail.totals.total_paid)} / ${peso(detail.totals.balance)}`} />
                </div>
                <p style={{ ...o.meta, margin: '0.25rem 0 1rem' }}>Full order ID: <code style={o.code}>{order.order_id}</code></p>

                <h4 style={o.h4}>Materials ({detail.totals.item_count} line{detail.totals.item_count === 1 ? '' : 's'}, {detail.totals.total_quantity} total)</h4>
                {detail.items.length === 0 ? <p style={o.meta}>No materials on this order.</p> : (
                  <table style={o.table}>
                    <thead><tr><th style={o.th}>Material</th><th style={o.th}>Details</th><th style={o.thNum}>Qty</th></tr></thead>
                    <tbody>
                      {detail.items.map((it) => (
                        <tr key={it.line_item_id}>
                          <td style={o.td}>{it.product_type}</td>
                          <td style={o.td}>{[it.size, it.custom_name, it.custom_number].filter(Boolean).join(' · ') || '—'}</td>
                          <td style={o.tdNum}>{it.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <h4 style={o.h4}>Payments</h4>
                {detail.payments.length === 0 ? <p style={o.meta}>No payments yet.</p> : (
                  <table style={o.table}>
                    <thead><tr><th style={o.th}>Date</th><th style={o.th}>Type</th><th style={o.thNum}>Amount</th></tr></thead>
                    <tbody>
                      {detail.payments.map((p) => (
                        <tr key={p.payment_id}>
                          <td style={o.td}>{formatDateTime(p.payment_date, { utc: true })}</td>
                          <td style={o.td}>{p.payment_type}</td>
                          <td style={o.tdNum}>{peso(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
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

                {canWrite && (ACTIONS[order.production_status] || []).length > 0 && (
                  <>
                    <h4 style={o.h4}>Update status</h4>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      {ACTIONS[order.production_status].map((action) => (
                        <button key={action.to} type="button" disabled={busy}
                          onClick={() => (action.danger ? setPendingAction(action) : changeStatus(action))}
                          style={action.danger ? o.btnDanger : o.btnPrimary}>
                          <action.Icon size={16} /> {action.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {order.sync_status !== 'synced' && (
                  <p style={{ ...o.meta, marginTop: '0.75rem' }}>This order was saved offline. Status changes are available once it syncs.</p>
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
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
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
  select: { ...control, padding: '0.5rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', fontSize: '0.875rem' },
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
  payForm: { display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }
};

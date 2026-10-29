import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, CloudOff, CalendarClock, AlarmClock, Wallet, PackageX, Copy, Download, TrendingUp, TriangleAlert } from 'lucide-react';
import { createApi, errorText, peso, formatDateTime, downloadFile, copyText } from './api';
import { ResultDialog } from './Dialogs';
import { orderNumber } from './lib/orders';

// Dashboard (replaces the old Analytics tab): what needs attention today.
//   GET /api/reports/dashboard          orders due / overdue, unpaid balances, income, restock list
//   GET /api/reports/export/*.csv       Excel / Google Sheets downloads
const FINANCE_ROLES = ['Owner', 'Admin'];
const PIN_NAMES = 4; // materials named in the pinned warning before "and N more"
const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'short', year: '2-digit' });

export default function Dashboard({ apiBase, token, userRole, onUnauthorized, refreshKey, onOpenOrders }) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);
  const canSeeMoney = FINANCE_ROLES.includes(userRole);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api('GET', '/reports/dashboard').then(({ ok, data: body }) => {
      if (cancelled) return;
      setLoading(false);
      if (!ok) return setError(errorText(body, 'The dashboard could not be loaded.'));
      setError('');
      setData(body);
    });
    return () => { cancelled = true; };
  }, [api, tick, refreshKey]);

  const reload = () => { setLoading(true); setTick((t) => t + 1); };

  const download = async (kind) => {
    const r = await downloadFile({ apiBase, token, path: `/reports/export/${kind}.csv`, onUnauthorized });
    setResult(r.ok
      ? { type: 'success', title: 'Download ready', message: `${r.name} was downloaded. Open it with Excel or Google Sheets.${r.offline ? '\nNote: made from the offline copy on this computer.' : ''}` }
      : { type: 'error', title: 'Download failed', message: r.message });
  };

  const copyRestock = async (list) => {
    const lines = list.map((r) => `• ${r.item_name}: buy ${r.suggested_order} ${r.unit}` +
      ` (free: ${r.free}${r.supplier ? `, supplier: ${r.supplier}` : ''})`);
    const ok = await copyText(`XiaoMei restock list (${new Date().toLocaleDateString('en-PH')})\n${lines.join('\n')}`);
    setResult(ok
      ? { type: 'success', title: 'Copied', message: 'The restock list was copied. Paste it in Messenger, a note or an email.' }
      : { type: 'error', title: 'Could not copy', message: 'Your browser blocked copying. Select the list and copy it by hand.' });
  };

  if (!data) {
    return (
      <div style={d.root}>
        <h2 style={d.title}>Dashboard</h2>
        {error ? <p style={{ ...d.banner, ...d.bannerError }}>{error}</p> : <p style={d.meta}>Loading…</p>}
        {error && <button type="button" onClick={reload} style={d.btn}><RefreshCw size={16} /> Try again</button>}
      </div>
    );
  }

  const { orders, inventory, income_by_month: income, top_materials: top } = data;
  const maxIncome = Math.max(1, ...income.map((m) => m.amount));
  const cards = [
    { label: 'Overdue orders', value: orders.overdue.length, Icon: AlarmClock, color: orders.overdue.length ? '#b91c1c' : '#166534' },
    { label: 'Due in 7 days', value: orders.due_this_week.length, Icon: CalendarClock, color: '#92400e' },
    { label: 'Open orders', value: orders.open, Icon: TrendingUp, color: '#4f46e5' },
    ...(canSeeMoney ? [{ label: 'Unpaid balance', value: peso(orders.outstanding_balance), sub: `${orders.unpaid_count} order(s)`, Icon: Wallet, color: '#0f766e' }] : []),
    { label: 'Needs restocking', value: inventory.restock.length, sub: `${inventory.summary.out_of_stock} out of stock`, Icon: PackageX, color: inventory.restock.length ? '#b91c1c' : '#166534' }
  ];

  return (
    <div style={d.root}>
      <div style={d.topBar}>
        <div>
          <h2 style={d.title}>Dashboard</h2>
          <p style={d.meta}>Today is {formatDateTime(data.today, { withTime: false })} · updated {formatDateTime(data.generated_at.slice(0, 19), { utc: true })}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => download('inventory')} style={d.btn}><Download size={16} /> Inventory (Excel)</button>
          {canSeeMoney && <button type="button" onClick={() => download('orders')} style={d.btn}><Download size={16} /> Orders (Excel)</button>}
          {canSeeMoney && <button type="button" onClick={() => download('payments')} style={d.btn}><Download size={16} /> Payments (Excel)</button>}
          <button type="button" onClick={reload} style={d.btn} disabled={loading}><RefreshCw size={16} /> {loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>

      {/* PB 17: pinned while any material is at or below its low-stock alert. It updates live
          (the Catalog's real-time push refreshes this page) and disappears once stock is added. */}
      {inventory.restock.length > 0 && (
        <div role="status" aria-live="polite" style={d.lowStockPin}>
          <TriangleAlert size={20} color="#92400e" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>Low stock: {inventory.restock.length} material{inventory.restock.length === 1 ? '' : 's'} need{inventory.restock.length === 1 ? 's' : ''} restocking</strong>
            {inventory.summary.out_of_stock > 0 && <> ({inventory.summary.out_of_stock} out of stock)</>}.
            <span style={{ display: 'block', fontSize: '0.8rem', marginTop: '0.15rem' }}>
              {inventory.restock.slice(0, PIN_NAMES).map((r) => `${r.item_name} (${r.free} ${r.unit} free)`).join(', ')}
              {inventory.restock.length > PIN_NAMES ? `, and ${inventory.restock.length - PIN_NAMES} more` : ''}
            </span>
          </div>
          <a href="#restock-list" style={d.pinLink}>See restock list</a>
        </div>
      )}

      {data.source === 'local' && (
        <p style={{ ...d.banner, ...d.bannerWarn }}><CloudOff size={16} /> Offline: these numbers come from the copy on this computer.</p>
      )}

      <div style={d.cards}>
        {cards.map(({ label, value, sub, Icon, color }) => (
          <div key={label} style={d.card}>
            <span style={d.cardLabel}><Icon size={16} color={color} /> {label}</span>
            <span style={{ ...d.cardValue, color }}>{value}</span>
            {sub && <span style={d.meta}>{sub}</span>}
          </div>
        ))}
      </div>

      <div style={d.grid}>
        <OrderList title="Overdue" empty="Nothing is overdue." rows={orders.overdue} tone="#b91c1c" canSeeMoney={canSeeMoney} onOpen={onOpenOrders} />
        <OrderList title="Due in the next 7 days" empty="No deadlines this week." rows={orders.due_this_week} tone="#92400e" canSeeMoney={canSeeMoney} onOpen={onOpenOrders} />
      </div>

      <section style={d.panel} id="restock-list">
        <div style={d.panelHead}>
          <h3 style={d.h3}>Restock list</h3>
          {inventory.restock.length > 0 && (
            <button type="button" onClick={() => copyRestock(inventory.restock)} style={d.btn}><Copy size={16} /> Copy list</button>
          )}
        </div>
        {inventory.restock.length === 0 ? <p style={d.meta}>All materials are above their low-stock alert.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={d.table}>
              <thead>
                <tr>
                  <th style={d.th}>Material</th><th style={d.th}>Supplier</th>
                  <th style={d.thNum}>Free</th><th style={d.thNum}>Alert at</th><th style={d.thNum}>Suggested to buy</th>
                </tr>
              </thead>
              <tbody>
                {inventory.restock.map((r) => (
                  <tr key={r.inventory_id}>
                    <td style={d.td}>
                      <strong>{r.item_name}</strong>
                      <span style={{ ...d.pill, ...(r.stock_status === 'out_of_stock' ? d.pillOut : d.pillLow) }}>
                        {r.stock_status === 'out_of_stock' ? 'Out of stock' : 'Low'}
                      </span>
                    </td>
                    <td style={d.td}>{r.supplier || '—'}</td>
                    <td style={d.tdNum}>{r.free} {r.unit}</td>
                    <td style={d.tdNum}>{r.minimum_threshold}</td>
                    <td style={{ ...d.tdNum, fontWeight: 'bold' }}>{r.suggested_order} {r.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={d.meta}>Suggested amount brings free stock back to twice its low-stock alert.</p>
          </div>
        )}
      </section>

      <div style={d.grid}>
        {canSeeMoney && (
          <section style={d.panel}>
            <h3 style={d.h3}>Payments received per month</h3>
            <div style={d.chart} role="img" aria-label="Payments received per month">
              {income.map((m) => (
                <div key={m.month} style={d.barCol} title={`${monthLabel(m.month)}: ${peso(m.amount)}`}>
                  <span style={d.barValue}>{m.amount > 0 ? peso(m.amount).replace('.00', '') : ''}</span>
                  <div style={{ ...d.bar, height: `${Math.max(2, (m.amount / maxIncome) * 120)}px` }} />
                  <span style={d.barLabel}>{monthLabel(m.month)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
        <section style={d.panel}>
          <h3 style={d.h3}>Most used materials</h3>
          {top.length === 0 ? <p style={d.meta}>No orders with materials yet.</p> : (
            <table style={d.table}>
              <tbody>
                {top.map((m) => (
                  <tr key={m.inventory_id}>
                    <td style={d.td}>{m.item_name}</td>
                    <td style={d.tdNum}>{m.quantity.toLocaleString()} {m.unit}</td>
                    <td style={{ ...d.tdNum, color: '#64748b' }}>{m.orders} order(s)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 style={{ ...d.h3, marginTop: '1rem' }}>Orders by status</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {Object.entries(orders.by_status).map(([st, n]) => <span key={st} style={d.statusChip}>{st}: <strong>{n}</strong></span>)}
          </div>
        </section>
      </div>

      {canSeeMoney && orders.unpaid.length > 0 && (
        <OrderList title={`Unpaid balances (${orders.unpaid_count})`} empty="" rows={orders.unpaid} tone="#0f766e" canSeeMoney onOpen={onOpenOrders} />
      )}

      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

function OrderList({ title, empty, rows, tone, canSeeMoney, onOpen }) {
  return (
    <section style={d.panel}>
      <h3 style={{ ...d.h3, color: tone }}>{title}</h3>
      {rows.length === 0 ? <p style={d.meta}>{empty}</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={d.table}>
            <thead>
              <tr>
                <th style={d.th}>Order</th><th style={d.th}>Customer</th><th style={d.th}>Deadline</th><th style={d.th}>Status</th>
                {canSeeMoney && <th style={d.thNum}>Balance</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.order_id} onClick={onOpen} style={{ cursor: onOpen ? 'pointer' : 'default' }}>
                  <td style={d.td}><code style={d.code}>{orderNumber(o)}</code></td>
                  <td style={d.td}>{o.customer_name}</td>
                  <td style={d.td}>{formatDateTime(o.production_deadline, { withTime: false })}</td>
                  <td style={d.td}>{o.production_status}</td>
                  {canSeeMoney && <td style={d.tdNum}>{peso(o.balance)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const d = {
  root: { textAlign: 'left' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' },
  title: { fontSize: '1.25rem', margin: 0, color: '#08060d' },
  meta: { fontSize: '0.8rem', color: '#64748b', margin: '0.25rem 0 0' },
  banner: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem', borderRadius: '0.375rem', margin: '0 0 1rem', fontSize: '0.875rem' },
  bannerWarn: { background: '#fef3c7', color: '#92400e' },
  lowStockPin: { position: 'sticky', top: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', margin: '0 0 1rem', background: '#fef9c3', border: '1px solid #facc15', borderLeft: '6px solid #eab308', borderRadius: '0.375rem', color: '#713f12', fontSize: '0.875rem', boxShadow: '0 2px 6px rgba(0,0,0,0.08)' },
  pinLink: { color: '#713f12', fontWeight: 'bold', fontSize: '0.85rem', whiteSpace: 'nowrap' },
  bannerError: { background: '#fee2e2', color: '#991b1b' },
  btn: { display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.9rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.85rem' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem', marginBottom: '1rem' },
  card: { display: 'flex', flexDirection: 'column', gap: '0.25rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', padding: '0.9rem' },
  cardLabel: { display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase' },
  cardValue: { fontSize: '1.6rem', fontWeight: 'bold' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' },
  panel: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', padding: '1rem', marginBottom: '1rem', minWidth: 0 },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' },
  h3: { fontSize: '1rem', margin: '0 0 0.5rem', color: '#0f172a' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th: { textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid #e2e8f0', color: '#334155', whiteSpace: 'nowrap' },
  thNum: { textAlign: 'right', padding: '0.5rem', borderBottom: '1px solid #e2e8f0', color: '#334155', whiteSpace: 'nowrap' },
  td: { padding: '0.5rem', borderBottom: '1px solid #f1f5f9', color: '#0f172a' },
  tdNum: { padding: '0.5rem', borderBottom: '1px solid #f1f5f9', color: '#0f172a', textAlign: 'right', whiteSpace: 'nowrap' },
  code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.8rem', background: '#f1f5f9', padding: '0.1rem 0.35rem', borderRadius: '0.25rem' },
  pill: { marginLeft: '0.4rem', padding: '0.05rem 0.4rem', borderRadius: '999px', fontSize: '0.65rem', fontWeight: 'bold' },
  pillOut: { background: '#fee2e2', color: '#991b1b' },
  pillLow: { background: '#fef3c7', color: '#92400e' },
  chart: { display: 'flex', alignItems: 'flex-end', gap: '0.5rem', height: '170px', paddingTop: '0.5rem' },
  barCol: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: '0.25rem', minWidth: 0 },
  bar: { width: '100%', maxWidth: '42px', background: '#6366f1', borderRadius: '4px 4px 0 0' },
  barValue: { fontSize: '0.65rem', color: '#334155', whiteSpace: 'nowrap' },
  barLabel: { fontSize: '0.7rem', color: '#64748b' },
  statusChip: { padding: '0.2rem 0.55rem', background: '#f1f5f9', borderRadius: '999px', fontSize: '0.8rem', color: '#334155' }
};

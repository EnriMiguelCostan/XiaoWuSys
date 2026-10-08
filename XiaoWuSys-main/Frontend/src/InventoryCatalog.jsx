import { useMemo, useState } from 'react';
import { RefreshCw, Search, CloudOff, TriangleAlert } from 'lucide-react';

// Inventory / Catalog page. Data comes from GET /api/inventory (owned by App.jsx so the
// Create Order picker and Analytics share the same snapshot). Styling is inline only,
// matching the rest of the frontend.

const STATUS_META = {
  in_stock: { label: 'In Stock', bg: '#dcfce7', color: '#166534', bar: '#10b981' },
  low_stock: { label: 'Low Stock', bg: '#fef3c7', color: '#92400e', bar: '#f59e0b' },
  out_of_stock: { label: 'Out of Stock', bg: '#fee2e2', color: '#991b1b', bar: '#ef4444' }
};

const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

const LIVE_META = {
  live: { dot: '#10b981', text: 'Live' },
  connecting: { dot: '#f59e0b', text: 'Connecting…' },
  disconnected: { dot: '#94a3b8', text: 'Not live · refreshing every 30s' }
};

export default function InventoryCatalog({
  items, summary, categories, source, fetchedAt, loading, error, onRefresh,
  liveStatus = 'disconnected', cloudListening = false, recentlyChanged = []
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) =>
      (!needle || item.item_name.toLowerCase().includes(needle)) &&
      (!category || item.item_category === category) &&
      (!status || item.stock_status === status)
    );
  }, [items, search, category, status]);

  const summaryCards = [
    { key: '', label: 'Total Items', value: summary.total_items, color: '#4f46e5' },
    { key: 'in_stock', label: 'In Stock', value: summary.in_stock, color: STATUS_META.in_stock.color },
    { key: 'low_stock', label: 'Low Stock', value: summary.low_stock, color: STATUS_META.low_stock.color },
    { key: 'out_of_stock', label: 'Out of Stock', value: summary.out_of_stock, color: STATUS_META.out_of_stock.color }
  ];

  return (
    <div style={s.root}>
      {/* Header: title, freshness, refresh */}
      <div style={s.topBar}>
        <div>
          <h2 style={{ fontSize: '1.25rem', margin: 0, color: '#08060d' }}>Inventory</h2>
          <p style={s.meta}>
            <span style={{ ...s.liveDot, background: (LIVE_META[liveStatus] || LIVE_META.disconnected).dot }} aria-hidden="true" />
            <span style={{ fontWeight: 'bold' }}>{(LIVE_META[liveStatus] || LIVE_META.disconnected).text}</span>
            {liveStatus === 'live' && !cloudListening && <span> (this server only)</span>}
            <span> · Last updated {formatTime(fetchedAt)}</span>
          </p>
        </div>
        <button type="button" onClick={onRefresh} style={s.refreshBtn} disabled={loading} aria-label="Refresh inventory">
          <RefreshCw size={16} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {source === 'local' && (
        <div style={{ ...s.banner, background: '#fef3c7', color: '#92400e' }}>
          <CloudOff size={16} /> Offline mode: showing the local cache. Numbers may lag behind other branches until the next sync.
        </div>
      )}
      {error && (
        <div style={{ ...s.banner, background: '#fee2e2', color: '#991b1b' }}>
          <TriangleAlert size={16} /> {error}
        </div>
      )}

      {/* Summary cards double as quick status filters */}
      <div style={s.summaryGrid}>
        {summaryCards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => setStatus(card.key)}
            style={{ ...s.summaryCard, ...(status === card.key ? s.summaryCardActive : {}) }}
            aria-pressed={status === card.key}
          >
            <span style={s.summaryLabel}>{card.label}</span>
            <span style={{ ...s.summaryValue, color: card.color }}>{card.value}</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={s.filters}>
        <div style={s.searchWrap}>
          <Search size={16} color="#64748b" />
          <input
            type="text"
            placeholder="Search materials…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={s.searchInput}
            aria-label="Search materials"
          />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={s.select} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={s.select} aria-label="Filter by stock status">
          <option value="">All statuses</option>
          {Object.entries(STATUS_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
        </select>
      </div>

      {/* Items */}
      {!loading && items.length === 0 && !error && (
        <p style={s.empty}>No inventory items yet. Items added by an Admin or Production user will appear here.</p>
      )}
      {items.length > 0 && visible.length === 0 && (
        <p style={s.empty}>No items match these filters.</p>
      )}

      <div style={s.grid}>
        {visible.map((item) => {
          const meta = STATUS_META[item.stock_status] || STATUS_META.in_stock;
          const reservedPct = item.quantity_available > 0
            ? Math.min(100, (item.quantity_reserved / item.quantity_available) * 100)
            : 0;
          return (
            <div
              key={item.inventory_id}
              data-inventory-id={item.inventory_id}
              style={{ ...s.card, borderTop: `4px solid ${meta.bar}`, ...(recentlyChanged.includes(item.inventory_id) ? s.cardChanged : {}) }}
            >
              <div style={s.cardHead}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={s.itemName} title={item.item_name}>{item.item_name}</h3>
                  <span style={s.category}>{item.item_category}</span>
                </div>
                <span style={{ ...s.badge, background: meta.bg, color: meta.color }}>{meta.label}</span>
              </div>

              <div style={s.stats}>
                <div style={s.stat}>
                  <span style={s.statLabel}>Available</span>
                  <span style={s.statValue}>{item.quantity_available}</span>
                </div>
                <div style={s.stat}>
                  <span style={s.statLabel}>Reserved</span>
                  <span style={s.statValue}>{item.quantity_reserved}</span>
                </div>
                <div style={s.stat}>
                  <span style={s.statLabel}>Min. Threshold</span>
                  <span style={s.statValue}>{item.minimum_threshold}</span>
                </div>
              </div>

              {/* Reserved share of on-hand stock */}
              <div style={s.barTrack} aria-hidden="true">
                <div style={{ ...s.barFill, width: `${reservedPct}%`, background: meta.bar }} />
              </div>
              <div style={s.cardFoot}>
                <span>Free to use: <strong style={{ color: meta.color }}>{item.quantity_available_net}</strong></span>
                <span>Unit cost: <strong>{peso(item.unit_cost)}</strong></span>
              </div>

              {item.sync_status !== 'synced' && (
                <span style={s.pending}>Pending sync</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const s = {
  root: { textAlign: 'left' }, // index.css centers #root text
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', gap: '1rem' },
  meta: { display: 'flex', alignItems: 'center', gap: '0.35rem', margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#64748b' },
  liveDot: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%' },
  cardChanged: { boxShadow: '0 0 0 3px #a5b4fc', transition: 'box-shadow 0.3s ease' },
  refreshBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.875rem' },
  banner: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem', borderRadius: '0.375rem', marginBottom: '1rem', fontSize: '0.875rem' },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1rem' },
  summaryCard: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', background: '#fff', padding: '1rem', borderRadius: '0.5rem', border: '1px solid #e2e8f0', cursor: 'pointer', textAlign: 'left' },
  summaryCardActive: { border: '2px solid #4f46e5', background: '#eef2ff' },
  summaryLabel: { fontSize: '0.8rem', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' },
  summaryValue: { fontSize: '1.75rem', fontWeight: 'bold' },
  filters: { display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap' },
  searchWrap: { flex: '2 1 220px', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0 0.75rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem' },
  searchInput: { flex: 1, padding: '0.65rem 0', border: 'none', outline: 'none', background: 'transparent', fontSize: '0.875rem' },
  select: { flex: '1 1 150px', padding: '0.65rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', background: '#fff', fontSize: '0.875rem' },
  empty: { textAlign: 'center', color: '#64748b', padding: '2rem', background: '#fff', borderRadius: '0.5rem', border: '1px dashed #cbd5e1' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.5rem' },
  card: { position: 'relative', background: '#fff', borderRadius: '0.5rem', border: '1px solid #e2e8f0', padding: '1rem', transition: 'box-shadow 0.6s ease' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '1rem' },
  itemName: { fontSize: '1.05rem', margin: 0, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  category: { fontSize: '0.8rem', color: '#64748b' },
  badge: { flexShrink: 0, padding: '0.25rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.7rem', fontWeight: 'bold', textTransform: 'uppercase' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '0.75rem' },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0.5rem 0.25rem', background: '#f8fafc', borderRadius: '0.375rem' },
  statLabel: { fontSize: '0.7rem', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase', textAlign: 'center' },
  statValue: { fontSize: '1.25rem', fontWeight: 'bold', color: '#0f172a' },
  barTrack: { height: '6px', background: '#e2e8f0', borderRadius: '3px', overflow: 'hidden', marginBottom: '0.5rem' },
  barFill: { height: '100%', borderRadius: '3px' },
  cardFoot: { display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#334155' },
  pending: { position: 'absolute', bottom: '-0.6rem', right: '1rem', padding: '0.1rem 0.5rem', background: '#e0e7ff', color: '#4f46e5', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 'bold' }
};

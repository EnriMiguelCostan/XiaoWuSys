import { useMemo, useState } from 'react';
import { RefreshCw, Search, CloudOff, TriangleAlert, PackagePlus, X, Plus, Minus, CircleCheck } from 'lucide-react';

// Inventory / Catalog page. Data comes from GET /api/inventory (owned by App.jsx so the
// Create Order picker and Analytics share the same snapshot). Styling is inline only,
// matching the rest of the frontend.
//
// Stock changes (all re-broadcast to every client over Socket.io by the server):
//   POST /api/inventory                    add a new item
//   POST /api/inventory/:id/adjust         add / subtract stock by hand
//   POST /api/inventory/:id/loss           subtract lost/damaged stock and record its cost

const STATUS_META = {
  in_stock: { label: 'In Stock', bg: '#dcfce7', color: '#166534', bar: '#10b981' },
  low_stock: { label: 'Low Stock', bg: '#fef3c7', color: '#92400e', bar: '#f59e0b' },
  out_of_stock: { label: 'Out of Stock', bg: '#fee2e2', color: '#991b1b', bar: '#ef4444' }
};

// Roles allowed to change stock (must match requireRole in Backend/routes/inventory.js)
const STOCK_EDIT_ROLES = ['Owner', 'Admin', 'Production'];

const SUBTRACT_REASONS = {
  taken: 'Taken / used',
  lost: 'Lost / damaged (records material loss)'
};

const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

const LIVE_META = {
  live: { dot: '#10b981', text: 'Live' },
  connecting: { dot: '#f59e0b', text: 'Connecting…' },
  disconnected: { dot: '#94a3b8', text: 'Not live · refreshing every 30s' }
};

const EMPTY_NEW_ITEM = { item_name: '', item_category: '', quantity_available: '', minimum_threshold: '', unit_cost: '' };
const EMPTY_ADJUST = { inventory_id: '', action: 'add', quantity: '', reason: 'taken', note: '' };

// '5' -> 5, '' -> null, '2.5' / '-1' / 'abc' -> NaN
const toWholeNumber = (value) => {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  return /^\d+$/.test(text) ? Number(text) : NaN;
};

export default function InventoryCatalog({
  items, summary, categories, source, fetchedAt, loading, error, onRefresh,
  liveStatus = 'disconnected', cloudListening = false, recentlyChanged = [],
  apiBase, token, userRole, onUnauthorized
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');

  const canEdit = STOCK_EDIT_ROLES.includes(userRole);

  // Manage Stock panel
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState('new'); // 'new' | 'adjust'
  const [newItem, setNewItem] = useState(EMPTY_NEW_ITEM);
  const [adjust, setAdjust] = useState(EMPTY_ADJUST);
  const [panelMsg, setPanelMsg] = useState(null); // { type: 'ok' | 'error', text }
  const [panelBusy, setPanelBusy] = useState(false);

  // Per-card quick +/- controls
  const [cardQty, setCardQty] = useState({});   // { [inventory_id]: '1' }
  const [cardMsg, setCardMsg] = useState({});   // { [inventory_id]: { type, text } }
  const [cardBusy, setCardBusy] = useState({}); // { [inventory_id]: true }

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) =>
      (!needle || item.item_name.toLowerCase().includes(needle)) &&
      (!category || item.item_category === category) &&
      (!status || item.stock_status === status)
    );
  }, [items, search, category, status]);

  const totalUnits = useMemo(() => items.reduce((sum, i) => sum + Number(i.quantity_available || 0), 0), [items]);

  const summaryCards = [
    { key: '', label: 'Total Items', value: summary.total_items, color: '#4f46e5', sub: `${totalUnits.toLocaleString()} units on hand` },
    { key: 'in_stock', label: 'In Stock', value: summary.in_stock, color: STATUS_META.in_stock.color },
    { key: 'low_stock', label: 'Low Stock', value: summary.low_stock, color: STATUS_META.low_stock.color },
    { key: 'out_of_stock', label: 'Out of Stock', value: summary.out_of_stock, color: STATUS_META.out_of_stock.color }
  ];

  // ---------- API ----------
  // Never throws: resolves to { ok, status, data } or { ok: false, data: { message } } on network failure
  const apiPost = async (path, body) => {
    try {
      const res = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      console.error(`POST ${path} failed`, err);
      return { ok: false, status: 0, data: { message: 'Cannot reach the server. Check that the backend is running.' } };
    }
  };

  const errorText = (data, fallback) => data.message || data.error || fallback;
  const offlineSuffix = (data) => (data.source === 'local' ? ' (saved offline, will sync later)' : '');

  // Shared add/subtract call used by the panel and the card buttons
  const changeStock = (item, action, quantity, reason) => {
    if (action === 'subtract' && reason === 'lost') {
      return apiPost(`/inventory/${encodeURIComponent(item.inventory_id)}/loss`, {
        quantity_lost: quantity,
        loss_reason: 'Lost / damaged (manual stock count)'
      });
    }
    return apiPost(`/inventory/${encodeURIComponent(item.inventory_id)}/adjust`, {
      action,
      quantity,
      reason: action === 'add' ? 'Stock received' : 'Taken / used (manual adjustment)'
    });
  };

  // ---------- Panel: new item ----------
  const handleAddItem = async (e) => {
    e.preventDefault();
    setPanelMsg(null);

    const name = newItem.item_name.trim();
    const cat = newItem.item_category.trim();
    const qty = toWholeNumber(newItem.quantity_available);
    const min = toWholeNumber(newItem.minimum_threshold);
    const costText = String(newItem.unit_cost).trim();
    const cost = costText === '' ? 0 : Number(costText);

    if (!name || !cat) return setPanelMsg({ type: 'error', text: 'Item name and category are required.' });
    if (Number.isNaN(qty) || Number.isNaN(min)) {
      return setPanelMsg({ type: 'error', text: 'Quantity and minimum threshold must be whole numbers (0 or more).' });
    }
    if (!Number.isFinite(cost) || cost < 0 || Math.abs(Math.round(cost * 100) - cost * 100) > 1e-6) {
      return setPanelMsg({ type: 'error', text: 'Unit cost must be 0 or more, with at most 2 decimal places.' });
    }
    const duplicate = items.find((i) => i.item_name.trim().toLowerCase() === name.toLowerCase());
    if (duplicate) {
      return setPanelMsg({
        type: 'error',
        text: `"${duplicate.item_name}" is already in the catalog. Use "Add / Subtract Stock" to change its quantity.`
      });
    }

    setPanelBusy(true);
    const { ok, data } = await apiPost('/inventory', {
      item_name: name,
      item_category: cat,
      quantity_available: qty ?? 0,
      minimum_threshold: min ?? 0,
      unit_cost: Math.round(cost * 100) / 100
    });
    setPanelBusy(false);

    if (!ok) return setPanelMsg({ type: 'error', text: errorText(data, 'Could not add the item.') });
    setPanelMsg({ type: 'ok', text: `Added "${data.item?.item_name || name}" with ${data.item?.quantity_available ?? qty ?? 0} in stock${offlineSuffix(data)}.` });
    setNewItem((prev) => ({ ...EMPTY_NEW_ITEM, item_category: prev.item_category })); // keep category for the next entry
    onRefresh();
  };

  // ---------- Panel: add / subtract ----------
  const handleAdjust = async (e) => {
    e.preventDefault();
    setPanelMsg(null);

    const item = items.find((i) => i.inventory_id === adjust.inventory_id);
    const qty = toWholeNumber(adjust.quantity);
    if (!item) return setPanelMsg({ type: 'error', text: 'Choose an item first.' });
    if (!qty || Number.isNaN(qty)) return setPanelMsg({ type: 'error', text: 'Quantity must be a whole number greater than 0.' });
    if (adjust.action === 'subtract' && qty > item.quantity_available) {
      return setPanelMsg({ type: 'error', text: `Cannot subtract ${qty}: only ${item.quantity_available} of "${item.item_name}" in stock.` });
    }

    setPanelBusy(true);
    const { ok, data } = await changeStock(item, adjust.action, qty, adjust.reason);
    setPanelBusy(false);

    if (!ok) return setPanelMsg({ type: 'error', text: errorText(data, 'Could not update the stock.') });
    const newQty = data.item?.quantity_available;
    setPanelMsg({
      type: 'ok',
      text: `${adjust.action === 'add' ? 'Added' : 'Subtracted'} ${qty} ${adjust.action === 'add' ? 'to' : 'from'} "${item.item_name}".` +
            `${newQty !== undefined ? ` Now ${newQty} in stock` : ''}${offlineSuffix(data)}.`
    });
    setAdjust((prev) => ({ ...prev, quantity: '' }));
    onRefresh();
  };

  // ---------- Card +/- ----------
  const handleCardChange = async (item, action) => {
    const id = item.inventory_id;
    const qty = toWholeNumber(cardQty[id] ?? '1');
    setCardMsg((m) => ({ ...m, [id]: null }));

    if (!qty || Number.isNaN(qty)) {
      return setCardMsg((m) => ({ ...m, [id]: { type: 'error', text: 'Enter a whole number above 0.' } }));
    }
    if (action === 'subtract' && qty > item.quantity_available) {
      return setCardMsg((m) => ({ ...m, [id]: { type: 'error', text: `Only ${item.quantity_available} in stock.` } }));
    }

    setCardBusy((b) => ({ ...b, [id]: true }));
    const { ok, data } = await changeStock(item, action, qty, 'taken');
    setCardBusy((b) => ({ ...b, [id]: false }));

    if (!ok) {
      return setCardMsg((m) => ({ ...m, [id]: { type: 'error', text: errorText(data, 'Update failed.') } }));
    }
    setCardMsg((m) => ({ ...m, [id]: { type: 'ok', text: `${action === 'add' ? '+' : '−'}${qty} saved${offlineSuffix(data)}` } }));
    setCardQty((q) => ({ ...q, [id]: '1' }));
    onRefresh();
  };

  const openAdjustFor = (item) => {
    setPanelOpen(true);
    setPanelTab('adjust');
    setPanelMsg(null);
    setAdjust({ ...EMPTY_ADJUST, inventory_id: item.inventory_id, action: 'subtract', reason: 'lost' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const selectedAdjustItem = items.find((i) => i.inventory_id === adjust.inventory_id);

  return (
    <div style={s.root}>
      {/* Header: title, freshness, actions */}
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
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {canEdit && (
            <button
              type="button"
              onClick={() => { setPanelOpen((o) => !o); setPanelMsg(null); }}
              style={panelOpen ? s.manageBtnActive : s.manageBtn}
              aria-expanded={panelOpen}
            >
              <PackagePlus size={16} /> {panelOpen ? 'Close Stock Manager' : 'Manage Stock'}
            </button>
          )}
          <button type="button" onClick={onRefresh} style={s.refreshBtn} disabled={loading} aria-label="Refresh inventory">
            <RefreshCw size={16} /> {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
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

      {/* Manage Stock window */}
      {canEdit && panelOpen && (
        <section style={s.panel} aria-label="Manage stock">
          <div style={s.panelHead}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', color: '#0f172a' }}>Manage Stock</h3>
            <button type="button" onClick={() => setPanelOpen(false)} style={s.panelClose} aria-label="Close stock manager">
              <X size={18} />
            </button>
          </div>

          <div style={s.tabs} role="tablist">
            <button
              type="button" role="tab" aria-selected={panelTab === 'new'}
              onClick={() => { setPanelTab('new'); setPanelMsg(null); }}
              style={panelTab === 'new' ? s.tabActive : s.tab}
            >
              Add New Item
            </button>
            <button
              type="button" role="tab" aria-selected={panelTab === 'adjust'}
              onClick={() => { setPanelTab('adjust'); setPanelMsg(null); }}
              style={panelTab === 'adjust' ? s.tabActive : s.tab}
            >
              Add / Subtract Stock
            </button>
          </div>

          {panelMsg && (
            <p style={{ ...s.msg, ...(panelMsg.type === 'ok' ? s.msgOk : s.msgError) }} role="status">
              {panelMsg.type === 'ok' ? <CircleCheck size={16} /> : <TriangleAlert size={16} />} {panelMsg.text}
            </p>
          )}

          {panelTab === 'new' ? (
            <form onSubmit={handleAddItem} style={s.formGrid}>
              <label style={{ ...s.field, gridColumn: '1 / -1' }}>
                <span style={s.fieldLabel}>Item name *</span>
                <input
                  type="text" value={newItem.item_name} maxLength={255} required
                  placeholder="e.g. Valiant Columnar Notebook"
                  onChange={(e) => setNewItem({ ...newItem, item_name: e.target.value })}
                  style={s.input}
                />
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Category *</span>
                <input
                  type="text" value={newItem.item_category} maxLength={100} required list="inventory-category-options"
                  placeholder="e.g. Notebooks"
                  onChange={(e) => setNewItem({ ...newItem, item_category: e.target.value })}
                  style={s.input}
                />
                <datalist id="inventory-category-options">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Quantity in stock</span>
                <input
                  type="number" min="0" step="1" inputMode="numeric" placeholder="0"
                  value={newItem.quantity_available}
                  onChange={(e) => setNewItem({ ...newItem, quantity_available: e.target.value })}
                  style={s.input}
                />
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Low-stock alert at</span>
                <input
                  type="number" min="0" step="1" inputMode="numeric" placeholder="0"
                  value={newItem.minimum_threshold}
                  onChange={(e) => setNewItem({ ...newItem, minimum_threshold: e.target.value })}
                  style={s.input}
                />
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Unit cost (₱)</span>
                <input
                  type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00"
                  value={newItem.unit_cost}
                  onChange={(e) => setNewItem({ ...newItem, unit_cost: e.target.value })}
                  style={s.input}
                />
              </label>
              <button type="submit" style={{ ...s.submitBtn, gridColumn: '1 / -1' }} disabled={panelBusy}>
                <Plus size={16} /> {panelBusy ? 'Saving…' : 'Add Item to Inventory'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleAdjust} style={s.formGrid}>
              {items.length === 0 && (
                <p style={{ ...s.hint, gridColumn: '1 / -1' }}>No items yet. Add one in the "Add New Item" tab first.</p>
              )}
              <label style={{ ...s.field, gridColumn: '1 / -1' }}>
                <span style={s.fieldLabel}>Item *</span>
                <select
                  value={adjust.inventory_id} required
                  onChange={(e) => setAdjust({ ...adjust, inventory_id: e.target.value })}
                  style={s.input}
                >
                  <option value="" style={s.option}>Select an item…</option>
                  {items.map((i) => (
                    <option key={i.inventory_id} value={i.inventory_id} style={s.option}>
                      {i.item_name} ({i.quantity_available} in stock)
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ ...s.field, gridColumn: '1 / -1' }}>
                <span style={s.fieldLabel}>Action</span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button" onClick={() => setAdjust({ ...adjust, action: 'add' })}
                    style={adjust.action === 'add' ? { ...s.toggle, ...s.toggleAdd } : s.toggle}
                    aria-pressed={adjust.action === 'add'}
                  >
                    <Plus size={16} /> Add stock
                  </button>
                  <button
                    type="button" onClick={() => setAdjust({ ...adjust, action: 'subtract' })}
                    style={adjust.action === 'subtract' ? { ...s.toggle, ...s.toggleSub } : s.toggle}
                    aria-pressed={adjust.action === 'subtract'}
                  >
                    <Minus size={16} /> Subtract stock
                  </button>
                </div>
              </div>
              <label style={s.field}>
                <span style={s.fieldLabel}>Quantity *</span>
                <input
                  type="number" min="1" step="1" inputMode="numeric" required placeholder="1"
                  value={adjust.quantity}
                  onChange={(e) => setAdjust({ ...adjust, quantity: e.target.value })}
                  style={s.input}
                />
              </label>
              {adjust.action === 'subtract' ? (
                <label style={s.field}>
                  <span style={s.fieldLabel}>Reason</span>
                  <select value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} style={s.input}>
                    {Object.entries(SUBTRACT_REASONS).map(([key, label]) => (
                      <option key={key} value={key} style={s.option}>{label}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div style={s.field} />
              )}
              {selectedAdjustItem && (
                <p style={{ ...s.hint, gridColumn: '1 / -1' }}>
                  Currently <strong>{selectedAdjustItem.quantity_available}</strong> in stock
                  {selectedAdjustItem.quantity_reserved > 0 && <> ({selectedAdjustItem.quantity_reserved} reserved)</>}.
                  {' '}Low-stock alert at {selectedAdjustItem.minimum_threshold}.
                </p>
              )}
              <button
                type="submit"
                style={{ ...s.submitBtn, gridColumn: '1 / -1', ...(adjust.action === 'subtract' ? { background: '#ef4444' } : {}) }}
                disabled={panelBusy || items.length === 0}
              >
                {adjust.action === 'add' ? <Plus size={16} /> : <Minus size={16} />}
                {panelBusy ? 'Saving…' : adjust.action === 'add' ? 'Add to Stock' : 'Subtract from Stock'}
              </button>
            </form>
          )}
        </section>
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
            {card.sub && <span style={s.summarySub}>{card.sub}</span>}
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
          <option value="" style={s.option}>All categories</option>
          {categories.map((c) => <option key={c} value={c} style={s.option}>{c}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={s.select} aria-label="Filter by stock status">
          <option value="" style={s.option}>All statuses</option>
          {Object.entries(STATUS_META).map(([key, meta]) => <option key={key} value={key} style={s.option}>{meta.label}</option>)}
        </select>
      </div>

      {/* Items */}
      <h3 style={s.sectionTitle}>
        Stock Items <span style={s.sectionCount}>({visible.length}{visible.length !== items.length ? ` of ${items.length}` : ''})</span>
      </h3>

      {!loading && items.length === 0 && !error && (
        <p style={s.empty}>
          No inventory items yet.{canEdit ? ' Click "Manage Stock" above to add your first item.' : ' Items added by an Owner, Admin or Production user will appear here.'}
        </p>
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
          const id = item.inventory_id;
          const busy = Boolean(cardBusy[id]);
          const msg = cardMsg[id];
          return (
            <div
              key={id}
              data-inventory-id={id}
              style={{ ...s.card, borderTop: `4px solid ${meta.bar}`, ...(recentlyChanged.includes(id) ? s.cardChanged : {}) }}
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

              {/* Manual stock correction: received, taken, or lost */}
              {canEdit && (
                <div style={s.adjustBox}>
                  <span style={s.adjustLabel}>Adjust stock</span>
                  <div style={s.adjustRow}>
                    <button
                      type="button" onClick={() => handleCardChange(item, 'subtract')}
                      style={{ ...s.stepBtn, color: '#b91c1c', borderColor: '#fecaca' }}
                      disabled={busy || item.quantity_available === 0}
                      aria-label={`Subtract from ${item.item_name}`}
                      title="Subtract (taken / used)"
                    >
                      <Minus size={16} />
                    </button>
                    <input
                      type="number" min="1" step="1" inputMode="numeric"
                      value={cardQty[id] ?? '1'}
                      onChange={(e) => setCardQty((q) => ({ ...q, [id]: e.target.value }))}
                      style={s.stepInput}
                      aria-label={`Quantity to add or subtract for ${item.item_name}`}
                    />
                    <button
                      type="button" onClick={() => handleCardChange(item, 'add')}
                      style={{ ...s.stepBtn, color: '#15803d', borderColor: '#bbf7d0' }}
                      disabled={busy}
                      aria-label={`Add to ${item.item_name}`}
                      title="Add (stock received)"
                    >
                      <Plus size={16} />
                    </button>
                    <button type="button" onClick={() => openAdjustFor(item)} style={s.moreBtn} disabled={busy} title="Record lost / damaged stock">
                      Lost?
                    </button>
                  </div>
                  {busy && <span style={s.cardNote}>Saving…</span>}
                  {!busy && msg && (
                    <span style={{ ...s.cardNote, color: msg.type === 'ok' ? '#166534' : '#991b1b' }}>{msg.text}</span>
                  )}
                </div>
              )}

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

// Explicit dark text + light color-scheme on form controls: without it, browsers in dark
// mode render native dropdown options as white text on a white list.
const control = { color: '#0f172a', backgroundColor: '#fff', colorScheme: 'light' };

const s = {
  root: { textAlign: 'left' }, // index.css centers #root text
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', gap: '1rem', flexWrap: 'wrap' },
  meta: { display: 'flex', alignItems: 'center', gap: '0.35rem', margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#64748b' },
  liveDot: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%' },
  cardChanged: { boxShadow: '0 0 0 3px #a5b4fc', transition: 'box-shadow 0.3s ease' },
  refreshBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.875rem' },
  manageBtn: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.5rem 1rem', background: '#4f46e5', border: '1px solid #4f46e5', borderRadius: '0.375rem', cursor: 'pointer', color: '#fff', fontWeight: 'bold', fontSize: '0.875rem' },
  manageBtnActive: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.5rem 1rem', background: '#e0e7ff', border: '1px solid #4f46e5', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.875rem' },
  banner: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem', borderRadius: '0.375rem', marginBottom: '1rem', fontSize: '0.875rem' },

  // Manage Stock window
  panel: { background: '#fff', border: '1px solid #c7d2fe', borderTop: '4px solid #4f46e5', borderRadius: '0.5rem', padding: '1.25rem', marginBottom: '1.5rem', boxShadow: '0 4px 12px -2px rgba(79,70,229,0.15)' },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  panelClose: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem' },
  tabs: { display: 'flex', gap: '0.25rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' },
  tab: { padding: '0.5rem 1rem', background: 'none', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer', color: '#64748b', fontSize: '0.875rem', fontWeight: 'bold' },
  tabActive: { padding: '0.5rem 1rem', background: 'none', border: 'none', borderBottom: '2px solid #4f46e5', cursor: 'pointer', color: '#4f46e5', fontSize: '0.875rem', fontWeight: 'bold' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem 1rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  fieldLabel: { fontSize: '0.8rem', fontWeight: 'bold', color: '#334155' },
  input: { ...control, width: '100%', padding: '0.6rem 0.75rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', fontSize: '0.875rem', boxSizing: 'border-box' },
  option: { color: '#0f172a', backgroundColor: '#fff' },
  hint: { margin: 0, fontSize: '0.8rem', color: '#64748b' },
  toggle: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem', padding: '0.6rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#334155', fontWeight: 'bold', fontSize: '0.875rem' },
  toggleAdd: { background: '#dcfce7', borderColor: '#16a34a', color: '#166534' },
  toggleSub: { background: '#fee2e2', borderColor: '#ef4444', color: '#991b1b' },
  submitBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', padding: '0.75rem', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.9rem' },
  msg: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', margin: '0 0 1rem', fontSize: '0.875rem' },
  msgOk: { background: '#dcfce7', color: '#166534' },
  msgError: { background: '#fee2e2', color: '#991b1b' },

  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1rem' },
  summaryCard: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', background: '#fff', padding: '1rem', borderRadius: '0.5rem', border: '1px solid #e2e8f0', cursor: 'pointer', textAlign: 'left' },
  summaryCardActive: { border: '2px solid #4f46e5', background: '#eef2ff' },
  summaryLabel: { fontSize: '0.8rem', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' },
  summaryValue: { fontSize: '1.75rem', fontWeight: 'bold' },
  summarySub: { fontSize: '0.75rem', color: '#64748b' },
  filters: { display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap' },
  searchWrap: { flex: '2 1 220px', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0 0.75rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem' },
  searchInput: { ...control, flex: 1, padding: '0.65rem 0', border: 'none', outline: 'none', background: 'transparent', fontSize: '0.875rem' },
  select: { ...control, flex: '1 1 150px', padding: '0.65rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', fontSize: '0.875rem' },
  sectionTitle: { fontSize: '1.05rem', margin: '0 0 0.75rem', color: '#0f172a' },
  sectionCount: { fontWeight: 'normal', color: '#64748b', fontSize: '0.9rem' },
  empty: { textAlign: 'center', color: '#64748b', padding: '2rem', background: '#fff', borderRadius: '0.5rem', border: '1px dashed #cbd5e1' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.5rem' },
  card: { position: 'relative', background: '#fff', borderRadius: '0.5rem', border: '1px solid #e2e8f0', padding: '1rem', transition: 'box-shadow 0.6s ease' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '1rem' },
  // Full title is shown (wraps) so long product names stay readable
  itemName: { fontSize: '1.05rem', margin: 0, color: '#0f172a', lineHeight: 1.3, overflowWrap: 'anywhere' },
  category: { fontSize: '0.8rem', color: '#64748b' },
  badge: { flexShrink: 0, padding: '0.25rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.7rem', fontWeight: 'bold', textTransform: 'uppercase' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '0.75rem' },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0.5rem 0.25rem', background: '#f8fafc', borderRadius: '0.375rem' },
  statLabel: { fontSize: '0.7rem', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase', textAlign: 'center' },
  statValue: { fontSize: '1.25rem', fontWeight: 'bold', color: '#0f172a' },
  barTrack: { height: '6px', background: '#e2e8f0', borderRadius: '3px', overflow: 'hidden', marginBottom: '0.5rem' },
  barFill: { height: '100%', borderRadius: '3px' },
  cardFoot: { display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#334155' },
  adjustBox: { marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px dashed #e2e8f0', display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  adjustLabel: { fontSize: '0.7rem', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' },
  adjustRow: { display: 'flex', gap: '0.35rem', alignItems: 'stretch' },
  stepBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '2.25rem', background: '#fff', border: '1px solid', borderRadius: '0.375rem', cursor: 'pointer' },
  stepInput: { ...control, flex: 1, minWidth: 0, padding: '0.4rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', textAlign: 'center', fontSize: '0.9rem' },
  moreBtn: { padding: '0 0.6rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#475569', fontSize: '0.75rem', fontWeight: 'bold' },
  cardNote: { fontSize: '0.75rem', color: '#64748b' },
  pending: { position: 'absolute', bottom: '-0.6rem', right: '1rem', padding: '0.1rem 0.5rem', background: '#e0e7ff', color: '#4f46e5', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 'bold' }
};

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, CloudOff, TriangleAlert, PackagePlus, X, Plus, Minus, Pencil, Trash2, ChevronDown, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react';
import { createApi, errorText, peso } from './api';
import { ResultDialog, ConfirmDialog } from './Dialogs';
import RecycleBin from './RecycleBin';

// Inventory / Catalog page. Data comes from GET /api/inventory (owned by App.jsx so the
// Create Order picker and Analytics share the same snapshot). Styling is inline only,
// matching the rest of the frontend.
//
// Changes (all re-broadcast to every client over Socket.io by the server):
//   POST   /api/inventory                  add a new item (duplicates rejected)
//   PATCH  /api/inventory/:id              edit name / category / threshold / unit cost
//   DELETE /api/inventory/:id              move to the Recycle Bin (restorable)
//   POST   /api/inventory/:id/adjust       add / subtract stock (Manage Stock panel)
//   POST   /api/inventory/:id/loss         subtract lost/damaged stock and record its cost

const STATUS_META = {
  in_stock: { label: 'In Stock', bg: '#dcfce7', color: '#166534', bar: '#10b981' },
  low_stock: { label: 'Low Stock', bg: '#fef3c7', color: '#92400e', bar: '#f59e0b' },
  out_of_stock: { label: 'Out of Stock', bg: '#fee2e2', color: '#991b1b', bar: '#ef4444' }
};

// Roles allowed to change the catalog (must match requireRole in Backend/routes/inventory.js)
const STOCK_EDIT_ROLES = ['Owner', 'Admin', 'Production'];

const SUBTRACT_REASONS = {
  taken: 'Taken / used',
  lost: 'Lost / damaged (records material loss)'
};

const formatTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

const LIVE_META = {
  live: { dot: '#10b981', text: 'Live' },
  connecting: { dot: '#f59e0b', text: 'Connecting…' },
  disconnected: { dot: '#94a3b8', text: 'Not live · refreshing every 30s' }
};

const EMPTY_NEW_ITEM = { item_name: '', item_category: '', quantity_available: '', minimum_threshold: '', unit_cost: '' };
const EMPTY_ADJUST = { inventory_id: '', action: 'add', quantity: '', reason: 'taken' };

// '5' -> 5, '' -> null, '2.5' / '-1' / 'abc' -> NaN
const toWholeNumber = (value) => {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  return /^\d+$/.test(text) ? Number(text) : NaN;
};
// '12.5' -> 12.5, '' -> 0, bad -> NaN (at most 2 decimals)
const toMoney = (value) => {
  const text = String(value ?? '').trim();
  if (text === '') return 0;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6 ? Math.round(n * 100) / 100 : NaN;
};
// List view: rows rendered per "page" (more are added with "Show more"), so a catalog with
// thousands of items stays fast and compact.
const LIST_PAGE = 50;
const STATUS_ORDER = { out_of_stock: 0, low_stock: 1, in_stock: 2 };
const SORTERS = {
  name: (a, b) => a.item_name.localeCompare(b.item_name),
  category: (a, b) => a.item_category.localeCompare(b.item_category) || a.item_name.localeCompare(b.item_name),
  status: (a, b) => STATUS_ORDER[a.stock_status] - STATUS_ORDER[b.stock_status] || a.item_name.localeCompare(b.item_name),
  available: (a, b) => a.quantity_available - b.quantity_available,
  free: (a, b) => a.quantity_available_net - b.quantity_available_net
};

// true when the window is narrower than px (hides less important columns on phones)
const useNarrow = (px = 640) => {
  const query = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
};

// Same rule as the backend: case and spaces are ignored ("Deli A4" = "deli  a4" = "DeliA4")
const nameKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

export default function InventoryCatalog({
  items, summary, categories, source, fetchedAt, loading, error, onRefresh,
  liveStatus = 'disconnected', cloudListening = false, recentlyChanged = [],
  apiBase, token, userRole, onUnauthorized
}) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');

  const canEdit = STOCK_EDIT_ROLES.includes(userRole);

  // Manage Stock panel
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState('new'); // 'new' | 'adjust'
  const [newItem, setNewItem] = useState(EMPTY_NEW_ITEM);
  const [adjust, setAdjust] = useState(EMPTY_ADJUST);
  const [panelBusy, setPanelBusy] = useState(false);

  // Pop-ups
  const [result, setResult] = useState(null);          // ResultDialog
  const [editing, setEditing] = useState(null);        // { item, form }
  const [editBusy, setEditBusy] = useState(false);
  const [toDelete, setToDelete] = useState(null);      // item awaiting delete confirmation
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [binOpen, setBinOpen] = useState(false);

  // List view state
  const [expanded, setExpanded] = useState(() => new Set());  // inventory_ids with details open
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const [shown, setShown] = useState(LIST_PAGE);
  const narrow = useNarrow();

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items
      .filter((item) =>
        (!needle || item.item_name.toLowerCase().includes(needle)) &&
        (!category || item.item_category === category) &&
        (!status || item.stock_status === status))
      .sort((a, b) => SORTERS[sort.key](a, b) * sort.dir);
  }, [items, search, category, status, sort]);

  // Back to the first page whenever the filters or sort change
  const filterKey = `${search}|${category}|${status}|${sort.key}|${sort.dir}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setShown(LIST_PAGE);
  }

  const toggleRow = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const sortBy = (key) => setSort((prev) => (prev.key === key ? { key, dir: -prev.dir } : { key, dir: 1 }));

  const totalUnits = useMemo(() => items.reduce((sum, i) => sum + Number(i.quantity_available || 0), 0), [items]);

  const summaryCards = [
    { key: '', label: 'Total Items', value: summary.total_items, color: '#4f46e5', sub: `${totalUnits.toLocaleString()} units on hand` },
    { key: 'in_stock', label: 'In Stock', value: summary.in_stock, color: STATUS_META.in_stock.color },
    { key: 'low_stock', label: 'Low Stock', value: summary.low_stock, color: STATUS_META.low_stock.color },
    { key: 'out_of_stock', label: 'Out of Stock', value: summary.out_of_stock, color: STATUS_META.out_of_stock.color }
  ];

  const offlineSuffix = (data) => (data.source === 'local' ? '\nSaved offline: it will sync to the cloud when the connection returns.' : '');
  const fail = (title, message) => setResult({ type: 'error', title, message });

  // ---------- Panel: new item ----------
  const handleAddItem = async (e) => {
    e.preventDefault();
    const name = newItem.item_name.trim().replace(/\s+/g, ' ');
    const cat = newItem.item_category.trim();
    const qty = toWholeNumber(newItem.quantity_available);
    const min = toWholeNumber(newItem.minimum_threshold);
    const cost = toMoney(newItem.unit_cost);

    if (!name || !cat) return fail('Missing details', 'Item name and category are required.');
    if (Number.isNaN(qty) || Number.isNaN(min)) return fail('Check the numbers', 'Quantity and low-stock alert must be whole numbers (0 or more).');
    if (Number.isNaN(cost)) return fail('Check the unit cost', 'Unit cost must be 0 or more, with at most 2 decimal places.');
    const duplicate = items.find((i) => nameKey(i.item_name) === nameKey(name));
    if (duplicate) {
      return setResult({
        type: 'warning',
        title: 'Duplicate item',
        message: `"${duplicate.item_name}" is already in the catalog, so it was not added again.\nUse "Add / Subtract Stock" to change its quantity.`
      });
    }

    setPanelBusy(true);
    const { ok, status: code, data } = await api('POST', '/inventory', {
      item_name: name, item_category: cat, quantity_available: qty ?? 0, minimum_threshold: min ?? 0, unit_cost: cost
    });
    setPanelBusy(false);

    if (!ok) {
      return setResult({
        type: code === 409 ? 'warning' : 'error',
        title: code === 409 ? 'Duplicate item' : 'Item not added',
        message: errorText(data, 'Could not add the item.')
      });
    }
    setResult({
      type: 'success',
      title: 'Item added',
      message: `"${data.item?.item_name || name}" was added with ${data.item?.quantity_available ?? qty ?? 0} in stock.${offlineSuffix(data)}`
    });
    setNewItem((prev) => ({ ...EMPTY_NEW_ITEM, item_category: prev.item_category })); // keep category for the next entry
    onRefresh();
  };

  // ---------- Panel: add / subtract ----------
  const handleAdjust = async (e) => {
    e.preventDefault();
    const item = items.find((i) => i.inventory_id === adjust.inventory_id);
    const qty = toWholeNumber(adjust.quantity);
    if (!item) return fail('Choose an item', 'Select the item whose stock you want to change.');
    if (!qty || Number.isNaN(qty)) return fail('Check the quantity', 'Quantity must be a whole number greater than 0.');
    if (adjust.action === 'subtract' && qty > item.quantity_available) {
      return fail('Not enough stock', `Cannot subtract ${qty}: only ${item.quantity_available} of "${item.item_name}" in stock.`);
    }

    setPanelBusy(true);
    const id = encodeURIComponent(item.inventory_id);
    const { ok, data } = adjust.action === 'subtract' && adjust.reason === 'lost'
      ? await api('POST', `/inventory/${id}/loss`, { quantity_lost: qty, loss_reason: 'Lost / damaged (manual stock count)' })
      : await api('POST', `/inventory/${id}/adjust`, {
        action: adjust.action, quantity: qty,
        reason: adjust.action === 'add' ? 'Stock received' : 'Taken / used (manual adjustment)'
      });
    setPanelBusy(false);

    if (!ok) return fail('Stock not changed', errorText(data, 'Could not update the stock.'));
    const newQty = data.item?.quantity_available;
    setResult({
      type: 'success',
      title: adjust.action === 'add' ? 'Stock added' : 'Stock subtracted',
      message: `${adjust.action === 'add' ? 'Added' : 'Subtracted'} ${qty} ${adjust.action === 'add' ? 'to' : 'from'} "${item.item_name}".` +
               `${newQty !== undefined ? ` Now ${newQty} in stock.` : ''}${offlineSuffix(data)}`
    });
    setAdjust((prev) => ({ ...prev, quantity: '' }));
    onRefresh();
  };

  // ---------- Card: edit ----------
  const openEdit = (item) => setEditing({
    item,
    form: {
      item_name: item.item_name,
      item_category: item.item_category,
      minimum_threshold: String(item.minimum_threshold),
      unit_cost: String(item.unit_cost)
    }
  });

  const handleEditSave = async (e) => {
    e.preventDefault();
    const { item, form } = editing;
    const name = form.item_name.trim().replace(/\s+/g, ' ');
    const cat = form.item_category.trim();
    const min = toWholeNumber(form.minimum_threshold);
    const cost = toMoney(form.unit_cost);
    if (!name || !cat) return fail('Missing details', 'Item name and category cannot be empty.');
    if (min === null || Number.isNaN(min)) return fail('Check the numbers', 'Low-stock alert must be a whole number (0 or more).');
    if (Number.isNaN(cost)) return fail('Check the unit cost', 'Unit cost must be 0 or more, with at most 2 decimal places.');
    const duplicate = items.find((i) => i.inventory_id !== item.inventory_id && nameKey(i.item_name) === nameKey(name));
    if (duplicate) {
      return setResult({ type: 'warning', title: 'Duplicate name', message: `Another item is already called "${duplicate.item_name}". Choose a different name.` });
    }

    const body = {};
    if (name !== item.item_name) body.item_name = name;
    if (cat !== item.item_category) body.item_category = cat;
    if (min !== item.minimum_threshold) body.minimum_threshold = min;
    if (cost !== item.unit_cost) body.unit_cost = cost;
    if (Object.keys(body).length === 0) {
      setEditing(null);
      return setResult({ type: 'warning', title: 'No changes', message: 'Nothing was changed, so nothing was saved.' });
    }
    if (item.version) body.expected_version = item.version;

    setEditBusy(true);
    const { ok, status: code, data } = await api('PATCH', `/inventory/${encodeURIComponent(item.inventory_id)}`, body);
    setEditBusy(false);
    if (!ok) {
      return setResult({
        type: code === 409 ? 'warning' : 'error',
        title: code === 409 && data.error === 'EDIT_CONFLICT' ? 'Changed by someone else' : code === 409 ? 'Duplicate name' : 'Not saved',
        message: errorText(data, 'Could not save the changes.')
      });
    }
    setEditing(null);
    setResult({ type: 'success', title: 'Item updated', message: `${data.message}${offlineSuffix(data)}` });
    onRefresh();
  };

  // ---------- Card: delete (to Recycle Bin) ----------
  const handleDelete = async () => {
    const item = toDelete;
    setDeleteBusy(true);
    const { ok, data } = await api('DELETE', `/inventory/${encodeURIComponent(item.inventory_id)}`);
    setDeleteBusy(false);
    setToDelete(null);
    if (!ok) return fail('Not deleted', errorText(data, 'Could not delete the item.'));
    setResult({ type: 'success', title: 'Moved to Recycle Bin', message: data.message });
    onRefresh();
  };

  const selectedAdjustItem = items.find((i) => i.inventory_id === adjust.inventory_id);
  const binCount = summary.recycle_bin || 0;

  return (
    <div style={s.root}>
      {/* Category suggestions for the Add and Edit forms */}
      <datalist id="inventory-category-options">
        {categories.map((c) => <option key={c} value={c} />)}
      </datalist>

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
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {canEdit && (
            <button
              type="button"
              onClick={() => setPanelOpen((o) => !o)}
              style={panelOpen ? s.manageBtnActive : s.manageBtn}
              aria-expanded={panelOpen}
            >
              <PackagePlus size={16} /> {panelOpen ? 'Close Stock Manager' : 'Manage Stock'}
            </button>
          )}
          {canEdit && (
            <button type="button" onClick={() => setBinOpen(true)} style={s.refreshBtn} aria-label={`Recycle Bin, ${binCount} items`}>
              <Trash2 size={16} /> Recycle Bin
              {binCount > 0 && <span style={s.binBadge}>{binCount}</span>}
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
            <button type="button" role="tab" aria-selected={panelTab === 'new'} onClick={() => setPanelTab('new')}
              style={panelTab === 'new' ? s.tabActive : s.tab}>
              Add New Item
            </button>
            <button type="button" role="tab" aria-selected={panelTab === 'adjust'} onClick={() => setPanelTab('adjust')}
              style={panelTab === 'adjust' ? s.tabActive : s.tab}>
              Add / Subtract Stock
            </button>
          </div>

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
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Quantity in stock</span>
                <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={newItem.quantity_available}
                  onChange={(e) => setNewItem({ ...newItem, quantity_available: e.target.value })} style={s.input} />
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Low-stock alert at</span>
                <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={newItem.minimum_threshold}
                  onChange={(e) => setNewItem({ ...newItem, minimum_threshold: e.target.value })} style={s.input} />
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Unit cost (₱)</span>
                <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" value={newItem.unit_cost}
                  onChange={(e) => setNewItem({ ...newItem, unit_cost: e.target.value })} style={s.input} />
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
                <select value={adjust.inventory_id} required onChange={(e) => setAdjust({ ...adjust, inventory_id: e.target.value })} style={s.input}>
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
                  <button type="button" onClick={() => setAdjust({ ...adjust, action: 'add' })}
                    style={adjust.action === 'add' ? { ...s.toggle, ...s.toggleAdd } : s.toggle} aria-pressed={adjust.action === 'add'}>
                    <Plus size={16} /> Add stock
                  </button>
                  <button type="button" onClick={() => setAdjust({ ...adjust, action: 'subtract' })}
                    style={adjust.action === 'subtract' ? { ...s.toggle, ...s.toggleSub } : s.toggle} aria-pressed={adjust.action === 'subtract'}>
                    <Minus size={16} /> Subtract stock
                  </button>
                </div>
              </div>
              <label style={s.field}>
                <span style={s.fieldLabel}>Quantity *</span>
                <input type="number" min="1" step="1" inputMode="numeric" required placeholder="1" value={adjust.quantity}
                  onChange={(e) => setAdjust({ ...adjust, quantity: e.target.value })} style={s.input} />
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
                  {selectedAdjustItem.quantity_reserved > 0 && <> ({selectedAdjustItem.quantity_reserved} reserved for orders)</>}.
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
          <button key={card.label} type="button" onClick={() => setStatus(card.key)}
            style={{ ...s.summaryCard, ...(status === card.key ? s.summaryCardActive : {}) }} aria-pressed={status === card.key}>
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
          <input type="text" placeholder="Search materials…" value={search} onChange={(e) => setSearch(e.target.value)}
            style={s.searchInput} aria-label="Search materials" />
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
      {items.length > 0 && visible.length === 0 && <p style={s.empty}>No items match these filters.</p>}

      {visible.length > 0 && (
        <div style={s.list} role="list" aria-label="Stock items">
          {/* Column headers (click to sort) */}
          <div style={{ ...s.row, ...s.headRow, gridTemplateColumns: narrow ? s.colsNarrow : s.cols }} aria-hidden="true">
            <span />
            <SortHeader label="Item" k="name" sort={sort} onSort={sortBy} />
            {!narrow && <SortHeader label="Category" k="category" sort={sort} onSort={sortBy} />}
            <SortHeader label="Status" k="status" sort={sort} onSort={sortBy} />
            <SortHeader label="Available" k="available" sort={sort} onSort={sortBy} align="right" />
            {!narrow && <SortHeader label="Free to use" k="free" sort={sort} onSort={sortBy} align="right" />}
          </div>

          {visible.slice(0, shown).map((item) => {
            const meta = STATUS_META[item.stock_status] || STATUS_META.in_stock;
            const reservedPct = item.quantity_available > 0
              ? Math.min(100, (item.quantity_reserved / item.quantity_available) * 100)
              : 0;
            const id = item.inventory_id;
            const open = expanded.has(id);
            const changed = recentlyChanged.includes(id);
            return (
              <div key={id} data-inventory-id={id} role="listitem"
                style={{ ...s.item, borderLeft: `4px solid ${meta.bar}`, ...(changed ? s.itemChanged : {}), ...(open ? s.itemOpen : {}) }}>
                {/* Summary row: click / Enter / Space to show details */}
                <button
                  type="button"
                  onClick={() => toggleRow(id)}
                  aria-expanded={open}
                  aria-controls={`item-details-${id}`}
                  style={{ ...s.row, ...s.rowBtn, gridTemplateColumns: narrow ? s.colsNarrow : s.cols }}
                >
                  <span style={s.chevron} aria-hidden="true">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={s.itemName}>{item.item_name}</span>
                    {narrow && <span style={s.category}>{item.item_category}</span>}
                    {item.sync_status !== 'synced' && <span style={s.pending}>Pending sync</span>}
                  </span>
                  {!narrow && <span style={s.category}>{item.item_category}</span>}
                  <span><span style={{ ...s.badge, background: meta.bg, color: meta.color }}>{meta.label}</span></span>
                  <span style={s.num}>{item.quantity_available.toLocaleString()}</span>
                  {!narrow && <strong style={{ ...s.num, color: meta.color }}>{item.quantity_available_net.toLocaleString()}</strong>}
                </button>

                {/* Details (everything the old card showed, plus stock value) */}
                {open && (
                  <div id={`item-details-${id}`} style={s.details}>
                    <div style={s.stats}>
                      <Stat label="Available" value={item.quantity_available} />
                      <Stat label="Reserved" value={item.quantity_reserved} />
                      <Stat label="Free to use" value={item.quantity_available_net} color={meta.color} />
                      <Stat label="Min. Threshold" value={item.minimum_threshold} />
                      <Stat label="Unit cost" value={peso(item.unit_cost)} />
                      <Stat label="Stock value" value={peso(item.quantity_available * item.unit_cost)} />
                    </div>

                    {/* Reserved share of on-hand stock */}
                    <div style={s.barLabel}>
                      <span>Reserved for orders</span>
                      <span>{item.quantity_reserved} of {item.quantity_available} ({Math.round(reservedPct)}%)</span>
                    </div>
                    <div style={s.barTrack} aria-hidden="true">
                      <div style={{ ...s.barFill, width: `${reservedPct}%`, background: meta.bar }} />
                    </div>

                    <div style={s.detailsFoot}>
                      <span style={s.category}>
                        Category: <strong>{item.item_category}</strong>
                        {item.sync_status !== 'synced' && ' · Saved offline, waiting to sync'}
                      </span>
                      {canEdit && (
                        <div style={s.cardActions}>
                          <button type="button" onClick={() => openEdit(item)} style={s.editBtn} aria-label={`Edit ${item.item_name}`}>
                            <Pencil size={14} /> Edit
                          </button>
                          <button type="button" onClick={() => setToDelete(item)} style={s.deleteBtn} aria-label={`Delete ${item.item_name}`}>
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div style={s.listFoot}>
            <span>Showing {Math.min(shown, visible.length)} of {visible.length}</span>
            <span style={{ display: 'flex', gap: '0.5rem' }}>
              {expanded.size > 0 && (
                <button type="button" onClick={() => setExpanded(new Set())} style={s.linkBtn}>Collapse all</button>
              )}
              {shown < visible.length && (
                <button type="button" onClick={() => setShown((n) => n + LIST_PAGE)} style={s.moreBtn}>
                  Show {Math.min(LIST_PAGE, visible.length - shown)} more
                </button>
              )}
            </span>
          </div>
        </div>
      )}

      {/* Edit item window */}
      {editing && (
        <div style={s.overlay} onClick={editBusy ? undefined : () => setEditing(null)}>
          <form role="dialog" aria-modal="true" aria-labelledby="edit-item-title" onSubmit={handleEditSave}
            style={s.modal} onClick={(e) => e.stopPropagation()}>
            <div style={s.panelHead}>
              <h3 id="edit-item-title" style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a' }}>Edit Item</h3>
              <button type="button" onClick={() => setEditing(null)} style={s.panelClose} aria-label="Close" disabled={editBusy}>
                <X size={18} />
              </button>
            </div>
            <div style={s.formGrid}>
              <label style={{ ...s.field, gridColumn: '1 / -1' }}>
                <span style={s.fieldLabel}>Item name *</span>
                <input type="text" maxLength={255} required value={editing.form.item_name} style={s.input} autoFocus
                  onChange={(e) => setEditing({ ...editing, form: { ...editing.form, item_name: e.target.value } })} />
              </label>
              <label style={{ ...s.field, gridColumn: '1 / -1' }}>
                <span style={s.fieldLabel}>Category *</span>
                <input type="text" maxLength={100} required list="inventory-category-options" value={editing.form.item_category} style={s.input}
                  onChange={(e) => setEditing({ ...editing, form: { ...editing.form, item_category: e.target.value } })} />
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Low-stock alert at</span>
                <input type="number" min="0" step="1" inputMode="numeric" required value={editing.form.minimum_threshold} style={s.input}
                  onChange={(e) => setEditing({ ...editing, form: { ...editing.form, minimum_threshold: e.target.value } })} />
              </label>
              <label style={s.field}>
                <span style={s.fieldLabel}>Unit cost (₱)</span>
                <input type="number" min="0" step="0.01" inputMode="decimal" value={editing.form.unit_cost} style={s.input}
                  onChange={(e) => setEditing({ ...editing, form: { ...editing.form, unit_cost: e.target.value } })} />
              </label>
              <p style={{ ...s.hint, gridColumn: '1 / -1' }}>
                Stock on hand: <strong>{editing.item.quantity_available}</strong>. To change the quantity, use
                {' '}<strong>Manage Stock → Add / Subtract Stock</strong>, so every stock movement is recorded.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', gridColumn: '1 / -1', justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setEditing(null)} style={s.refreshBtn} disabled={editBusy}>Cancel</button>
                <button type="submit" style={s.submitBtn} disabled={editBusy}>{editBusy ? 'Saving…' : 'Save Changes'}</button>
              </div>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(toDelete)}
        title="Move to Recycle Bin?"
        message={toDelete ? `"${toDelete.item_name}" will be removed from the catalog and kept in the Recycle Bin, where you can restore it at any time.` : ''}
        confirmLabel="Move to Recycle Bin"
        danger
        busy={deleteBusy}
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
      />

      {binOpen && (
        <RecycleBin
          apiBase={apiBase}
          token={token}
          userRole={userRole}
          onUnauthorized={onUnauthorized}
          onClose={() => setBinOpen(false)}
          onResult={(r) => { setResult(r); onRefresh(); }}
          refreshKey={`${binCount}:${fetchedAt}`}
        />
      )}

      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

function SortHeader({ label, k, sort, onSort, align = 'left' }) {
  const active = sort.key === k;
  return (
    <button type="button" onClick={() => onSort(k)} style={{ ...s.sortBtn, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}
      aria-label={`Sort by ${label}`}>
      {label}
      {active && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </button>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={s.stat}>
      <span style={s.statLabel}>{label}</span>
      <span style={{ ...s.statValue, ...(color ? { color } : {}) }}>{value}</span>
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
  refreshBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.875rem' },
  binBadge: { marginLeft: '0.25rem', minWidth: '1.25rem', padding: '0 0.35rem', background: '#ef4444', color: '#fff', borderRadius: '999px', fontSize: '0.7rem', lineHeight: '1.25rem', textAlign: 'center' },
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
  submitBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', padding: '0.75rem 1.25rem', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.9rem' },

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
  // List view: one compact row per item; details open below the row
  list: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', overflow: 'hidden' },
  cols: '1.5rem minmax(0, 3fr) minmax(0, 1.4fr) 7.5rem 5.5rem 6rem',
  colsNarrow: '1.25rem minmax(0, 1fr) 6.5rem 4.5rem',
  row: { display: 'grid', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', width: '100%', boxSizing: 'border-box' },
  headRow: { background: '#f8fafc', borderBottom: '1px solid #e2e8f0', paddingLeft: 'calc(0.75rem + 4px)' },
  sortBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: '0.7rem', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.03em' },
  item: { borderBottom: '1px solid #f1f5f9', transition: 'background-color 0.6s ease' },
  itemOpen: { background: '#fafbff' },
  itemChanged: { backgroundColor: '#eef2ff' },
  rowBtn: { background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit' },
  chevron: { display: 'flex', color: '#64748b' },
  // Full title is shown (wraps) so long product names stay readable
  itemName: { display: 'block', fontSize: '0.92rem', fontWeight: 'bold', color: '#0f172a', lineHeight: 1.3, overflowWrap: 'anywhere' },
  category: { display: 'block', fontSize: '0.8rem', color: '#64748b', overflowWrap: 'anywhere' },
  badge: { display: 'inline-block', whiteSpace: 'nowrap', padding: '0.2rem 0.45rem', borderRadius: '0.25rem', fontSize: '0.65rem', fontWeight: 'bold', textTransform: 'uppercase' },
  num: { textAlign: 'right', fontSize: '0.92rem', color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  details: { padding: '0.25rem 1rem 1rem calc(0.75rem + 1.5rem + 0.75rem)' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.5rem', marginBottom: '0.75rem' },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '0.45rem 0.6rem', background: '#f1f5f9', borderRadius: '0.375rem' },
  statLabel: { fontSize: '0.65rem', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' },
  statValue: { fontSize: '1rem', fontWeight: 'bold', color: '#0f172a' },
  barLabel: { display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#475569', marginBottom: '0.25rem' },
  barTrack: { height: '6px', background: '#e2e8f0', borderRadius: '3px', overflow: 'hidden', marginBottom: '0.75rem' },
  barFill: { height: '100%', borderRadius: '3px' },
  detailsFoot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' },
  cardActions: { display: 'flex', gap: '0.5rem' },
  editBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem', padding: '0.4rem 0.9rem', background: '#fff', border: '1px solid #c7d2fe', borderRadius: '0.375rem', cursor: 'pointer', color: '#4338ca', fontWeight: 'bold', fontSize: '0.8rem' },
  deleteBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem', padding: '0.4rem 0.9rem', background: '#fff', border: '1px solid #fecaca', borderRadius: '0.375rem', cursor: 'pointer', color: '#b91c1c', fontWeight: 'bold', fontSize: '0.8rem' },
  listFoot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.75rem', background: '#f8fafc', fontSize: '0.8rem', color: '#64748b', flexWrap: 'wrap' },
  moreBtn: { padding: '0.35rem 0.9rem', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.8rem' },
  linkBtn: { padding: '0.35rem 0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.8rem' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 },
  modal: { background: '#fff', borderRadius: '0.5rem', borderTop: '4px solid #4f46e5', padding: '1.25rem', width: '100%', maxWidth: '520px', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.25)', textAlign: 'left' },
  pending: { display: 'inline-block', marginTop: '0.2rem', padding: '0.05rem 0.45rem', background: '#e0e7ff', color: '#4f46e5', borderRadius: '999px', fontSize: '0.65rem', fontWeight: 'bold' }
};

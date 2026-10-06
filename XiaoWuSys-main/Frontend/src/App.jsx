import { useState, useEffect, useCallback } from 'react';
import { Package, PlusCircle, TrendingUp, LogOut, TriangleAlert, Clock, XCircle, Trash2, Plus, X } from 'lucide-react';
import { io } from 'socket.io-client';
import InventoryCatalog from './InventoryCatalog';

const API_BASE = 'http://localhost:5000/api';
const SOCKET_URL = API_BASE.replace(/\/api\/?$/, '');

const emptyOrderLine = () => ({ inventory_id: '', quantity_needed: '' });

// Polling is only a fallback for when the real-time socket is disconnected
const INVENTORY_POLL_MS = 30000;
const CHANGE_HIGHLIGHT_MS = 2500;

// GET /api/inventory. Never throws: resolves to { ok, status, data } or { networkError }.
const fetchInventorySnapshot = async (token) => {
  try {
    const res = await fetch(`${API_BASE}/inventory`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error('Failed to fetch inventory', err);
    return { networkError: true };
  }
};
const EMPTY_SUMMARY = { total_items: 0, in_stock: 0, low_stock: 0, out_of_stock: 0, unsynced: 0, stock_value: 0 };

// 'YYYY-MM-DD' for the day after the given date string (used as the min for a delayed deadline)
const dayAfter = (dateStr) => {
  const base = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  base.setDate(base.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
};

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('xiaomei_token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('xiaomei_user')) || null);
  const [activeTab, setActiveTab] = useState('catalog');

  // Auth Form State for XiaoMei Printing
  // Public sign-up was removed (audit C1): accounts are created by an Admin.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // Create Order Profile State
  const [customerId, setCustomerId] = useState('');
  const [productionDeadline, setProductionDeadline] = useState('');
  const [orderStatusMsg, setOrderStatusMsg] = useState('');

  // Inventory snapshot from GET /api/inventory, shared by Catalog, Create Order and Analytics
  const [inventory, setInventory] = useState([]);
  const [inventoryMeta, setInventoryMeta] = useState({ summary: EMPTY_SUMMARY, categories: [], source: null, fetchedAt: null });
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState('');
  // Real-time push: 'connecting' | 'live' | 'disconnected'; cloudListening = cross-branch NOTIFY active
  const [liveStatus, setLiveStatus] = useState('connecting');
  const [cloudListening, setCloudListening] = useState(false);
  const [recentlyChanged, setRecentlyChanged] = useState([]);

  // Sprint 9: Order materials + Capacity Alert (PB 9 & PB 10)
  const [orderLines, setOrderLines] = useState([emptyOrderLine()]);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [capacityAlert, setCapacityAlert] = useState(null); // { message, shortages, total_shortfall, pendingOrder }
  const [alertMode, setAlertMode] = useState('choose');      // 'choose' | 'delay'
  const [delayedDeadline, setDelayedDeadline] = useState('');
  const [alertError, setAlertError] = useState('');

  const handleLogout = useCallback(() => {
    setToken('');
    setUser(null);
    localStorage.removeItem('xiaomei_token');
    localStorage.removeItem('xiaomei_user');
  }, []);

  // Applies one GET /api/inventory result. Only ever called from a promise callback.
  const applyInventoryResult = ({ ok, status, data, networkError }) => {
    setInventoryLoading(false);
    if (networkError) {
      setInventoryError('Cannot reach the server. Showing the last loaded data.');
      return;
    }
    if (status === 401) {
      handleLogout(); // expired session
      return;
    }
    if (!ok) {
      setInventoryError(data.message || data.error || 'Could not load inventory.');
      return;
    }
    setInventory(Array.isArray(data.items) ? data.items : []);
    setInventoryMeta({
      summary: data.summary || EMPTY_SUMMARY,
      categories: Array.isArray(data.categories) ? data.categories : [],
      source: data.source || null,
      fetchedAt: data.fetched_at || new Date().toISOString()
    });
    setInventoryError('');
  };

  // Bumping this re-runs the load effect (manual refresh, after an order is saved)
  const [inventoryTick, setInventoryTick] = useState(0);
  const refreshInventory = () => {
    setInventoryLoading(true);
    setInventoryTick(t => t + 1);
  };

  // Real-time stock updates over Socket.io (server pushes a full snapshot on every change)
  useEffect(() => {
    if (!token) return undefined;
    const socket = io(SOCKET_URL, { auth: { token }, transports: ['websocket', 'polling'] });
    let highlightTimer = null;

    socket.on('connect', () => {
      setLiveStatus('live');
      socket.emit('inventory_subscribe', {}, (reply) => {
        if (!reply) return;
        setCloudListening(Boolean(reply.listening));
        if (reply.ok) applyInventoryResult({ ok: true, status: 200, data: reply.snapshot });
      });
    });
    socket.on('disconnect', () => setLiveStatus('disconnected'));
    socket.on('connect_error', () => setLiveStatus('disconnected'));
    socket.on('inventory_live', ({ listening }) => setCloudListening(Boolean(listening)));
    socket.on('inventory_updated', ({ changed_ids, snapshot }) => {
      applyInventoryResult({ ok: true, status: 200, data: snapshot });
      if (Array.isArray(changed_ids) && changed_ids.length > 0) {
        setRecentlyChanged(changed_ids);
        clearTimeout(highlightTimer);
        highlightTimer = setTimeout(() => setRecentlyChanged([]), CHANGE_HIGHLIGHT_MS);
      }
    });

    return () => {
      clearTimeout(highlightTimer);
      socket.disconnect();
    };
    // applyInventoryResult only calls state setters, which are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Load on login / tab change / refresh; poll only while the socket is down
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const load = () => fetchInventorySnapshot(token).then(result => {
      if (!cancelled) applyInventoryResult(result);
    });
    load();
    const timer = (activeTab === 'add' || liveStatus === 'live') ? null : setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, INVENTORY_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // applyInventoryResult only calls state setters, which are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeTab, inventoryTick, liveStatus]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password })
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.token) {
        const activeUser = { username: username.trim(), role: data.role };
        setToken(data.token);
        localStorage.setItem('xiaomei_token', data.token);
        setUser(activeUser);
        localStorage.setItem('xiaomei_user', JSON.stringify(activeUser));
        setPassword('');
      } else {
        setAuthError(data.error || 'Authentication failed');
      }
    } catch (err) {
      console.error('Server connection error:', err);
      setAuthError('Failed to connect to the backend.');
    }
  };

  const postOrder = async (payload) => {
    const res = await fetch(`${API_BASE}/orders`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` 
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const resetOrderForm = () => {
    setCustomerId('');
    setProductionDeadline('');
    setOrderLines([emptyOrderLine()]);
  };

  const closeCapacityAlert = () => {
    setCapacityAlert(null);
    setAlertMode('choose');
    setDelayedDeadline('');
    setAlertError('');
  };

  const updateOrderLine = (index, field, value) => {
    setOrderLines(lines => lines.map((line, i) => (i === index ? { ...line, [field]: value } : line)));
  };

  const handleCreateOrder = async (e) => {
    e.preventDefault();
    setOrderStatusMsg('');

    const required_items = orderLines.map(line => ({
      inventory_id: line.inventory_id,
      quantity_needed: Number(line.quantity_needed)
    }));
    const pendingOrder = {
      customer_id: customerId,
      production_deadline: productionDeadline,
      required_items
    };

    setIsSubmittingOrder(true);
    try {
      const { res, data } = await postOrder(pendingOrder);

      if (res.ok) {
        setOrderStatusMsg(`Order Created Successfully! ID: ${data.order_id || data.id || ''}`);
        resetOrderForm();
        refreshInventory();
      } else if (res.status === 409) {
        // PB 9 halt caught -> PB 10 warning modal
        setCapacityAlert({
          message: data.message,
          shortages: data.shortages || [],
          total_shortfall: data.total_shortfall || 0,
          pendingOrder
        });
      } else {
        const missing = data.missing_inventory_ids ? ` (${data.missing_inventory_ids.join(', ')})` : '';
        setOrderStatusMsg(`Error: ${data.message || data.error || 'Failed to create order.'}${missing}`);
      }
    } catch (err) {
      console.error('Error creating order:', err);
      setOrderStatusMsg('Error: Network connection failure.');
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  // PB 10: log the staff member's resolution for a halted order
  const handleResolveHaltedOrder = async (resolution) => {
    if (!capacityAlert) return;
    setAlertError('');

    if (resolution === 'Delayed' && !delayedDeadline) {
      setAlertError('Please choose a new production deadline.');
      return;
    }

    const { pendingOrder } = capacityAlert;
    const production_deadline = resolution === 'Delayed' ? delayedDeadline : pendingOrder.production_deadline;

    setIsSubmittingOrder(true);
    try {
      const { res, data } = await postOrder({ ...pendingOrder, production_deadline, resolution });

      if (res.ok) {
        const id = data.order_id || data.id || '';
        setOrderStatusMsg(
          resolution === 'Delayed'
            ? `Notice: Order ${id} logged as DELAYED. New deadline: ${production_deadline}.`
            : `Notice: Order ${id} logged as CANCELLED (lost sale recorded).`
        );
        resetOrderForm();
        closeCapacityAlert();
      } else {
        setAlertError(data.error || 'Failed to log resolution.');
      }
    } catch (err) {
      console.error('Error logging resolution:', err);
      setAlertError('Network connection failure.');
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  const lowStockItems = inventory.filter(item => item.stock_status !== 'in_stock');

  if (!token) {
    return (
      <div style={styles.authContainer}>
        <div style={styles.authCard}>
          <h2>User Login</h2>

          {authError && (
            <p style={{ padding: '0.75rem', borderRadius: '0.375rem', margin: '1rem 0 0', fontSize: '0.875rem', backgroundColor: '#fee2e2', color: '#991b1b' }}>
              {authError}
            </p>
          )}

          <form onSubmit={handleAuth} style={{ marginTop: '1rem' }}>
            <input 
              type="text" 
              placeholder="Username or Email" 
              autoComplete="username"
              value={username} 
              onChange={e => setUsername(e.target.value)} 
              style={styles.input} 
              required 
            />

            <input 
              type="password" 
              placeholder="Password" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              style={styles.input} 
              required 
            />

            <button type="submit" style={styles.btnPrimary}>Log In</button>
          </form>

          <p style={styles.authHint}>
            Need an account? Ask an Admin to create one for you.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: '#f8fafc', minHeight: '100vh', fontFamily: 'sans-serif' }}>
      <header style={styles.header}>
        <h1 style={{ fontSize: '1.45rem', fontWeight: 'bold', color: '#08060d', userSelect: 'none' }}>
          Hello, {user?.username || 'Dashboard'}
        </h1>
        <nav style={styles.nav}>
          <button style={activeTab === 'catalog' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('catalog')}>
            <Package size={18} /> Catalog
          </button>
          <button style={activeTab === 'add' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('add')}>
            <PlusCircle size={18} /> Create Order
          </button>
          <button style={activeTab === 'metrics' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('metrics')}>
            <TrendingUp size={18} /> Analytics
          </button>
          <button style={styles.navBtn} onClick={handleLogout}>
            <LogOut size={18} /> Logout
          </button>
        </nav>
      </header>

      <main style={{ maxWidth: '1000px', margin: '2rem auto', padding: '0 1rem' }}>
        {activeTab === 'catalog' && (
          <InventoryCatalog
            items={inventory}
            summary={inventoryMeta.summary}
            categories={inventoryMeta.categories}
            source={inventoryMeta.source}
            fetchedAt={inventoryMeta.fetchedAt}
            loading={inventoryLoading}
            error={inventoryError}
            onRefresh={refreshInventory}
            liveStatus={liveStatus}
            cloudListening={cloudListening}
            recentlyChanged={recentlyChanged}
          />
        )}

        {activeTab === 'add' && (
          <div style={styles.formCard}>
            <h2 style={{ textAlign: 'center', marginBottom: '1rem' }}>Create Order Profile</h2>
            
            {orderStatusMsg && (
              <p style={{
                padding: '0.75rem',
                borderRadius: '0.375rem',
                marginBottom: '1rem',
                fontSize: '0.875rem',
                backgroundColor: orderStatusMsg.startsWith('Error') ? '#fee2e2' : orderStatusMsg.startsWith('Notice') ? '#fef3c7' : '#dcfce7',
                color: orderStatusMsg.startsWith('Error') ? '#991b1b' : orderStatusMsg.startsWith('Notice') ? '#92400e' : '#166534'
              }}>
                {orderStatusMsg}
              </p>
            )}

            <form onSubmit={handleCreateOrder}>
              <label style={styles.label}>Customer ID</label>
              <input 
                type="text" 
                placeholder="Enter Customer ID" 
                value={customerId} 
                onChange={e => setCustomerId(e.target.value)} 
                style={styles.input} 
                required 
              />

              <label style={styles.label}>Production Deadline</label>
              <input 
                type="date" 
                value={productionDeadline} 
                onChange={e => setProductionDeadline(e.target.value)} 
                style={styles.input} 
                required 
              />

              <label style={styles.label}>Required Materials</label>
              {inventory.length === 0 && (
                <p style={styles.hint}>No inventory items found. Add inventory before creating orders.</p>
              )}
              {orderLines.map((line, index) => (
                <div key={index} style={styles.lineRow}>
                  <select
                    value={line.inventory_id}
                    onChange={e => updateOrderLine(index, 'inventory_id', e.target.value)}
                    style={{ ...styles.input, flex: 2, marginBottom: 0 }}
                    aria-label={`Material ${index + 1}`}
                    required
                  >
                    <option value="">Select material…</option>
                    {inventory.map(inv => (
                      <option key={inv.inventory_id} value={inv.inventory_id}>
                        {inv.item_name} ({inv.quantity_available_net} available)
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Qty"
                    value={line.quantity_needed}
                    onChange={e => updateOrderLine(index, 'quantity_needed', e.target.value)}
                    style={{ ...styles.input, flex: 1, marginBottom: 0 }}
                    aria-label={`Quantity ${index + 1}`}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setOrderLines(lines => lines.filter((_, i) => i !== index))}
                    style={styles.iconBtn}
                    disabled={orderLines.length === 1}
                    aria-label={`Remove material ${index + 1}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setOrderLines(lines => [...lines, emptyOrderLine()])}
                style={styles.btnLink}
              >
                <Plus size={16} /> Add Material
              </button>

              <button type="submit" style={styles.btnPrimary} disabled={isSubmittingOrder}>
                {isSubmittingOrder ? 'Checking Inventory…' : 'Create Order Profile'}
              </button>
            </form>
          </div>
        )}

        {capacityAlert && (
          <div style={styles.modalOverlay}>
            <div role="dialog" aria-modal="true" aria-labelledby="capacity-alert-title" style={styles.modalCard}>
              <button type="button" onClick={closeCapacityAlert} style={styles.modalClose} aria-label="Back to order form">
                <X size={18} />
              </button>

              <div style={styles.modalHeader}>
                <TriangleAlert size={28} color="#b45309" />
                <h2 id="capacity-alert-title" style={{ fontSize: '1.2rem', margin: 0, color: '#92400e' }}>
                  Order Exceeds Maximum Inventory
                </h2>
              </div>
              <p style={{ fontSize: '0.875rem', color: '#334155', margin: '0.75rem 0' }}>
                {capacityAlert.message || 'This order cannot be approved with current stock.'} Please log how this order will be handled.
              </p>

              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Material</th>
                    <th style={styles.thNum}>Requested</th>
                    <th style={styles.thNum}>Available</th>
                    <th style={styles.thNum}>Shortfall</th>
                  </tr>
                </thead>
                <tbody>
                  {capacityAlert.shortages.map(s => (
                    <tr key={s.inventory_id}>
                      <td style={styles.td}>{s.item_name}</td>
                      <td style={styles.tdNum}>{s.requested}</td>
                      <td style={styles.tdNum}>{s.available}</td>
                      <td style={{ ...styles.tdNum, color: '#991b1b', fontWeight: 'bold' }}>-{s.shortfall}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {alertError && (
                <p style={{ padding: '0.5rem', borderRadius: '0.375rem', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
                  {alertError}
                </p>
              )}

              {alertMode === 'choose' ? (
                <div style={styles.modalActions}>
                  <button
                    type="button"
                    onClick={() => { setAlertError(''); setAlertMode('delay'); }}
                    style={styles.btnWarning}
                    disabled={isSubmittingOrder}
                  >
                    <Clock size={16} /> Delay Order
                  </button>
                  <button
                    type="button"
                    onClick={() => handleResolveHaltedOrder('Cancelled')}
                    style={styles.btnDanger}
                    disabled={isSubmittingOrder}
                  >
                    <XCircle size={16} /> Cancel Order
                  </button>
                </div>
              ) : (
                <div>
                  <label style={styles.label} htmlFor="delayed-deadline">New Production Deadline</label>
                  <input
                    id="delayed-deadline"
                    type="date"
                    min={dayAfter(capacityAlert.pendingOrder.production_deadline)}
                    value={delayedDeadline}
                    onChange={e => setDelayedDeadline(e.target.value)}
                    style={styles.input}
                  />
                  <div style={styles.modalActions}>
                    <button
                      type="button"
                      onClick={() => { setAlertError(''); setAlertMode('choose'); }}
                      style={{ ...styles.btnSecondary, marginTop: 0, width: 'auto', flex: 1 }}
                      disabled={isSubmittingOrder}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResolveHaltedOrder('Delayed')}
                      style={styles.btnWarning}
                      disabled={isSubmittingOrder}
                    >
                      <Clock size={16} /> {isSubmittingOrder ? 'Saving…' : 'Confirm Delay'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'metrics' && (
          <div>
            <div style={styles.metricsGrid}>
              <div style={styles.metricCard}>
                <h4>Total Items</h4>
                <p>{inventoryMeta.summary.total_items}</p>
              </div>
              <div style={styles.metricCard}>
                <h4>Stock Value</h4>
                <p>₱{inventoryMeta.summary.stock_value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
              <div style={styles.metricCard}>
                <h4>Low Stock</h4>
                <p style={{ color: '#92400e' }}>{inventoryMeta.summary.low_stock}</p>
              </div>
              <div style={styles.metricCard}>
                <h4>Out of Stock</h4>
                <p style={{ color: '#991b1b' }}>{inventoryMeta.summary.out_of_stock}</p>
              </div>
            </div>

            <div style={{ ...styles.formCard, maxWidth: 'none', marginTop: '1.5rem', padding: '1.5rem' }}>
              <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>Needs Restocking</h3>
              {lowStockItems.length === 0 ? (
                <p style={styles.hint}>All materials are above their minimum threshold.</p>
              ) : (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Material</th>
                      <th style={styles.thNum}>Available</th>
                      <th style={styles.thNum}>Reserved</th>
                      <th style={styles.thNum}>Min. Threshold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowStockItems.map(item => (
                      <tr key={item.inventory_id}>
                        <td style={styles.td}>{item.item_name}</td>
                        <td style={styles.tdNum}>{item.quantity_available}</td>
                        <td style={styles.tdNum}>{item.quantity_reserved}</td>
                        <td style={{ ...styles.tdNum, fontWeight: 'bold' }}>{item.minimum_threshold}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const styles = {
  authContainer: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8fafc' },
  authCard: { background: '#fff', padding: '2rem', borderRadius: '0.5rem', width: '100%', maxWidth: '400px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' },
  label: { display: 'block', fontSize: '0.875rem', fontWeight: 'bold', marginBottom: '0.25rem', color: '#334155' },
  input: { width: '100%', padding: '0.75rem', marginBottom: '1rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', boxSizing: 'border-box' },
  btnPrimary: { width: '100%', padding: '0.75rem', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 'bold' },
  authHint: { marginTop: '1rem', color: '#64748b', textAlign: 'center', fontSize: '0.875rem' },
  header: { background: '#fff', padding: '1rem 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0' },
  nav: { display: 'flex', gap: '0.5rem' },
  navBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  navActive: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: '#e0e7ff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold' },
  btnSecondary: { width: '100%', padding: '0.5rem', marginTop: '1rem', background: '#94a3b8', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer' },
  formCard: { background: '#fff', padding: '2rem', borderRadius: '0.5rem', maxWidth: '500px', margin: '0 auto', border: '1px solid #e2e8f0' },
  metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' },
  metricCard: { background: '#fff', padding: '1.5rem', borderRadius: '0.5rem', border: '1px solid #e2e8f0', textAlign: 'center' },

  // Sprint 9: Order materials + Capacity Alert modal
  hint: { fontSize: '0.8rem', color: '#64748b', marginBottom: '0.5rem' },
  lineRow: { display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' },
  iconBtn: { padding: '0.6rem', background: 'none', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#64748b' },
  btnLink: { display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'none', border: 'none', color: '#4f46e5', cursor: 'pointer', fontSize: '0.875rem', padding: '0.25rem 0', marginBottom: '1rem' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 50 },
  modalCard: { position: 'relative', background: '#fff', padding: '1.5rem', borderRadius: '0.5rem', width: '100%', maxWidth: '520px', borderTop: '4px solid #f59e0b', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.25)' },
  modalClose: { position: 'absolute', top: '0.75rem', right: '0.75rem', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  modalHeader: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  modalActions: { display: 'flex', gap: '0.5rem', marginTop: '1rem' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem', marginBottom: '0.75rem' },
  th: { textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid #e2e8f0', color: '#334155' },
  thNum: { textAlign: 'right', padding: '0.5rem', borderBottom: '1px solid #e2e8f0', color: '#334155' },
  td: { padding: '0.5rem', borderBottom: '1px solid #f1f5f9' },
  tdNum: { textAlign: 'right', padding: '0.5rem', borderBottom: '1px solid #f1f5f9' },
  btnWarning: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem', padding: '0.75rem', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 'bold' },
  btnDanger: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem', padding: '0.75rem', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 'bold' }
};
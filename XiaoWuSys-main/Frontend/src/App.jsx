import { useState, useEffect, useCallback, useMemo } from 'react';
import { Package, PlusCircle, LogOut, TriangleAlert, Clock, XCircle, Trash2, Plus, X, ClipboardList, LayoutDashboard, Users, KeyRound } from 'lucide-react';
import { io } from 'socket.io-client';
import InventoryCatalog from './InventoryCatalog';
import OrdersPage from './OrdersPage';
import Dashboard from './Dashboard';
import UsersPage, { ChangePasswordDialog } from './UsersPage';
import { API_BASE, SOCKET_URL } from './config';
import { ResultDialog } from './Dialogs';
import { createApi, errorText, todayInManila, MOBILE_PATTERN } from './api';


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
  const [changingPassword, setChangingPassword] = useState(false);

  // Auth Form State for XiaoMei Printing
  // Public sign-up was removed (audit C1): accounts are created by an Admin.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // Create Order Profile State
  const [customerId, setCustomerId] = useState('');
  // Customer picker: choose a saved customer or type a new one (POST /api/customers)
  const [customers, setCustomers] = useState([]);
  const [customersTick, setCustomersTick] = useState(0);
  const [newCustomerMode, setNewCustomerMode] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ full_name: '', contact_number: '', platform_source: '' });
  const [quoteAmount, setQuoteAmount] = useState('');
  const [orderResult, setOrderResult] = useState(null); // ResultDialog after creating an order
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0);
  const [productionDeadline, setProductionDeadline] = useState('');

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
      setInventoryError('The system could not be reached. Showing the last loaded data.');
      return;
    }
    if (status === 401) {
      handleLogout(); // expired session
      return;
    }
    if (!ok) {
      setInventoryError(errorText(data, 'The inventory could not be loaded. Please press Refresh.'));
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

  const api = useMemo(() => createApi({ apiBase: API_BASE, token, onUnauthorized: handleLogout }), [token, handleLogout]);

  useEffect(() => {
    if (!token || activeTab !== 'add') return undefined;
    let cancelled = false;
    api('GET', '/customers').then(({ ok, data }) => {
      if (cancelled || !ok) return;
      const list = data.customers || [];
      setCustomers(list);
      if (list.length === 0) setNewCustomerMode(true);
    });
    return () => { cancelled = true; };
  }, [api, token, activeTab, customersTick]);

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
        const activeUser = data.user
          ? { user_id: data.user.user_id, username: data.user.username, role: data.user.role }
          : { username: username.trim(), role: data.role };
        setToken(data.token);
        localStorage.setItem('xiaomei_token', data.token);
        setUser(activeUser);
        localStorage.setItem('xiaomei_user', JSON.stringify(activeUser));
        setPassword('');
      } else {
        setAuthError(errorText(data, 'Login failed. Please try again.'));
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
    setQuoteAmount('');
    setNewCustomer({ full_name: '', contact_number: '', platform_source: '' });
    setNewCustomerMode(false);
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

    const required_items = orderLines.map(line => ({
      inventory_id: line.inventory_id,
      quantity_needed: Number(line.quantity_needed)
    }));
    const quote = quoteAmount.trim() === '' ? 0 : Number(quoteAmount);
    if (!Number.isFinite(quote) || quote < 0 || Math.abs(Math.round(quote * 100) - quote * 100) > 1e-6) {
      setOrderResult({ type: 'error', title: 'Please check the quote amount', message: 'The quote must be a peso amount of 0 or more, like 1500 or 1500.50.' });
      return;
    }
    if (!productionDeadline) {
      setOrderResult({ type: 'error', title: 'Please choose a deadline', message: 'Pick the date when this order should be finished.' });
      return;
    }
    if (productionDeadline < todayInManila()) {
      setOrderResult({
        type: 'error',
        title: 'Please choose another deadline',
        message: 'The deadline you picked has already passed. Please choose today or a later date.'
      });
      return;
    }
    if (newCustomerMode && newCustomer.contact_number && !MOBILE_PATTERN.test(newCustomer.contact_number)) {
      setOrderResult({
        type: 'error',
        title: 'Please check the mobile number',
        message: 'A mobile number must be exactly 11 digits and start with 0, like 09171234567.\nYou can also leave it blank.'
      });
      return;
    }

    setIsSubmittingOrder(true);
    try {
      // 1) Customer: saved one, or create the new one first
      let resolvedCustomerId = customerId;
      if (newCustomerMode) {
        const name = newCustomer.full_name.trim();
        if (!name) {
          setOrderResult({ type: 'error', title: 'Customer name needed', message: "Please type the customer's name, or pick a saved customer from the list." });
          return;
        }
        const created = await api('POST', '/customers', {
          full_name: name,
          contact_number: newCustomer.contact_number || undefined,
          platform_source: newCustomer.platform_source.trim() || undefined
        });
        if (created.ok) {
          resolvedCustomerId = created.data.customer.customer_id;
        } else if (created.status === 409 && created.data.existing) {
          resolvedCustomerId = created.data.existing.customer_id; // same customer already saved: reuse it
        } else {
          setOrderResult({ type: 'error', title: 'The customer could not be saved', message: errorText(created.data, 'The customer could not be saved. Please try again.') });
          return;
        }
        setCustomersTick(t => t + 1);
        setCustomerId(resolvedCustomerId);
        setNewCustomerMode(false);
      }
      if (!resolvedCustomerId) {
        setOrderResult({ type: 'error', title: 'Please choose a customer', message: 'Select who this order is for, or add a new customer.' });
        return;
      }

      const pendingOrder = {
        customer_id: resolvedCustomerId,
        production_deadline: productionDeadline,
        required_items,
        total_quote_amount: Math.round(quote * 100) / 100
      };
      const { res, data } = await postOrder(pendingOrder);

      if (res.ok) {
        const shortId = String(data.order_id || '').slice(0, 8).toUpperCase();
        setOrderResult({
          type: 'success',
          title: 'Order created',
          message: `Order #${shortId} was saved${data.source === 'local' ? ' offline (it will sync later)' : ''}.\n` +
                   `${(data.items || []).length} material(s) reserved in the Catalog. You can follow it in the Orders tab.`
        });
        setOrdersRefreshKey(k => k + 1);
        resetOrderForm();
        refreshInventory();
      } else if (res.status === 409) {
        // PB 9 halt caught -> PB 10 warning modal
        setCapacityAlert({
          message: errorText(data, 'There is not enough stock for this order right now.'),
          shortages: data.shortages || [],
          total_shortfall: data.total_shortfall || 0,
          pendingOrder
        });
      } else {
        // Name the missing materials instead of showing their internal IDs
        const missingNames = (data.missing_inventory_ids || [])
          .map(id => inventory.find(inv => inv.inventory_id === id)?.item_name)
          .filter(Boolean);
        const text = errorText(data, 'The order could not be saved. Please try again.') +
          (missingNames.length ? `\nMaterials affected: ${missingNames.join(', ')}.` : '');
        setOrderResult({ type: 'error', title: 'The order was not created', message: text });
      }
    } catch (err) {
      console.error('Error creating order:', err);
      setOrderResult({
        type: 'error',
        title: 'The order was not created',
        message: 'The system could not be reached, so nothing was saved. Check your internet connection and that the server is running, then try again.'
      });
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  // PB 10: log the staff member's resolution for a halted order
  const handleResolveHaltedOrder = async (resolution) => {
    if (!capacityAlert) return;
    setAlertError('');

    if (resolution === 'Delayed' && !delayedDeadline) {
      setAlertError('Please pick the new date when this order should be finished.');
      return;
    }

    const { pendingOrder } = capacityAlert;
    const production_deadline = resolution === 'Delayed' ? delayedDeadline : pendingOrder.production_deadline;

    setIsSubmittingOrder(true);
    try {
      const { res, data } = await postOrder({ ...pendingOrder, production_deadline, resolution });

      if (res.ok) {
        const id = String(data.order_id || data.id || '').slice(0, 8).toUpperCase();
        const notice = resolution === 'Delayed'
          ? `Order #${id} logged as DELAYED. New deadline: ${production_deadline}. Resume it from the Orders tab when stock arrives.`
          : `Order #${id} logged as CANCELLED (lost sale recorded).`;
        setOrderResult({ type: 'warning', title: resolution === 'Delayed' ? 'Order delayed' : 'Order cancelled', message: notice });
        setOrdersRefreshKey(k => k + 1);
        resetOrderForm();
        closeCapacityAlert();
      } else {
        setAlertError(errorText(data, 'This choice could not be saved. Please try again.'));
      }
    } catch (err) {
      console.error('Error logging resolution:', err);
      setAlertError('The system could not be reached, so nothing was saved. Please try again.');
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  const canManageUsers = ['Owner', 'Admin'].includes(user?.role);

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
          {user?.role && <span style={styles.roleTag}>{user.role}</span>}
        </h1>
        <nav style={styles.nav}>
          <button style={activeTab === 'catalog' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('catalog')}>
            <Package size={18} /> Catalog
          </button>
          <button style={activeTab === 'add' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('add')}>
            <PlusCircle size={18} /> Create Order
          </button>
          <button style={activeTab === 'orders' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('orders')}>
            <ClipboardList size={18} /> Orders
          </button>
          <button style={activeTab === 'dashboard' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('dashboard')}>
            <LayoutDashboard size={18} /> Dashboard
          </button>
          {canManageUsers && (
            <button style={activeTab === 'users' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('users')}>
              <Users size={18} /> Accounts
            </button>
          )}
          <button style={styles.navBtn} onClick={() => setChangingPassword(true)} title="Change my password">
            <KeyRound size={18} /> Password
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
            apiBase={API_BASE}
            token={token}
            userRole={user?.role}
            onUnauthorized={handleLogout}
          />
        )}

        {activeTab === 'add' && (
          <div style={styles.formCard}>
            <h2 style={{ textAlign: 'center', marginBottom: '1rem' }}>Create Order Profile</h2>
            

            <form onSubmit={handleCreateOrder}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <label style={styles.label} htmlFor="order-customer">Customer</label>
                {!(newCustomerMode && customers.length === 0) && (
                  <button
                    type="button"
                    onClick={() => setNewCustomerMode(m => !m)}
                    style={{ ...styles.btnLink, marginBottom: '0.25rem' }}
                  >
                    {newCustomerMode ? 'Pick a saved customer' : '+ New customer'}
                  </button>
                )}
              </div>
              {newCustomerMode ? (
                <div style={styles.customerBox}>
                  <input
                    type="text" placeholder="Customer full name *" maxLength={255} required
                    value={newCustomer.full_name}
                    onChange={e => setNewCustomer({ ...newCustomer, full_name: e.target.value })}
                    style={styles.input}
                  />
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <input
                        type="tel" inputMode="numeric" autoComplete="tel" placeholder="Mobile no. (09XXXXXXXXX)"
                        maxLength={11} pattern="0[0-9]{10}"
                        title="11 digits starting with 0, like 09171234567"
                        aria-label="Mobile number, 11 digits starting with 0"
                        aria-describedby="mobile-hint"
                        value={newCustomer.contact_number}
                        // digits only, at most 11
                        onChange={e => setNewCustomer({ ...newCustomer, contact_number: e.target.value.replace(/\D/g, '').slice(0, 11) })}
                        style={{
                          ...styles.input, marginBottom: 0,
                          ...(newCustomer.contact_number && !MOBILE_PATTERN.test(newCustomer.contact_number) ? { borderColor: '#f59e0b' } : {})
                        }}
                      />
                      <span id="mobile-hint" style={{
                        ...styles.hint, display: 'block', margin: '0.25rem 0 0',
                        color: !newCustomer.contact_number ? '#64748b' : MOBILE_PATTERN.test(newCustomer.contact_number) ? '#166534' : '#92400e'
                      }}>
                        {!newCustomer.contact_number
                          ? 'Optional · 11 digits, starts with 0'
                          : MOBILE_PATTERN.test(newCustomer.contact_number)
                            ? '✓ Valid mobile number'
                            : !newCustomer.contact_number.startsWith('0')
                              ? 'Must start with 0'
                              : `${newCustomer.contact_number.length} of 11 digits`}
                      </span>
                    </div>
                    <input
                      type="text" placeholder="From (Facebook, walk-in…)" maxLength={100}
                      value={newCustomer.platform_source}
                      onChange={e => setNewCustomer({ ...newCustomer, platform_source: e.target.value })}
                      style={{ ...styles.input, marginBottom: 0, flex: 1, minWidth: 0, alignSelf: 'flex-start' }}
                    />
                  </div>
                </div>
              ) : (
                <select
                  id="order-customer"
                  value={customerId}
                  onChange={e => setCustomerId(e.target.value)}
                  style={styles.input}
                  required
                >
                  <option value="">Select customer…</option>
                  {customers.map(c => (
                    <option key={c.customer_id} value={c.customer_id}>
                      {c.full_name}{c.contact_number ? ` · ${c.contact_number}` : ''}
                    </option>
                  ))}
                </select>
              )}

              <label style={styles.label}>Production Deadline</label>
              <input 
                type="date" 
                min={todayInManila()}
                value={productionDeadline} 
                onChange={e => setProductionDeadline(e.target.value)} 
                style={styles.input} 
                required 
              />

              <label style={styles.label} htmlFor="order-quote">Quote Amount (₱, optional)</label>
              <input
                id="order-quote"
                type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00"
                value={quoteAmount}
                onChange={e => setQuoteAmount(e.target.value)}
                style={styles.input}
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
                  Not Enough Stock for This Order
                </h2>
              </div>
              <p style={{ fontSize: '0.875rem', color: '#334155', margin: '0.75rem 0' }}>
                {capacityAlert.message || 'There is not enough stock for this order right now.'} The table below shows what is missing.
                {' '}Please choose whether to <strong>delay</strong> the order until stock arrives, or <strong>cancel</strong> it.
              </p>

              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Material</th>
                    <th style={styles.thNum}>Needed</th>
                    <th style={styles.thNum}>Free to use</th>
                    <th style={styles.thNum}>Missing</th>
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

        {activeTab === 'orders' && (
          <OrdersPage
            apiBase={API_BASE}
            token={token}
            userRole={user?.role}
            onUnauthorized={handleLogout}
            refreshKey={ordersRefreshKey}
            onStockChanged={refreshInventory}
          />
        )}

        <ResultDialog
          result={orderResult}
          onClose={() => setOrderResult(null)}
          actionLabel={orderResult && orderResult.type !== 'error' && activeTab === 'add' ? 'View Orders' : undefined}
          onAction={() => { setOrderResult(null); setActiveTab('orders'); }}
        />

        {activeTab === 'dashboard' && (
          <Dashboard
            apiBase={API_BASE}
            token={token}
            userRole={user?.role}
            onUnauthorized={handleLogout}
            refreshKey={`${inventoryMeta.fetchedAt}:${ordersRefreshKey}`}
            onOpenOrders={() => setActiveTab('orders')}
          />
        )}

        {activeTab === 'users' && canManageUsers && (
          <UsersPage apiBase={API_BASE} token={token} currentUser={user} onUnauthorized={handleLogout} />
        )}
      </main>

      {changingPassword && (
        <ChangePasswordDialog
          apiBase={API_BASE}
          token={token}
          onUnauthorized={handleLogout}
          onClose={() => setChangingPassword(false)}
          onChanged={(newToken) => { setToken(newToken); localStorage.setItem('xiaomei_token', newToken); }}
        />
      )}
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
  header: { background: '#fff', padding: '1rem 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', borderBottom: '1px solid #e2e8f0' },
  nav: { display: 'flex', gap: '0.25rem', flexWrap: 'wrap', justifyContent: 'flex-end' },
  roleTag: { marginLeft: '0.5rem', padding: '0.1rem 0.5rem', background: '#e0e7ff', color: '#4f46e5', borderRadius: '999px', fontSize: '0.75rem', verticalAlign: 'middle' },
  navBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  navActive: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: '#e0e7ff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold' },
  btnSecondary: { width: '100%', padding: '0.5rem', marginTop: '1rem', background: '#94a3b8', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer' },
  formCard: { background: '#fff', padding: '2rem', borderRadius: '0.5rem', maxWidth: '500px', margin: '0 auto', border: '1px solid #e2e8f0' },

  // Sprint 9: Order materials + Capacity Alert modal
  hint: { fontSize: '0.8rem', color: '#64748b', marginBottom: '0.5rem' },
  lineRow: { display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' },
  iconBtn: { padding: '0.6rem', background: 'none', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#64748b' },
  customerBox: { padding: '0.75rem', marginBottom: '1rem', border: '1px dashed #c7d2fe', borderRadius: '0.375rem', background: '#f8fafc' },
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
import { useState, useEffect } from 'react';
import { Package, PlusCircle, TrendingUp, LogOut } from 'lucide-react';

const API_BASE = 'http://localhost:5000/api';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('xiaomei_token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('xiaomei_user')) || null);
  const [activeTab, setActiveTab] = useState('catalog');
  const [items, setItems] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Auth Form State for XiaoMei Printing
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState('');      // Used for Login / Register authentication
  const [username, setUsername] = useState('');   // Display name for the Dashboard & Orders
  const [password, setPassword] = useState('');

  // Create Order Profile State
  const [customerId, setCustomerId] = useState('');
  const [productionDeadline, setProductionDeadline] = useState('');
  const [orderStatusMsg, setOrderStatusMsg] = useState('');

  useEffect(() => {
    async function fetchItems() {
      try {
        const res = await fetch(`${API_BASE}/items`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) setItems(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error('Failed to fetch items', err);
      }
    }

    if (token) {
      fetchItems();
    }
  }, [token, refreshKey]);

  const handleAuth = async (e) => {
    e.preventDefault();
    const endpoint = isSignup ? '/auth/register' : '/auth/login';
    
    // Pass 'email' into 'username' if backend expects username for auth lookup
    const payload = isSignup 
      ? { email, username: email, displayName: username, password, role: 'Production' } 
      : { username: email, password }; 

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        const activeToken = data.token || '';
        const activeUser = data.user || { username: username || data.username || email, email, role: data.role };

        if (!isSignup) {
          setToken(activeToken);
          localStorage.setItem('xiaomei_token', activeToken);
        }
        
        setUser(activeUser);
        localStorage.setItem('xiaomei_user', JSON.stringify(activeUser));
        
        if (isSignup) {
          alert('Registration successful! You can now log in.');
          setIsSignup(false);
          setPassword('');
        }
      } else {
        alert(data.error || 'Authentication failed');
      }
    } catch (err) {
      console.error('Server connection error:', err);
      alert('Failed to connect to the backend.');
    }
  };

  const handleLogout = () => {
    setToken('');
    setUser(null);
    localStorage.removeItem('xiaomei_token');
    localStorage.removeItem('xiaomei_user');
  };

  const handleCreateOrder = async (e) => {
    e.preventDefault();
    setOrderStatusMsg('');

    try {
      const res = await fetch(`${API_BASE}/orders`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({
          customer_id: customerId,
          production_deadline: productionDeadline
        })
      });

      const data = await res.json();

      if (res.ok) {
        setOrderStatusMsg(`Order Created Successfully! ID: ${data.order_id || data.id || ''}`);
        setCustomerId('');
        setProductionDeadline('');
      } else {
        setOrderStatusMsg(`Error: ${data.error || 'Failed to create order.'}`);
      }
    } catch (err) {
      console.error('Error creating order:', err);
      setOrderStatusMsg('Error: Network connection failure.');
    }
  };

  const toggleSoldStatus = async (id) => {
    const res = await fetch(`${API_BASE}/items/${id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) setRefreshKey(prev => prev + 1);
  };

  // Safe Calculations with fallbacks for undefined properties
  const totalCost = items.reduce((acc, item) => acc + (item.costPrice || 0), 0);
  const totalRevenue = items.reduce((acc, item) => acc + (item.sellingPrice || 0), 0);
  const realizedProfit = items
    .filter(item => item.status === 'sold')
    .reduce((acc, item) => acc + ((item.sellingPrice || 0) - (item.costPrice || 0)), 0);
  const margin = totalRevenue > 0 ? (((totalRevenue - totalCost) / totalRevenue) * 100).toFixed(1) : 0;

  if (!token) {
    return (
      <div style={styles.authContainer}>
        <div style={styles.authCard}>
          <h2>{isSignup ? 'Create User Account' : 'User Login'}</h2>
          <form onSubmit={handleAuth} style={{ marginTop: '1rem' }}>
            
            <input 
              type="email" 
              placeholder="Gmail / Email Address" 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
              style={styles.input} 
              required 
            />

            {isSignup && (
              <input 
                type="text" 
                placeholder="Display Username" 
                value={username} 
                onChange={e => setUsername(e.target.value)} 
                style={styles.input} 
                required 
              />
            )}

            <input 
              type="password" 
              placeholder="Password" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              style={styles.input} 
              required 
            />

            <button type="submit" style={styles.btnPrimary}>
              {isSignup ? 'Sign Up' : 'Log In'}
            </button>
          </form>

          <p 
            onClick={() => {
              setIsSignup(!isSignup);
              setEmail('');
              setPassword('');
              setUsername('');
            }} 
            style={styles.switchAuth}
          >
            {isSignup ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
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
          <div style={styles.grid}>
            {items.map(item => (
              <div key={item.id} style={styles.card}>
                <span style={item.status === 'sold' ? styles.badgeSold : styles.badgeAvailable}>
                  {item.status}
                </span>
                <img src={item.imageUrl || 'https://via.placeholder.com/300'} alt={item.title} style={styles.cardImg} />
                <div style={{ padding: '1rem' }}>
                  <h3 style={{ fontSize: '1.1rem' }}>{item.title}</h3>
                  <p style={{ color: '#64748b', fontSize: '0.875rem', margin: '0.5rem 0' }}>{item.description}</p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                    <span>Cost: <strong>${(item.costPrice || 0).toFixed(2)}</strong></span>
                    <span>Price: <strong>${(item.sellingPrice || 0).toFixed(2)}</strong></span>
                  </div>
                  <button 
                    onClick={() => toggleSoldStatus(item.id)} 
                    style={item.status === 'sold' ? styles.btnSecondary : styles.btnSuccess}
                  >
                    {item.status === 'sold' ? 'Mark Available' : 'Mark as Sold'}
                  </button>
                </div>
              </div>
            ))}
          </div>
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
                backgroundColor: orderStatusMsg.startsWith('Error') ? '#fee2e2' : '#dcfce7',
                color: orderStatusMsg.startsWith('Error') ? '#991b1b' : '#166534'
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

              <button type="submit" style={styles.btnPrimary}>Create Order Profile</button>
            </form>
          </div>
        )}

        {activeTab === 'metrics' && (
          <div style={styles.metricsGrid}>
            <div style={styles.metricCard}>
              <h4>Total Items</h4>
              <p>{items.length}</p>
            </div>
            <div style={styles.metricCard}>
              <h4>Sourced Cost</h4>
              <p>${totalCost.toFixed(2)}</p>
            </div>
            <div style={styles.metricCard}>
              <h4>Realized Profit</h4>
              <p>${realizedProfit.toFixed(2)}</p>
            </div>
            <div style={styles.metricCard}>
              <h4>Profit Margin</h4>
              <p>{margin}%</p>
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
  switchAuth: { marginTop: '1rem', color: '#4f46e5', textAlign: 'center', cursor: 'pointer', fontSize: '0.875rem' },
  header: { background: '#fff', padding: '1rem 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0' },
  nav: { display: 'flex', gap: '0.5rem' },
  navBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  navActive: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: '#e0e7ff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '1.5rem' },
  card: { background: '#fff', borderRadius: '0.5rem', overflow: 'hidden', border: '1px solid #e2e8f0', position: 'relative' },
  cardImg: { width: '100%', height: '200px', objectFit: 'cover' },
  badgeAvailable: { position: 'absolute', top: '10px', right: '10px', background: '#10b981', color: '#fff', padding: '0.25rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.75rem', fontWeight: 'bold', textTransform: 'uppercase' },
  badgeSold: { position: 'absolute', top: '10px', right: '10px', background: '#ef4444', color: '#fff', padding: '0.25rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.75rem', fontWeight: 'bold', textTransform: 'uppercase' },
  btnSuccess: { width: '100%', padding: '0.5rem', marginTop: '1rem', background: '#10b981', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer' },
  btnSecondary: { width: '100%', padding: '0.5rem', marginTop: '1rem', background: '#94a3b8', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer' },
  formCard: { background: '#fff', padding: '2rem', borderRadius: '0.5rem', maxWidth: '500px', margin: '0 auto', border: '1px solid #e2e8f0' },
  metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' },
  metricCard: { background: '#fff', padding: '1.5rem', borderRadius: '0.5rem', border: '1px solid #e2e8f0', textAlign: 'center' }
};
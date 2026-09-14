import { useState, useEffect } from 'react';
import { Package, PlusCircle, TrendingUp, LogOut,} from 'lucide-react';

const API_BASE = 'http://localhost:5000/api';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('thrift_token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('thrift_user')) || null);
  const [activeTab, setActiveTab] = useState('catalog');
  const [items, setItems] = useState([]);

  // Auth Form State
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [storeName, setStoreName] = useState('');

  // Add Item State
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [cost, setCost] = useState('');
  const [price, setPrice] = useState('');
  const [imageFile, setImageFile] = useState(null);

  useEffect(() => {
    if (token) {
      fetchItems();
    }
  }, [token]);

  async function fetchItems() {
    try {
      const res = await fetch(`${API_BASE}/items`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) setItems(data);
    } catch (err) {
      console.error('Failed to fetch items', err);
    }
  }

  

  const handleAuth = async (e) => {
    e.preventDefault();
    const endpoint = isSignup ? '/auth/signup' : '/auth/login';
    const payload = isSignup ? { email, password, storeName } : { email, password };

    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (res.ok) {
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('thrift_token', data.token);
      localStorage.setItem('thrift_user', JSON.stringify(data.user));
    } else {
      alert(data.error || 'Authentication failed');
    }
  };

  const handleLogout = () => {
    setToken('');
    setUser(null);
    localStorage.removeItem('thrift_token');
    localStorage.removeItem('thrift_user');
  };

  const handleAddItem = async (e) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append('title', title);
    formData.append('description', desc);
    formData.append('costPrice', cost);
    formData.append('sellingPrice', price);
    if (imageFile) formData.append('image', imageFile);

    const res = await fetch(`${API_BASE}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });

    if (res.ok) {
      setTitle(''); setDesc(''); setCost(''); setPrice(''); setImageFile(null);
      fetchItems();
      setActiveTab('catalog');
    }
  };

  const toggleSoldStatus = async (id) => {
    const res = await fetch(`${API_BASE}/items/${id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) fetchItems();
  };

  // Calculations
  const totalCost = items.reduce((acc, item) => acc + item.costPrice, 0);
  const totalRevenue = items.reduce((acc, item) => acc + item.sellingPrice, 0);
  const realizedProfit = items
    .filter(item => item.status === 'sold')
    .reduce((acc, item) => acc + (item.sellingPrice - item.costPrice), 0);
  const margin = totalRevenue > 0 ? (((totalRevenue - totalCost) / totalRevenue) * 100).toFixed(1) : 0;

  if (!token) {
    return (
      <div style={styles.authContainer}>
        <div style={styles.authCard}>
          <h2>{isSignup ? 'Create Seller Account' : 'Seller Login'}</h2>
          <form onSubmit={handleAuth} style={{ marginTop: '1rem' }}>
            {isSignup && (
              <input 
                type="text" 
                placeholder="Store Name" 
                value={storeName} 
                onChange={e => setStoreName(e.target.value)} 
                style={styles.input} 
                required 
              />
            )}
            <input 
              type="email" 
              placeholder="Email" 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
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
            <button type="submit" style={styles.btnPrimary}>
              {isSignup ? 'Sign Up' : 'Log In'}
            </button>
          </form>
          <p onClick={() => setIsSignup(!isSignup)} style={styles.switchAuth}>
            {isSignup ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: '#f8fafc', minHeight: '100vh', fontFamily: 'sans-serif' }}>
      <header style={styles.header}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{user?.storeName || 'Thrift Hub'}</h1>
        <nav style={styles.nav}>
          <button style={activeTab === 'catalog' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('catalog')}>
            <Package size={18} /> Catalog
          </button>
          <button style={activeTab === 'add' ? styles.navActive : styles.navBtn} onClick={() => setActiveTab('add')}>
            <PlusCircle size={18} /> Add Item
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
        {/* CATALOG VIEW */}
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
                    <span>Cost: <strong>${item.costPrice.toFixed(2)}</strong></span>
                    <span>Price: <strong>${item.sellingPrice.toFixed(2)}</strong></span>
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

        {/* ADD ITEM VIEW */}
        {activeTab === 'add' && (
          <div style={styles.formCard}>
            <h2>Add New Clothing Piece</h2>
            <form onSubmit={handleAddItem} style={{ marginTop: '1rem' }}>
              <input type="text" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} style={styles.input} required />
              <textarea placeholder="Description & Sizing" value={desc} onChange={e => setDesc(e.target.value)} style={styles.input} required />
              <input type="number" step="0.01" placeholder="Cost Price ($)" value={cost} onChange={e => setCost(e.target.value)} style={styles.input} required />
              <input type="number" step="0.01" placeholder="Selling Price ($)" value={price} onChange={e => setPrice(e.target.value)} style={styles.input} required />
              <input type="file" onChange={e => setImageFile(e.target.files[0])} accept="image/*" style={styles.input} required />
              <button type="submit" style={styles.btnPrimary}>Upload Item</button>
            </form>
          </div>
        )}

        {/* METRICS VIEW */}
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

// INLINE STYLES FOR QUICK SETUP
const styles = {
  authContainer: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8fafc' },
  authCard: { background: '#fff', padding: '2rem', borderRadius: '0.5rem', width: '100%', maxWidth: '400px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' },
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
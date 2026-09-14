require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Initialize Express and HTTP Server (HTTP server is required for WebSockets)
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Note: Update this to Pat and Rin's frontend URL later
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
  }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// ================= DATABASE CONFIGURATION =================

// 1. Cloud Database: PostgreSQL (Primary Source of Truth)
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Vercel/Neon cloud databases
});

// The Passive Monitor: Logs when the pool spins up a new client for heavy traffic
pgPool.on('connect', () => {
  console.log('🔗 New client connected to PostgreSQL pool');
});

// Force a quick test query to ensure it connects on startup
pgPool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ PostgreSQL Connection Error:', err.message);
  } else {
    console.log('✅ Connected to PostgreSQL Cloud Database');
  }
});

// 2. Local Cache Database: SQLite (Offline Mode Fallback)
const sqliteDbPath = path.resolve(__dirname, 'local_cache.db');
const localDb = new sqlite3.Database(sqliteDbPath, (err) => {
  if (err) {
    console.error('❌ Error connecting to SQLite Local Cache:', err.message);
  } else {
    console.log('✅ Connected to SQLite Local Cache');
  }
});

// ================= WEBSOCKETS: CONCURRENCY CONTROL =================

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Listen for order edits to enforce the "Owner Prevails" logic
  socket.on('editing_order', (data) => {
    // Broadcast to other branches/clients that an order is currently locked
    socket.broadcast.emit('order_locked', { 
      orderId: data.orderId, 
      userRole: data.userRole 
    });
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// ================= CORE ROUTES SKELETON =================

// Make databases accessible to our routers
app.use((req, res, next) => {
  req.pgPool = pgPool;
  req.localDb = localDb;
  next();
});

// You and Enzo will build these out in separate files inside a /routes folder
// app.use('/api/auth', require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
// app.use('/api/inventory', require('./routes/inventory'));
// app.use('/api/waste', require('./routes/waste'));
// app.use('/api/financials', require('./routes/financials'));

// Health Check / Sync Status
app.get('/api/status', (req, res) => {
  res.json({ message: 'XiaoMei ERP Server is running', status: 'online' });
});

// Import the sync function
const { syncOfflineData } = require('./services/sync');

// Run the sync script every 5 minutes (300,000 milliseconds)
setInterval(() => {
  syncOfflineData(pgPool, localDb);
}, 300000);

// Manual Sync Trigger (Frontend will call this when internet returns)
app.post('/api/sync', async (req, res) => {
  try {
    await syncOfflineData(pgPool, localDb);
    res.status(200).json({ message: 'Sync process triggered.' });
  } catch (error) {
    res.status(500).json({ error: 'Sync failed.' });
  }
});

// ================= START SERVER =================
server.listen(PORT, () => {
  console.log(`🚀 XiaoMei ERP Backend running on http://localhost:${PORT}`);
});
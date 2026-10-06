require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyToken, requireRole } = require('./middleware/authMiddleware');
const { createOrderLockManager } = require('./services/orderLocks');
const { ensureLocalSyncColumns } = require('./utils/localSync');

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
app.use(express.json({ limit: '100kb' }));

// Audit fix M8: Express 5 leaves req.body undefined when a request has no JSON body.
// Default it to {} so destructuring in routes can never throw.
app.use((req, res, next) => {
  if (req.body === undefined || req.body === null) req.body = {};
  next();
});

// ================= DATABASE CONFIGURATION =================

// 1. Cloud Database: PostgreSQL (Primary Source of Truth)
const pgPool = new Pool({
  connectionTimeoutMillis: 5000,
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Vercel/Neon cloud databases
});

// The Passive Monitor: Logs when the pool spins up a new client for heavy traffic
pgPool.on('connect', () => {
  console.log('🔗 New client connected to PostgreSQL pool');
});

// Audit fix C4: an error on an IDLE pooled client (e.g. Neon dropping the connection)
// is emitted on the pool. Without this listener Node treats it as an unhandled 'error'
// event and crashes the whole server, taking the SQLite offline fallback down with it.
// pg-pool already discards the broken client; the next query opens a fresh one.
pgPool.on('error', (err) => {
  console.error('⚠️ PostgreSQL idle client error (client discarded, server still running):', err.message);
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

// Audit fix H5: foreign keys are OFF by default for every new SQLite connection.
// initLocalDb.js only enabled them on its own short-lived connection, so the running
// server ignored REFERENCES / ON DELETE CASCADE. Queued first, so it runs before any query.
localDb.run('PRAGMA foreign_keys = ON;');
// M9: offline transactions use a short-lived second connection; wait for its lock instead
// of failing immediately with SQLITE_BUSY.
localDb.configure('busyTimeout', 5000);
localDb.get('PRAGMA foreign_keys;', (err, row) => {
  if (err || !row || row.foreign_keys !== 1) {
    console.error('❌ Could not enable SQLite foreign keys:', err ? err.message : 'PRAGMA returned 0');
  } else {
    console.log('🔒 SQLite foreign key enforcement: ON');
  }
});

// ================= WEBSOCKETS: CONCURRENCY CONTROL (Audit fix H2) =================
// "Owner Prevails" edit locks, tracked on the server. Identity/role come from the JWT.
//
// Client usage (socket.io-client):
//   const socket = io(API_URL, { auth: { token } });
//   socket.emit('editing_order', { orderId }, (res) => { /* res.granted, res.lock */ });
//   socket.emit('release_order', { orderId });
//   socket.on('order_locked' | 'order_unlocked' | 'order_lock_revoked' | 'locks_snapshot', ...)
// Re-emit 'editing_order' at least every 60s while editing to keep the lock (2 min TTL).
const orderLocks = createOrderLockManager();

io.use((socket, next) => {
  const header = socket.handshake.headers.authorization || '';
  const token = socket.handshake.auth?.token || (header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!token) return next(new Error('Unauthorized: no token provided'));
  try {
    const { user_id, role } = jwt.verify(token, process.env.JWT_SECRET);
    socket.data.user = { user_id, role };
    next();
  } catch (err) {
    next(new Error('Unauthorized: invalid or expired token'));
  }
});

const validOrderId = (data) =>
  data && typeof data.orderId === 'string' && data.orderId.length > 0 && data.orderId.length <= 50;

io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`🔌 Client connected: ${socket.id} (${user.role})`);
  socket.emit('locks_snapshot', orderLocks.snapshot());

  socket.on('editing_order', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!validOrderId(data)) return reply({ granted: false, error: 'orderId is required.' });

    const result = orderLocks.acquire(data.orderId, user, socket.id);
    if (!result.granted) {
      return reply({ granted: false, reason: result.reason, lock: orderLocks.publicView(result.lock) });
    }

    if (result.previous) {
      // Owner prevails: tell the lower-ranked editor they lost the lock
      io.to(result.previous.socketId).emit('order_lock_revoked', {
        orderId: data.orderId,
        by: orderLocks.publicView(result.lock)
      });
    }
    socket.broadcast.emit('order_locked', orderLocks.publicView(result.lock));
    reply({ granted: true, lock: orderLocks.publicView(result.lock) });
  });

  socket.on('release_order', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!validOrderId(data)) return reply({ released: false });
    const released = orderLocks.release(data.orderId, user.user_id);
    if (released) socket.broadcast.emit('order_unlocked', { orderId: data.orderId });
    reply({ released });
  });

  socket.on('disconnect', () => {
    for (const orderId of orderLocks.releaseBySocket(socket.id)) {
      io.emit('order_unlocked', { orderId });
    }
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// ================= CORE ROUTES SKELETON =================

// Make databases accessible to our routers
app.use((req, res, next) => {
  req.pgPool = pgPool;
  req.localDb = localDb;
  req.localDbPath = sqliteDbPath;
  req.orderLocks = orderLocks;
  next();
});

// You and Enzo will build these out in separate files inside a /routes folder
// app.use('/api/auth', require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/inventory', require('./routes/inventory'));
// app.use('/api/waste', require('./routes/waste'));
// app.use('/api/financials', require('./routes/financials'));

// Health Check / Sync Status
app.get('/api/status', (req, res) => {
  res.json({ message: 'XiaoMei ERP Server is running', status: 'online' });
});

// Import the sync function
const { syncOfflineData, listConflicts, SYNC_TABLES } = require('./services/sync');

// Add local-only sync bookkeeping columns, then warm the cache right away (H4/H5)
ensureLocalSyncColumns(localDb, SYNC_TABLES.map((t) => t.table))
  .then(() => syncOfflineData(pgPool, localDb))
  .catch((err) => console.error('❌ Startup sync failed:', err.message));

// Run the sync script every 5 minutes (300,000 milliseconds).
// H3: overlapping runs are impossible; a call during a run joins the in-flight one.
setInterval(() => {
  syncOfflineData(pgPool, localDb).catch(() => {});
}, 300000);

// Manual Sync Trigger (Frontend will call this when internet returns)
// 200 = done, 409 = some rows conflict with newer cloud edits (C3), 503 = cloud unreachable
app.post('/api/sync', verifyToken, async (req, res) => {
  try {
    const summary = await syncOfflineData(pgPool, localDb);
    if (summary.aborted) {
      return res.status(503).json({ error: 'CLOUD_UNREACHABLE', message: 'Sync paused: cloud database unreachable.', summary });
    }
    if (summary.conflicts.length > 0 || summary.unresolved_conflicts > 0) {
      return res.status(409).json({
        error: 'SYNC_CONFLICT',
        message: 'Some offline edits were not applied because the cloud record was changed by someone else.',
        summary
      });
    }
    res.status(200).json({ message: 'Sync complete.', summary });
  } catch (error) {
    res.status(500).json({ error: 'Sync failed.' });
  }
});

// Offline edits blocked by a newer cloud edit, waiting for a human decision (C3)
app.get('/api/sync/conflicts', verifyToken, requireRole(['Owner', 'Admin']), async (req, res) => {
  try {
    res.status(200).json({ conflicts: await listConflicts(localDb) });
  } catch (error) {
    res.status(500).json({ error: 'Could not read sync conflicts.' });
  }
});

// ================= ERROR HANDLING (Audit fix M8) =================
// Every failure leaves the API as structured JSON. No HTML pages, no stack traces.

// Unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}.` });
});

// Global error handler (must have 4 arguments). Express 5 also routes rejected
// promises from async handlers here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Request body is not valid JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' });
  }
  if (err.type && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'BAD_REQUEST', message: 'The request could not be read.' });
  }

  const errorId = crypto.randomUUID();
  console.error(`❌ Unhandled error ${errorId} on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong on the server.', error_id: errorId });
});

// ================= START SERVER =================
server.listen(PORT, () => {
  console.log(`🚀 XiaoMei ERP Backend running on http://localhost:${PORT}`);
});
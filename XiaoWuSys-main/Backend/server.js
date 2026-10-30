require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const jwt = require('jsonwebtoken');
const { createApp, parseOrigins } = require('./app');
const { createOrderLockManager } = require('./services/orderLocks');
const { ensureLocalSyncColumns } = require('./utils/localSync');
const { createInventoryEvents } = require('./services/inventoryEvents');
const { checkCloudSchema } = require('./services/schemaCheck');
const { createLocalSchema, createLocalIndexes, upgradeLocalOrderStatusCheck } = require('./services/localSchema');
const { applyPendingMigrations } = require('./services/migrations');
const { startRecycleBinJanitor } = require('./services/recycleBin');
const { startRevocationRefresh, isTokenRevoked, onSessionRevoked } = require('./services/sessions');
const { createCloudDisabledPool } = require('./services/cloudDisabledPool');
const { isConnectionError } = require('./utils/dbErrors');
const { syncOfflineData, listConflicts, buildSyncStatus, SYNC_TABLES } = require('./services/sync');
const { createCloudHealth, watchPool } = require('./services/cloudHealth');

// ================= START-UP CHECKS =================
// Without a secret anyone could forge a login token, so refuse to start.
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET is not set. Add a long random value to Backend/.env (see .env.example), then start again.');
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.warn('⚠️ JWT_SECRET is shorter than 32 characters. Use a long random value in production (see .env.example).');
}

const PORT = process.env.PORT || 5000;
const corsOrigins = parseOrigins(process.env.CORS_ORIGINS);
// Offline-only mode: no cloud at all (demo / testing without a Neon account)
const cloudDisabled = String(process.env.CLOUD_DISABLED).toLowerCase() === 'true' || !process.env.DATABASE_URL;

// ================= DATABASES =================
// Demo data must never be synced into the real cloud database
if (/demo/i.test(process.env.LOCAL_DB_PATH || '') && !cloudDisabled) {
  console.error('❌ LOCAL_DB_PATH points to a demo database while DATABASE_URL is set. Use "npm run demo" (offline-only) instead.');
  process.exit(1);
}

// 1. Cloud: PostgreSQL on Neon (source of truth)
const rawPgPool = cloudDisabled ? createCloudDisabledPool() : new Pool({
  connectionTimeoutMillis: 5000,
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon
});

// PB 3: cloud health. Every query the server makes reports whether the cloud answered; only
// while it is unreachable does the watcher probe (SELECT 1 every 15 s), never while online (D3).
// The handlers are defined further down (they need the socket server and the sync).
let onCloudChange = () => {};
let onCloudBack = () => {};
const cloudHealth = createCloudHealth({
  pgPool: rawPgPool,
  cloudDisabled,
  probeMs: Number(process.env.CLOUD_PROBE_MS) || 15000,
  onChange: (next, previous) => onCloudChange(next, previous),
  onReconnect: () => onCloudBack()
});
const pgPool = cloudDisabled ? rawPgPool : watchPool(rawPgPool, cloudHealth);

if (cloudDisabled) {
  console.warn('☁️  Cloud disabled (CLOUD_DISABLED=true or no DATABASE_URL): running in OFFLINE-ONLY mode on the local database.');
} else {
  pgPool.on('connect', () => console.log('🔗 New client connected to PostgreSQL pool'));
  // Audit fix C4: an idle client error must not crash the server (and its offline fallback)
  pgPool.on('error', (err) => console.error('⚠️ PostgreSQL idle client error (client discarded, server still running):', err.message));
  pgPool.query('SELECT NOW()', (err) => {
    if (err) console.error('❌ PostgreSQL Connection Error:', err.message);
    else console.log('✅ Connected to PostgreSQL Cloud Database');
  });
}

// 2. Local cache: SQLite (offline fallback). LOCAL_DB_PATH picks another file (e.g. demo data).
const sqliteDbPath = path.resolve(__dirname, process.env.LOCAL_DB_PATH || 'local_cache.db');
const localDb = new sqlite3.Database(sqliteDbPath, (err) => {
  if (err) console.error('❌ Error connecting to SQLite Local Cache:', err.message);
  else console.log(`✅ Connected to SQLite Local Cache (${path.basename(sqliteDbPath)})`);
});
// Audit fix H5: foreign keys are OFF by default for every new SQLite connection
localDb.run('PRAGMA foreign_keys = ON;');
// M9: wait for a short-lived transaction connection's lock instead of failing with SQLITE_BUSY
localDb.configure('busyTimeout', 5000);

// ================= REAL-TIME + LOCKS =================
// The Express app is created further down (it needs the services below). socket.io wraps the
// server's request listener when it attaches, so the listener must exist now: it forwards to
// the app once it is ready.
let app = null;
const server = http.createServer((req, res) => {
  if (app) return app(req, res);
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'STARTING', message: 'The server is starting. Please try again in a moment.' }));
});
const io = new Server(server, {
  cors: { origin: corsOrigins.includes('*') ? '*' : corsOrigins, methods: ['GET', 'POST'] }
});

// "Owner Prevails" order edit locks (audit H2), checked by the order write routes
const orderLocks = createOrderLockManager();

// Real-time stock push: Postgres NOTIFY (all branches) + this server's own writes
const inventoryEvents = createInventoryEvents({
  io,
  pgPool,
  localDb,
  databaseUrl: cloudDisabled ? null : process.env.DATABASE_URL,
  listenUrl: cloudDisabled ? null : process.env.PG_LISTEN_URL
});

// Socket connections need a valid, not signed-out login token
io.use((socket, next) => {
  const header = socket.handshake.headers.authorization || '';
  const token = socket.handshake.auth?.token || (header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!token) return next(new Error('Unauthorized: no token provided'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (isTokenRevoked(payload)) return next(new Error('Unauthorized: session ended'));
    socket.data.user = { user_id: payload.user_id, role: payload.role, sid: payload.sid || null };
    next();
  } catch (err) {
    next(new Error('Unauthorized: invalid or expired token'));
  }
});

// PB 1: "Log out" on a device also closes that device's live connection (its edit locks are
// released by the normal disconnect handler). Other devices of the account stay connected.
onSessionRevoked((sid) => {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user && socket.data.user.sid === sid) socket.disconnect(true);
  }
});

const validOrderId = (data) =>
  data && typeof data.orderId === 'string' && data.orderId.length > 0 && data.orderId.length <= 50;

io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`🔌 Client connected: ${socket.id} (${user.role})`);
  socket.emit('locks_snapshot', orderLocks.snapshot());
  inventoryEvents.attachSocket(socket); // 'inventory_subscribe' -> live 'inventory_updated'

  // Edit locks: socket.emit('editing_order', { orderId }, ack) while editing; 'release_order' when done.
  socket.on('editing_order', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!validOrderId(data)) return reply({ granted: false, error: 'orderId is required.' });
    const result = orderLocks.acquire(data.orderId, user, socket.id);
    if (!result.granted) return reply({ granted: false, reason: result.reason, lock: orderLocks.publicView(result.lock) });
    if (result.previous) {
      io.to(result.previous.socketId).emit('order_lock_revoked', { orderId: data.orderId, by: orderLocks.publicView(result.lock) });
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
    for (const orderId of orderLocks.releaseBySocket(socket.id)) io.emit('order_unlocked', { orderId });
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// ================= SYNC =================
// PB 4: every logged-in screen gets the connection state and the "changes waiting" count
// as a "sync_status" event (same body as GET /api/sync/status). Each branch server reports
// its own local queue.
const emitSyncStatus = async () => {
  try {
    io.emit('sync_status', await buildSyncStatus({ localDb, cloudHealth, conflicts: listConflicts }));
  } catch (err) {
    console.error('⚠️ Could not send the sync status:', err.message);
  }
};
// Writes saved offline come in bursts (an order and its items): send one update per burst
let localWriteTimer = null;
const onLocalWrite = () => {
  if (localWriteTimer) return;
  localWriteTimer = setTimeout(() => { localWriteTimer = null; emitSyncStatus(); }, 500);
};

// Runs a sync and pushes stock changes it pulled from / pushed to the cloud
const syncAndNotify = async () => {
  if (cloudDisabled) return { synced: 0, conflicts: [], failed: 0, requeued: 0, aborted: true };
  const running = syncOfflineData(pgPool, localDb);
  emitSyncStatus(); // shows "syncing" on every screen
  try {
    const summary = await running;
    if (summary && summary.inventory_changed && !summary.joined) inventoryEvents.notifyChanged([], 'sync');
    return summary;
  } finally {
    emitSyncStatus();
  }
};

// PB 3 / PB 4: tell the screens, and sync once when the cloud comes back. Single-flight in
// the sync service means this never overlaps the 5-minute timer or a "Sync now".
onCloudChange = () => { emitSyncStatus(); };
onCloudBack = () => {
  console.log('🔄 Cloud is back: sending changes saved on this computer.');
  return syncAndNotify();
};

// A screen that connects gets the current state straight away
io.on('connection', (socket) => {
  buildSyncStatus({ localDb, cloudHealth, conflicts: listConflicts })
    .then((status) => socket.emit('sync_status', status))
    .catch(() => {});
});

// ================= HTTP API =================
app = createApp({
  pgPool, localDb, localDbPath: sqliteDbPath, orderLocks, inventoryEvents, syncAndNotify, listConflicts,
  cloudHealth, onLocalWrite, corsOrigins
});

// Applies pending migrations/*.sql to Neon (AUTO_MIGRATE=false to manage them by hand)
const autoMigrate = async () => {
  if (cloudDisabled || String(process.env.AUTO_MIGRATE).toLowerCase() === 'false') return;
  try {
    await applyPendingMigrations(pgPool);
  } catch (err) {
    if (isConnectionError(err)) return console.warn('⚠️ Cloud unreachable; migrations will be applied on the next start.');
    console.error('❌ Automatic migration failed:', err.message, '\n   Fix it, then run "npm run migrate".');
  }
};

// Start-up: local tables, local sync columns, cloud migrations, schema check, first sync.
createLocalSchema(localDb)
  .then(() => ensureLocalSyncColumns(localDb, SYNC_TABLES.map((t) => t.table)))
  .then(() => upgradeLocalOrderStatusCheck(sqliteDbPath))
  .then(() => createLocalIndexes(localDb))
  .then(() => console.log('🗄️  Local cache tables ready'))
  .then(() => autoMigrate())
  .then(() => (cloudDisabled ? null : checkCloudSchema(pgPool)))
  .then(() => syncAndNotify())
  .then(() => startRevocationRefresh({ pgPool, localDb }))
  .catch((err) => console.error('❌ Startup sync failed:', err.message));

// Recycle Bin: permanently removes items deleted more than RECYCLE_BIN_RETENTION_DAYS ago
if (!cloudDisabled) startRecycleBinJanitor({ pgPool, localDb, inventoryEvents });

// Sync every 5 minutes. H3: overlapping runs are impossible (a call joins the running one).
setInterval(() => { syncAndNotify().catch(() => {}); }, 300000);

server.listen(PORT, () => {
  console.log(`🚀 XiaoMei ERP Backend running on http://localhost:${PORT}`);
  console.log(`🌐 Allowed frontend origins: ${corsOrigins.join(', ')}`);
});

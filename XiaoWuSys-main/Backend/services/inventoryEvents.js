// ==========================================
// REAL-TIME STOCK UPDATES (Socket.io)
//
// Two sources of "stock changed":
//  1. Postgres NOTIFY 'inventory_changed' (migration 003). Fires for every committed change
//     in Neon, from ANY backend/branch, the sync service, or the SQL editor.
//  2. notifyChanged() calls from this process. Covers offline writes (Neon down, so no
//     NOTIFY) and makes the local UI instant even while the LISTEN link is reconnecting.
//
// Bursts are coalesced (DEBOUNCE_MS) into ONE 'inventory_updated' event carrying the full
// catalog snapshot (same shape as GET /api/inventory) plus the IDs that changed.
//
// Server -> client events (room 'inventory', joined on 'inventory_subscribe'):
//   inventory_updated { reason, changed_ids, snapshot }
//   inventory_live    { listening }   whether cross-branch NOTIFY is currently active
//
// LISTEN needs a session-level connection. Neon's pooled endpoint (hostname with
// "-pooler", PgBouncer transaction mode) does NOT support LISTEN, so set PG_LISTEN_URL to
// the DIRECT (non-pooled) connection string. Without it, DATABASE_URL is used if it is
// direct; with a pooled DATABASE_URL, cross-branch push is disabled (local push still works).
// ==========================================
const { Client } = require('pg');
const { buildInventorySnapshot } = require('./inventorySnapshot');
const { refreshLocalRows } = require('./sync');

const ROOM = 'inventory';
const CHANNEL = 'inventory_changed';
const DEBOUNCE_MS = 250;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60000;

const isPooledUrl = (url) => {
  try { return /-pooler\./i.test(new URL(url).hostname); } catch { return false; }
};

const createInventoryEvents = ({ io, pgPool, localDb, databaseUrl, listenUrl }) => {
  const ctx = { pgPool, localDb };
  let pendingIds = new Set();
  let pendingReasons = new Set();
  let pendingCloudIds = new Set(); // changed in Neon by anyone -> copy into local cache
  let timer = null;
  let listening = false;
  let client = null;
  let stopped = false;
  let retryMs = RECONNECT_MIN_MS;

  const flush = async () => {
    timer = null;
    const changed_ids = [...pendingIds];
    const cloudIds = [...pendingCloudIds];
    const reason = [...pendingReasons].join(',');
    pendingIds = new Set();
    pendingCloudIds = new Set();
    pendingReasons = new Set();

    // Keep the offline cache current with changes made elsewhere (always, even with no viewers)
    if (cloudIds.length > 0) {
      try {
        await refreshLocalRows(pgPool, localDb, 'inventory_items', cloudIds);
      } catch (err) {
        console.error('⚠️ Could not refresh changed inventory rows into local cache:', err.message);
      }
    }
    if (io.sockets.adapter.rooms.get(ROOM)?.size > 0) {
      try {
        const snapshot = await buildInventorySnapshot(ctx);
        io.to(ROOM).emit('inventory_updated', { reason, changed_ids, snapshot });
      } catch (err) {
        console.error('❌ Could not build inventory snapshot for push:', err.message);
      }
    }
  };

  // Call after any write that changes inventory_items (ids may be empty = "something changed")
  const notifyChanged = (ids = [], reason = 'local_write') => {
    ids.filter(Boolean).forEach((id) => pendingIds.add(id));
    pendingReasons.add(reason);
    if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
  };

  const setListening = (value) => {
    if (listening !== value) {
      listening = value;
      io.to(ROOM).emit('inventory_live', { listening });
    }
  };

  // ---------- Postgres LISTEN with automatic reconnect ----------
  const url = listenUrl || databaseUrl;
  const listenDisabledReason = !url
    ? 'no database URL'
    : (!listenUrl && isPooledUrl(databaseUrl))
      ? 'DATABASE_URL is a Neon pooled (-pooler) endpoint; set PG_LISTEN_URL to the direct connection string'
      : null;

  const scheduleReconnect = () => {
    if (stopped) return;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
  };

  const connect = async () => {
    if (stopped) return;
    const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
    client = c;
    let failed = false;
    const onFailure = (err) => {
      if (failed) return;
      failed = true;
      if (err) console.error('⚠️ Inventory LISTEN connection lost:', err.message);
      setListening(false);
      c.removeAllListeners();
      c.end().catch(() => {});
      scheduleReconnect();
    };
    c.on('error', onFailure);
    c.on('end', () => onFailure(null));
    c.on('notification', (msg) => {
      if (msg.channel !== CHANNEL) return;
      try {
        const id = JSON.parse(msg.payload).inventory_id;
        if (id) pendingCloudIds.add(id);
        notifyChanged([id], 'cloud_change');
      } catch {
        notifyChanged([], 'cloud_change');
      }
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      retryMs = RECONNECT_MIN_MS;
      setListening(true);
      console.log('📡 Listening for inventory changes in the cloud (real-time push ON)');
      // Changes may have happened while we were disconnected: push a fresh snapshot
      notifyChanged([], 'resync');
    } catch (err) {
      onFailure(err);
    }
  };

  if (listenDisabledReason) {
    console.warn(`⚠️ Cross-branch inventory push disabled: ${listenDisabledReason}. Local changes are still pushed.`);
  } else {
    connect();
  }

  // ---------- Socket wiring ----------
  const attachSocket = (socket) => {
    socket.on('inventory_subscribe', async (_data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      socket.join(ROOM);
      try {
        reply({ ok: true, listening, snapshot: await buildInventorySnapshot(ctx) });
      } catch (err) {
        reply({ ok: false, listening, error: 'Could not load inventory.' });
      }
    });
    socket.on('inventory_unsubscribe', () => socket.leave(ROOM));
  };

  const stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (client) await client.end().catch(() => {});
  };

  return { notifyChanged, attachSocket, isListening: () => listening, stop };
};

module.exports = { createInventoryEvents, isPooledUrl };

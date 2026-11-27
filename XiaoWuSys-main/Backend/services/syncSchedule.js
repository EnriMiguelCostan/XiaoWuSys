// ==========================================
// WHEN THE BACKGROUND SYNC RUNS (egress fix, November 2026)
// The timer still wakes every SYNC_CHECK_MS (default 5 minutes), but a full sync run only
// happens when it can do something useful:
//   - work saved on this computer is waiting to be sent (always sent at once), or
//   - the real-time link (Postgres LISTEN) is down, so changes made on other branches are
//     not arriving by themselves, or
//   - the last sync that reached the cloud is older than SYNC_IDLE_MS (default 30 minutes)
// Otherwise the run is skipped: LISTEN / NOTIFY already copies stock and order changes into the
// local cache as they happen. "Sync now", the cloud coming back and start-up still sync at once.
// ==========================================
const minutes = (n) => n * 60 * 1000;
const positiveMs = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const SYNC_CHECK_MS = positiveMs(process.env.SYNC_CHECK_MS, minutes(5));
const SYNC_IDLE_MS = Math.max(SYNC_CHECK_MS, positiveMs(process.env.SYNC_IDLE_MS, minutes(30)));

// pendingCount: rows waiting to be sent; listening: whether LISTEN is connected;
// lastSyncAt: ISO time of the last sync that reached the cloud (or null)
// -> { run: boolean, reason }
const shouldRunScheduledSync = ({ pendingCount = 0, listening = false, lastSyncAt = null, now = Date.now(), idleMs = SYNC_IDLE_MS } = {}) => {
  if (pendingCount > 0) return { run: true, reason: 'pending' };
  if (!listening) return { run: true, reason: 'no_live_link' };
  const last = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
  if (!Number.isFinite(last)) return { run: true, reason: 'never_synced' };
  if (now - last >= idleMs) return { run: true, reason: 'idle_interval' };
  return { run: false, reason: 'up_to_date' };
};

module.exports = { SYNC_CHECK_MS, SYNC_IDLE_MS, shouldRunScheduledSync };

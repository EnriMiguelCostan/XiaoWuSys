// ==========================================
// SESSION REVOCATION
// A login token (JWT) is valid for 8 hours. When an account is deactivated, its role is
// changed, or its password is reset/changed, users.tokens_valid_after is set to NOW() and
// every token issued BEFORE that moment is rejected, so the person is signed out at once.
// "Log out" ends only that device's session: its token's sid goes into revoked_sessions.
//
// verifyToken must stay fast and synchronous, so the cut-off times are kept in memory:
//   - loaded from the database at start-up and refreshed every minute (other servers' changes)
//   - updated immediately when this server changes an account
// ==========================================
const { isConnectionError } = require('../utils/dbErrors');
const { sqliteAll } = require('./records');

const cutoffs = new Map(); // user_id -> epoch ms (Infinity = account deactivated)
// PB 1: sessions ended with "Log out" on ONE device (token "sid" -> token expiry, epoch ms).
// Other devices of the same account keep working. Loaded from revoked_sessions (migration 007).
const revokedSessions = new Map();
const sessionListeners = new Set();
const REFRESH_MS = 60 * 1000;

const isActiveValue = (v) => !(v === false || v === 0 || v === '0' || v === 'false' || v === 'f');

// Timestamps from Neon (NOW(), UTC) arrive as 'YYYY-MM-DD HH:MM:SS(.ffffff)' text
const toEpochMs = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim().replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? 0 : ms;
};

const applyRows = (rows) => {
  const next = new Map();
  for (const r of rows) {
    if (!isActiveValue(r.is_active)) next.set(r.user_id, Infinity);
    else if (toEpochMs(r.tokens_valid_after) > 0) next.set(r.user_id, toEpochMs(r.tokens_valid_after));
  }
  cutoffs.clear();
  for (const [k, v] of next) cutoffs.set(k, v);
};

// ---------- Per-device sign-out (PB 1) ----------
// listener(sid) runs once for every newly ended session, e.g. to close its live connection
const onSessionRevoked = (listener) => {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
};

const revokeSession = (sid, expiresAtMs) => {
  if (!sid) return;
  const isNew = !revokedSessions.has(sid);
  revokedSessions.set(sid, Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 24 * 3600 * 1000);
  if (!isNew) return;
  for (const listener of sessionListeners) {
    try { listener(sid); } catch (err) { console.error('⚠️ Session sign-out listener failed:', err.message); }
  }
};

// Rows: [{ session_id, expires_at }]. Expired sessions are dropped: their tokens are refused anyway.
const applySessionRows = (rows) => {
  const now = Date.now();
  for (const r of rows) {
    const exp = toEpochMs(r.expires_at);
    if (exp > now) revokeSession(r.session_id, exp);
  }
  for (const [sid, exp] of revokedSessions) if (exp <= now) revokedSessions.delete(sid);
};

// Cloud rows (every branch) plus local rows (logouts made here while offline, not synced yet)
const loadSessionRevocations = async ({ pgPool, localDb }) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT session_id, expires_at::text AS expires_at FROM revoked_sessions WHERE expires_at > (NOW() AT TIME ZONE 'UTC')`
    );
    applySessionRows(rows);
  } catch (err) {
    if (!isConnectionError(err) && !/(relation|column) .* does not exist/i.test(err.message)) {
      console.error('⚠️ Could not load the list of logged-out sessions:', err.message);
    }
  }
  try {
    applySessionRows(await sqliteAll(localDb, 'SELECT session_id, expires_at FROM revoked_sessions'));
  } catch { /* local table may not exist yet on first start */ }
};

// Cloud first, local cache when offline. Never throws.
const loadRevocations = async ({ pgPool, localDb }) => {
  await loadSessionRevocations({ pgPool, localDb });
  try {
    const { rows } = await pgPool.query(
      'SELECT user_id, is_active, tokens_valid_after::text AS tokens_valid_after FROM users WHERE is_active = FALSE OR tokens_valid_after IS NOT NULL'
    );
    applyRows(rows);
  } catch (err) {
    if (!isConnectionError(err) && !/column .* does not exist/i.test(err.message)) {
      console.error('⚠️ Could not load account sign-out list:', err.message);
    }
    try {
      applyRows(await sqliteAll(localDb, 'SELECT user_id, is_active, tokens_valid_after FROM users'));
    } catch { /* local table may not exist yet on first start */ }
  }
};

const startRevocationRefresh = (ctx) => {
  loadRevocations(ctx);
  const timer = setInterval(() => loadRevocations(ctx), REFRESH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
};

// Called right after this server signs an account out
// at: the same epoch-ms value written to users.tokens_valid_after (one clock for both)
const revokeUser = (user_id, { deactivated = false, at = Date.now() } = {}) => {
  cutoffs.set(user_id, deactivated ? Infinity : at);
};
const reactivateUser = (user_id, at = Date.now()) => cutoffs.set(user_id, at);

// SQL for "this epoch-ms value as a UTC TIMESTAMP" (users.tokens_valid_after has no time zone).
// The cut-off uses the app server's clock, like the token's iat, so database clock drift
// can never sign out a token that was issued after the change.
const CUTOFF_SQL = (param) => `(to_timestamp(${param}::double precision / 1000.0) AT TIME ZONE 'UTC')`;

// payload = decoded JWT. A token is revoked if it was issued before the cut-off: exactly, using
// its ims claim (milliseconds); for older tokens without it, by iat (seconds), when the whole
// issue second is before the cut-off.
const isTokenRevoked = (payload) => {
  if (payload && payload.sid && revokedSessions.has(payload.sid)) return true;
  const cutoff = cutoffs.get(payload && payload.user_id);
  if (!cutoff) return false;
  if (cutoff === Infinity) return true;
  if (Number.isFinite(payload.ims)) return payload.ims < cutoff;
  return ((Number(payload.iat) || 0) + 1) * 1000 <= cutoff;
};

module.exports = {
  loadRevocations, startRevocationRefresh, revokeUser, reactivateUser, isTokenRevoked, isActiveValue, toEpochMs, CUTOFF_SQL,
  revokeSession, onSessionRevoked
};

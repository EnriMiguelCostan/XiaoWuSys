// ==========================================
// SESSION REVOCATION
// A login token (JWT) is valid for 8 hours. When an account is deactivated, its role is
// changed, or its password is reset/changed, users.tokens_valid_after is set to NOW() and
// every token issued BEFORE that moment is rejected, so the person is signed out at once.
//
// verifyToken must stay fast and synchronous, so the cut-off times are kept in memory:
//   - loaded from the database at start-up and refreshed every minute (other servers' changes)
//   - updated immediately when this server changes an account
// ==========================================
const { isConnectionError } = require('../utils/dbErrors');
const { sqliteAll } = require('./records');

const cutoffs = new Map(); // user_id -> epoch ms (Infinity = account deactivated)
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

// Cloud first, local cache when offline. Never throws.
const loadRevocations = async ({ pgPool, localDb }) => {
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
  const cutoff = cutoffs.get(payload && payload.user_id);
  if (!cutoff) return false;
  if (cutoff === Infinity) return true;
  if (Number.isFinite(payload.ims)) return payload.ims < cutoff;
  return ((Number(payload.iat) || 0) + 1) * 1000 <= cutoff;
};

module.exports = { loadRevocations, startRevocationRefresh, revokeUser, reactivateUser, isTokenRevoked, isActiveValue, toEpochMs, CUTOFF_SQL };

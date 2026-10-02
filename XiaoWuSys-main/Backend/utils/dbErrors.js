// ==========================================
// DATABASE ERROR CLASSIFICATION (Audit fix C5)
// Only a genuine "cloud unreachable" error may trigger the SQLite offline fallback.
// Everything else (bad data, constraint violations, schema bugs) must be reported
// to the client instead of being silently cached as an unsyncable 'pending_insert'.
// ==========================================

// Node/OS-level network failures (DNS, TCP, TLS socket)
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE'
]);

// Postgres SQLSTATEs meaning "the server is not available right now"
// (class 08 = connection exception is handled separately below)
const UNAVAILABLE_SQLSTATES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (server starting up)
  '53300'  // too_many_connections
]);

// node-postgres / pg-pool errors that carry no code
const CONNECTION_MESSAGE_PATTERNS = [
  /connection terminated/i,                     // "Connection terminated unexpectedly" / "...due to connection timeout"
  /timeout exceeded when trying to connect/i,   // pg-pool connectionTimeoutMillis
  /client has encountered a connection error/i,
  /cannot use a pool after calling end/i
];

const isConnectionError = (err) => {
  if (!err) return false;

  // Node >= 20 may wrap per-address failures (IPv4 + IPv6) in an AggregateError
  if (Array.isArray(err.errors) && err.errors.some(isConnectionError)) return true;

  const code = typeof err.code === 'string' ? err.code : '';
  if (NETWORK_ERROR_CODES.has(code)) return true;
  if (UNAVAILABLE_SQLSTATES.has(code) || code.startsWith('08')) return true;

  const message = typeof err.message === 'string' ? err.message : '';
  return CONNECTION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
};

// Maps a NON-connection database error to a safe HTTP response.
// Internal details (table/column names, SQL) are logged, never sent to the client.
const sendDbError = (res, err, context = 'database operation') => {
  const code = typeof err?.code === 'string' ? err.code : '';
  console.error(`✗ ${context} failed [${code || 'no code'}]:`, err?.message);

  let status = 500;
  let body = { error: 'DATABASE_ERROR', message: `Unexpected database error during ${context}.` };

  if (code === '23505') {
    status = 409;
    body = { error: 'DUPLICATE_RECORD', message: 'A record with this value already exists.' };
  } else if (code === '23503') {
    status = 400;
    body = { error: 'INVALID_REFERENCE', message: 'A referenced record (e.g. customer, order or inventory item) does not exist.' };
  } else if (code === '23502') {
    status = 400;
    body = { error: 'MISSING_REQUIRED_FIELD', message: 'A required field is missing.' };
  } else if (code === '23514') {
    status = 400;
    body = { error: 'CONSTRAINT_VIOLATION', message: 'A value is outside the allowed range.' };
  } else if (code.startsWith('22')) {
    // Class 22 = data exception: invalid dates, numbers, UUIDs, strings too long, etc.
    status = 400;
    body = { error: 'INVALID_INPUT', message: 'One or more fields have an invalid format or value.' };
  } else if (code === 'SQLITE_CONSTRAINT' && /FOREIGN KEY/i.test(err?.message || '')) {
    // H5: foreign keys are now enforced offline. The parent is not in the local cache yet.
    status = 400;
    body = {
      error: 'INVALID_REFERENCE',
      message: 'Offline: the referenced customer, order or inventory item is not in the local cache. ' +
               'It will be available after the next successful sync.'
    };
  } else if (code === 'SQLITE_CONSTRAINT') {
    status = 400;
    body = { error: 'CONSTRAINT_VIOLATION', message: 'Offline: a required field is missing or a value is not allowed.' };
  } else if (code.startsWith('SQLITE')) {
    // Only reached after the cloud was confirmed unreachable
    body = { error: 'LOCAL_CACHE_ERROR', message: 'Cloud database unreachable and the local cache failed.' };
  }

  return res.status(status).json(body);
};

module.exports = { isConnectionError, sendDbError };

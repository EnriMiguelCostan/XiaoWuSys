// ==========================================
// INPUT VALIDATION (Audit fix M7)
// Strict, type-exact checks run BEFORE any database call. Numbers must be JSON numbers
// (the string "5" is rejected), so text can never reach an INTEGER or NUMERIC column.
//
// Usage:
//   const v = createValidator();
//   const qty = v.positiveInt(body.quantity, 'quantity');
//   if (v.failed()) return v.send(res);
// ==========================================

const INT_MAX = 2147483647;          // Postgres INTEGER
const MONEY_MAX = 99999999.99;       // NUMERIC(10,2)
const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,50}$/; // matches VARCHAR(50) IDs (UUIDs, 'CUST-001', ...)
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Asia/Manila';

const PAYMENT_TYPES = ['Cash', 'GCash', 'Bank Transfer'];
const PRODUCTION_STATUSES = ['Pending', 'Printing', 'Completed', 'Delayed', 'Cancelled'];

// 'YYYY-MM-DDTHH:MM:SS' for a Date, as seen on a wall clock in the business timezone
const localDateTime = (date, timeZone = BUSINESS_TIMEZONE) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
};

const DEADLINE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

// Parses a deadline and normalizes it to 'YYYY-MM-DDTHH:MM:SS' (business-local wall time,
// matching the TIMESTAMP-without-time-zone columns). Rejects impossible and past dates.
const parseDeadline = (value, now = new Date()) => {
  if (typeof value !== 'string') return { error: 'must be a date string (YYYY-MM-DD).' };
  const m = DEADLINE_PATTERN.exec(value.trim());
  if (!m) return { error: 'must be a date (YYYY-MM-DD) or date-time (YYYY-MM-DDTHH:MM).' };

  const [, y, mo, d, hh = '00', mi = '00', ss = '00', zone] = m;
  const calendar = new Date(Date.UTC(+y, +mo - 1, +d));
  if (calendar.getUTCFullYear() !== +y || calendar.getUTCMonth() !== +mo - 1 || calendar.getUTCDate() !== +d) {
    return { error: 'is not a real calendar date.' };
  }
  if (+hh > 23 || +mi > 59 || +ss > 59) return { error: 'has an invalid time of day.' };

  const normalized = zone
    ? localDateTime(new Date(value.trim()))            // explicit offset: convert to business time
    : `${y}-${mo}-${d}T${hh}:${mi}:${ss}`;
  const nowLocal = localDateTime(now);
  const dateOnly = m[4] === undefined;

  if (dateOnly ? normalized.slice(0, 10) < nowLocal.slice(0, 10) : normalized < nowLocal) {
    return { error: `cannot be in the past (today is ${nowLocal.slice(0, 10)} ${BUSINESS_TIMEZONE}).` };
  }
  return { value: normalized };
};

const isMissing = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const hasAtMostTwoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const createValidator = () => {
  const errors = [];
  const fail = (field, message) => { errors.push({ field, message: `${field} ${message}` }); return undefined; };

  const integer = (value, field, { min, required = true, defaultValue }) => {
    if (isMissing(value)) return required ? fail(field, 'is required.') : defaultValue;
    if (typeof value !== 'number' || !Number.isInteger(value)) return fail(field, 'must be a whole number (not text or a fraction).');
    if (value < min) return fail(field, min === 1 ? 'must be greater than 0.' : 'cannot be negative.');
    if (value > INT_MAX) return fail(field, `must be at most ${INT_MAX}.`);
    return value;
  };

  const money = (value, field, { allowZero, required = true, defaultValue }) => {
    if (isMissing(value)) return required ? fail(field, 'is required.') : defaultValue;
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail(field, 'must be a number (not text).');
    if (value < 0 || (!allowZero && value === 0)) return fail(field, allowZero ? 'cannot be negative.' : 'must be greater than 0.');
    if (!hasAtMostTwoDecimals(value)) return fail(field, 'can have at most 2 decimal places (centavos).');
    if (value > MONEY_MAX) return fail(field, `must be at most ${MONEY_MAX}.`);
    return value;
  };

  const string = (value, field, { required = true, max }) => {
    if (isMissing(value)) return required ? fail(field, 'is required.') : null;
    if (typeof value !== 'string') return fail(field, 'must be text.');
    const trimmed = value.trim();
    if (trimmed.length > max) return fail(field, `must be at most ${max} characters.`);
    return trimmed;
  };

  return {
    errors,
    failed: () => errors.length > 0,
    send: (res) => res.status(400).json({ error: 'VALIDATION_FAILED', message: errors[0].message, details: errors }),

    id: (value, field, { required = true } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required.') : null;
      if (typeof value !== 'string' || !ID_PATTERN.test(value)) return fail(field, 'is not a valid ID.');
      return value;
    },
    requiredString: (value, field, max) => string(value, field, { max }),
    optionalString: (value, field, max) => string(value, field, { required: false, max }),
    positiveInt: (value, field) => integer(value, field, { min: 1 }),
    nonNegativeInt: (value, field, defaultValue = 0) => integer(value, field, { min: 0, required: false, defaultValue }),
    positiveMoney: (value, field) => money(value, field, { allowZero: false }),
    nonNegativeMoney: (value, field, { required = true, defaultValue } = {}) =>
      money(value, field, { allowZero: true, required, defaultValue }),
    oneOf: (value, field, allowed, { required = true } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required.') : undefined;
      if (!allowed.includes(value)) return fail(field, `must be one of: ${allowed.join(', ')}.`);
      return value;
    },
    deadline: (value, field) => {
      if (isMissing(value)) return fail(field, 'is required.');
      const parsed = parseDeadline(value);
      return parsed.error ? fail(field, parsed.error) : parsed.value;
    },
    pagination: (query) => {
      const toInt = (raw, field, def, min, max) => {
        if (raw === undefined) return def;
        const n = /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
        if (!Number.isInteger(n) || n < min || n > max) return fail(field, `must be a whole number between ${min} and ${max}.`);
        return n;
      };
      return { limit: toInt(query.limit, 'limit', 50, 1, 200), offset: toInt(query.offset, 'offset', 0, 0, 1000000) };
    }
  };
};

module.exports = {
  createValidator,
  parseDeadline,
  localDateTime,
  PAYMENT_TYPES,
  PRODUCTION_STATUSES,
  ID_PATTERN,
  BUSINESS_TIMEZONE
};

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
const MOBILE_PATTERN = /^0\d{10}$/;           // e.g. 09171234567
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
  if (typeof value !== 'string') return { error: 'must be a date. Please pick one from the calendar.' };
  const m = DEADLINE_PATTERN.exec(value.trim());
  if (!m) return { error: 'must be a date. Please pick one from the calendar.' };

  const [, y, mo, d, hh = '00', mi = '00', ss = '00', zone] = m;
  const calendar = new Date(Date.UTC(+y, +mo - 1, +d));
  if (calendar.getUTCFullYear() !== +y || calendar.getUTCMonth() !== +mo - 1 || calendar.getUTCDate() !== +d) {
    return { error: 'is not a real date. Please pick one from the calendar.' };
  }
  if (+hh > 23 || +mi > 59 || +ss > 59) return { error: 'has a time that does not exist. Please check the time.' };

  const normalized = zone
    ? localDateTime(new Date(value.trim()))            // explicit offset: convert to business time
    : `${y}-${mo}-${d}T${hh}:${mi}:${ss}`;
  const nowLocal = localDateTime(now);
  const dateOnly = m[4] === undefined;

  if (dateOnly ? normalized.slice(0, 10) < nowLocal.slice(0, 10) : normalized < nowLocal) {
    return {
      error: `cannot be a date that has already passed. Please choose today (${friendlyDate(nowLocal.slice(0, 10))}) or a later date.`
    };
  }
  return { value: normalized };
};

// Plain-language names for fields, used in error messages shown to users.
// The technical field name is still returned in details[].field for programs.
const FIELD_LABELS = {
  production_deadline: 'Production deadline', customer_id: 'Customer', order_id: 'Order', inventory_id: 'Item',
  item_name: 'Item name', item_category: 'Category', quantity_available: 'Quantity in stock', quantity: 'Quantity',
  quantity_lost: 'Quantity lost', minimum_threshold: 'Low-stock alert', unit_cost: 'Unit cost',
  total_quote_amount: 'Quote amount', amount: 'Amount', payment_type: 'Payment type', financial_cost: 'Cost',
  full_name: 'Customer name', contact_number: 'Mobile number', platform_source: 'Where the customer came from',
  loss_reason: 'Reason', reason: 'Reason', resolution: 'Resolution', status: 'Status', action: 'Action',
  product_type: 'Product type', size: 'Size', custom_name: 'Custom name', custom_number: 'Custom number',
  category: 'Category', stock_status: 'Stock status', search: 'Search', limit: 'Page size', offset: 'Page'
};
const labelOf = (field) =>
  FIELD_LABELS[field] || String(field).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// 'October 27, 2026' for a 'YYYY-MM-DD' string
const friendlyDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
};

const isMissing = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const hasAtMostTwoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const createValidator = () => {
  const errors = [];
  const fail = (field, message) => { errors.push({ field, message: `${labelOf(field)} ${message}` }); return undefined; };

  const integer = (value, field, { min, required = true, defaultValue }) => {
    if (isMissing(value)) return required ? fail(field, 'is required. Please fill it in.') : defaultValue;
    if (typeof value !== 'number' || !Number.isInteger(value)) return fail(field, 'must be a whole number, like 1, 5 or 20.');
    if (value < min) return fail(field, min === 1 ? 'must be at least 1.' : 'cannot be less than 0.');
    if (value > INT_MAX) return fail(field, 'is too large. Please enter a smaller number.');
    return value;
  };

  const money = (value, field, { allowZero, required = true, defaultValue }) => {
    if (isMissing(value)) return required ? fail(field, 'is required. Please fill it in.') : defaultValue;
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail(field, 'must be a peso amount, like 150 or 150.50.');
    if (value < 0 || (!allowZero && value === 0)) return fail(field, allowZero ? 'cannot be less than ₱0.' : 'must be more than ₱0.');
    if (!hasAtMostTwoDecimals(value)) return fail(field, 'can only have centavos up to 2 digits, like 150.50.');
    if (value > MONEY_MAX) return fail(field, 'is too large. The highest allowed amount is ₱99,999,999.99.');
    return value;
  };

  const string = (value, field, { required = true, max }) => {
    if (isMissing(value)) return required ? fail(field, 'is required. Please fill it in.') : null;
    if (typeof value !== 'string') return fail(field, 'must be written as text.');
    const trimmed = value.trim();
    if (trimmed.length > max) return fail(field, `is too long. Please keep it to ${max} characters or fewer.`);
    return trimmed;
  };

  return {
    errors,
    failed: () => errors.length > 0,
    send: (res) => res.status(400).json({ error: 'VALIDATION_FAILED', message: errors[0].message, details: errors }),

    id: (value, field, { required = true } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required. Please select one.') : null;
      if (typeof value !== 'string' || !ID_PATTERN.test(value)) return fail(field, 'was not recognized. Please select it again from the list.');
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
      if (isMissing(value)) return required ? fail(field, 'is required. Please choose one.') : undefined;
      if (!allowed.includes(value)) return fail(field, `must be one of these: ${allowed.join(', ')}.`);
      return value;
    },
    deadline: (value, field) => {
      if (isMissing(value)) return fail(field, 'is required. Please pick a date.');
      const parsed = parseDeadline(value);
      return parsed.error ? fail(field, parsed.error) : parsed.value;
    },
    // Philippine mobile number: exactly 11 digits starting with 0 (spaces/dashes ignored)
    mobileNumber: (value, field, { required = false } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required. Please fill it in.') : null;
      if (typeof value !== 'string') return fail(field, 'must be written as numbers, like 09171234567.');
      const digits = value.replace(/[\s-]/g, '');
      if (!MOBILE_PATTERN.test(digits)) {
        return fail(field, 'must be exactly 11 digits and start with 0, like 09171234567.');
      }
      return digits;
    },
    pagination: (query) => {
      const toInt = (raw, field, def, min, max) => {
        if (raw === undefined) return def;
        const n = /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
        if (!Number.isInteger(n) || n < min || n > max) return fail(field, `must be a whole number from ${min} to ${max}.`);
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
  MOBILE_PATTERN,
  labelOf,
  BUSINESS_TIMEZONE
};

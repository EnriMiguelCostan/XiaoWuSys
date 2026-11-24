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
const TRACKING_NO_PATTERN = /^XM-\d{4}-\d{4,9}$/; // order number, e.g. XM-2026-0123 (migration 007)
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Asia/Manila';
// The date window every calendar accepts: 2018 to 2034 (8 years either side of 2026).
// Same as Web/lib/input-limits.ts EARLIEST_DATE / LATEST_DATE; keep the two in step.
const EARLIEST_DAY = '2018-01-01';
const LATEST_DAY = '2034-12-31';

// Migration 015 adds Maya, PayPal, cheque, card and "Other" (each with the details it needs:
// services/domain/payments.js PAYMENT_METHOD_RULES)
const PAYMENT_TYPES = ['Cash', 'GCash', 'Maya', 'PayPal', 'Bank Transfer', 'Cheque', 'Credit/Debit Card', 'Other'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Any phone a supplier may give: mobile, landline with area code, +63 ... (7 to 20 characters)
const PHONE_PATTERN = /^\+?[0-9(][0-9 ()-]{5,18}[0-9]$/;
// Sprint 11 / PB 13 adds 'Approved'; PB 14 (migration 010) adds the optional 'Pressing' step:
// Pending -> Approved -> Printing -> (Pressing ->) Completed
// Migration 016 adds 'Ready': production is done and the order waits to be picked up / delivered
const PRODUCTION_STATUSES = ['Pending', 'Approved', 'Printing', 'Pressing', 'Ready', 'Completed', 'Delayed', 'Cancelled'];

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
  if (normalized.slice(0, 10) > LATEST_DAY) {
    return { error: `is too far ahead. Please choose a date on or before ${friendlyDate(LATEST_DAY)}.` };
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
  category: 'Category', stock_status: 'Stock status', search: 'Search', limit: 'Page size', offset: 'Page',
  sort: 'Sort by', dir: 'Sort direction', tracking_no: 'Order number', design_drive_link: 'Design link',
  quantity_reserved: 'Reserved stock', supplier: 'Supplier', unit: 'Unit', keep: 'Which version to keep',
  // migration 011 (PB 11 / PB 12 / PB 15)
  selling_price: 'Selling price', subtotal_amount: 'Subtotal', discount_amount: 'Discount', discount_percent: 'Discount (%)',
  discount_reason: 'Reason for the discount', quantity_per_piece: 'Amount per piece', trigger_status: 'When it is used',
  consumable_inventory_id: 'Consumable', items: 'Items', rates: 'Usage rates', dry_run: 'Preview only',
  // migration 012 (PB 18 / PB 19 / PB 22 / PB 23)
  reason_code: 'Reason', loss_category: 'Cause', production_stage: 'Production step',
  cancellation_reason: 'Reason for cancelling', void_reason: 'Reason for voiding', confirm_break_downpayment: 'Confirmation',
  expense_date: 'Date', description: 'Description', from: 'Start date', to: 'End date', payment_id: 'Payment',
  expense_id: 'Expense',
  // migration 013 (PB 23 archiving)
  include_archived: 'Show archived', archived_at: 'Archived on', customer: 'Customer',
  // migration 015 (inventory system, client profiles, payments, deliveries)
  supplier_id: 'Supplier', supplier_name: 'Supplier name', contact_person: 'Contact person', email: 'Email',
  address: 'Address', notes: 'Notes', has_sizes: 'Has sizes', document_type: 'Kind of record', reference_type: 'Kind of paper',
  reference_no: 'Reference number', occurred_at: 'Date and time', lines: 'Items', unit_cost_line: 'Unit cost',
  counted_quantity: 'Counted quantity', order_description: 'Order description', labor_amount: 'Labor and services',
  incidental_amount: 'Incidental charges', incidental_percent: 'Incidental charges (%)', payer_name: 'Paid by',
  bank_name: 'Bank', account_name: 'Sender account name', cheque_no: 'Cheque number', cheque_date: 'Cheque date',
  payment_notes: 'Payment notes', payment_date: 'Date paid', refund_reason: 'Reason for the refund',
  customer_type: 'Client type', social_media: 'Social media', print_type: 'What is printed', line_item_id: 'Material',
  batch_no: 'Batch', delivered_at: 'Date delivered', method: 'How it was handed over', received_by_name: 'Received by',
  allow_unpaid: 'Complete with a balance due', month: 'Month', movement_type: 'Movement'
};
const labelOf = (field) =>
  FIELD_LABELS[field] || String(field).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// A wall-clock time in the business timezone ('YYYY-MM-DDTHH:MM:SS') -> the Date it is.
// Works for any zone: the offset is read from Intl for that moment (Manila has no DST anyway).
const shopTimeToUtc = (local, timeZone = BUSINESS_TIMEZONE) => {
  const asUtc = new Date(`${local}Z`);
  const seen = new Date(`${localDateTime(asUtc, timeZone)}Z`); // the same instant on the shop clock
  return new Date(asUtc.getTime() - (seen.getTime() - asUtc.getTime()));
};

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
    // Order number like XM-2026-0123 (case and surrounding spaces ignored) -> 'XM-2026-0123'
    trackingNo: (value, field, { required = true } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required. Please type it in.') : null;
      const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
      if (!TRACKING_NO_PATTERN.test(text)) return fail(field, 'must look like XM-2026-0123.');
      return text;
    },
    // Order-number keyword search (PB 6+): "12", "0012", "2026-00", "xm-2026-0012".
    // -> { digitsOnly, pattern } where pattern is a LIKE pattern, or null when empty.
    // Only letters, digits and dashes are accepted, so the pattern never contains % or _
    // typed by the user (no wildcard tricks).
    orderNumberSearch: (value, field) => {
      if (isMissing(value)) return null;
      const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
      if (text === '') return null;
      if (!/^[A-Z0-9-]{1,20}$/.test(text)) return fail(field, 'can only contain letters, numbers and dashes, like 12 or XM-2026-0012.');
      return { digitsOnly: /^\d+$/.test(text), pattern: `%${text}%` };
    },
    oneOf: (value, field, allowed, { required = true } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required. Please choose one.') : undefined;
      if (!allowed.includes(value)) return fail(field, `must be one of these: ${allowed.join(', ')}.`);
      return value;
    },
    // A calendar day 'YYYY-MM-DD' (shop dates for reports and expenses; past dates allowed).
    // latest: optional 'YYYY-MM-DD' it may not be after (e.g. today for an expense).
    shopDay: (value, field, { required = true, latest = null } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required. Please pick a date.') : null;
      const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
      if (!m) return fail(field, 'must be a date. Please pick one from the calendar.');
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
        return fail(field, 'is not a real date. Please pick one from the calendar.');
      }
      const ymd = value.trim();
      if (ymd < EARLIEST_DAY || ymd > LATEST_DAY) {
        return fail(field, `must be between ${friendlyDate(EARLIEST_DAY)} and ${friendlyDate(LATEST_DAY)}.`);
      }
      if (latest && ymd > latest) return fail(field, `cannot be later than today (${friendlyDate(latest)}).`);
      return ymd;
    },
    deadline: (value, field) => {
      if (isMissing(value)) return fail(field, 'is required. Please pick a date.');
      const parsed = parseDeadline(value);
      return parsed.error ? fail(field, parsed.error) : parsed.value;
    },
    // A date and time on the shop's clock ('YYYY-MM-DDTHH:MM' or with seconds), for something
    // that already happened: a delivery received, a payment made, a count. Not in the future
    // (a minute of clock drift is allowed), not before EARLIEST_DAY.
    // -> the UTC timestamp 'YYYY-MM-DD HH:MM:SS' the TIMESTAMP columns store (like CURRENT_TIMESTAMP)
    pastShopDateTime: (value, field, { required = true, now = new Date() } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required. Please pick the date and time.') : null;
      const m = typeof value === 'string'
        ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim()) : null;
      if (!m) return fail(field, 'must be a date and time. Please pick them from the calendar.');
      const [, y, mo, d, hh, mi, ss = '00'] = m;
      const day = new Date(Date.UTC(+y, +mo - 1, +d));
      if (day.getUTCFullYear() !== +y || day.getUTCMonth() !== +mo - 1 || day.getUTCDate() !== +d) {
        return fail(field, 'is not a real date. Please pick one from the calendar.');
      }
      if (+hh > 23 || +mi > 59 || +ss > 59) return fail(field, 'has a time that does not exist. Please check the time.');
      const ymd = `${y}-${mo}-${d}`;
      if (ymd < EARLIEST_DAY) return fail(field, `cannot be before ${friendlyDate(EARLIEST_DAY)}.`);
      const utc = shopTimeToUtc(`${ymd}T${hh}:${mi}:${ss}`);
      if (utc.getTime() > now.getTime() + 60 * 1000) {
        return fail(field, 'cannot be in the future. Choose the date and time it really happened.');
      }
      return utc.toISOString().slice(0, 19).replace('T', ' ');
    },
    email: (value, field, { required = false } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required. Please fill it in.') : null;
      if (typeof value !== 'string') return fail(field, 'must be written as text.');
      const text = value.trim();
      if (text.length > 255 || !EMAIL_PATTERN.test(text)) return fail(field, 'must look like name@example.com.');
      return text;
    },
    phone: (value, field, { required = false } = {}) => {
      if (isMissing(value)) return required ? fail(field, 'is required. Please fill it in.') : null;
      if (typeof value !== 'string' || !PHONE_PATTERN.test(value.trim())) {
        return fail(field, 'must be a phone number, like 09171234567 or (082) 123 4567.');
      }
      return value.trim().replace(/\s+/g, ' ');
    },
    bool: (value, field, { defaultValue = false } = {}) => {
      if (value === undefined || value === null) return defaultValue;
      if (typeof value !== 'boolean') return fail(field, 'must be yes or no (true or false).');
      return value;
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
  EARLIEST_DAY,
  LATEST_DAY,
  localDateTime,
  shopTimeToUtc,
  PAYMENT_TYPES,
  PRODUCTION_STATUSES,
  ID_PATTERN,
  TRACKING_NO_PATTERN,
  MOBILE_PATTERN,
  labelOf,
  BUSINESS_TIMEZONE
};

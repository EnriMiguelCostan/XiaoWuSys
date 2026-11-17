// Native HTML input bounds (maxLength / max). They stop impossible input early (a typo with
// twelve extra zeros) and let the browser explain it. They are the database's STORAGE limits,
// copied from Backend/utils/validation.js and the routes' string lengths, not business rules:
// the server still validates every field and its plain-language 400 message is shown.
// If a backend limit changes, change it here.

/** Postgres INTEGER (quantities, low-stock alert): validation.js INT_MAX */
export const WHOLE_NUMBER_MAX = 2147483647;

/** NUMERIC(10,2) (unit cost, quote, payments): validation.js MONEY_MAX */
export const MONEY_INPUT_MAX = 99999999.99;

/** Text lengths the server accepts, per field */
export const TEXT_MAX = {
  default: 255, // item_name, supplier, full_name, custom_name
  category: 100, // item_category
  unit: 30,
  platformSource: 100,
  productType: 100,
  shortCode: 50, // size, custom_number
  designLink: 2048, // utils/validateDriveLink.js
  search: 100, // GET /inventory?search=
  orderNumber: 20, // XM-2026-0123 (normalizeOrderNumber accepts up to 9 digits)
  note: 200, // loss note (sent inside loss_reason, max 1000)
  reason: 1000, // cancellation_reason, void reason (routes/orders.js CANCEL_REASON_MAX / VOID_REASON_MAX)
  expenseDescription: 250, // overhead_expenses.description (routes/reports.js DESCRIPTION_MAX)
  username: 100, // users.username VARCHAR(100), routes/auth.js MAX_USERNAME_LENGTH
  password: 72, // bcrypt reads at most 72 bytes (routes/auth.js MAX_PASSWORD_BYTES)
} as const;

// ---------------------------------------------------------------------------------------------
// Form limits. These are STRICTER than the storage limits above on purpose: they are what a
// sensible entry looks like in this shop (a jersey back name, a discount reason that fits the
// printed quote). The server still enforces its own (wider) storage limits.

/** "Add print details" line (order detail sheet) */
export const PRINT_LINE_LIMITS = {
  productType: 60, // "Jersey print", "Sublimated shorts"
  name: 50, // name on the back of the jersey
  numberDigits: 3, // jersey number 0-999 (leading zeros kept: "00", "07")
  quantity: 9999, // pieces on ONE line
} as const;

/** Garment sizes offered in the print-details size dropdown, smallest first */
export const GARMENT_SIZES = [
  'Kids 2', 'Kids 4', 'Kids 6', 'Kids 8', 'Kids 10', 'Kids 12', 'Kids 14', 'Kids 16',
  'XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL',
  'Free size',
] as const;

/** Calculate quote & discount */
export const DISCOUNT_LIMITS = { reasonMin: 3, reasonMax: 150, percentMin: 0.01, percentMax: 100 } as const;

/** Log misprint / material loss: optional note */
export const LOSS_NOTE_MAX = 200;

/** Overhead expense description (shown in full with the "View" button) */
export const EXPENSE_DESCRIPTION_MAX = 250;

/** Name characters: letters (incl. Ñ, accents), spaces, period, hyphen, apostrophe */
// (built with new RegExp: the tsconfig target, ES2017, predates \p{…} in regex literals)
export const NAME_CHARS = new RegExp("^[\\p{L}\\p{M} .'-]*$", 'u');
/** At most 2 decimals, e.g. 12.5 or 150.75 */
export const TWO_DECIMALS = /^\d+(\.\d{1,2})?$/;

/**
 * The date window every calendar in the app accepts: 2018 to 2034 (8 years either side of
 * 2026). The picker greys out anything outside it, and a hand-typed year outside it (e.g. 1900
 * or 2099) is moved back inside on leaving the field. The server checks the same window
 * (Backend/utils/validation.js EARLIEST_DAY / LATEST_DAY); keep the two in step.
 */
export const EARLIEST_DATE = '2018-01-01';
export const LATEST_DATE = '2034-12-31';

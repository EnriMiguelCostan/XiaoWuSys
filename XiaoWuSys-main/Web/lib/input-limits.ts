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
  username: 100, // users.username VARCHAR(100), routes/auth.js MAX_USERNAME_LENGTH
  password: 72, // bcrypt reads at most 72 bytes (routes/auth.js MAX_PASSWORD_BYTES)
} as const;

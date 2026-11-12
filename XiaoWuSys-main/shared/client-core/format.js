// Display formatting shared by every screen (moved from Frontend/src/api.js in Batch M0).
// Formatting only: these never decide anything. Money arithmetic stays on the server.

// Today's date in the shop's time zone, 'YYYY-MM-DD' (for date pickers' minimum)
export const todayInManila = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Philippine mobile number: exactly 11 digits starting with 0 (input format check only;
// the server validates again)
export const MOBILE_PATTERN = /^0\d{10}$/;

export const peso = (n) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// 'YYYY-MM-DDTHH:MM:SS' -> 'Oct 8, 2026, 2:15 PM'
// utc: true for server-generated times (date_created, deleted_at, payment_date: NOW() in UTC);
// false for wall-clock values typed by users (production_deadline, Asia/Manila).
export const formatDateTime = (value, { withTime = true, utc = false } = {}) => {
  if (!value) return '—';
  const text = String(value).replace(' ', 'T');
  const d = new Date(utc && !/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? `${text}Z` : text);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-PH', withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
};

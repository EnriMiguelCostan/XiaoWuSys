// Small fetch wrapper shared by the Catalog, Recycle Bin and Orders screens.
// Never throws: resolves to { ok, status, data }. status 0 = server unreachable.
export const createApi = ({ apiBase, token, onUnauthorized }) => async (method, path, body) => {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`${method} ${path} failed`, err);
    return { ok: false, status: 0, data: { message: 'Cannot reach the server. Check that the backend is running.' } };
  }
};

// Downloads a file (e.g. a CSV export) that needs the login token. -> { ok, message? }
export const downloadFile = async ({ apiBase, token, path, onUnauthorized }) => {
  try {
    const res = await fetch(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, message: errorText(data, 'The file could not be downloaded.') };
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'export.csv';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, name, offline: res.headers.get('X-Data-Source') === 'local' };
  } catch (err) {
    console.error(`download ${path} failed`, err);
    return { ok: false, message: 'Cannot reach the server. Check that the backend is running.' };
  }
};

// Copies text to the clipboard (with a fallback for older browsers / plain http). -> boolean
export const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
};

// Minimal CSV reader for imports (handles quotes, commas and line breaks inside quotes,
// and the BOM Excel adds). -> array of rows (arrays of strings)
export const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^\uFEFF/, '');
  // Excel uses ";" instead of "," in some regional settings; Google Sheets "TSV" uses tabs.
  // Pick whichever appears most in the header line.
  const header = src.split(/\r?\n/, 1)[0] || '';
  const count = (c) => header.split(c).length - 1;
  const delim = [',', ';', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best), ',');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
};

// Plain-language messages for errors whose server text is technical. Everything else
// (validation, duplicates, stock shortages) already comes back in plain language.
const FRIENDLY_ERRORS = {
  INVENTORY_ITEM_NOT_FOUND: 'This item is no longer in the inventory. It may have been deleted or moved to the Recycle Bin. Refresh the page and try again.',
  DATABASE_ERROR: 'Something went wrong on our side, so nothing was saved. Please try again. If it keeps happening, tell the system administrator.',
  INTERNAL_ERROR: 'Something went wrong on our side, so nothing was saved. Please try again. If it keeps happening, tell the system administrator.',
  LOCAL_CACHE_ERROR: 'The system is offline and could not save on this computer either. Nothing was saved. Please try again later.',
  INVALID_REFERENCE: 'Something you selected is no longer available (for example a customer or material). Refresh the page and choose it again.',
  INVALID_INPUT: 'One of the values you entered is not in the right format. Please check your entries and try again.',
  MISSING_REQUIRED_FIELD: 'Some required information is missing. Please fill in all the required fields.',
  CONSTRAINT_VIOLATION: 'One of the values you entered is not allowed. Please check your entries and try again.',
  DUPLICATE_RECORD: 'This record already exists, so it was not saved again.',
  INVALID_JSON: 'The information could not be sent properly. Please refresh the page and try again.',
  PAYLOAD_TOO_LARGE: 'Too much information was sent at once. Please shorten your entries and try again.',
  NOT_FOUND: 'This feature is not available on the server yet. Make sure the backend is up to date and restarted.',
  SESSION_EXPIRED: 'Your session has expired. Please log in again.',
  SESSION_ENDED: 'Your session has ended (your account was changed). Please log in again.',
  INVALID_SESSION: 'Your session is not valid. Please log in again.',
  NOT_LOGGED_IN: 'Please log in to continue.'
};

export const errorText = (data, fallback) => {
  if (!data) return fallback;
  if (FRIENDLY_ERRORS[data.error]) return FRIENDLY_ERRORS[data.error];
  const text = data.message || data.error;
  if (typeof text === 'string') {
    if (/^Forbidden/i.test(text)) return 'Your account does not have permission to do this. Please ask an Owner or Admin.';
    if (/token|log in/i.test(text)) return 'Your session has expired. Please log in again.';
  }
  return text || fallback;
};

// Today's date in the shop's time zone, 'YYYY-MM-DD' (for date pickers' minimum)
export const todayInManila = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Philippine mobile number: exactly 11 digits starting with 0
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

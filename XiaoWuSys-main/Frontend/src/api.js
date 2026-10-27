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

export const errorText = (data, fallback) => (data && (data.message || data.error)) || fallback;

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

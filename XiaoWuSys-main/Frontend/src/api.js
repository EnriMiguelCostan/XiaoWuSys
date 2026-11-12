// Vite MVP (frozen, Batch M0): the shared, non-DOM helpers now live in shared/client-core so the
// Next.js and mobile apps use the very same code. This file re-exports them under the old names
// and keeps only the two helpers that need the browser DOM.
import { errorText } from '@xiaowu/client-core/api';

export { createApi, errorText } from '@xiaowu/client-core/api';
export { parseCsv } from '@xiaowu/client-core/csv';
export { todayInManila, MOBILE_PATTERN, peso, formatDateTime } from '@xiaowu/client-core/format';

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

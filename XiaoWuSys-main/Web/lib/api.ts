// How the browser talks to Express (N2/N3). There is no Next.js API in between.
//
// Same contract as the Vite MVP (createApi in @xiaowu/client-core):
//   - never throws: resolves to { ok, status, data }
//   - status 0 means the shop server could not be reached
//   - every request carries the current login token as "Authorization: Bearer <token>"
//   - a 401 means the session has ended (expired, signed out elsewhere, account changed):
//     this device forgets it and the auth gate sends the user back to the login screen
//
// Call it only from client code: the server address is worked out from the page address.
import {
  createApi,
  errorText,
  FRIENDLY_ERRORS,
  type ApiBody,
  type ApiResult,
  type HttpMethod,
} from '@xiaowu/client-core/api';
import type { SessionUser } from '@xiaowu/client-core/permissions';
import { apiBase } from '@/lib/config';
import { endSessionIfCurrent, getSession } from '@/lib/session';

export type { ApiBody, ApiResult, HttpMethod };

const SESSION_ENDED_NOTICE = FRIENDLY_ERRORS.SESSION_EXPIRED;

/**
 * Authenticated request to the shop server, e.g. api('GET', '/sync/status').
 * The token is read at call time, so a request started after a password change already uses
 * the new one.
 */
export function api<T = ApiBody>(method: HttpMethod, path: string, body?: unknown): Promise<ApiResult<T>> {
  const { token } = getSession();
  const call = createApi({
    apiBase: apiBase(),
    token,
    onUnauthorized: () => endSessionIfCurrent(token, SESSION_ENDED_NOTICE),
  });
  return call<T>(method, path, body);
}

/**
 * Plain-language error for any response body (client-core's errorText, without requiring the
 * body type to match ApiBody exactly).
 */
export const errorMessage = (data: unknown, fallback: string): string =>
  errorText(data && typeof data === 'object' ? (data as ApiBody) : null, fallback);

// ---------------------------------------------------------------------------------------------
// File downloads (CSV exports). Same token and 401 handling as api(); the browser saves the
// file under the name the server gives in Content-Disposition. Never throws.
// ---------------------------------------------------------------------------------------------
export type DownloadResult = { ok: true; name: string; offline: boolean } | { ok: false; message: string };

export async function downloadFile(path: string): Promise<DownloadResult> {
  const { token } = getSession();
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) endSessionIfCurrent(token, SESSION_ENDED_NOTICE);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, message: errorText(data, 'The file could not be downloaded.') };
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'export.csv';
    saveBlob(await res.blob(), name);
    return { ok: true, name, offline: res.headers.get('X-Data-Source') === 'local' };
  } catch (err) {
    console.error(`download ${path} failed`, err);
    return { ok: false, message: 'Cannot reach the server. Check that the backend is running.' };
  }
}

/** Hands a file made in the browser (e.g. a CSV template) to the user. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------------------------
// Login: the one request where 401 means "wrong password", not "session ended".
// ---------------------------------------------------------------------------------------------
interface LoginBody extends ApiBody {
  token?: string;
  role?: string;
  user?: { user_id?: string; username?: string; role?: string };
  capabilities?: string[];
  offline?: boolean;
}

export type LoginResult =
  | { ok: true; token: string; user: SessionUser; offline: boolean }
  | { ok: false; message: string };

export async function requestLogin(username: string, password: string): Promise<LoginResult> {
  const name = username.trim();
  const call = createApi({ apiBase: apiBase(), token: '' }); // no onUnauthorized on purpose
  const { ok, data } = await call<LoginBody>('POST', '/auth/login', { username: name, password });

  if (!ok || !data.token) return { ok: false, message: errorText(data, 'Login failed. Please try again.') };

  // Same shape the Vite MVP stores. role is for display only; capabilities decide what shows.
  const user: SessionUser = {
    user_id: data.user?.user_id ?? '',
    username: data.user?.username ?? name,
    role: data.user?.role ?? data.role ?? '',
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
  };
  return { ok: true, token: data.token, user, offline: Boolean(data.offline) };
}

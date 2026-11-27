// How the browser talks to Express (N2/N3). There is no Next.js API in between.
//
// Same contract as createApi in @xiaowu/client-core:
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
import { toast } from '@/lib/toast';

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
  const done = trackWork(method, path, body);
  return call<T>(method, path, body).finally(done);
}

// ---------------------------------------------------------------------------------------------
// "Something is happening" (HCI: visibility of system status). When a save, removal or
// calculation the person started takes longer than a moment, one small "Saving…" notice appears
// until every such request has answered. Fast requests never flash it. Reads (GET) and requests
// that have their own indicator (login, logout, Sync now) are not tracked.
// The answer itself is still shown by the screen (success notice or ResultDialog).
// ---------------------------------------------------------------------------------------------
const SHOW_AFTER_MS = 600;
const OWN_INDICATOR = ['/auth/login', '/auth/logout', '/sync'];
let inFlight = 0;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let workToast: number | null = null;
let workLabel = 'Saving…';

function trackWork(method: HttpMethod, path: string, body: unknown): () => void {
  if (method === 'GET' || typeof window === 'undefined' || OWN_INDICATOR.includes(path)) return () => {};
  const dryRun = Boolean(body && typeof body === 'object' && (body as { dry_run?: unknown }).dry_run);
  workLabel = dryRun ? 'Calculating…' : method === 'DELETE' ? 'Removing…' : 'Saving…';
  inFlight += 1;
  if (inFlight === 1 && !showTimer && workToast === null) {
    showTimer = setTimeout(() => {
      showTimer = null;
      if (inFlight > 0) workToast = toast.loading(workLabel, 'Please wait while the server answers.');
    }, SHOW_AFTER_MS);
  }
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight > 0) return;
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (workToast !== null) {
      toast.dismiss(workToast);
      workToast = null;
    }
  };
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

// ---------------------------------------------------------------------------------------------
// Migration 016: design files picked from this computer. The file goes as the request body
// (no Google Drive needed); its name and an optional note go in the address. Never throws.
// ---------------------------------------------------------------------------------------------
export async function uploadFile<T = ApiBody>(path: string, file: File, query: Record<string, string> = {}): Promise<ApiResult<T>> {
  const { token } = getSession();
  const params = new URLSearchParams({ name: file.name, ...query });
  const done = trackWork('POST', path, undefined);
  try {
    const res = await fetch(`${apiBase()}${path}?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (res.status === 401) endSessionIfCurrent(token, SESSION_ENDED_NOTICE);
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`upload ${path} failed`, err);
    return { ok: false, status: 0, data: { error: 'NETWORK_ERROR', message: 'Cannot reach the server. Check that the backend is running.' } as unknown as T };
  } finally {
    done();
  }
}

/** A file from the server as a Blob (for an image preview or a download), or null. Never throws. */
export async function fetchBlob(path: string): Promise<{ ok: true; blob: Blob } | { ok: false; message: string }> {
  const { token } = getSession();
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) endSessionIfCurrent(token, SESSION_ENDED_NOTICE);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, message: errorText(data, 'The file could not be opened.') };
    }
    return { ok: true, blob: await res.blob() };
  } catch (err) {
    console.error(`fetch ${path} failed`, err);
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

  // The stored account. role is for display only; capabilities decide what shows.
  const user: SessionUser = {
    user_id: data.user?.user_id ?? '',
    username: data.user?.username ?? name,
    role: data.user?.role ?? data.role ?? '',
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
  };
  return { ok: true, token: data.token, user, offline: Boolean(data.offline) };
}

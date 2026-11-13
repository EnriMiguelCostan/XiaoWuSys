// The ONE place that reads and writes the login token (rules guard: token-storage-in-session-only).
//
// N4: the JWT stays in the browser's storage under the same keys as the Vite MVP
// ('xiaomei_token', 'xiaomei_user'), not in a cookie, so offline login, device logout and the
// socket handshake behave exactly as today.
//
// The token is never opened in the browser (rules guard: no-token-decoding). Who the user is
// and what they may do come from the server: POST /api/auth/login and GET /api/auth/me.
//
// This is a tiny external store so React can read it with useSyncExternalStore: every write
// notifies subscribers, and a login or logout in another tab is picked up through the
// 'storage' event.
import type { SessionUser } from '@xiaowu/client-core/permissions';

const TOKEN_KEY = 'xiaomei_token';
const USER_KEY = 'xiaomei_user';

export interface Session {
  token: string;
  /** Last known account details. Null right after an old MVP login until /auth/me answers. */
  user: SessionUser | null;
}

const SIGNED_OUT: Session = Object.freeze({ token: '', user: null });

// Storage can be missing (server render) or throw (privacy mode, blocked site data).
const storage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const read = (key: string): string | null => {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    const s = storage();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Storage full or blocked: the session still lives in memory until the tab closes.
  }
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

// Only keeps the fields the screens use, in the shapes they expect. Anything odd -> null.
const toUser = (value: unknown): SessionUser | null => {
  if (!value || typeof value !== 'object') return null;
  const u = value as Record<string, unknown>;
  return {
    user_id: text(u.user_id),
    username: text(u.username),
    role: text(u.role), // display only
    capabilities: Array.isArray(u.capabilities) ? u.capabilities.filter((c): c is string => typeof c === 'string') : [],
  };
};

const parseUser = (raw: string | null): SessionUser | null => {
  if (!raw) return null;
  try {
    return toUser(JSON.parse(raw));
  } catch {
    return null;
  }
};

// useSyncExternalStore needs the same object back while nothing changed.
let cache: { rawToken: string | null; rawUser: string | null; value: Session } | null = null;

export const getSession = (): Session => {
  const rawToken = read(TOKEN_KEY);
  const rawUser = read(USER_KEY);
  if (cache && cache.rawToken === rawToken && cache.rawUser === rawUser) return cache.value;
  const value: Session = rawToken ? { token: rawToken, user: parseUser(rawUser) } : SIGNED_OUT;
  cache = { rawToken, rawUser, value };
  return value;
};

/** What the server render sees: nobody is signed in there. */
export const getServerSession = (): Session => SIGNED_OUT;

// ---------------------------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------------------------
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

const onStorage = (event: StorageEvent) => {
  if (event.key === null || event.key === TOKEN_KEY || event.key === USER_KEY) notify();
};

export const subscribeSession = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
};

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** After a successful login. */
export const startSession = (token: string, user: SessionUser) => {
  write(TOKEN_KEY, token);
  write(USER_KEY, JSON.stringify(toUser(user)));
  endedNotice = null;
  notify();
};

/** After "Change my password": the server hands back a fresh token for this device. */
export const replaceToken = (token: string) => {
  if (!token || !getSession().token) return;
  write(TOKEN_KEY, token);
  notify();
};

/** After GET /api/auth/me. Ignored if that session has ended in the meantime. */
export const updateUser = (forToken: string, user: SessionUser) => {
  if (!forToken || getSession().token !== forToken) return;
  write(USER_KEY, JSON.stringify(toUser(user)));
  notify();
};

/**
 * Forget the session on this device. `notice` is shown once on the login screen (kept in
 * memory only, so it never outlives the tab).
 */
export const clearSession = (notice: string | null = null) => {
  write(TOKEN_KEY, null);
  write(USER_KEY, null);
  endedNotice = notice;
  notify();
};

/**
 * A 401 for a request sent with `usedToken`. Only that session is ended: a late answer for an
 * old token must not sign out someone who has logged in again since.
 */
export const endSessionIfCurrent = (usedToken: string, notice: string) => {
  if (usedToken && getSession().token === usedToken) clearSession(notice);
};

let endedNotice: string | null = null;

/** Why the last session ended (e.g. it expired), for the login screen. Cleared by the next login. */
export const getEndedNotice = (): string | null => endedNotice;

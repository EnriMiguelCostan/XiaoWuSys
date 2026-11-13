'use client';

// Who is signed in on this device, for every client component (useSession()).
//
// The account's role and capabilities come from the server only: from the login answer, then
// refreshed from GET /api/auth/me each time a session starts or the page is reloaded (an Admin
// may have changed the role). The JWT itself is never opened in the browser.
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SessionUser } from '@xiaowu/client-core/permissions';
import { api, requestLogin } from '@/lib/api';
import {
  clearSession,
  getServerSession,
  getSession,
  replaceToken as storeToken,
  startSession,
  subscribeSession,
  updateUser,
} from '@/lib/session';

/** 'loading' only during the first render in the browser, before storage has been read. */
export type SessionStatus = 'loading' | 'signed_in' | 'signed_out';

export interface SessionContextValue {
  status: SessionStatus;
  token: string;
  user: SessionUser | null;
  /** Signs in and stores the session; on failure, `message` is the server's plain-language reason. */
  login: (username: string, password: string) => Promise<{ ok: true; offline: boolean } | { ok: false; message: string }>;
  /** PB 1: ends this device's session on the server too; other devices stay signed in. */
  logout: () => Promise<void>;
  /** Keep this device signed in with the token returned by "Change my password". */
  replaceToken: (token: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface MeBody {
  user?: { user_id?: string; role?: string };
  capabilities?: string[];
}

const noopSubscribe = () => () => {};

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useSyncExternalStore(subscribeSession, getSession, getServerSession);
  // false while hydrating (the server cannot see storage), true from then on
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);

  // Refresh what this account may do. A 401 here ends the session through lib/api.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    api<MeBody>('GET', '/auth/me').then(({ ok, data }) => {
      if (cancelled || !ok || !data.user) return;
      const known = getSession().user;
      updateUser(token, {
        user_id: data.user.user_id ?? known?.user_id ?? '',
        username: known?.username ?? '', // /auth/me does not repeat the username
        role: data.user.role ?? known?.role ?? '',
        capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      });
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const login = useCallback<SessionContextValue['login']>(async (username, password) => {
    const result = await requestLogin(username, password);
    if (!result.ok) return result;
    startSession(result.token, result.user);
    return { ok: true, offline: result.offline };
  }, []);

  const logout = useCallback(async () => {
    // If the server can't be reached the browser still forgets the session (same as the MVP).
    await api('POST', '/auth/logout');
    clearSession();
  }, []);

  const replaceToken = useCallback((next: string) => storeToken(next), []);

  const status: SessionStatus = !hydrated ? 'loading' : token ? 'signed_in' : 'signed_out';

  const value = useMemo<SessionContextValue>(
    () => ({ status, token, user, login, logout, replaceToken }),
    [status, token, user, login, logout, replaceToken]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession() must be used inside <SessionProvider>.');
  return ctx;
}

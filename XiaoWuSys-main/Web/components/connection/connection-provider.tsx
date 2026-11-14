'use client';

// PB 3 / PB 4: connection state and the "changes waiting" queue, shared by the ConnectionBar
// and any screen that needs it (useConnection()).
//
// GET /api/sync/status is fetched on the same triggers as the Vite MVP:
//   - when the session starts
//   - when the socket drops (dropping does not prove the server is down: re-check)
//   - when the browser says the network changed (navigator.onLine is a hint only)
//   - after "Sync now"
//   - every 30 s, but only while the socket is not live (useFallbackPolling)
// While the socket is live the server pushes the same body as a "sync_status" event.
//
// Wording comes from @xiaowu/client-core/connection; this file only gathers the inputs.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  deriveConnectionState,
  syncResultMessage,
  type CloudState,
  type ConnectionState,
  type SyncResultMessage,
} from '@xiaowu/client-core/connection';
import { can } from '@xiaowu/client-core/permissions';
import { useSocket } from '@/components/providers/socket-provider';
import { useFallbackPolling } from '@/hooks/use-fallback-polling';
import { useSession } from '@/hooks/use-session';
import { useSocketEvent } from '@/hooks/use-socket-event';
import { api } from '@/lib/api';

const SYNC_STATUS_POLL_MS = 30_000;

/** Body of GET /api/sync/status and of the "sync_status" socket event (Backend/services/sync.js). */
export interface SyncStatus {
  cloud: CloudState;
  cloud_since: string | null;
  last_sync_at: string | null;
  last_sync_result: unknown;
  syncing: boolean;
  pending: Record<string, number>;
  pending_total: number;
  conflicts: number;
}

interface ConnectionContextValue {
  state: ConnectionState;
  syncStatus: SyncStatus | null;
  browserOnline: boolean;
  /** "Sync now" request in flight from this tab, or a sync the server says is running */
  syncBusy: boolean;
  syncNow: () => Promise<void>;
  /** Outcome of the last "Sync now", for the ResultDialog. */
  syncResult: SyncResultMessage | null;
  dismissSyncResult: () => void;
  /** Goes up after a sync that may have changed data (200 / 409): screens reload on change. */
  syncGeneration: number;
  recheck: () => void;
  /** A sync conflict was settled (PB 5): refresh the counts and let the screens reload. */
  conflictSettled: () => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

// navigator.onLine as an external store (it is only a hint, see connection.js)
const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
};
const getOnline = () => navigator.onLine;
const getOnlineOnServer = () => true;

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const { status: liveStatus } = useSocket();
  const browserOnline = useSyncExternalStore(subscribeOnline, getOnline, getOnlineOnServer);

  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  // null until the first answer, false when the shop server cannot be reached
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResultMessage | null>(null);
  const [syncGeneration, setSyncGeneration] = useState(0);

  const recheck = useCallback(() => {
    api<SyncStatus>('GET', '/sync/status').then(({ ok, status, data }) => {
      if (status === 0) {
        setServerReachable(false);
        return;
      }
      setServerReachable(true);
      if (ok) setSyncStatus(data);
    });
  }, []);

  // Session start, and every time the socket stops being live
  useEffect(() => {
    if (liveStatus !== 'live') recheck();
  }, [liveStatus, recheck]);

  // The browser says the network changed: re-check straight away
  useEffect(() => {
    window.addEventListener('online', recheck);
    window.addEventListener('offline', recheck);
    return () => {
      window.removeEventListener('online', recheck);
      window.removeEventListener('offline', recheck);
    };
  }, [recheck]);

  useFallbackPolling(recheck, SYNC_STATUS_POLL_MS);

  useSocketEvent<SyncStatus>('sync_status', (pushed) => {
    setServerReachable(true);
    if (pushed && typeof pushed === 'object') setSyncStatus(pushed);
  });

  const canSeeConflicts = can(user, 'manage_accounts');

  const syncNow = useCallback(async () => {
    setSyncing(true);
    const { status, data } = await api('POST', '/sync');
    setSyncing(false);
    if (status === 0) setServerReachable(false);
    setSyncResult(syncResultMessage(status, data, { canSeeConflicts }));
    recheck();
    if (status === 200 || status === 409) setSyncGeneration((g) => g + 1); // offline orders now have numbers
  }, [canSeeConflicts, recheck]);

  const dismissSyncResult = useCallback(() => setSyncResult(null), []);

  const conflictSettled = useCallback(() => {
    recheck();
    setSyncGeneration((g) => g + 1);
  }, [recheck]);

  // A live socket proves the shop server is reachable, whatever the last request said.
  const reachable = liveStatus === 'live' ? true : serverReachable;
  const state = deriveConnectionState({ serverReachable: reachable, cloud: syncStatus?.cloud });
  const syncBusy = syncing || Boolean(syncStatus?.syncing);

  const value = useMemo<ConnectionContextValue>(
    () => ({
      state,
      syncStatus,
      browserOnline,
      syncBusy,
      syncNow,
      syncResult,
      dismissSyncResult,
      syncGeneration,
      recheck,
      conflictSettled,
    }),
    [state, syncStatus, browserOnline, syncBusy, syncNow, syncResult, dismissSyncResult, syncGeneration, recheck, conflictSettled]
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection() must be used inside <ConnectionProvider>.');
  return ctx;
}

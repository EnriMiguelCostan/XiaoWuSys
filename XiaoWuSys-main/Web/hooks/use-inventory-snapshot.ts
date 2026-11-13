'use client';

// The catalog as the server sees it (GET /api/inventory), kept current the same way as the
// Vite MVP:
//   - loaded when the screen opens and after a "Sync now" that changed data
//   - live: 'inventory_subscribe' on every (re)connect, then 'inventory_updated' pushes a full
//     snapshot after any stock change on any device; changed rows are highlighted for 2.5 s
//   - polled every 30 s ONLY while the socket is down (useFallbackPolling)
// Create Order (M3) will read the same hook.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '@/components/connection/connection-provider';
import { useSocket } from '@/components/providers/socket-provider';
import { useFallbackPolling } from '@/hooks/use-fallback-polling';
import { useSocketEvent } from '@/hooks/use-socket-event';
import { api, errorMessage } from '@/lib/api';
import type { InventorySnapshot } from '@/lib/inventory';

const INVENTORY_POLL_MS = 30_000;
const CHANGE_HIGHLIGHT_MS = 2_500;

export function useInventorySnapshot() {
  const { status: liveStatus, emit } = useSocket();
  const { syncGeneration } = useConnection();

  const [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cloudListening, setCloudListening] = useState(false);
  const [recentlyChanged, setRecentlyChanged] = useState<string[]>([]);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((next: InventorySnapshot | null | undefined) => {
    if (!next || !Array.isArray(next.items)) return;
    setSnapshot(next);
    setError('');
  }, []);

  // Never sets state before the answer arrives, so it is safe to call from effects.
  const load = useCallback(() => {
    api<InventorySnapshot>('GET', '/inventory').then(({ ok, status, data }) => {
      setLoading(false);
      if (status === 0) {
        setError('The system could not be reached. Showing the last loaded data.');
        return;
      }
      if (!ok) {
        setError(errorMessage(data, 'The inventory could not be loaded. Please press Refresh.'));
        return;
      }
      apply(data);
    });
  }, [apply]);

  /** Refresh button and after a change made on this screen */
  const refresh = useCallback(() => {
    setLoading(true);
    load();
  }, [load]);

  // First load, and again after a sync that may have changed stock
  useEffect(() => {
    load();
  }, [load, syncGeneration]);

  // Live updates: subscribe on every (re)connect; the reply carries a fresh snapshot
  useEffect(() => {
    if (liveStatus !== 'live') return;
    emit('inventory_subscribe', {}, (reply) => {
      const r = reply as { ok?: boolean; listening?: boolean; snapshot?: InventorySnapshot } | null;
      if (!r) return;
      setCloudListening(Boolean(r.listening));
      if (r.ok) apply(r.snapshot);
    });
  }, [liveStatus, emit, apply]);

  useSocketEvent<{ listening?: boolean }>('inventory_live', (payload) => setCloudListening(Boolean(payload?.listening)));

  useSocketEvent<{ changed_ids?: string[]; snapshot?: InventorySnapshot }>('inventory_updated', (payload) => {
    apply(payload?.snapshot);
    const ids = payload?.changed_ids;
    if (Array.isArray(ids) && ids.length > 0) {
      setRecentlyChanged(ids);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setRecentlyChanged([]), CHANGE_HIGHLIGHT_MS);
    }
  });

  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    []
  );

  useFallbackPolling(load, INVENTORY_POLL_MS);

  return { snapshot, loading, error, refresh, liveStatus, cloudListening, recentlyChanged };
}

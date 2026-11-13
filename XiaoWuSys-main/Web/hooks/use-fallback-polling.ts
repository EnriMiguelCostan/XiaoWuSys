'use client';

// useFallbackPolling(refresh, 30_000)
//
// Polling rule (master context §3, steering §2.3): repeat `fn` ONLY while the live socket is
// not connected, and only while this tab is visible. When pushes arrive again the timer stops.
// This is the only file allowed to call setInterval (rules guard: polling-only-in-fallback-hook).
import { useEffect, useEffectEvent } from 'react';
import { useSocket } from '@/components/providers/socket-provider';

export function useFallbackPolling(fn: () => void, intervalMs: number) {
  const { status } = useSocket();
  const tick = useEffectEvent(() => fn());

  useEffect(() => {
    if (status === 'live') return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [status, intervalMs]);
}

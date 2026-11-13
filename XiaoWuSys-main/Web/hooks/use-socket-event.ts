'use client';

// useSocketEvent('inventory_updated', (payload) => …)
// Listens on the tab's single socket (SocketProvider). The handler always sees the latest
// props and state without re-subscribing.
import { useEffect, useEffectEvent } from 'react';
import { useSocket } from '@/components/providers/socket-provider';

export function useSocketEvent<T = unknown>(event: string, handler: (payload: T) => void) {
  const { subscribe } = useSocket();
  const onEvent = useEffectEvent((payload: T) => handler(payload));

  useEffect(() => subscribe(event, (payload) => onEvent(payload as T)), [subscribe, event]);
}

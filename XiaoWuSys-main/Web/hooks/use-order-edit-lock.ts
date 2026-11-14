'use client';

// useOrderEditLock(orderId, editing, onRefused)
//
// PB 5: while an edit form of an order is open, this tab holds the order's edit lock on the
// server, so others see "being edited" and the server refuses their writes (409 ORDER_LOCKED).
//   editing_order { orderId }, ack { granted, reason?, lock? }   take or renew the lock
//   release_order { orderId }                                    give it back
// The server decides: it grants the lock, refuses it (someone of the same or a higher role is
// editing) or hands it over from a lower role. A lock lasts 2 minutes on the server, so it is
// renewed every 60 seconds while the form stays open.
//
// The renewal is a heartbeat on the live socket, not polling: it reads nothing, and it stops
// when the socket drops (the server then frees the lock itself). It is taken again when the
// socket is back.
import { useEffect, useEffectEvent } from 'react';
import { useSocket } from '@/components/providers/socket-provider';

const LOCK_RENEW_MS = 60_000;

interface LockReply {
  granted?: boolean;
  reason?: string;
  lock?: { role?: string };
}

export function useOrderEditLock(orderId: string | null, editing: boolean, onRefused: (heldByRole: string | null) => void) {
  const { emit, status } = useSocket();
  const refused = useEffectEvent((role: string | null) => onRefused(role));

  useEffect(() => {
    if (!orderId || !editing || status !== 'live') return undefined;
    let stopped = false;
    let renewal: ReturnType<typeof setTimeout> | undefined;

    const hold = () => {
      emit('editing_order', { orderId }, (reply) => {
        if (stopped) return;
        const answer = (reply ?? {}) as LockReply;
        if (answer.granted === false) {
          refused(answer.lock?.role ?? null);
          return;
        }
        renewal = setTimeout(hold, LOCK_RENEW_MS);
      });
    };
    hold();

    return () => {
      stopped = true;
      clearTimeout(renewal);
      emit('release_order', { orderId });
    };
  }, [orderId, editing, status, emit]);
}

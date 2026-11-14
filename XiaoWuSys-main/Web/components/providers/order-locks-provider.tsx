'use client';

// PB 5: who is editing which order right now, as told by the server over the tab's socket
// (Backend/server.js + services/orderLocks.js). Nothing here decides who may edit: the server
// grants, refuses or takes over a lock, and its REST routes answer 409 ORDER_LOCKED.
//
//   locks_snapshot  [lock, …]        on connect: every lock held at that moment
//   order_locked    lock             someone else started editing
//   order_unlocked  { orderId }      they finished (or their screen went away)
//   order_overridden { order_id, tracking_no, overridden_by_role }
//                                    a higher role replaced THIS account's change to an order
//
// A lock that is not renewed simply runs out on the server (no event), so each one is dropped
// here when its expiresAt passes.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { useSession } from '@/hooks/use-session';
import { useSocketEvent } from '@/hooks/use-socket-event';

/** orderLocks.publicView() on the server */
export interface OrderLock {
  orderId: string;
  userId: string;
  /** display only: never compare it */
  role: string;
  expiresAt: string;
}

interface OrderOverridden {
  order_id: string;
  tracking_no: string | null;
  overridden_by_role: string | null;
}

interface OrderLocksValue {
  /** The lock another account holds on this order, or null (free, or held by this account). */
  lockedByOther: (orderId: string | null | undefined) => OrderLock | null;
}

const OrderLocksContext = createContext<OrderLocksValue | null>(null);

const isLock = (value: unknown): value is OrderLock =>
  Boolean(value) && typeof value === 'object' && typeof (value as OrderLock).orderId === 'string' && typeof (value as OrderLock).userId === 'string';

export function OrderLocksProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const [locks, setLocks] = useState<Record<string, OrderLock>>({});
  const [notice, setNotice] = useState<ResultMessage | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const drop = useCallback((orderId: string) => {
    clearTimeout(timers.current.get(orderId));
    timers.current.delete(orderId);
    setLocks((prev) => {
      if (!(orderId in prev)) return prev;
      const next = { ...prev };
      delete next[orderId];
      return next;
    });
  }, []);

  // Forget a lock when the server would have let it run out
  const expireLater = useCallback(
    (lock: OrderLock) => {
      clearTimeout(timers.current.get(lock.orderId));
      const wait = Math.max(0, new Date(lock.expiresAt).getTime() - Date.now());
      timers.current.set(lock.orderId, setTimeout(() => drop(lock.orderId), wait));
    },
    [drop]
  );

  useSocketEvent<unknown>('locks_snapshot', (list) => {
    const held = Array.isArray(list) ? list.filter(isLock) : [];
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
    held.forEach(expireLater);
    setLocks(Object.fromEntries(held.map((lock) => [lock.orderId, lock])));
  });
  useSocketEvent<unknown>('order_locked', (lock) => {
    if (!isLock(lock)) return;
    expireLater(lock);
    setLocks((prev) => ({ ...prev, [lock.orderId]: lock }));
  });
  useSocketEvent<{ orderId?: string }>('order_unlocked', (payload) => {
    if (payload?.orderId) drop(payload.orderId);
  });

  // The server sends this only to the account whose change was replaced
  useSocketEvent<OrderOverridden>('order_overridden', (payload) => {
    if (!payload?.order_id) return;
    const who = payload.overridden_by_role ? `The ${payload.overridden_by_role}` : 'Someone with a higher role';
    const which = payload.tracking_no ? `order ${payload.tracking_no}` : 'an order';
    setNotice({
      type: 'warning',
      title: 'Your changes were replaced',
      message: `${who} replaced your changes to ${which}.\nOpen the order to see what it says now.`,
    });
  });

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  const myId = user?.user_id;
  const value = useMemo<OrderLocksValue>(
    () => ({
      lockedByOther: (orderId) => {
        const lock = orderId ? locks[orderId] : undefined;
        return lock && lock.userId !== myId ? lock : null;
      },
    }),
    [locks, myId]
  );

  return (
    <OrderLocksContext.Provider value={value}>
      {children}
      <ResultDialog result={notice} onClose={() => setNotice(null)} />
    </OrderLocksContext.Provider>
  );
}

export function useOrderLocks(): OrderLocksValue {
  const ctx = useContext(OrderLocksContext);
  if (!ctx) throw new Error('useOrderLocks() must be used inside <OrderLocksProvider>.');
  return ctx;
}

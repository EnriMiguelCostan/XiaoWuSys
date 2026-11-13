'use client';

// The ONE Socket.io connection of this tab (rules guard: one-socket). Screens never import
// socket.io-client: they listen with useSocketEvent() and read the status with useSocket().
//
//   connecting    the first connection attempt has not finished
//   live          pushes arrive (sync_status, inventory_updated, …): no polling needed
//   disconnected  no pushes: useFallbackPolling() takes over until the socket is back
//
// The socket opens when someone is signed in and closes on logout. When this device logs out
// the server also closes it (onSessionRevoked in Backend/server.js).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useSession } from '@/hooks/use-session';
import { socketUrl } from '@/lib/config';

export type LiveStatus = 'connecting' | 'live' | 'disconnected';

type Handler = (...args: unknown[]) => void;

interface SocketContextValue {
  status: LiveStatus;
  /** Register a handler for a server event; returns the unsubscribe function. */
  subscribe: (event: string, handler: Handler) => () => void;
  /** Send an event (with optional acknowledgement). Returns false if the socket is not connected. */
  emit: (event: string, data?: unknown, ack?: (reply: unknown) => void) => boolean;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { token } = useSession();
  // Status is remembered per token, so a new login starts at 'connecting' without a reset.
  const [state, setState] = useState<{ token: string; status: LiveStatus }>({ token: '', status: 'connecting' });
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef(new Map<string, Set<Handler>>());

  useEffect(() => {
    if (!token) return undefined;
    // autoConnect off + connect on the next tick: React Strict Mode (dev) mounts, unmounts and
    // remounts every effect at once. Connecting straight away opened a WebSocket that was closed
    // mid-handshake, which the browser logs as "WebSocket connection to ws://…:5000 failed".
    const socket = io(socketUrl(), { auth: { token }, transports: ['websocket', 'polling'], autoConnect: false });
    socketRef.current = socket;
    const opening = setTimeout(() => socket.connect(), 0);

    socket.on('connect', () => setState({ token, status: 'live' }));
    socket.on('disconnect', () => setState({ token, status: 'disconnected' }));
    socket.on('connect_error', () => setState({ token, status: 'disconnected' }));
    // Fan every server event out to the screens that asked for it
    socket.onAny((event: string, ...args: unknown[]) => {
      handlersRef.current.get(event)?.forEach((handler) => handler(...args));
    });

    return () => {
      clearTimeout(opening);
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [token]);

  const subscribe = useCallback((event: string, handler: Handler) => {
    const map = handlersRef.current;
    if (!map.has(event)) map.set(event, new Set());
    map.get(event)!.add(handler);
    return () => {
      map.get(event)?.delete(handler);
    };
  }, []);

  const emit = useCallback<SocketContextValue['emit']>((event, data, ack) => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return false;
    if (ack) socket.emit(event, data, ack);
    else socket.emit(event, data);
    return true;
  }, []);

  const status: LiveStatus = state.token === token ? state.status : 'connecting';
  const value = useMemo(() => ({ status, subscribe, emit }), [status, subscribe, emit]);

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket() must be used inside <SocketProvider>.');
  return ctx;
}

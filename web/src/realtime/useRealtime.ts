import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { PaymentView } from '../api/types';

export interface RealtimeEvents {
  onPaymentUpdated?: (payment: PaymentView) => void;
  onWalletUpdated?: (wallet: {
    walletId: string;
    available: { minor: string; currency: string };
    pending: { minor: string; currency: string };
  }) => void;
}

/**
 * WebSocket subscription.
 *
 * Chosen over polling because a payment settles asynchronously: the saga
 * may take a second or ten, and polling every screen every second is both
 * wasteful and still laggy. Chosen over SSE because the channel is
 * bidirectional — the client subscribes to merchant rooms.
 *
 * The token travels in the handshake `auth` payload rather than the query
 * string, which keeps it out of proxy access logs.
 */
export function useRealtime(token: string | null, handlers: RealtimeEvents): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!token) {
      return;
    }

    const base = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';
    const socket: Socket = io(`${base}/realtime`, {
      auth: { token },
      transports: ['websocket', 'polling'],
      // Reconnect with backoff; the server is allowed to restart.
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 10_000,
      withCredentials: true,
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('unauthorized', () => setConnected(false));

    socket.on('payment:updated', (payment: PaymentView) =>
      handlersRef.current.onPaymentUpdated?.(payment),
    );
    socket.on('wallet:updated', (wallet: Parameters<NonNullable<RealtimeEvents['onWalletUpdated']>>[0]) =>
      handlersRef.current.onWalletUpdated?.(wallet),
    );

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
    // Handlers are read through a ref so a new closure does not tear the
    // socket down on every render.
  }, [token]);

  return { connected };
}

import { io } from 'socket.io-client';

const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '');

let socket = null;
let currentCenterId = null;

/**
 * Initialize Socket.IO connection for the live counter display.
 * Uses the short-lived displayToken provided by the authoritative display endpoint.
 */
export function initDisplaySocket({ centerId, displayToken, onStatusChange, onEvent, onReconnect }) {
  closeDisplaySocket();

  currentCenterId = centerId;

  socket = io(SOCKET_URL, {
    auth: {
      token: displayToken ? `Bearer ${displayToken}` : undefined,
    },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: true,
  });

  socket.on('connect', () => {
    onStatusChange?.('connected');
    if (currentCenterId) {
      socket.emit('join:center', currentCenterId);
    }
  });

  socket.on('disconnect', (reason) => {
    onStatusChange?.('disconnected', reason);
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    onStatusChange?.('reconnecting', attempt);
  });

  socket.io.on('reconnect', () => {
    onStatusChange?.('connected');
    if (currentCenterId) {
      socket.emit('join:center', currentCenterId);
    }
    onReconnect?.();
  });

  socket.on('connect_error', (err) => {
    onStatusChange?.('error', err.message);
  });

  // Listen to all authoritative queue and telemetry events for the center
  const queueEvents = [
    'token.called',
    'token.serving',
    'token.completed',
    'token.skipped',
    'token.cancelled',
    'token.expired',
    'queue.updated',
    'counter.updated',
    'crowd.updated',
  ];

  queueEvents.forEach((eventName) => {
    socket.on(eventName, (data) => {
      onEvent?.(eventName, data);
    });
  });

  return socket;
}

/**
 * Disconnect socket and cleanup handlers.
 */
export function closeDisplaySocket() {
  if (socket) {
    socket.removeAllListeners();
    if (socket.io) {
      socket.io.removeAllListeners();
    }
    socket.disconnect();
    socket = null;
  }
  currentCenterId = null;
}

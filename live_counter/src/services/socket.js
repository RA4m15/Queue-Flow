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
    console.log(`[LiveCounter] Socket connected (center: ${currentCenterId})`);
    onStatusChange?.('connected');
    if (currentCenterId) {
      socket.emit('join:center', currentCenterId);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('[LiveCounter] Socket disconnected:', reason);
    onStatusChange?.('disconnected', reason);
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    onStatusChange?.('reconnecting', attempt);
  });

  socket.io.on('reconnect', () => {
    console.log('[LiveCounter] Socket reconnected');
    onStatusChange?.('connected');
    if (currentCenterId) {
      socket.emit('join:center', currentCenterId);
    }
    onReconnect?.();
  });

  socket.on('connect_error', (err) => {
    console.warn('[LiveCounter] Socket connect error:', err.message);
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
    if (eventName === 'token.called') {
      console.log('[LiveCounter] token.called handler registered');
    }
    socket.on(eventName, (data) => {
      // The socket is already scoped to `center:<centerId>` via the room join,
      // so every event delivered here belongs to this display's center. Any
      // payload that does carry a centerId is still verified, correctly handling
      // populated objects like { _id, name } vs plain strings/ObjectIds.
      const rawCenter = data?.centerId ?? data?.token?.centerId ?? data?.counter?.centerId;
      const payloadCenterId =
        rawCenter && typeof rawCenter === 'object' && rawCenter._id
          ? String(rawCenter._id)
          : rawCenter
            ? String(rawCenter)
            : null;

      if (payloadCenterId && payloadCenterId !== String(currentCenterId)) {
        console.warn(`[LiveCounter] Ignored event for foreign center: ${payloadCenterId} (current: ${currentCenterId})`);
        return;
      }

      if (eventName === 'token.called') {
        console.log('[LiveCounter] token.called RECEIVED', data?.token?.tokenCode);
        console.log('[LiveCounter] token.called received');
        console.log('[LiveCounter] token payload:', data?.token);
        console.log('[LiveCounter] counter payload:', data?.counter);
      }

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
    console.log('[LiveCounter] token.called handler removed');
    socket.removeAllListeners();
    if (socket.io) {
      socket.io.removeAllListeners();
    }
    socket.disconnect();
    socket = null;
  }
  currentCenterId = null;
}

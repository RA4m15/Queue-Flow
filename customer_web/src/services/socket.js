import { io } from 'socket.io-client';
import { storage } from './storage';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

let socket = null;
let currentCenterId = null;
const statusListeners = new Set();
const reconnectListeners = new Set();

/**
 * Get or create the Socket.IO client instance.
 * Automatically passes the authenticated customer JWT in handshake auth.
 */
export function getSocket() {
  if (!socket) {
    const token = storage.getToken();
    
    // Only connect with auth token if token exists, backend JWT middleware requires valid token
    socket = io(SOCKET_URL, {
      auth: {
        token: token ? `Bearer ${token}` : undefined,
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      autoConnect: false,
    });

    socket.on('connect', () => {
      notifyStatus('connected');
      if (currentCenterId) {
        socket.emit('join:center', currentCenterId);
      }
    });

    socket.on('disconnect', (reason) => {
      notifyStatus('disconnected', reason);
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      notifyStatus('reconnecting', attempt);
    });

    socket.io.on('reconnect', () => {
      notifyStatus('connected');
      if (currentCenterId) {
        socket.emit('join:center', currentCenterId);
      }
      // Notify components to refetch authoritative data on reconnect
      reconnectListeners.forEach((cb) => {
        try { cb(); } catch (_) {}
      });
    });

    socket.on('connect_error', (err) => {
      notifyStatus('error', err.message);
    });
  }

  return socket;
}

/**
 * Connect socket with current token.
 */
export function connectSocket() {
  const s = getSocket();
  const token = storage.getToken();
  if (token) {
    s.auth = { token: `Bearer ${token}` };
  } else {
    s.auth = {};
  }
  if (!s.connected) {
    s.connect();
  }
  return s;
}

/**
 * Disconnect and reset socket instance.
 */
export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  currentCenterId = null;
  notifyStatus('disconnected');
}

/**
 * Subscribe to a service center room for queue/crowd updates.
 * @param {string} centerId 
 */
export function joinCenterRoom(centerId) {
  if (!centerId) return;
  currentCenterId = centerId;
  const s = connectSocket();
  if (s.connected) {
    s.emit('join:center', centerId);
  }
}

/**
 * Leave a service center room.
 * @param {string} centerId 
 */
export function leaveCenterRoom(centerId) {
  if (!centerId) return;
  if (socket && socket.connected) {
    socket.emit('leave:center', centerId);
  }
  if (currentCenterId === centerId) {
    currentCenterId = null;
  }
}

/**
 * Register a callback for connection status updates.
 */
export function onSocketStatus(callback) {
  statusListeners.add(callback);
  return () => statusListeners.delete(callback);
}

/**
 * Register a callback triggered whenever the socket successfully reconnects.
 */
export function onSocketReconnect(callback) {
  reconnectListeners.add(callback);
  return () => reconnectListeners.delete(callback);
}

function notifyStatus(status, details) {
  statusListeners.forEach((cb) => {
    try { cb(status, details); } catch (_) {}
  });
}

'use strict';

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createRedisClient, isRedisEnabled, isRedisRequired } = require('./redis');
const { ALLOWED_ORIGINS } = require('./env');
const { logger } = require('../utils/logger');

let io = null;
let adapterPubClient = null;
let adapterSubClient = null;
let adapterMode = 'memory';
let isAdapterReady = false;

// ─── Validated MongoDB ObjectId format ────────────────────────────────────────
const MONGO_ID_REGEX = /^[a-fA-F0-9]{24}$/;

/**
 * Safely extract a bearer token string from a value that may contain
 * "Bearer <token>" or a bare token.
 * Returns null if the value is empty or missing.
 */
function extractBearer(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    const t = trimmed.slice(7).trim();
    return t || null;
  }
  return trimmed;
}

/**
 * Socket.IO JWT authentication middleware.
 *
 * Extracts the token from:
 *   1. socket.handshake.auth.token   (Flutter setAuth, preferred)
 *   2. socket.handshake.headers.authorization  (extra header fallback)
 *
 * If BOTH are provided they MUST be identical; if they differ the connection
 * is rejected to prevent confused-deputy attacks.
 *
 * Identity is derived ONLY from the verified JWT payload — never from any
 * client-supplied userId, email, or role claim.
 *
 * On success:  socket.user = { id: '<24-hex-string>', role: '<ROLE>' }
 * On failure:  next(Error) → connection rejected with an authentication error
 *
 * SECURITY:
 *   - JWT secret is read from process.env.JWT_SECRET (same as REST middleware).
 *   - Neither the raw token nor any decoded field is ever logged.
 *   - Expired, tampered, and missing tokens are all rejected with the same
 *     generic message to avoid information leakage.
 */
async function socketAuthMiddleware(socket, next) {
  try {
    const { isShuttingDown } = require('../utils/shutdown');
    if (isShuttingDown()) {
      logger.security('SOCKET_AUTH_FAILURE', { socketId: socket.id, reason: 'SERVER_SHUTTING_DOWN' });
      return next(new Error('SERVER_SHUTTING_DOWN'));
    }
  } catch (_) {}

  // ── Extract token ──────────────────────────────────────────────────────────
  const authToken = extractBearer(socket.handshake.auth && socket.handshake.auth.token);
  const headerToken = extractBearer(
    socket.handshake.headers && socket.handshake.headers.authorization
  );

  // Choose the effective token; reject if both are supplied but different
  let token;
  if (authToken && headerToken) {
    if (authToken !== headerToken) {
      // Mismatched credentials — refuse rather than guess
      logger.security('SOCKET_AUTH_FAILURE', { socketId: socket.id, reason: 'SOCKET_AUTH_MISMATCH' });
      return next(new Error('SOCKET_AUTH_MISMATCH'));
    }
    token = authToken;
  } else {
    token = authToken || headerToken;
  }

  if (!token) {
    logger.security('SOCKET_AUTH_FAILURE', { socketId: socket.id, reason: 'SOCKET_AUTH_REQUIRED' });
    return next(new Error('SOCKET_AUTH_REQUIRED'));
  }

  // ── Verify token ───────────────────────────────────────────────────────────
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_err) {
    // Covers: TokenExpiredError, JsonWebTokenError, NotBeforeError
    // Generic message — do NOT reveal whether it was expired vs tampered.
    logger.security('SOCKET_AUTH_FAILURE', { socketId: socket.id, reason: 'SOCKET_AUTH_INVALID' });
    return next(new Error('SOCKET_AUTH_INVALID'));
  }

  // ── Validate decoded payload ───────────────────────────────────────────────
  if (!decoded || typeof decoded.id !== 'string' || !MONGO_ID_REGEX.test(decoded.id)) {
    logger.security('SOCKET_AUTH_FAILURE', { socketId: socket.id, reason: 'SOCKET_AUTH_INVALID' });
    return next(new Error('SOCKET_AUTH_INVALID'));
  }

  // ── Validate user status and tokenVersion in database ───────────────────────
  try {
    const User = require('../models/User');
    const user = await User.findById(decoded.id).select('role tokenVersion isActive');
    if (user) {
      if (user.isActive === false) {
        logger.security('SOCKET_AUTH_FAILURE', { socketId: socket.id, reason: 'SOCKET_AUTH_DEACTIVATED' });
        return next(new Error('SOCKET_AUTH_INVALID'));
      }
      const currentVersion = user.tokenVersion !== undefined ? user.tokenVersion : 0;
      if (typeof decoded.tokenVersion === 'number' && decoded.tokenVersion !== currentVersion) {
        logger.security('SOCKET_AUTH_FAILURE', { socketId: socket.id, reason: 'SOCKET_AUTH_REVOKED' });
        return next(new Error('SOCKET_AUTH_REVOKED'));
      }
    }
  } catch (_) {
    // Fail-open only for DB connectivity glitches, decoded token is cryptographically verified
  }

  // ── Attach minimum identity — DO NOT store raw JWT ─────────────────────────
  // Role claim is validated against canonical enum ('CUSTOMER', 'STAFF', 'ADMIN').
  // Unrecognized or omitted values safely default to 'CUSTOMER'.
  const VALID_ROLES = ['CUSTOMER', 'STAFF', 'ADMIN'];
  const rawRole = (typeof decoded.role === 'string' && decoded.role.trim().toUpperCase()) || '';
  const role = VALID_ROLES.includes(rawRole) ? rawRole : 'CUSTOMER';

  socket.user = {
    id: decoded.id,
    role,
    tokenVersion: decoded.tokenVersion,
  };

  return next();
}

/**
 * Attach Redis pub/sub adapter to Socket.IO server.
 *
 * In production:
 * - Strictly mandatory. Throws FATAL_REDIS_CONFIG if missing/disabled.
 *
 * In development/test:
 * - Falls back cleanly to default in-memory adapter if Redis is unconfigured.
 * - Accepts custom { pubClient, subClient } options for tests/mock harnesses.
 */
function setupRedisAdapter(ioInstance, options = {}) {
  // Custom adapter injection for automated tests or custom harnesses
  if (options.pubClient && options.subClient) {
    adapterPubClient = options.pubClient;
    adapterSubClient = options.subClient;
    adapterMode = 'redis';
    isAdapterReady = true;
    ioInstance.adapter(createAdapter(adapterPubClient, adapterSubClient));
    console.log('[Socket] Redis pub/sub adapter attached (custom/test configuration)');
    return;
  }

  const isProd = process.env.NODE_ENV === 'production';
  const redisRequired = isRedisRequired();
  const redisEnabled = isRedisEnabled();

  if (isProd) {
    if (process.env.REDIS_ENABLED === 'false') {
      const err = new Error(
        'FATAL_REDIS_CONFIG: Redis cannot be disabled (REDIS_ENABLED=false) in production. ' +
        'Horizontal scaling is strictly mandatory for Socket.IO in production. Cannot fall back to local-only in-memory adapter.'
      );
      console.error(`[Socket] ${err.message}`);
      throw err;
    }
    const hasConfig = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
    if (!hasConfig) {
      const err = new Error(
        'FATAL_REDIS_CONFIG: Redis configuration missing in production for Socket.IO horizontal scaling. ' +
        'Please configure REDIS_URL or REDIS_HOST.'
      );
      console.error(`[Socket] ${err.message}`);
      throw err;
    }
  } else if (!redisEnabled) {
    if (redisRequired) {
      const err = new Error('REDIS_REQUIRED: Redis is mandatory in this environment but not configured');
      console.error(`[Socket] Fatal: ${err.message}`);
      throw err;
    }
    adapterMode = 'memory';
    isAdapterReady = true;
    console.log('[Socket] Operating in single-instance memory adapter mode (development/test only)');
    return;
  }

  try {
    adapterPubClient = createRedisClient('socket-pub');
    adapterSubClient = createRedisClient('socket-sub');

    adapterPubClient.on('ready', () => {
      if (adapterSubClient && adapterSubClient.status === 'ready') {
        isAdapterReady = true;
      }
    });

    adapterSubClient.on('ready', () => {
      if (adapterPubClient && adapterPubClient.status === 'ready') {
        isAdapterReady = true;
      }
    });

    const handleAdapterError = (role, err) => {
      isAdapterReady = false;
      console.error(`[Socket:Adapter] Redis ${role} client error:`, err.message);
      if (isProd || redisRequired) {
        console.error('[Socket:Adapter] CRITICAL: Cross-instance pub/sub synchronization degraded');
      }
    };

    adapterPubClient.on('error', (err) => handleAdapterError('pub', err));
    adapterSubClient.on('error', (err) => handleAdapterError('sub', err));

    adapterPubClient.on('close', () => {
      isAdapterReady = false;
    });
    adapterSubClient.on('close', () => {
      isAdapterReady = false;
    });

    ioInstance.adapter(createAdapter(adapterPubClient, adapterSubClient));
    adapterMode = 'redis';
    console.log('[Socket] Redis pub/sub adapter initialized for horizontal scaling');
  } catch (err) {
    if (isProd || redisRequired) {
      console.error('[Socket] Failed to attach Redis adapter in production:', err.message);
      throw err;
    }
    adapterMode = 'memory';
    isAdapterReady = true;
    console.warn('[Socket] Redis adapter failed to initialize, falling back to memory adapter (dev only):', err.message);
  }
}

/**
 * Initialize the Socket.IO server.
 * Must be called once from server.js after the HTTP server is created.
 *
 * @param {import('http').Server} httpServer
 * @param {object} [options={}] Optional configuration including custom adapter clients
 */
function initSocket(httpServer, options = {}) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const normalizedOrigin = origin.trim().replace(/\/$/, '');
        if (ALLOWED_ORIGINS.includes(normalizedOrigin)) {
          callback(null, true);
        } else {
          callback(new Error(`Socket.IO CORS: Origin ${origin} not allowed`));
        }
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  });

  // Attach horizontal scaling Redis adapter
  setupRedisAdapter(io, options);

  // ─── JWT authentication middleware ─────────────────────────────────────────
  // Every incoming socket MUST carry a valid JWT. Unauthenticated connections
  // are rejected before the 'connection' handler fires.
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    // socket.user is guaranteed to exist here (set by socketAuthMiddleware).
    console.log(`[Socket] Client authenticated: ${socket.id} (role: ${socket.user.role})`);

    // Automatically join the authenticated user's private room.
    // The room name is derived from the VERIFIED JWT identity — never from a
    // client-supplied value.
    socket.join(`user:${socket.user.id}`);

    // ── Room subscriptions ────────────────────────────────────────────────────

    // join:center — public / shared event channel for a service center.
    // Any authenticated user may join a center room to receive queue-level
    // broadcasts (queue.updated, token.called, counter.updated, crowd.updated).
    // The centerId is validated to be a 24-hex MongoDB ObjectId before use.
    socket.on('join:center', (centerId) => {
      if (!centerId || typeof centerId !== 'string') return;
      const id = centerId.trim();
      if (!MONGO_ID_REGEX.test(id)) return; // Reject malformed / injection IDs
      socket.join(`center:${id}`);
      console.log(`[Socket] ${socket.id} joined center:${id}`);
    });

    socket.on('leave:center', (centerId) => {
      if (!centerId || typeof centerId !== 'string') return;
      const id = centerId.trim();
      if (!MONGO_ID_REGEX.test(id)) return;
      socket.leave(`center:${id}`);
    });

    // join:user — SECURE private room subscription.
    //
    // The server IGNORES the client-supplied userId and always joins the
    // authenticated user's own room (derived from socket.user.id).
    //
    // This approach is backward-compatible with the Flutter client, which
    // currently emits:  join:user(currentUserId)
    //
    // Cross-user attacks are structurally impossible:
    //   • Customer A JWT  + join:user(B) → Customer A still only in user:A
    //   • Customer A JWT  + join:user()  → Customer A still only in user:A
    //
    // The room join already happened unconditionally above on connection;
    // this handler is retained for backward-compatibility with the Flutter
    // client event, but it is now a no-op (the private room is already set).
    socket.on('join:user', (_clientUserId) => {
      // Nothing to do — the user room was joined at connection time using the
      // verified JWT identity. The event is acknowledged silently to keep
      // the Flutter client compatible without exposing any security boundary.
      console.log(`[Socket] ${socket.id} user-room already joined (server-authoritative)`);
    });

    socket.on('leave:user', (_userId) => {
      // Clients may NOT leave their own private notification room.
      // Silently ignore the request.
    });

    // join:counter — display-board subscription for a counter kiosk.
    // Requires authenticated socket; counter rooms receive counter.updated events.
    socket.on('join:counter', ({ centerId, counterId } = {}) => {
      if (!centerId || !counterId) return;
      const cid = typeof centerId === 'string' ? centerId.trim() : '';
      const ctid = typeof counterId === 'string' ? counterId.trim() : '';
      if (!MONGO_ID_REGEX.test(cid) || !MONGO_ID_REGEX.test(ctid)) return;
      socket.join(`counter:${cid}:${ctid}`);
      console.log(`[Socket] ${socket.id} joined counter:${cid}:${ctid}`);
    });

    socket.on('leave:counter', ({ centerId, counterId } = {}) => {
      if (!centerId || !counterId) return;
      const cid = typeof centerId === 'string' ? centerId.trim() : '';
      const ctid = typeof counterId === 'string' ? counterId.trim() : '';
      if (!MONGO_ID_REGEX.test(cid) || !MONGO_ID_REGEX.test(ctid)) return;
      socket.leave(`counter:${cid}:${ctid}`);
      console.log(`[Socket] ${socket.id} left counter:${cid}:${ctid}`);
    });

    socket.on('disconnect', (reason) => {
      // Clear identity reference (belt-and-suspenders; Node GC would handle it)
      socket.user = null;
      console.log(`[Socket] Client disconnected: ${socket.id} — ${reason}`);
    });

    socket.on('error', (err) => {
      console.error(`[Socket] Error from ${socket.id}:`, err.message);
    });
  });

  console.log('[Socket] Socket.IO server initialized with JWT authentication');
  return io;
}

/**
 * Get the Socket.IO instance.
 * Call this from controllers/services to emit events.
 */
function getIO() {
  if (!io) {
    throw new Error('[Socket] Socket.IO has not been initialized. Call initSocket() first.');
  }
  return io;
}

// ─── Named emit helpers ────────────────────────────────────────────────────────

/**
 * Emit to all clients in a service center room.
 * @param {string} centerId
 * @param {string} event - Socket.IO event name
 * @param {object} data
 */
function emitToCenter(centerId, event, data) {
  getIO().to(`center:${centerId}`).emit(event, data);
}

/**
 * Emit to a specific user's personal room.
 * @param {string} userId
 * @param {string} event
 * @param {object} data
 */
function emitToUser(userId, event, data) {
  getIO().to(`user:${userId}`).emit(event, data);
}

/**
 * Emit to all clients subscribed to a specific counter display.
 * @param {string} centerId
 * @param {string} counterId
 * @param {string} event
 * @param {object} data
 */
function emitToCounter(centerId, counterId, event, data) {
  getIO().to(`counter:${centerId}:${counterId}`).emit(event, data);
}

/**
 * Broadcast to all connected clients.
 * Use sparingly — prefer room-scoped emits.
 */
function broadcast(event, data) {
  getIO().emit(event, data);
}

/**
 * Disconnect and revoke all active sockets for a specific user across all backend instances.
 * In multi-instance mode with @socket.io/redis-adapter, disconnectSockets broadcasts
 * a REMOTE_DISCONNECT request across the Redis cluster so all nodes disconnect matching sockets.
 *
 * @param {string} userId
 * @returns {Promise<void>}
 */
function disconnectUserSockets(userId) {
  if (!io || !userId) return Promise.resolve();
  try {
    const userRoom = `user:${userId}`;
    const p = io.in(userRoom).disconnectSockets(true);
    console.log(`[Socket] Revoked and disconnected all sockets for user ${userId}`);
    logger.security('SOCKET_USER_REVOKED', { userId: String(userId) });
    return Promise.resolve(p);
  } catch (err) {
    console.error(`[Socket] Error revoking sockets for user ${userId}:`, err.message);
    return Promise.resolve();
  }
}

/**
 * Gracefully close Redis pub/sub adapter connections.
 * Exposed for clean server shutdown and testing.
 *
 * @returns {Promise<void>}
 */
async function closeSocketAdapter() {
  const promises = [];
  if (adapterPubClient) {
    promises.push(
      adapterPubClient.quit().catch((err) => {
        console.warn('[Socket:pubClient] Force disconnecting:', err.message);
        adapterPubClient.disconnect();
      })
    );
  }
  if (adapterSubClient) {
    promises.push(
      adapterSubClient.quit().catch((err) => {
        console.warn('[Socket:subClient] Force disconnecting:', err.message);
        adapterSubClient.disconnect();
      })
    );
  }
  await Promise.all(promises);
  adapterPubClient = null;
  adapterSubClient = null;
  adapterMode = 'memory';
  isAdapterReady = false;
  console.log('[Socket] Redis pub/sub adapter connections closed gracefully');
}

/**
 * Retrieve current adapter health and status.
 *
 * @returns {{ mode: string, isReady: boolean, pubStatus: string, subStatus: string }}
 */
function getAdapterStatus() {
  return {
    mode: adapterMode,
    isReady: isAdapterReady,
    pubStatus: adapterPubClient ? adapterPubClient.status : 'none',
    subStatus: adapterSubClient ? adapterSubClient.status : 'none',
  };
}

/**
 * Gracefully close Socket.IO server and disconnect all connected clients.
 *
 * @returns {Promise<void>}
 */
async function closeSocket() {
  if (io) {
    try {
      io.disconnectSockets(true);
      await new Promise((resolve) => {
        io.close(() => {
          resolve();
        });
      });
      console.log('[Socket] Socket.IO server closed');
    } catch (err) {
      console.warn('[Socket] Error closing Socket.IO server:', err.message);
    } finally {
      io = null;
    }
  }
}

module.exports = {
  initSocket,
  getIO,
  emitToCenter,
  emitToUser,
  emitToCounter,
  broadcast,
  disconnectUserSockets,
  closeSocketAdapter,
  closeSocket,
  getAdapterStatus,
  setupRedisAdapter,
};

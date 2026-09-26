'use strict';

/**
 * QueueFlow — MongoDB Connection & Pool Resilience
 * Phase 5 — Step 8: Connection Pooling & Graceful Teardown
 */

const mongoose = require('mongoose');
const { redactString } = require('../utils/redact');
const { isShuttingDown } = require('../utils/shutdown');

let connectPromise = null;
let reconnectTimer = null;
let isClosing = false;

/**
 * Helper to parse bounded integers from environment variables.
 * Falls back to default if variable is undefined, empty, or outside [min, max].
 *
 * @param {string|undefined} val
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseBoundedInt(val, def, min, max) {
  if (val === undefined || val === '') return def;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed < min || parsed > max) return def;
  return parsed;
}

/**
 * Build production-safe Mongoose connection and pool options.
 *
 * Defaults:
 *   - maxPoolSize: 25 (prod) / 10 (dev/test). Configurable via MONGODB_MAX_POOL_SIZE (2-100).
 *     Appropriate for multi-instance Render deployments connecting to MongoDB Atlas to prevent
 *     saturating Atlas connection tiers while handling queue traffic bursts.
 *   - minPoolSize: 5 (prod) / 1 (dev/test). Configurable via MONGODB_MIN_POOL_SIZE (0-maxPoolSize).
 *     Maintains warm TCP/TLS sockets to eliminate connection establishment latency during sudden traffic.
 *   - maxIdleTimeMS: 30000. Configurable via MONGODB_MAX_IDLE_TIME_MS (1000-300000).
 *     Reaps idle sockets after 30 seconds of inactivity to release database resources.
 *   - serverSelectionTimeoutMS: 10000. Configurable via MONGODB_SERVER_SELECTION_TIMEOUT_MS (1000-60000).
 *     Allows fast failover when replica set primary steps down.
 *   - socketTimeoutMS: 45000. Configurable via MONGODB_SOCKET_TIMEOUT_MS (5000-120000).
 *     Times out slow queries before they exhaust server thread pools.
 *   - connectTimeoutMS: 15000. Configurable via MONGODB_CONNECT_TIMEOUT_MS (1000-60000).
 *     Initial TCP socket connection timeout.
 *   - heartbeatFrequencyMS: 10000. Configurable via MONGODB_HEARTBEAT_FREQUENCY_MS (500-30000).
 *     Server discovery and monitoring heartbeat interval.
 *   - retryWrites: true, retryReads: true.
 *     Automatic driver retries on transient network errors.
 *   - autoIndex: false in production (avoids blocking index builds during startup), true in dev/test.
 *
 * @returns {object}
 */
function getMongoPoolOptions() {
  const isProd = process.env.NODE_ENV === 'production';

  const maxPoolSize = parseBoundedInt(process.env.MONGODB_MAX_POOL_SIZE, isProd ? 25 : 10, 2, 100);
  const minPoolSize = parseBoundedInt(process.env.MONGODB_MIN_POOL_SIZE, isProd ? 5 : 1, 0, maxPoolSize);
  const maxIdleTimeMS = parseBoundedInt(process.env.MONGODB_MAX_IDLE_TIME_MS, 30000, 1000, 300000);
  const serverSelectionTimeoutMS = parseBoundedInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10000, 1000, 60000);
  const socketTimeoutMS = parseBoundedInt(process.env.MONGODB_SOCKET_TIMEOUT_MS, 45000, 5000, 120000);
  const connectTimeoutMS = parseBoundedInt(process.env.MONGODB_CONNECT_TIMEOUT_MS, 15000, 1000, 60000);
  const heartbeatFrequencyMS = parseBoundedInt(process.env.MONGODB_HEARTBEAT_FREQUENCY_MS, 10000, 500, 30000);

  return {
    maxPoolSize,
    minPoolSize,
    maxIdleTimeMS,
    serverSelectionTimeoutMS,
    socketTimeoutMS,
    connectTimeoutMS,
    heartbeatFrequencyMS,
    retryWrites: true,
    retryReads: true,
    autoIndex: !isProd,
  };
}

async function connectDB() {
  if (isShuttingDown() || isClosing) {
    return null;
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (connectPromise) {
    return connectPromise;
  }

  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error('[DB] MONGODB_URI is not set. Please configure your .env file.');
    process.exit(1);
  }

  const options = getMongoPoolOptions();

  connectPromise = (async () => {
    try {
      const conn = await mongoose.connect(uri, options);

      console.log(`[DB] MongoDB connected: ${conn.connection.host}`);

      // In non-production or initialization, ensure critical security indexes are registered
      try {
        const { Token } = require('../models/Token');
        const User = require('../models/User');
        Token.init().catch((idxErr) => console.warn('[DB] Token index init warning:', idxErr.message));
        User.init().catch((idxErr) => console.warn('[DB] User index init warning:', idxErr.message));
      } catch (_) {}

      mongoose.connection.on('disconnected', () => {
        console.warn('[DB] MongoDB disconnected.');
        connectPromise = null;
      });

      mongoose.connection.on('reconnected', () => {
        console.log('[DB] MongoDB reconnected.');
      });

      mongoose.connection.on('error', (err) => {
        console.error('[DB] MongoDB connection error:', redactString(err.message));
      });

      return conn;
    } catch (err) {
      connectPromise = null;
      console.error('[DB] Initial connection failed:', redactString(err.message));
      if (process.env.NODE_ENV === 'test') throw err;

      // Only schedule reconnect if not shutting down and not explicitly closing
      if (!isShuttingDown() && !isClosing) {
        console.log('[DB] Retrying in 5 seconds...');
        reconnectTimer = setTimeout(connectDB, 5000);
      }
    }
  })();

  return connectPromise;
}

/**
 * Safely and gracefully close MongoDB connection pool.
 * Idempotent: safe when already disconnected, does not create reconnect loops,
 * and clears any pending reconnection timers.
 *
 * @returns {Promise<void>}
 */
async function closeDB() {
  isClosing = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connectPromise = null;

  if (mongoose.connection && mongoose.connection.readyState !== 0) {
    try {
      await mongoose.connection.close(false);
      console.log('[DB] MongoDB disconnected cleanly.');
    } catch (err) {
      console.warn('[DB] Force disconnecting MongoDB:', redactString(err.message));
      try {
        await mongoose.disconnect();
      } catch (_) {}
    }
  }
  isClosing = false;
}

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.closeDB = closeDB;
module.exports.getMongoPoolOptions = getMongoPoolOptions;

'use strict';

/**
 * QueueFlow — Centralized Graceful Shutdown Coordinator
 * Phase 5 — Step 8: Production Resilience & Graceful Shutdown
 *
 * Coordinates deterministic, ordered teardown:
 *   1. Mark application as shutting down (isShuttingDown = true)
 *   2. /health/ready immediately fails with HTTP 503
 *   3. Stop accepting new HTTP requests and drain active connections
 *   4. Reject incoming Socket.IO handshakes
 *   5. Disconnect connected Socket.IO clients and close server
 *   6. Close Socket.IO Redis pub/sub adapter
 *   7. Close main Redis rate-limiting client
 *   8. Close MongoDB connection pool cleanly
 *   9. Emit structured audit logs throughout
 *  10. Enforce hard shutdown timeout to prevent hung processes
 */

const { logger } = require('./logger');

let _isShuttingDown = false;
let _shutdownPromise = null;
let _server = null;
let _closeSocketFn = null;
let _closeAdapterFn = null;
let _closeRedisFn = null;
let _closeDBFn = null;

/**
 * Check if the application is currently in a graceful shutdown phase.
 *
 * @returns {boolean}
 */
function isShuttingDown() {
  return _isShuttingDown;
}

/**
 * Explicitly set shutting down state (used internally and by tests).
 *
 * @param {boolean} [val=true]
 */
function setShuttingDown(val = true) {
  _isShuttingDown = Boolean(val);
}

/**
 * Register runtime targets for coordinated shutdown.
 *
 * @param {object} targets
 * @param {import('http').Server} [targets.server]
 * @param {Function} [targets.closeSocket]
 * @param {Function} [targets.closeAdapter]
 * @param {Function} [targets.closeRedis]
 * @param {Function} [targets.closeDB]
 */
function registerShutdownTargets({ server, closeSocket, closeAdapter, closeRedis, closeDB } = {}) {
  if (server) _server = server;
  if (closeSocket) _closeSocketFn = closeSocket;
  if (closeAdapter) _closeAdapterFn = closeAdapter;
  if (closeRedis) _closeRedisFn = closeRedis;
  if (closeDB) _closeDBFn = closeDB;
}

/**
 * Execute graceful shutdown.
 * Idempotent: returns existing promise if shutdown has already been initiated.
 *
 * @param {string} [signal='SIGTERM'] Triggering signal or reason
 * @param {object} [options={}]
 * @param {number} [options.timeoutMs] Shutdown deadline in milliseconds (default: SHUTDOWN_TIMEOUT_MS or 15000)
 * @param {boolean} [options.exitProcess=true] Whether to call process.exit() upon completion
 * @returns {Promise<void>}
 */
async function shutdown(signal = 'SIGTERM', options = {}) {
  if (_shutdownPromise) {
    return _shutdownPromise;
  }

  _isShuttingDown = true;

  _shutdownPromise = (async () => {
    const rawTimeout = options.timeoutMs !== undefined ? options.timeoutMs : process.env.SHUTDOWN_TIMEOUT_MS;
    const timeoutMs = parseInt(rawTimeout || '15000', 10);
    const exitProcess = options.exitProcess !== false;

    logger.info('Graceful shutdown initiated', {
      event: 'SHUTDOWN_INITIATED',
      signal,
      timeoutMs,
    });

    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        logger.error('Graceful shutdown timed out; forcing exit', {
          event: 'SHUTDOWN_TIMEOUT',
          signal,
          timeoutMs,
        });
        const err = new Error(`Shutdown timed out after ${timeoutMs}ms`);
        err.isTimeout = true;
        reject(err);
      }, timeoutMs);
    });

    const cleanupSequence = async () => {
      // 1. Stop accepting new HTTP requests and drain active connections
      if (_server && typeof _server.close === 'function') {
        try {
          if (typeof _server.closeIdleConnections === 'function') {
            _server.closeIdleConnections();
          }
          await new Promise((resolve) => {
            _server.close(() => resolve());
          });
          logger.info('HTTP server closed and connections drained', {
            event: 'SHUTDOWN_HTTP_CLOSED',
          });
        } catch (err) {
          logger.warn('Error closing HTTP server:', { error: err.message });
        }
      }

      // 2. Disconnect connected Socket.IO clients and close server
      if (_closeSocketFn && typeof _closeSocketFn === 'function') {
        try {
          await _closeSocketFn();
          logger.info('Socket.IO server closed', {
            event: 'SHUTDOWN_SOCKET_CLOSED',
          });
        } catch (err) {
          logger.warn('Error closing Socket.IO:', { error: err.message });
        }
      }

      // 3. Close Socket.IO Redis pub/sub adapter
      if (_closeAdapterFn && typeof _closeAdapterFn === 'function') {
        try {
          await _closeAdapterFn();
          logger.info('Socket.IO Redis adapter closed', {
            event: 'SHUTDOWN_SOCKET_ADAPTER_CLOSED',
          });
        } catch (err) {
          logger.warn('Error closing Socket.IO adapter:', { error: err.message });
        }
      }

      // 4. Close main Redis client
      if (_closeRedisFn && typeof _closeRedisFn === 'function') {
        try {
          await _closeRedisFn();
          logger.info('Redis connection closed', {
            event: 'SHUTDOWN_REDIS_CLOSED',
          });
        } catch (err) {
          logger.warn('Error closing Redis:', { error: err.message });
        }
      }

      // 5. Close MongoDB connection pool
      if (_closeDBFn && typeof _closeDBFn === 'function') {
        try {
          await _closeDBFn();
          logger.info('MongoDB connection closed', {
            event: 'SHUTDOWN_MONGO_CLOSED',
          });
        } catch (err) {
          logger.warn('Error closing MongoDB:', { error: err.message });
        }
      }

      logger.info('Graceful shutdown completed successfully', {
        event: 'SHUTDOWN_COMPLETE',
        signal,
      });
    };

    const shouldExit =
      options.exitProcess === true ||
      (options.exitProcess !== false && process.env.NODE_ENV !== 'test');

    try {
      await Promise.race([cleanupSequence(), timeoutPromise]);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (shouldExit) {
        process.exit(0);
      }
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (shouldExit) {
        process.exit(1);
      }
      throw err;
    }
  })();

  return _shutdownPromise;
}

/**
 * Reset internal shutdown state (for testing harness and process simulation).
 */
function _resetShutdownState() {
  _isShuttingDown = false;
  _shutdownPromise = null;
  _server = null;
  _closeSocketFn = null;
  _closeAdapterFn = null;
  _closeRedisFn = null;
  _closeDBFn = null;
}

module.exports = {
  isShuttingDown,
  setShuttingDown,
  registerShutdownTargets,
  shutdown,
  _resetShutdownState,
};

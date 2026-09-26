'use strict';

const Redis = require('ioredis');
const { redactString } = require('../utils/redact');

let client = null;
let isReady = false;

/**
 * Mask passwords/credentials in Redis connection URLs for safe logging.
 *
 * @param {string} urlStr
 * @returns {string} Sanitized URL string
 */
function sanitizeRedisUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    const parsed = new URL(urlStr);
    if (parsed.password) {
      parsed.password = '***';
    }
    if (parsed.username) {
      parsed.username = '***';
    }
    return parsed.toString();
  } catch (_) {
    return '[REDACTED_REDIS_URL]';
  }
}

/**
 * Determine if Redis is configured as required for this environment.
 * In production (NODE_ENV === 'production'), Redis is ALWAYS mandatory.
 * It cannot be bypassed, and in-memory fallback is strictly blocked.
 * In development/test, Redis is mandatory only if REDIS_REQUIRED === 'true'.
 *
 * @returns {boolean}
 */
function isRedisRequired() {
  if (process.env.NODE_ENV === 'production') {
    return true; // Strictly mandatory in production
  }
  return process.env.REDIS_REQUIRED === 'true';
}

/**
 * Determine if Redis is enabled in configuration.
 * In production, Redis CANNOT be disabled.
 * In development/test, Redis is enabled if REDIS_ENABLED=true or REDIS_URL/REDIS_HOST is set.
 *
 * @returns {boolean}
 */
function isRedisEnabled() {
  if (process.env.NODE_ENV === 'production') {
    return true; // Always enabled/mandatory in production
  }
  if (process.env.REDIS_ENABLED === 'false') return false;
  if (process.env.REDIS_ENABLED === 'true') return true;
  return Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
}

/**
 * Build Redis connection configuration options purely from environment variables.
 * Never stores or exposes raw credentials.
 *
 * @returns {object|string} ioredis options
 */
function getRedisOptions() {
  const url = process.env.REDIS_URL;

  const baseOptions = {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    retryStrategy(times) {
      try {
        const { isShuttingDown } = require('../utils/shutdown');
        if (isShuttingDown()) {
          return null;
        }
      } catch (_) {}
      if (times > 10) {
        console.error('[Redis] Max reconnection attempts (10) reached.');
        return null;
      }
      return Math.min(times * 200, 3000);
    },
  };

  if (url) {
    return { url, ...baseOptions };
  }

  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const tls = process.env.REDIS_TLS === 'true' ? {} : undefined;

  return {
    host,
    port,
    password,
    tls,
    ...baseOptions,
  };
}

/**
 * Initialize Redis connection singleton.
 *
 * In production:
 * - Fails startup immediately if Redis configuration is missing or REDIS_ENABLED=false.
 * - Fails startup immediately if Redis server connection fails.
 *
 * In development/test:
 * - Redis is optional and cleanly falls back to local in-memory rate limiting when unconfigured.
 *
 * @returns {Promise<Redis|null>} Connected client or null if not enabled
 */
async function initRedis() {
  try {
    const { isShuttingDown } = require('../utils/shutdown');
    if (isShuttingDown()) {
      return null;
    }
  } catch (_) {}

  if (process.env.NODE_ENV === 'production') {
    if (process.env.REDIS_ENABLED === 'false') {
      const err = new Error(
        'FATAL_REDIS_CONFIG: Redis cannot be disabled (REDIS_ENABLED=false) in production. ' +
        'Distributed rate limiting is required across instances. Cannot fallback to MemoryStore.'
      );
      console.error(`[Redis] ${err.message}`);
      throw err;
    }

    const hasExplicitConfig = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
    if (!hasExplicitConfig) {
      const err = new Error(
        'FATAL_REDIS_CONFIG: Redis configuration missing in production. ' +
        'Please configure REDIS_URL or REDIS_HOST for distributed rate limiting.'
      );
      console.error(`[Redis] ${err.message}`);
      throw err;
    }
  } else if (!isRedisEnabled()) {
    if (isRedisRequired()) {
      const err = new Error('REDIS_REQUIRED: Redis is mandatory in this environment but not configured');
      console.error(`[Redis] Fatal: ${err.message}`);
      throw err;
    }
    return null;
  }

  if (client) {
    return client;
  }

  const config = getRedisOptions();
  const displayTarget = config.url
    ? sanitizeRedisUrl(config.url)
    : `${config.host || '127.0.0.1'}:${config.port || 6379}`;

  try {
    client = config.url ? new Redis(config.url, config) : new Redis(config);

    client.on('connect', () => {
      console.log(`[Redis] Connection established to ${displayTarget}`);
    });

    client.on('ready', () => {
      isReady = true;
      console.log('[Redis] Client ready to receive commands');
    });

    client.on('error', (err) => {
      isReady = false;
      console.error('[Redis] Client error:', redactString(err.message));
    });

    client.on('close', () => {
      isReady = false;
    });

    client.on('reconnecting', (delay) => {
      isReady = false;
      console.log(`[Redis] Reconnecting in ${delay}ms...`);
    });

    await client.connect();
    return client;
  } catch (err) {
    isReady = false;
    console.error(`[Redis] Failed to connect to ${displayTarget}:`, redactString(err.message));
    if (isRedisRequired()) {
      throw err;
    }
    return null;
  }
}

/**
 * Get active Redis client instance if ready.
 *
 * @returns {Redis|null}
 */
function getRedisClient() {
  return client;
}

/**
 * Check if Redis connection is currently open and ready.
 *
 * @returns {boolean}
 */
function isRedisReady() {
  return Boolean(client && isReady && client.status === 'ready');
}

/**
 * Gracefully close Redis connection.
 *
 * @returns {Promise<void>}
 */
async function closeRedis() {
  if (client) {
    try {
      await client.quit();
      console.log('[Redis] Connection closed gracefully');
    } catch (err) {
      console.warn('[Redis] Force disconnecting client:', err.message);
      client.disconnect();
    } finally {
      client = null;
      isReady = false;
    }
  }
}

/**
 * Reset internal client instance (used for testing).
 *
 * @param {Redis|null} newClient
 * @param {boolean} [ready=false]
 */
function _setMockClient(newClient, ready = false) {
  client = newClient;
  isReady = ready;
}

/**
 * Create a new, dedicated Redis client instance using centralized options.
 * Used for Socket.IO Redis adapter pub/sub and other components needing isolated connections.
 *
 * @param {string} role - Identification tag (e.g. 'socket-pub', 'socket-sub')
 * @param {object} [customOpts={}] - Overrides or additional options
 * @returns {Redis}
 */
function createRedisClient(role = 'generic', customOpts = {}) {
  const baseConfig = getRedisOptions();
  let clientInstance;
  let displayTarget;

  if (typeof baseConfig === 'object' && baseConfig.url) {
    const { url, ...rest } = baseConfig;
    const merged = { ...rest, ...customOpts };
    displayTarget = sanitizeRedisUrl(url);
    clientInstance = new Redis(url, merged);
  } else if (typeof baseConfig === 'object') {
    const merged = { ...baseConfig, ...customOpts };
    displayTarget = `${merged.host || '127.0.0.1'}:${merged.port || 6379}`;
    clientInstance = new Redis(merged);
  } else {
    displayTarget = sanitizeRedisUrl(baseConfig);
    clientInstance = new Redis(baseConfig, customOpts);
  }

  clientInstance.on('connect', () => {
    console.log(`[Redis:${role}] Connection established to ${displayTarget}`);
  });

  clientInstance.on('error', (err) => {
    console.error(`[Redis:${role}] Client error:`, redactString(err.message));
  });

  return clientInstance;
}

module.exports = {
  initRedis,
  getRedisClient,
  isRedisReady,
  isRedisRequired,
  isRedisEnabled,
  closeRedis,
  sanitizeRedisUrl,
  _setMockClient,
  getRedisOptions,
  createRedisClient,
};

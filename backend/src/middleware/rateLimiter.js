'use strict';

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedisClient, isRedisReady, isRedisRequired } = require('../config/redis');
const { logger } = require('../utils/logger');

/**
 * Distributed rate limiter store wrapper.
 * Uses Redis (via rate-limit-redis) when Redis is enabled and connected.
 * In development without Redis: falls back to in-memory store.
 * In production: if Redis is required, it fails safely (throws 503) rather
 * than silently allowing unthrottled requests across instances.
 */
class QueueFlowDistributedStore {
  constructor(options = {}) {
    this.prefix = options.prefix || 'rl:';
    this.localStore = new rateLimit.MemoryStore();
    this.redisStore = null;
    this.lastClient = null;
    this.options = options;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.localStore.init(options);
  }

  /**
   * Lazily retrieve or construct the RedisStore when the Redis client is connected.
   */
  _getRedisStore() {
    const client = this.options.getClient ? this.options.getClient() : getRedisClient();
    const ready = this.options.isReady ? this.options.isReady() : isRedisReady();

    if (client && ready) {
      if (!this.redisStore || this.lastClient !== client) {
        this.redisStore = new RedisStore({
          sendCommand: (...args) => client.call(...args),
          prefix: this.prefix,
        });
        this.redisStore.init({ windowMs: this.windowMs });
        this.lastClient = client;
      }
      return this.redisStore;
    }

    return null;
  }

  /**
   * Increment hit counter for key.
   */
  async increment(key) {
    const redisStore = this._getRedisStore();
    if (redisStore) {
      return redisStore.increment(key);
    }

    const required = this.options.isRequired ? this.options.isRequired() : isRedisRequired();
    if (required && !this.options.isTest) {
      const err = new Error('REDIS_UNAVAILABLE: Distributed rate limiting store is required in production');
      err.status = 503;
      err.statusCode = 503;
      throw err;
    }

    return this.localStore.increment(key);
  }

  /**
   * Decrement hit counter for key.
   */
  async decrement(key) {
    const redisStore = this._getRedisStore();
    if (redisStore) {
      return redisStore.decrement(key);
    }
    return this.localStore.decrement(key);
  }

  /**
   * Reset hits for key.
   */
  async resetKey(key) {
    const redisStore = this._getRedisStore();
    if (redisStore) {
      return redisStore.resetKey(key);
    }
    return this.localStore.resetKey(key);
  }

  /**
   * Reset all counters (used in testing).
   */
  async resetAll() {
    if (this.localStore && typeof this.localStore.resetAll === 'function') {
      await this.localStore.resetAll();
    }
  }
}

/**
 * Key generator: for authenticated routes, binds rate limits to user ID so
 * rotating IP addresses / proxies cannot bypass user limits.
 * Falls back to client IP for unauthenticated requests.
 */
function userOrIpKeyGenerator(req) {
  if (req.user && (req.user._id || req.user.id)) {
    return `usr:${req.user._id || req.user.id}`;
  }
  return `ip:${req.ip || '127.0.0.1'}`;
}

/**
 * Key generator: IP-based.
 */
function ipKeyGenerator(req) {
  return req.ip || '127.0.0.1';
}

/**
 * Factory to create rate limiter instances with consistent configuration,
 * distributed Redis backing, and safe error handling.
 *
 * @param {object} config
 * @returns {Function} Express middleware
 */
function createLimiter(config = {}) {
  const {
    prefix = 'rl:gen:',
    windowMs = 15 * 60 * 1000,
    max = 200,
    message = { success: false, message: 'Too many requests, please try again later.' },
    keyGenerator = ipKeyGenerator,
    storeOptions = {},
  } = config;

  const isTest = process.env.NODE_ENV === 'test';

  const store = new QueueFlowDistributedStore({
    prefix,
    isTest: storeOptions.isTest !== undefined ? storeOptions.isTest : isTest,
    ...storeOptions,
  });

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message,
    keyGenerator,
    store,
    passOnStoreError: false, // In production, errors halt safely rather than allowing unlimited bypass
    handler: (req, res, _next, options) => {
      logger.security('RATE_LIMIT_EXCEEDED', {
        requestId: req ? req.id : undefined,
        path: req ? (req.originalUrl ? req.originalUrl.split('?')[0] : req.path) : undefined,
        clientIp: req ? (req.ip || '127.0.0.1') : '127.0.0.1',
        prefix,
      });
      res.status(options.statusCode || 429).json(options.message);
    },
  });
}

// ─── Concrete Pre-configured Limiters (Preserving Phase 3 Limits) ────────────

const generalLimiter = createLimiter({
  prefix: 'rl:gen:',
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 200,
  keyGenerator: ipKeyGenerator,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const authLimiter = createLimiter({
  prefix: 'rl:auth:',
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 20,
  keyGenerator: ipKeyGenerator,
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});

const passwordChangeLimiter = createLimiter({
  prefix: 'rl:pwd:',
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 10,
  keyGenerator: userOrIpKeyGenerator,
  message: { success: false, message: 'Too many password change attempts, please try again later.' },
});

const tokenCreateLimiter = createLimiter({
  prefix: 'rl:tok_create:',
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 30,
  keyGenerator: userOrIpKeyGenerator,
  message: { success: false, message: 'Too many token requests, please try again later.' },
});

const feedbackLimiter = createLimiter({
  prefix: 'rl:feedback:',
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 30,
  keyGenerator: userOrIpKeyGenerator,
  message: { success: false, message: 'Too many feedback submissions, please try again later.' },
});

const verifyQRLimiter = createLimiter({
  prefix: 'rl:verify_qr:',
  windowMs: 1 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 120,
  keyGenerator: userOrIpKeyGenerator,
  message: { success: false, message: 'Too many QR verification requests.' },
});

const channelLimiter = createLimiter({
  prefix: 'rl:chan:',
  windowMs: 1 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 60,
  keyGenerator: ipKeyGenerator,
  message: { success: false, message: 'Too many channel requests, please try again later.' },
});

module.exports = {
  createLimiter,
  QueueFlowDistributedStore,
  userOrIpKeyGenerator,
  ipKeyGenerator,
  generalLimiter,
  authLimiter,
  passwordChangeLimiter,
  tokenCreateLimiter,
  feedbackLimiter,
  verifyQRLimiter,
  channelLimiter,
};


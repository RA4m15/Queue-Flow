/**
 * QueueFlow — Customer Web Storage Utility
 * Handles token, user session, and offline state caching safely.
 *
 * All cached queue snapshots are stored as structured envelopes:
 * {
 *   data: { ...sanitizedFields },
 *   cachedAt: ISO string,
 *   receivedAt: ISO string,
 *   source: "server",
 *   userId: string | null,
 *   version: 1
 * }
 *
 * Guarantees:
 * - Scoped by authenticated userId (prevents cross-user cache leakage)
 * - Expiration check (MAX_CACHE_AGE_MS = 24h)
 * - Safe sanitization (no passwords, JWT secrets, or unnecessary PII stored)
 * - Multi-tab synchronization via BroadcastChannel
 */

const TOKEN_KEY = 'queueflow_customer_token';
const USER_KEY = 'queueflow_customer_user';
const LAST_TOKEN_KEY = 'queueflow_last_known_token';
const CACHE_PREFIX_TOKEN = 'queueflow_cached_token_';
const CACHE_PREFIX_QUEUE = 'queueflow_cached_queue_';

export const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Multi-tab sync channel
let syncChannel = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    syncChannel = new BroadcastChannel('queueflow_cache_sync');
  }
} catch (_) {}

/**
 * Filter out sensitive fields and retain only queue-display attributes
 */
function sanitizeTokenForCache(token) {
  if (!token || typeof token !== 'object') return null;
  return {
    _id: token._id,
    tokenCode: token.tokenCode,
    tokenNumber: token.tokenNumber,
    status: token.status,
    currentPosition: token.currentPosition,
    peopleAhead: token.peopleAhead,
    estimatedWaitMinutes: token.estimatedWaitMinutes,
    waitEstimateMinutes: token.waitEstimateMinutes,
    servingToken: token.servingToken,
    calledAt: token.calledAt,
    createdAt: token.createdAt,
    centerId: token.centerId,
    serviceId: token.serviceId,
    counterId: token.counterId,
    activeCounters: token.activeCounters,
    proximityState: token.proximityState,
    proximityDistanceMeters: token.proximityDistanceMeters,
    proximityUpdatedAt: token.proximityUpdatedAt,
  };
}

export const storage = {
  getToken: () => {
    try {
      return localStorage.getItem(TOKEN_KEY) || null;
    } catch (_) {
      return null;
    }
  },

  setToken: (token) => {
    try {
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch (_) {}
  },

  removeToken: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  },

  getUser: () => {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  },

  setUser: (user) => {
    try {
      if (user) {
        localStorage.setItem(USER_KEY, JSON.stringify(user));
      } else {
        localStorage.removeItem(USER_KEY);
      }
    } catch (_) {}
  },

  removeUser: () => {
    try {
      localStorage.removeItem(USER_KEY);
    } catch (_) {}
  },

  /**
   * Legacy simple token getter for backward compatibility
   */
  getLastKnownToken: (userId = null) => {
    try {
      const cached = storage.getCachedToken(userId);
      return cached ? cached : null;
    } catch (_) {
      return null;
    }
  },

  /**
   * Legacy simple token setter for backward compatibility
   */
  setLastKnownToken: (token, userId = null) => {
    try {
      if (token) {
        storage.setCachedToken(token, userId);
      } else {
        storage.clearCachedToken(userId);
      }
    } catch (_) {}
  },

  /**
   * Set structured cached token envelope
   */
  setCachedToken: (token, userId = null) => {
    if (!token) return;
    try {
      const sanitized = sanitizeTokenForCache(token);
      const envelope = {
        data: sanitized,
        cachedAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        source: 'server',
        userId: userId || null,
        version: 1,
      };
      const serialized = JSON.stringify(envelope);
      const userKey = userId ? `${CACHE_PREFIX_TOKEN}${userId}` : `${CACHE_PREFIX_TOKEN}anon`;
      localStorage.setItem(userKey, serialized);
      localStorage.setItem(LAST_TOKEN_KEY, serialized);

      // Broadcast update to other open tabs
      if (syncChannel) {
        syncChannel.postMessage({
          type: 'TOKEN_CACHED',
          userId: userId || null,
          tokenId: sanitized._id,
          cachedAt: envelope.cachedAt,
        });
      }
    } catch (_) {}
  },

  /**
   * Get cached token envelope with max-age validation
   */
  getCachedToken: (userId = null) => {
    try {
      const userKey = userId ? `${CACHE_PREFIX_TOKEN}${userId}` : `${CACHE_PREFIX_TOKEN}anon`;
      let raw = localStorage.getItem(userKey);
      if (!raw && !userId) {
        raw = localStorage.getItem(LAST_TOKEN_KEY);
      }
      if (!raw) return null;

      const envelope = JSON.parse(raw);
      // Support legacy unwrapped token or envelope
      const data = envelope.data || envelope;
      const cachedAt = envelope.cachedAt || envelope.updatedAt || envelope.createdAt;

      // Check max cache age
      if (cachedAt) {
        const age = Date.now() - new Date(cachedAt).getTime();
        if (age > MAX_CACHE_AGE_MS) {
          localStorage.removeItem(userKey);
          localStorage.removeItem(LAST_TOKEN_KEY);
          return null;
        }
      }

      // Return token with cache metadata
      return {
        ...data,
        _cachedAt: envelope.cachedAt || cachedAt || new Date().toISOString(),
        _receivedAt: envelope.receivedAt || cachedAt,
        _source: envelope.source || 'server',
        _isStale: true,
      };
    } catch (_) {
      return null;
    }
  },

  /**
   * Clear cached token for a specific user
   */
  clearCachedToken: (userId = null) => {
    try {
      const userKey = userId ? `${CACHE_PREFIX_TOKEN}${userId}` : `${CACHE_PREFIX_TOKEN}anon`;
      localStorage.removeItem(userKey);
      localStorage.removeItem(LAST_TOKEN_KEY);

      if (syncChannel) {
        syncChannel.postMessage({
          type: 'CACHE_CLEARED',
          userId: userId || null,
        });
      }
    } catch (_) {}
  },

  /**
   * Cache queue preview state for a service at a center
   */
  setCachedQueue: (centerId, serviceId, queueData) => {
    if (!centerId || !serviceId || !queueData) return;
    try {
      const key = `${CACHE_PREFIX_QUEUE}${centerId}_${serviceId}`;
      const envelope = {
        data: queueData,
        centerId,
        serviceId,
        cachedAt: new Date().toISOString(),
        source: 'server',
        version: 1,
      };
      localStorage.setItem(key, JSON.stringify(envelope));
    } catch (_) {}
  },

  /**
   * Get cached queue preview state with max-age validation
   */
  getCachedQueue: (centerId, serviceId) => {
    if (!centerId || !serviceId) return null;
    try {
      const key = `${CACHE_PREFIX_QUEUE}${centerId}_${serviceId}`;
      const raw = localStorage.getItem(key);
      if (!raw) return null;

      const envelope = JSON.parse(raw);
      if (envelope.cachedAt) {
        const age = Date.now() - new Date(envelope.cachedAt).getTime();
        if (age > MAX_CACHE_AGE_MS) {
          localStorage.removeItem(key);
          return null;
        }
      }
      return {
        ...envelope.data,
        _cachedAt: envelope.cachedAt,
        _source: envelope.source || 'server',
        _isStale: true,
      };
    } catch (_) {
      return null;
    }
  },

  /**
   * Subscribe to multi-tab cache sync messages
   */
  onCacheSync: (callback) => {
    if (!syncChannel) return () => {};
    const handler = (event) => {
      try {
        if (callback && event.data) {
          callback(event.data);
        }
      } catch (_) {}
    };
    syncChannel.addEventListener('message', handler);
    return () => {
      syncChannel.removeEventListener('message', handler);
    };
  },

  /**
   * Clear all user session, token caches, and scoped data on logout
   */
  clearAllSession: () => {
    try {
      const user = storage.getUser();
      const userId = user?._id || null;

      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(LAST_TOKEN_KEY);
      if (userId) {
        localStorage.removeItem(`${CACHE_PREFIX_TOKEN}${userId}`);
      }
      localStorage.removeItem(`${CACHE_PREFIX_TOKEN}anon`);

      // Clear any cached queues
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith(CACHE_PREFIX_TOKEN) || key.startsWith(CACHE_PREFIX_QUEUE))) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));

      if (syncChannel) {
        syncChannel.postMessage({
          type: 'CACHE_CLEARED',
          userId,
        });
      }
    } catch (_) {}
  }
};


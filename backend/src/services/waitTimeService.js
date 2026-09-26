'use strict';

/**
 * Wait Time Estimation Service — QueueFlow TIER 3 / FEATURE 1: CONTEXT-AWARE EWT
 *
 * ─── Single source of truth for Estimated Wait Time (EWT) ──────────────────────
 * Every EWT number returned by the API, Socket.IO, Resource Hub, TV display,
 * Customer Web and Flutter originates here. No controller, service or client
 * computes a second estimate.
 *
 * ─── TIER 1 (frozen) BASELINE ─────────────────────────────────────────────────
 *   EWT = queueDepth × averageServiceTime ÷ activeCounters
 * Implemented by `calculateEstimatedWaitTime()` (pure, unchanged) and by the
 * `TIER1_FALLBACK` branch of the context-aware engine below.
 *
 * ─── TIER 3 / FEATURE 1 (this engine) ─────────────────────────────────────────
 * The Tier 1 baseline assumes every counter is idle and that service time is a
 * single constant. Both assumptions are false in a live queue. The engine
 * replaces them with real observed values already persisted by QueueFlow:
 *
 *   STEP 1 — EFFECTIVE SERVICE TIME (`effectiveServiceSeconds`)
 *     Bounded, server-side aggregation over REAL completed Token records.
 *     Strict precedence (no blending, so every number traces to exactly one
 *     real query result — explainability is prioritised over marginal accuracy):
 *
 *       1. RECENT_HOUR            mean duration of tokens completed in the same
 *                                 clock-hour, inside the daily window
 *                                 (real time-of-day context; only used when the
 *                                 bucket has >= EWT_MIN_SAMPLES records).
 *                                 The clock is the SERVER-LOCAL clock, i.e. the
 *                                 same convention QueueFlow already uses to
 *                                 partition queues by day (getTodayDateString).
 *       2. RECENT_WINDOW          mean duration completed inside the recent
 *                                 window (default 60 min)
 *       3. DAILY_WINDOW           mean duration completed inside the daily
 *                                 window (default 14 days)
 *       4. QUEUE_RUNNING_AVERAGE  Queue.avgServiceTimeSeconds (running mean
 *                                 maintained by queueService.completeToken)
 *       5. SERVICE_CONFIG         Service.avgServiceTimeMinutes (admin-set)
 *       6. SERVICE_CONFIG_FALLBACK last-resort guard, mirrors legacy Tier 1
 *
 *     `EWT_MIN_SAMPLES` (default 3) is a STATISTICAL-STABILITY THRESHOLD, not a
 *     tuning weight: a mean of fewer than 3 observations is dominated by a
 *     single outlier and is not a usable service-time estimate. It is
 *     configurable via the environment so it is never a disguised constant.
 *
 *   STEP 2 — REAL AVAILABLE CAPACITY (`freeCapacity`)
 *     For every ACTIVE counter assigned to the service, the residual service
 *     time left on the customer already at that counter is read from the REAL
 *     `Counter.servingStartedAt` timestamp:
 *
 *         residual_i = max(0, effectiveServiceSeconds − elapsed_i)
 *
 *     A counter is then worth `residual_i / effectiveServiceSeconds` of a whole
 *     service slot. Summing gives the number of service slots that are genuinely
 *     available to the waiting queue right now:
 *
 *         freeCapacity = Σ_i ( residual_i / effectiveServiceSeconds )
 *
 *   STEP 3 — ESTIMATE
 *
 *         EWT_seconds = ( queueDepth × effectiveServiceSeconds ) / freeCapacity
 *
 *     DEGENERACY PROOF (this is why the change is safe):
 *       When every counter is idle, residual_i = effectiveServiceSeconds for all
 *       i, so freeCapacity = activeCounters and
 *           EWT_seconds = queueDepth × effectiveServiceSeconds / activeCounters
 *       which is EXACTLY the Tier 1 baseline. The context-aware engine therefore
 *       reproduces Tier 1 bit-for-bit whenever there is no mid-service context,
 *       and only diverges when real counter state says capacity is temporarily
 *       reduced (counters partway through a service). No behaviour is invented.
 *
 *   GUARDS (deterministic, no randomness, no invented coefficients):
 *     • queueDepth <= 0            → 0 minutes (real empty state)
 *     • freeCapacity == 0          → queueDepth × effectiveServiceSeconds
 *                                    (nothing is freeing up: sequential fallback)
 *     • activeCounters == 0        → queueDepth × effectiveServiceSeconds
 *                                    (degraded capacity, sequential fallback)
 *     • elapsed clock skew         → elapsed clamped to >= 0
 *     • result                     → clamped to >= 0, rounded with Math.round,
 *                                    min 1 minute for a non-empty queue
 *
 *   ROUNDING: Math.round is used because the estimated value is already
 *   continuous (it includes real sub-minute residual times). Rounding to the
 *   NEAREST minute is what the pre-existing production call sites already did
 *   (`getServiceQueue` and `estimateWait` both used Math.round), and it avoids
 *   flipping a whole displayed minute because a counter is one second into its
 *   service. The frozen pure helper `calculateEstimatedWaitTime` keeps its own
 *   original Math.ceil so Tier 1 regression behaviour is bit-identical.
 *
 *   MEASURED BUT DELIBERATELY NOT USED AS A MULTIPLIER (documented, not hidden):
 *     • recentThroughputPerHour  — real completions/hour in the recent window.
 *       Capacity is already measured directly from counter timestamps, which is
 *       strictly more informative; any throughput weight would be an unevidenced
 *       coefficient.
 *     • abandonRate              — `queueDepth` counts only WAITING tokens, so
 *       terminal tokens (SKIPPED/CANCELLED/EXPIRED) are already excluded.
 *       Multiplying again would double-count.
 *     • crowdLoadPercent         — ServiceCenter.currentCrowd / capacity. No
 *       measured relationship between crowd level and service duration exists
 *       in the data, so applying one would be a fabricated assumption.
 *   All three are still returned in the explainability context for admin use.
 *
 * ─── BOUNDED QUERIES ───────────────────────────────────────────────────────────
 *   Every historical read is a single indexed aggregation over a bounded time
 *   window, served by `Token { centerId, serviceId, completedAt: -1 }`.
 *   No unbounded scans, no full-collection transfer, no client-side aggregation.
 *
 * ─── PERFORMANCE ───────────────────────────────────────────────────────────────
 *   Queue lifecycle events fire on every join/call/complete/skip/cancel. The
 *   historical context is memoised in a small bounded TTL cache
 *   (EWT_CONTEXT_CACHE_TTL_MS, default 15 000 ms, 500 entries max) that is
 *   explicitly invalidated by every queue mutation, so the value is never stale
 *   while the aggregation is not repeated needlessly.
 *
 * ─── EXTERNAL AI SERVICE ───────────────────────────────────────────────────────
 *   If AI_SERVICE_URL is configured the existing Python service remains the
 *   highest-priority source (unchanged behaviour, currently not configured).
 *   No "AI predicted X" claim is ever made for the deterministic engine below.
 */

const axios = require('axios');
const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL;

// ─── Tunable, documented parameters (all overridable via environment) ──────────

/** Statistical-stability threshold: below this many observations a mean is unusable. */
const MIN_SAMPLES = (() => {
  const parsed = parseInt(process.env.EWT_MIN_SAMPLES, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : 3;
})();

/** Recent-window size in minutes for the "right now" service-time mean. */
const RECENT_WINDOW_MINUTES = (() => {
  const parsed = parseInt(process.env.EWT_RECENT_WINDOW_MINUTES, 10);
  return Number.isInteger(parsed) && parsed >= 5 && parsed <= 1440 ? parsed : 60;
})();

/** Daily-window size in days for the seasonal baseline and hour-of-day bucket. */
const DAILY_WINDOW_DAYS = (() => {
  const parsed = parseInt(process.env.EWT_DAILY_WINDOW_DAYS, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 90 ? parsed : 14;
})();

/** Memoisation TTL for the historical context aggregation. */
const CONTEXT_CACHE_TTL_MS = (() => {
  const parsed = parseInt(process.env.EWT_CONTEXT_CACHE_TTL_MS, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 600000 ? parsed : 15000;
})();

const CONTEXT_CACHE_MAX_ENTRIES = 500;

/**
 * IANA timezone of this server process.
 *
 * Required because the time-of-day bucket must be computed on the SAME clock the
 * rest of QueueFlow uses (e.g. `getTodayDateString()` partitions queues by the
 * LOCAL calendar day). MongoDB's `$hour` always operates in UTC, so it is only
 * correct as a fallback when the server itself runs in UTC.
 */
const SERVER_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
})();

/** Zero-padded 2-digit hour label, matching MongoDB's `%H` format specifier. */
function _hourLabel(hour) {
  return String(hour).padStart(2, '0');
}

/**
 * Last-resort guard ONLY. Reached when a caller supplies no Service document at
 * all, which cannot happen for a persisted Service (the schema defaults
 * `avgServiceTimeMinutes` to 8). Preserves the legacy Tier 1 guard value.
 */
const SERVICE_CONFIG_FALLBACK_MINUTES = 8;

// ─── Bounded historical context cache ──────────────────────────────────────────

/** @type {Map<string, { expiresAt: number, value: object }>} */
const contextCache = new Map();

function _cacheKey(centerId, serviceId) {
  return `${String(centerId)}:${String(serviceId)}`;
}

function _readCache(key) {
  const hit = contextCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    contextCache.delete(key);
    return null;
  }
  // Refresh insertion order so the oldest key is the first eviction candidate.
  contextCache.delete(key);
  contextCache.set(key, hit);
  return hit.value;
}

function _writeCache(key, value) {
  if (CONTEXT_CACHE_TTL_MS === 0) return;
  if (contextCache.size >= CONTEXT_CACHE_MAX_ENTRIES) {
    const oldest = contextCache.keys().next();
    if (!oldest.done) contextCache.delete(oldest.value);
  }
  contextCache.set(key, { expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS, value });
}

/**
 * Drop the memoised historical context for one service queue.
 * Called by queueService on every mutation that can change the estimate.
 *
 * @param {string|object} centerId
 * @param {string|object} serviceId
 */
function invalidateServiceContext(centerId, serviceId) {
  if (centerId === undefined || centerId === null) return;
  if (serviceId === undefined || serviceId === null) {
    for (const key of contextCache.keys()) {
      if (key.startsWith(`${String(centerId)}:`)) contextCache.delete(key);
    }
    return;
  }
  contextCache.delete(_cacheKey(centerId, serviceId));
}

/** Drop every memoised historical context (centre-wide invalidation). */
function invalidateAllServiceContext() {
  contextCache.clear();
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

const MONGO_ID_REGEX = /^[a-fA-F0-9]{24}$/;

function _toObjectId(value) {
  if (value && typeof value === 'object' && value._id) value = value._id;
  if (value && typeof value === 'object' && value.$oid) return new mongoose.Types.ObjectId(value.$oid);
  const str = value === undefined || value === null ? '' : String(value).trim();
  if (!MONGO_ID_REGEX.test(str)) return null;
  return new mongoose.Types.ObjectId(str);
}

function _finitePositive(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

/**
 * Time-of-day context: real conditional mean for the current clock hour.
 *
 * Buckets completions by the SERVER-LOCAL clock hour. MongoDB's bare `$hour`
 * always truncates in UTC, which would compare a local hour label against a UTC
 * label and silently produce an empty bucket on any non-UTC deployment, so the
 * timezone is passed explicitly. If the server's timezone is not available in
 * the database's tz database, the query degrades to a documented UTC bucket
 * rather than failing the whole estimate.
 *
 * @returns {Promise<{ rows: Array, basis: 'SERVER_LOCAL'|'UTC' }>}
 */
async function _aggregateHourOfDay(dailyMatch, now) {
  const { Token } = require('../models/Token');
  try {
    const rows = await Token.aggregate([
      { $match: dailyMatch },
      {
        $group: {
          _id: {
            $dateToString: { format: '%H', date: '$completedAt', timezone: SERVER_TIMEZONE },
          },
          count: { $sum: 1 },
          mean: { $avg: '$actualServiceSeconds' },
        },
      },
      { $match: { _id: _hourLabel(now.getHours()) } },
    ]).limit(1);
    return { rows, basis: 'SERVER_LOCAL' };
  } catch (err) {
    logger.warn('[WaitTime] Local hour bucket unavailable, degrading to UTC', {
      error: err.message,
      timezone: SERVER_TIMEZONE,
      service: 'waitTime',
    });
    const rows = await Token.aggregate([
      { $match: dailyMatch },
      {
        $group: {
          _id: { $hour: '$completedAt' },
          count: { $sum: 1 },
          mean: { $avg: '$actualServiceSeconds' },
        },
      },
      { $match: { _id: now.getUTCHours() } },
    ]).limit(1);
    return { rows, basis: 'UTC' };
  }
}

/**
 * One bounded aggregation over real completed Token records.
 * Never returns a fabricated value: an empty window yields nulls and zero counts.
 */
async function _aggregateServiceHistory({ centerIdOid, serviceIdOid, since, now }) {
  const { Token } = require('../models/Token');

  const baseMatch = {
    centerId: centerIdOid,
    serviceId: serviceIdOid,
    status: 'COMPLETED',
    completedAt: { $gte: since, $lte: now },
    actualServiceSeconds: { $gt: 0 },
  };

  const dailyMatch = {
    ...baseMatch,
    completedAt: {
      $gte: new Date(now.getTime() - DAILY_WINDOW_DAYS * 86400000),
      $lte: now,
    },
  };

  const [recentRows, dailyRows, hourOfDay] = await Promise.all([
    Token.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          mean: { $avg: '$actualServiceSeconds' },
          min: { $min: '$actualServiceSeconds' },
          max: { $max: '$actualServiceSeconds' },
        },
      },
    ]).limit(1),

    Token.aggregate([
      { $match: dailyMatch },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          mean: { $avg: '$actualServiceSeconds' },
        },
      },
    ]).limit(1),

    // Time-of-day context: real conditional mean for the current clock hour.
    _aggregateHourOfDay(dailyMatch, now),
  ]);

  const recent = recentRows[0] || null;
  const daily = dailyRows[0] || null;
  const hour = (hourOfDay.rows && hourOfDay.rows[0]) || null;

  const recentWindowSeconds = RECENT_WINDOW_MINUTES * 60;
  const recentThroughputPerHour =
    recent && recent.count > 0
      ? Math.round(((recent.count / recentWindowSeconds) * 3600) * 100) / 100
      : 0;

  // Abandonment over the daily window (real SKIPPED/CANCELLED/EXPIRED share).
  const abandonRows = await Token.aggregate([
    {
      $match: {
        centerId: centerIdOid,
        serviceId: serviceIdOid,
        createdAt: { $gte: new Date(now.getTime() - DAILY_WINDOW_DAYS * 86400000), $lte: now },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        abandoned: {
          $sum: { $cond: [{ $in: ['$status', ['SKIPPED', 'CANCELLED', 'EXPIRED']] }, 1, 0] },
        },
      },
    },
  ]).limit(1);

  const abandon = abandonRows[0] || null;
  const abandonRate =
    abandon && abandon.total > 0 ? Math.round((abandon.abandoned / abandon.total) * 1000) / 10 : 0;

  return {
    recentCount: recent ? recent.count : 0,
    recentMeanSeconds: recent ? Math.round(recent.mean) : null,
    recentMinSeconds: recent ? Math.round(recent.min) : null,
    recentMaxSeconds: recent ? Math.round(recent.max) : null,
    recentThroughputPerHour,

    dailyCount: daily ? daily.count : 0,
    dailyMeanSeconds: daily ? Math.round(daily.mean) : null,

    hourOfDay: now.getHours(),
    hourOfDayTimezone: SERVER_TIMEZONE,
    hourOfDayBasis: hourOfDay.basis,
    hourOfDayCount: hour ? hour.count : 0,
    hourOfDayMeanSeconds: hour ? Math.round(hour.mean) : null,

    abandonRate,
    observedTokensInDailyWindow: abandon ? abandon.total : 0,
  };
}

/**
 * Resolve the effective service time using the documented strict precedence.
 * Every branch traces back to a real persisted value or real observed records.
 *
 * @returns {{ seconds: number, source: string, sampleCount: number }}
 */
function _resolveEffectiveServiceSeconds(history, { queue, service }) {
  if (history) {
    if (history.hourOfDayCount >= MIN_SAMPLES && _finitePositive(history.hourOfDayMeanSeconds)) {
      return {
        seconds: history.hourOfDayMeanSeconds,
        source: 'RECENT_HOUR',
        sampleCount: history.hourOfDayCount,
      };
    }
    if (history.recentCount >= MIN_SAMPLES && _finitePositive(history.recentMeanSeconds)) {
      return {
        seconds: history.recentMeanSeconds,
        source: 'RECENT_WINDOW',
        sampleCount: history.recentCount,
      };
    }
    if (history.dailyCount >= 1 && _finitePositive(history.dailyMeanSeconds)) {
      return {
        seconds: history.dailyMeanSeconds,
        source: 'DAILY_WINDOW',
        sampleCount: history.dailyCount,
      };
    }
  }

  const queueAvg = _finitePositive(queue && queue.avgServiceTimeSeconds);
  if (queueAvg !== null) {
    return { seconds: queueAvg, source: 'QUEUE_RUNNING_AVERAGE', sampleCount: 0 };
  }

  const serviceAvg = _finitePositive(service && service.avgServiceTimeMinutes);
  if (serviceAvg !== null) {
    return {
      seconds: Math.round(serviceAvg * 60),
      source: 'SERVICE_CONFIG',
      sampleCount: 0,
    };
  }

  return {
    seconds: SERVICE_CONFIG_FALLBACK_MINUTES * 60,
    source: 'SERVICE_CONFIG_FALLBACK',
    sampleCount: 0,
  };
}

/**
 * Read REAL live counter state for a service and convert it into available
 * capacity expressed in whole service slots.
 *
 * @returns {Promise<{ activeCounters, idleCounters, busyCounters, freeCapacity,
 *                     residualSeconds, counters: Array<{ counterId, status, busy, elapsedSeconds, residualSeconds }> }>}
 */
async function _resolveCapacity({ centerIdOid, serviceIdOid, effectiveServiceSeconds, now }) {
  const Counter = require('../models/Counter');

  const counters = await Counter.find({
    centerId: centerIdOid,
    serviceId: serviceIdOid,
    status: 'ACTIVE',
  })
    .select('_id status currentTokenId servingStartedAt')
    .lean();

  let residualSeconds = 0;
  let idleCounters = 0;
  let busyCounters = 0;

  const detail = counters.map((counter) => {
    const busy = Boolean(counter.servingStartedAt) && Boolean(counter.currentTokenId);
    let elapsedSeconds = 0;
    let residual = effectiveServiceSeconds;

    if (busy) {
      busyCounters += 1;
      const startedAt = new Date(counter.servingStartedAt).getTime();
      const raw = Number.isFinite(startedAt) ? Math.round((now.getTime() - startedAt) / 1000) : 0;
      elapsedSeconds = Math.max(0, raw);
      residual = Math.max(0, effectiveServiceSeconds - elapsedSeconds);
    } else {
      idleCounters += 1;
    }

    residualSeconds += residual;
    return {
      counterId: counter._id ? counter._id.toString() : null,
      busy,
      elapsedSeconds,
      residualSeconds: Math.round(residual),
    };
  });

  const activeCounters = counters.length;
  const freeCapacity =
    effectiveServiceSeconds > 0 ? residualSeconds / effectiveServiceSeconds : 0;

  return {
    activeCounters,
    idleCounters,
    busyCounters,
    freeCapacity,
    residualSeconds: Math.round(residualSeconds),
    counters: detail,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the bounded, real historical context for a service queue.
 * Memoised with a short TTL and invalidated on every queue mutation.
 *
 * @param {object} params
 * @param {string} params.centerId
 * @param {string} params.serviceId
 * @param {Date}   [params.now]
 * @param {boolean}[params.bypassCache]
 * @returns {Promise<object|null>} null when the identifiers are unusable.
 */
async function getServiceContext({ centerId, serviceId, now = new Date(), bypassCache = false }) {
  const centerIdOid = _toObjectId(centerId);
  const serviceIdOid = _toObjectId(serviceId);
  if (!centerIdOid || !serviceIdOid) return null;

  const key = _cacheKey(centerIdOid.toString(), serviceIdOid.toString());
  if (!bypassCache) {
    const cached = _readCache(key);
    if (cached) return cached;
  }

  const history = await _aggregateServiceHistory({
    centerIdOid,
    serviceIdOid,
    since: new Date(now.getTime() - RECENT_WINDOW_MINUTES * 60000),
    now,
  });

  const ServiceCenter = require('../models/ServiceCenter');
  const center = await ServiceCenter.findById(centerIdOid)
    .select('isOpen capacity currentCrowd noShowTimeoutSeconds')
    .lean();

  const context = {
    history,
    center: center
      ? {
          isOpen: center.isOpen,
          capacity: center.capacity,
          currentCrowd: center.currentCrowd,
          noShowTimeoutSeconds: center.noShowTimeoutSeconds,
          crowdLoadPercent:
            center.capacity > 0
              ? Math.round((center.currentCrowd / center.capacity) * 1000) / 10
              : 0,
        }
      : null,
    contextWindow: {
      recentWindowMinutes: RECENT_WINDOW_MINUTES,
      dailyWindowDays: DAILY_WINDOW_DAYS,
      minSamples: MIN_SAMPLES,
    },
  };

  _writeCache(key, context);
  return context;
}

/**
 * Context-aware EWT for a service queue.
 *
 * The backend is the sole authority: this is the only function that produces an
 * EWT for live queue conditions. Customer output is a single integer number of
 * minutes; the returned `context` is for admin/debug consumers only.
 *
 * @param {object} params
 * @param {string} params.centerId
 * @param {string} params.serviceId
 * @param {object} [params.queue]   Queue document (for Queue.avgServiceTimeSeconds)
 * @param {object} [params.service] Service document (for Service.avgServiceTimeMinutes)
 * @param {number} [params.queueDepth] People the estimate covers. Callers pass
 *        the same depth semantics the Tier 1 baseline used at that call site.
 * @param {Date}   [params.now]
 * @param {boolean}[params.bypassCache]
 * @returns {Promise<{ minutes: number, context: object }>}
 */
async function estimateContextAwareWait({
  centerId,
  serviceId,
  queue = null,
  service = null,
  queueDepth = 0,
  now = new Date(),
  bypassCache = false,
}) {
  const centerIdOid = _toObjectId(centerId);
  const serviceIdOid = _toObjectId(serviceId);

  const depth = Number.isFinite(Number(queueDepth)) ? Math.max(0, Math.floor(Number(queueDepth))) : 0;

  // Unusable identifiers: fall back to the pure Tier 1 maths rather than guess.
  if (!centerIdOid || !serviceIdOid) {
    const minutes = calculateEstimatedWaitTime({
      queueDepth: depth,
      avgServiceTimeMinutes:
        (service && service.avgServiceTimeMinutes) || SERVICE_CONFIG_FALLBACK_MINUTES,
      activeCounters: queue && Number.isFinite(Number(queue.activeCount)) ? queue.activeCount : 1,
    });
    return {
      minutes,
      context: {
        estimationMethod: 'TIER1_FALLBACK',
        fallbackUsed: true,
        fallbackReason: 'INVALID_IDENTIFIERS',
        queueDepth: depth,
        activeCounters: null,
        idleCounters: null,
        busyCounters: null,
        freeCapacity: null,
        residualSeconds: null,
        effectiveServiceSeconds: null,
        serviceAverageSeconds: null,
        serviceAverageSource: null,
        recentThroughputPerHour: null,
        abandonRate: null,
        crowdLoadPercent: null,
        degradedCapacity: false,
        contextWindow: null,
        computedAt: now.toISOString(),
      },
    };
  }

  const context = await getServiceContext({
    centerId: centerIdOid,
    serviceId: serviceIdOid,
    now,
    bypassCache,
  });

  const effective = _resolveEffectiveServiceSeconds(context ? context.history : null, {
    queue,
    service,
  });

  const capacity = await _resolveCapacity({
    centerIdOid,
    serviceIdOid,
    effectiveServiceSeconds: effective.seconds,
    now,
  });

  const history = (context && context.history) || null;
  const centerInfo = (context && context.center) || null;

  let estimatedSeconds;
  let method = 'CONTEXT_AWARE';
  let degradedCapacity = false;
  let reason = null;

  if (depth === 0) {
    estimatedSeconds = 0;
    method = 'CONTEXT_AWARE';
  } else if (capacity.activeCounters === 0) {
    // No counter is serving this service: nothing will free up in parallel.
    estimatedSeconds = depth * effective.seconds;
    degradedCapacity = true;
    reason = 'NO_ACTIVE_COUNTERS';
  } else if (!(capacity.freeCapacity > 0)) {
    // Every counter is at or beyond its expected service duration.
    estimatedSeconds = depth * effective.seconds;
    degradedCapacity = true;
    reason = 'NO_AVAILABLE_CAPACITY';
  } else {
    estimatedSeconds = (depth * effective.seconds) / capacity.freeCapacity;
  }

  if (estimatedSeconds < 0 || !Number.isFinite(estimatedSeconds)) {
    // Deterministic guard: never emit NaN / Infinity / negative to a client.
    estimatedSeconds = depth * effective.seconds;
    degradedCapacity = true;
    reason = reason || 'NON_FINITE_GUARD';
  }

  // Math.round matches the pre-existing production call sites (see ROUNDING note).
  const rawMinutes = Math.round(estimatedSeconds / 60);
  const minutes = depth === 0 ? 0 : Math.max(1, Math.min(rawMinutes, 525600));

  return {
    minutes,
    context: {
      estimationMethod: method,
      fallbackUsed: degradedCapacity,
      fallbackReason: reason,
      queueDepth: depth,
      activeCounters: capacity.activeCounters,
      idleCounters: capacity.idleCounters,
      busyCounters: capacity.busyCounters,
      freeCapacity: Math.round(capacity.freeCapacity * 1000) / 1000,
      residualSeconds: capacity.residualSeconds,
      effectiveServiceSeconds: effective.seconds,
      serviceAverageSeconds: effective.seconds,
      serviceAverageSource: effective.source,
      serviceAverageSampleCount: effective.sampleCount,
      recentThroughputPerHour: history ? history.recentThroughputPerHour : 0,
      recentCompletedCount: history ? history.recentCount : 0,
      dailyCompletedCount: history ? history.dailyCount : 0,
      hourOfDay: now.getHours(),
      hourOfDayTimezone: SERVER_TIMEZONE,
      hourOfDayBasis: history ? history.hourOfDayBasis : null,
      hourOfDaySampleCount: history ? history.hourOfDayCount : 0,
      abandonRate: history ? history.abandonRate : 0,
      crowdLoadPercent: centerInfo ? centerInfo.crowdLoadPercent : null,
      centerIsOpen: centerInfo ? centerInfo.isOpen : null,
      noShowTimeoutSeconds: centerInfo ? centerInfo.noShowTimeoutSeconds : null,
      degradedCapacity,
      contextWindow: context ? context.contextWindow : null,
      counters: capacity.counters,
      computedAt: now.toISOString(),
    },
  };
}

/**
 * Estimate wait time for a new token joining the queue.
 * Existing Tier 1 entry point — preserved signature and semantics.
 *
 * Behaviour: the optional external AI service keeps priority when configured,
 * otherwise the deterministic context-aware engine answers. When the engine
 * itself cannot run, the Tier 1 formula is used.
 *
 * @param {object} params
 * @param {string} params.centerId
 * @param {string} params.serviceId
 * @param {object} params.queue   - Current Queue document
 * @param {object} params.service - Service document
 * @returns {Promise<number>} Estimated wait in minutes (minimum 1)
 */
async function estimateWait({ centerId, serviceId, queue, service }) {
  // Try AI service first if configured
  if (AI_SERVICE_URL) {
    try {
      const aiEstimate = await _callAIService({ centerId, serviceId, queue, service });
      if (aiEstimate !== null) return aiEstimate;
    } catch (err) {
      // AI service unavailable — fall through to the context-aware engine
      logger.warn('[WaitTime] AI service unavailable, using context-aware engine', {
        error: err.message,
        service: 'waitTime',
      });
    }
  }

  try {
    const { minutes } = await estimateContextAwareWait({
      centerId,
      serviceId,
      queue,
      service,
      // Tier 1 `estimateWait` counted WAITING + CALLED/SERVING as people ahead.
      queueDepth: ((queue && queue.waitingCount) || 0) + ((queue && queue.activeCount) || 0),
    });
    return minutes;
  } catch (err) {
    logger.warn('[WaitTime] Context-aware engine failed, using Tier 1 formula', {
      error: err.message,
      service: 'waitTime',
    });
    return _formulaEstimate({ queue, service });
  }
}

/**
 * Tier 1 pure formula — FROZEN. Unchanged so Tier 1 regression tests and any
 * existing consumer keep the exact documented behaviour:
 *   ceil((queueDepth * avgServiceTimeMinutes) / max(1, activeCounters))
 */
function calculateEstimatedWaitTime({
  queueDepth = 0,
  avgServiceTimeMinutes = SERVICE_CONFIG_FALLBACK_MINUTES,
  activeCounters = 1,
} = {}) {
  if (queueDepth <= 0) return 0;
  const counters = Math.max(1, activeCounters || 1);
  const avg = Math.max(1, avgServiceTimeMinutes || SERVICE_CONFIG_FALLBACK_MINUTES);
  return Math.ceil((queueDepth * avg) / counters);
}

/**
 * Legacy Tier 1 estimate used only as the last-resort guard inside `estimateWait`.
 * Kept verbatim so the degraded path matches the original implementation.
 */
function _formulaEstimate({ queue, service }) {
  // Number of people currently waiting (including active)
  const peopleAhead = (queue.waitingCount || 0) + (queue.activeCount || 0);

  // Average service time in minutes
  let avgMinutes;
  if (queue.avgServiceTimeSeconds) {
    avgMinutes = Math.ceil(queue.avgServiceTimeSeconds / 60);
  } else if (service && service.avgServiceTimeMinutes) {
    avgMinutes = service.avgServiceTimeMinutes;
  } else {
    avgMinutes = SERVICE_CONFIG_FALLBACK_MINUTES;
  }

  const estimate = Math.max(1, Math.round(peopleAhead * avgMinutes));
  return estimate;
}

/**
 * Call the Python FastAPI AI prediction service.
 * Returns null if the service is not available or returns an invalid response.
 */
async function _callAIService({ centerId, serviceId, queue, service }) {
  const response = await axios.post(
    `${AI_SERVICE_URL}/predict`,
    {
      center_id: centerId.toString(),
      service_id: serviceId.toString(),
      current_waiting: queue.waitingCount || 0,
      current_active: queue.activeCount || 0,
      avg_service_seconds:
        queue.avgServiceTimeSeconds || (service.avgServiceTimeMinutes * 60),
      hour_of_day: new Date().getHours(),
      day_of_week: new Date().getDay(),
    },
    { timeout: 3000 } // Don't block the user for more than 3s
  );

  if (response.data && typeof response.data.predicted_wait_minutes === 'number') {
    return Math.max(1, Math.round(response.data.predicted_wait_minutes));
  }

  return null;
}

module.exports = {
  estimateWait,
  estimateContextAwareWait,
  calculateEstimatedWaitTime,
  getServiceContext,
  invalidateServiceContext,
  invalidateAllServiceContext,
  // Exposed for tests / admin diagnostics
  CONFIG: {
    MIN_SAMPLES,
    RECENT_WINDOW_MINUTES,
    DAILY_WINDOW_DAYS,
    CONTEXT_CACHE_TTL_MS,
    CONTEXT_CACHE_MAX_ENTRIES,
    SERVICE_CONFIG_FALLBACK_MINUTES,
    SERVER_TIMEZONE,
  },
};

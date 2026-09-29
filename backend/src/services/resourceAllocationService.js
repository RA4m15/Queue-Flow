'use strict';

/**
 * QueueFlow — Centralized Resource Allocation Engine
 *
 * Server-authoritative distribution of ONE waiting queue across MULTIPLE
 * service counters. Customers never pick a counter; the backend decides.
 *
 * Design rules enforced here:
 *
 * 1. One queue, many counters. Customers join a single service queue and the
 *    allocator decides which counter each customer goes to.
 * 2. Strict FIFO. The head of a service queue is always allocated before any
 *    later token, and geography never reorders a queue.
 * 3. Real eligibility. Only counters that are ACTIVE, have a live service
 *    assigned and are not already serving another customer are candidates.
 * 4. Deterministic counter choice: lowest workload first, then longest idle
 *    time, then lowest counter number. No round-robin, no "every 3rd customer".
 * 5. Single source of truth for the call. The allocator never calls a token
 *    itself; it delegates to `queueService.callNext`, which owns the Phase 2
 *    geofence rules, the atomic token claim and the customer notification.
 * 6. Concurrency safety. Allocation runs are serialized per center, the token
 *    claim is a single atomic MongoDB state transition, and the counter bind
 *    is a compare-and-swap. Two counters going free at the same moment can
 *    never take the same customer.
 */

const Counter = require('../models/Counter');
const ServiceCenter = require('../models/ServiceCenter');
const { Token } = require('../models/Token');
const Queue = require('../models/Queue');
const workloadBalancerService = require('./workloadBalancerService');
const { emitToCenter } = require('../config/socket');
const { logger } = require('../utils/logger');
const { getTodayDateString } = require('../utils/tokenUtils');

// In-process allocation mutex per center. Serialises rapid concurrent triggers
// (token join + counter opened + service completed all firing at once) so the
// allocator does not repeatedly recompute the same decision. Correctness does
// NOT depend on this lock: the atomic claims below are what prevent double
// assignment. The lock only avoids wasted work and log noise.
const allocationLocks = new Map();

// Upper bound on allocation passes for one trigger. A pass that allocates
// nothing is terminal, so this is only a runaway guard, not a queue-depth cap.
const MAX_ALLOCATION_PASSES = 50;

/**
 * Whether centralized auto-allocation is switched on for a service center.
 *
 * Reads the persisted `autoResourceAllocation` flag written by the admin
 * settings API. No center is special-cased by id or code: the College Account
 * is enabled because an administrator enabled it, not because of a constant
 * in this file.
 *
 * @param {string|mongoose.Types.ObjectId} centerId
 * @returns {Promise<boolean>}
 */
async function isAutoAllocationEnabled(centerId) {
  if (!centerId) return false;
  const cId = centerId.toString();
  if (!/^[a-f\d]{24}$/i.test(cId)) return false;

  const center = await ServiceCenter.findById(cId)
    .select('autoResourceAllocation')
    .lean();

  if (!center) return false;
  return center.autoResourceAllocation === true;
}

/**
 * Counters at a center that are genuinely free to take a customer right now.
 *
 * A counter qualifies only when all of the following hold:
 *  - it belongs to this center;
 *  - its status is ACTIVE (not BREAK, not CLOSED);
 *  - a service is assigned and that service is still active;
 *  - no CALLED/SERVING token is bound to it in the database.
 *
 * The last condition is checked against Token documents rather than trusted
 * from the counter document alone, so a stale `currentTokenId` can never make
 * a busy counter look ready.
 *
 * @param {string|mongoose.Types.ObjectId} centerId
 * @returns {Promise<Array<object>>} ready counters with workload/idle metrics
 */
async function getReadyCounters(centerId) {
  const cId = centerId.toString();

  const activeCounters = await Counter.find({ centerId: cId, status: 'ACTIVE' })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes isActive')
    .populate('staffId', 'name email role')
    .lean();

  if (activeCounters.length === 0) return [];

  // One query for every busy counter instead of one per counter.
  const busyTokenDocs = await Token.find({
    counterId: { $in: activeCounters.map((c) => c._id) },
    status: { $in: ['CALLED', 'SERVING'] },
  })
    .select('_id counterId')
    .lean();

  const busyCounters = new Set(busyTokenDocs.map((t) => t.counterId.toString()));

  const readyCounters = [];

  for (const counter of activeCounters) {
    if (!counter.serviceId) continue;
    if (counter.serviceId.isActive === false) continue;
    if (busyCounters.has(counter._id.toString())) continue;

    let workloadScore = 0;
    let workloadLevel = 'LOW';
    try {
      const wl = await workloadBalancerService.calculateOperatorWorkload({
        counterId: counter._id,
        centerId: cId,
      });
      if (wl && typeof wl.workloadScore === 'number') {
        workloadScore = wl.workloadScore;
        workloadLevel = wl.loadLevel || 'LOW';
      }
    } catch (err) {
      logger.warn('[ResourceAllocation] workload lookup failed', {
        counterId: counter._id.toString(),
        error: err.message,
      });
    }

    // Idle time is measured from the last moment this counter did work.
    const lastActive =
      counter.servingStartedAt || counter.updatedAt || counter.createdAt || new Date(0);
    const lastActiveMs = new Date(lastActive).getTime();
    const idleSeconds = Math.max(0, Math.round((Date.now() - lastActiveMs) / 1000));

    readyCounters.push({
      ...counter,
      workloadScore,
      workloadLevel,
      idleSeconds,
      lastActiveTimestamp: lastActiveMs,
    });
  }

  return readyCounters;
}

/**
 * Deterministic counter preference: least loaded first, then the counter that
 * has been idle longest, then the lowest counter number. The final key makes
 * the choice stable across processes so the same state always yields the same
 * decision.
 *
 * @param {Array<object>} counters
 * @returns {Array<object>} a new, sorted array
 */
function sortCountersByPreference(counters) {
  return [...counters].sort((a, b) => {
    if (a.workloadScore !== b.workloadScore) return a.workloadScore - b.workloadScore;
    if (a.lastActiveTimestamp !== b.lastActiveTimestamp) {
      return a.lastActiveTimestamp - b.lastActiveTimestamp; // older = idle longer
    }
    const numberDelta = (a.number || 0) - (b.number || 0);
    if (numberDelta !== 0) return numberDelta;
    return a._id.toString().localeCompare(b._id.toString());
  });
}

/**
 * Run centralized resource allocation for a service center.
 *
 * Repeatedly offers every currently-free counter to the authoritative queue
 * dispatcher until nothing more can be allocated. Each dispatched customer is
 * recorded so callers can report exactly what the backend decided.
 *
 * Concurrent runs for the same center are serialized, and the underlying
 * claims are atomic, so two counters becoming free in the same instant receive
 * two different customers.
 *
 * @param {string|mongoose.Types.ObjectId} centerId
 * @returns {Promise<{ allocatedCount: number, allocations: Array<object>, reason?: string }>}
 */
async function allocateNextForCenter(centerId) {
  if (!centerId) return { allocatedCount: 0, allocations: [], reason: 'NO_CENTER_ID' };
  const cId = centerId.toString();

  const prevLock = allocationLocks.get(cId) || Promise.resolve();
  let releaseLock;
  const currentLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  allocationLocks.set(cId, currentLock);

  try {
    await prevLock;
    return await _executeAllocationLoop(cId);
  } finally {
    releaseLock();
    if (allocationLocks.get(cId) === currentLock) {
      allocationLocks.delete(cId);
    }
  }
}

/**
 * Core allocation loop.
 *
 * Deliberately thin: it decides WHICH free counter should be offered the next
 * customer, and then hands the actual call to `queueService.callNext`. FIFO
 * ordering, the Phase 2 geofence verdicts, the atomic token claim and the
 * customer notification all stay in that one authoritative code path, so
 * auto-allocation and a manual CALL NEXT can never disagree.
 */
async function _executeAllocationLoop(centerId) {
  const queueService = require('./queueService');

  const enabled = await isAutoAllocationEnabled(centerId);
  if (!enabled) {
    return { allocatedCount: 0, allocations: [], reason: 'AUTO_ALLOCATION_DISABLED' };
  }

  const center = await ServiceCenter.findById(centerId).select('_id').lean();
  if (!center) {
    return { allocatedCount: 0, allocations: [], reason: 'CENTER_NOT_FOUND' };
  }

  const allocations = [];
  let passes = 0;

  while (passes < MAX_ALLOCATION_PASSES) {
    passes += 1;

    const readyCounters = sortCountersByPreference(await getReadyCounters(centerId));
    if (readyCounters.length === 0) break;

    let allocatedThisPass = 0;

    for (const counter of readyCounters) {
      let result = null;
      try {
        result = await queueService.callNext({
          counterId: counter._id.toString(),
          centerId: centerId.toString(),
          // No operator is physically pressing the button, so no staff id is
          // recorded as `servedBy`. The counter's own assigned operator is used
          // for the audit trail instead, and stays null when unstaffed.
          adminId: counter.staffId?._id ? counter.staffId._id.toString() : null,
        });
      } catch (err) {
        // A counter can close or be re-pointed at another service between the
        // readiness check and the dispatch. That is a normal race, not a
        // reason to abandon the remaining counters.
        logger.warn('[ResourceAllocation] dispatch failed for counter', {
          centerId: centerId.toString(),
          counterId: counter._id.toString(),
          counterName: counter.name,
          error: err.message,
        });
        continue;
      }

      if (result && result.token) {
        allocatedThisPass += 1;
        allocations.push({
          tokenId: result.token._id,
          tokenCode: result.token.tokenCode,
          counterId: counter._id,
          counterName: counter.name,
          counterLabel: counter.displayLabel || counter.name,
          counterNumber: counter.number,
          serviceId: counter.serviceId?._id || counter.serviceId,
          calledAt: result.token.calledAt,
        });

        logger.info('[ResourceAllocation] allocated customer to counter', {
          centerId: centerId.toString(),
          tokenCode: result.token.tokenCode,
          counterId: counter._id.toString(),
          counterName: counter.name,
        });
      }
    }

    // A pass in which nothing was dispatched means the center is genuinely
    // saturated: no free counter can take anybody. Re-running would only
    // repeat the same decision.
    if (allocatedThisPass === 0) break;
  }

  // Push on EVERY trigger, not only when somebody was dispatched.
  //
  // The Admin allocation panel renders per-counter READY/BUSY state and the
  // live occupancy ratio. A trigger that dispatches nothing is exactly the
  // case where that state has changed (a service finished and the counter is
  // now idle, or a counter went on break) — suppressing the push there would
  // leave the panel showing a stale busy/ready split until the next reload.
  broadcastAllocationState(centerId);

  return {
    allocatedCount: allocations.length,
    allocations,
  };
}

/**
 * Fire-and-forget allocation trigger used by every event that can create
 * allocatable capacity or new demand: a customer joining, a counter opening,
 * a counter being (re)pointed at a service, a service completing, a customer
 * being skipped, a no-show expiring, and the admin toggle being switched on.
 *
 * Never rejects, so a background allocation can never fail a user request.
 *
 * @param {string|mongoose.Types.ObjectId} centerId
 */
function triggerAllocation(centerId) {
  if (!centerId) return;
  const cId = centerId.toString();
  setImmediate(async () => {
    try {
      await allocateNextForCenter(cId);
    } catch (err) {
      logger.warn('[ResourceAllocation] triggerAllocation error', {
        centerId: cId,
        error: err.message,
      });
    }
  });
}

/**
 * Authoritative allocation snapshot for one center.
 *
 * Every number here is read from persisted state. Nothing is estimated,
 * defaulted to a plausible constant, or filled in on the client. Where a
 * figure genuinely cannot be derived from available data the API returns the
 * string 'Unavailable' so the UI can say so instead of inventing a number.
 *
 * @param {string|mongoose.Types.ObjectId} centerId
 * @returns {Promise<object>}
 */
async function getResourceAllocationOverview(centerId) {
  const cId = centerId.toString();

  const center = await ServiceCenter.findById(cId)
    .select('name code capacity isOpen autoResourceAllocation currentCrowd crowdUpdatedAt')
    .lean();

  if (!center) {
    const err = new Error('Service center not found');
    err.status = 404;
    throw err;
  }

  const autoEnabled = center.autoResourceAllocation === true;

  const counters = await Counter.find({ centerId: cId })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes isActive')
    .populate('staffId', 'name email role')
    .sort({ number: 1 })
    .lean();

  // Current customer per counter, read from the Token documents themselves so
  // a counter that still points at a finished token is shown as free.
  const activeTokens = await Token.find({
    centerId: cId,
    status: { $in: ['CALLED', 'SERVING'] },
  })
    .select('_id tokenCode tokenNumber status counterId serviceId calledAt servingAt')
    .lean();

  const activeTokenByCounter = new Map();
  for (const t of activeTokens) {
    if (!t.counterId) continue;
    const key = t.counterId.toString();
    if (!activeTokenByCounter.has(key)) activeTokenByCounter.set(key, t);
  }

  const waitingTotal = await Token.countDocuments({ centerId: cId, status: 'WAITING' });

  const waitingPreview = await Token.find({ centerId: cId, status: 'WAITING' })
    .sort({ createdAt: 1 })
    .select('tokenCode tokenNumber currentPosition waitEstimateMinutes serviceId createdAt')
    .populate('serviceId', 'name tokenPrefix')
    .limit(15)
    .lean();

  const date = getTodayDateString();
  const queues = await Queue.find({ centerId: cId, date })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .lean();

  let activeCount = 0;
  let busyCount = 0;
  let readyCount = 0;
  let breakCount = 0;
  let closedCount = 0;

  const counterDetails = [];

  for (const c of counters) {
    const isActive = c.status === 'ACTIVE';
    if (isActive) activeCount += 1;
    if (c.status === 'BREAK') breakCount += 1;
    if (c.status === 'CLOSED') closedCount += 1;

    const activeTokenObj = activeTokenByCounter.get(c._id.toString()) || null;
    const isBusy = Boolean(activeTokenObj);
    const isReady = isActive && !isBusy && Boolean(c.serviceId) && c.serviceId?.isActive !== false;

    if (isBusy) busyCount += 1;
    if (isReady) readyCount += 1;

    let workloadScore = null;
    let workloadLevel = 'Unavailable';
    try {
      const wl = await workloadBalancerService.calculateOperatorWorkload({
        counterId: c._id,
        centerId: cId,
      });
      if (wl && typeof wl.workloadScore === 'number') {
        workloadScore = wl.workloadScore;
        workloadLevel = wl.loadLevel || 'LOW';
      }
    } catch (err) {
      logger.warn('[ResourceAllocation] overview workload lookup failed', {
        counterId: c._id.toString(),
        error: err.message,
      });
    }

    const lastActive = c.servingStartedAt || c.updatedAt || c.createdAt || null;
    const lastActiveMs = lastActive ? new Date(lastActive).getTime() : null;
    const idleSeconds =
      lastActiveMs === null ? null : Math.max(0, Math.round((Date.now() - lastActiveMs) / 1000));

    counterDetails.push({
      _id: c._id,
      name: c.name,
      number: c.number,
      displayLabel: c.displayLabel || c.name || `Counter ${c.number}`,
      status: c.status,
      isReady,
      isBusy,
      // "READY" / "BUSY" / "BREAK" / "CLOSED" / "UNASSIGNED" — the allocation
      // state a customer or operator actually cares about.
      allocationState: !isActive
        ? c.status
        : !c.serviceId
          ? 'UNASSIGNED'
          : c.serviceId?.isActive === false
            ? 'SERVICE_INACTIVE'
            : isBusy
              ? 'BUSY'
              : 'READY',
      currentToken: activeTokenObj
        ? {
            _id: activeTokenObj._id,
            tokenCode: activeTokenObj.tokenCode,
            tokenNumber: activeTokenObj.tokenNumber,
            status: activeTokenObj.status,
            calledAt: activeTokenObj.calledAt,
            servingAt: activeTokenObj.servingAt,
          }
        : null,
      service: c.serviceId
        ? {
            _id: c.serviceId._id,
            name: c.serviceId.name,
            tokenPrefix: c.serviceId.tokenPrefix,
            isActive: c.serviceId.isActive !== false,
          }
        : null,
      staff: c.staffId
        ? { _id: c.staffId._id, name: c.staffId.name, email: c.staffId.email }
        : null,
      workloadScore,
      workloadLevel,
      idleSeconds,
      idleMinutes: idleSeconds === null ? null : Math.round(idleSeconds / 60),
      lastActiveAt: lastActive,
    });
  }

  const servingCount = activeTokens.filter((t) => t.status === 'SERVING').length;
  const calledCount = activeTokens.filter((t) => t.status === 'CALLED').length;

  // Live occupancy is a real ratio of real counters, so it is always available.
  // Day-long "utilization" is not derivable from the persisted data (there is
  // no recorded open-hours total to divide by), so it is reported as
  // Unavailable rather than being reverse-engineered from a made-up target.
  const liveOccupancyPercent = activeCount > 0 ? Math.round((busyCount / activeCount) * 100) : null;

  return {
    center: {
      _id: center._id,
      name: center.name,
      code: center.code,
      isOpen: center.isOpen !== false,
    },
    autoResourceAllocation: autoEnabled,
    allocationStatus: autoEnabled ? 'ACTIVE' : 'INACTIVE',
    generatedAt: new Date(),
    metrics: {
      totalCounters: counters.length,
      activeCounters: activeCount,
      busyCounters: busyCount,
      readyCounters: readyCount,
      breakCounters: breakCount,
      closedCounters: closedCount,
      waitingCustomers: waitingTotal,
      currentlyServing: servingCount,
      calledTokens: calledCount,
      liveOccupancyPercent: liveOccupancyPercent === null ? 'Unavailable' : `${liveOccupancyPercent}%`,
      counterUtilization: 'Unavailable',
    },
    counters: counterDetails,
    waitingQueue: waitingPreview.map((t) => ({
      _id: t._id,
      tokenCode: t.tokenCode,
      tokenNumber: t.tokenNumber,
      position: t.currentPosition,
      waitEstimateMinutes: t.waitEstimateMinutes,
      serviceId: t.serviceId?._id || t.serviceId,
      serviceName: t.serviceId?.name || null,
      createdAt: t.createdAt,
    })),
    queues: queues.map((q) => ({
      serviceId: q.serviceId?._id || q.serviceId,
      serviceName: q.serviceId?.name || null,
      tokenPrefix: q.serviceId?.tokenPrefix || null,
      waitingCount: q.waitingCount,
      activeCount: q.activeCount,
      completedCount: q.completedCount,
      abandonedCount: q.abandonedCount,
      status: q.status,
    })),
  };
}

/**
 * Push the current allocation snapshot to the center Socket.IO room so the
 * Admin Panel and Live Counter update without a refresh.
 *
 * @param {string|mongoose.Types.ObjectId} centerId
 */
async function broadcastAllocationState(centerId) {
  try {
    const overview = await getResourceAllocationOverview(centerId);
    emitToCenter(centerId.toString(), 'resource.allocation.updated', overview);
  } catch (err) {
    logger.warn('[ResourceAllocation] broadcastAllocationState failed', {
      centerId: centerId.toString(),
      error: err.message,
    });
  }
}

module.exports = {
  isAutoAllocationEnabled,
  getReadyCounters,
  sortCountersByPreference,
  allocateNextForCenter,
  triggerAllocation,
  getResourceAllocationOverview,
  broadcastAllocationState,
  MAX_ALLOCATION_PASSES,
};

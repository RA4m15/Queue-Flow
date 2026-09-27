'use strict';

/**
 * QueueFlow — Tier 4 / Feature 5: Cognitive Load / Workload Balancer Service
 *
 * Implements a deterministic, server-authoritative operational workload evaluation
 * and balancing recommendation engine for queue operators and service counters.
 *
 * IMPORTANT:
 * - This service evaluates purely OPERATIONAL metrics (serving duration, queue depth,
 *   token throughput, continuous operating time, and relative load).
 * - It does NOT diagnose or infer medical fatigue, physiological states, mental health,
 *   or biometric exhaustion.
 * - All metrics originate from real MongoDB records (Counter, Token, Service, QueueEvent).
 */

const mongoose = require('mongoose');
const Counter = require('../models/Counter');
const { Token } = require('../models/Token');
const Service = require('../models/Service');
const Queue = require('../models/Queue');
const User = require('../models/User');
const QueueEvent = require('../models/QueueEvent');
const Notification = require('../models/Notification');
const { emitToCenter } = require('../config/socket');
const { logger } = require('../utils/logger');
const { getTodayDateString } = require('../utils/tokenUtils');

// Short transient cache to avoid N+1 aggregations during dashboard polling
const workloadCache = new Map();
const CACHE_TTL_MS = 15 * 1000; // 15 seconds

/**
 * Global algorithmic thresholds (clearly defined and configurable)
 */
const THRESHOLDS = {
  ACTIVE_SERVING_BASE: 30, // Base workload score if currently serving a customer
  RECENT_WINDOW_HOURS: 2, // Rolling window for recent completed tokens
  EXPECTED_HOURLY_TOKENS: 6, // Baseline expected customer throughput per hour per counter
  SUSTAINED_MINUTES_MODERATE: 90, // Minutes of continuous activity for moderate sustained score
  SUSTAINED_MINUTES_HIGH: 150, // Minutes of continuous activity for elevated sustained score
  LEVEL_LOW: 39,
  LEVEL_MODERATE: 69,
  LEVEL_HIGH: 84, // >= 85 is SUSTAINED_HIGH
};

// ─── Cache Helpers ────────────────────────────────────────────────────────────

function getCached(key) {
  const item = workloadCache.get(key);
  if (!item) return null;
  if (Date.now() - item.cachedAt > CACHE_TTL_MS) {
    workloadCache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data) {
  workloadCache.set(key, { data, cachedAt: Date.now() });
}

function invalidateCenterCache(centerId) {
  if (!centerId) return;
  const cId = centerId.toString();
  for (const [key] of workloadCache.entries()) {
    if (key.startsWith(`center:${cId}`)) {
      workloadCache.delete(key);
    }
  }
}

// ─── Operator Workload Evaluation ─────────────────────────────────────────────

/**
 * Calculate operational workload for a specific operator and/or counter.
 *
 * @param {object} params
 * @param {string} [params.operatorId] - Staff / User ObjectId
 * @param {string} [params.counterId]  - Counter ObjectId (if evaluating by counter)
 * @param {string} params.centerId     - ServiceCenter ObjectId
 * @returns {Promise<object>} Explainable workload object
 */
async function calculateOperatorWorkload({ operatorId = null, counterId = null, centerId }) {
  if (!centerId) {
    const err = new Error('centerId is required to evaluate workload');
    err.status = 400;
    throw err;
  }

  // 1. Identify Target Counter
  let counter = null;
  if (counterId) {
    counter = await Counter.findOne({ _id: counterId, centerId })
      .populate('serviceId')
      .populate('staffId', 'name email role');
  } else if (operatorId) {
    counter = await Counter.findOne({ staffId: operatorId, centerId })
      .populate('serviceId')
      .populate('staffId', 'name email role');
  }

  // If counter is not found or operator has no active counter assignment
  if (!counter) {
    return {
      workloadScore: null,
      loadLevel: 'UNKNOWN',
      dataSufficiency: 'INSUFFICIENT_DATA',
      explanation: 'Operator is not assigned to an active counter at this service center.',
      factors: null,
      calculatedAt: new Date(),
    };
  }

  const staff = counter.staffId || null;
  const targetOperatorId = operatorId || (staff ? staff._id : null);

  // 2. Data Sufficiency Check
  // Check if counter has never had any activity or is closed with zero stats
  const isCounterClosed = counter.status === 'CLOSED';
  const hasZeroStats = (!counter.stats || counter.stats.served === 0) && !counter.currentTokenId;
  const isStale = counter.updatedAt && (Date.now() - new Date(counter.updatedAt).getTime()) > 24 * 60 * 60 * 1000;

  if (isStale) {
    return {
      workloadScore: 0,
      loadLevel: 'LOW',
      dataSufficiency: 'STALE_DATA',
      explanation: 'Counter operational data is stale (no recent updates in over 24 hours).',
      factors: null,
      calculatedAt: new Date(),
    };
  }

  if (isCounterClosed && hasZeroStats) {
    return {
      workloadScore: 0,
      loadLevel: 'LOW',
      dataSufficiency: 'INSUFFICIENT_DATA',
      explanation: 'Counter is closed and has zero operating history today.',
      factors: null,
      calculatedAt: new Date(),
    };
  }

  // If counter is currently paused on break
  if (counter.status === 'BREAK') {
    return {
      workloadScore: 15,
      loadLevel: 'LOW',
      dataSufficiency: 'AVAILABLE',
      explanation: 'Operator is currently on a scheduled operational break.',
      factors: {
        activeServiceLoad: { score: 0, status: 'BREAK', elapsedSeconds: 0 },
        recentVolume: { score: 10, completedCount: counter.stats?.served || 0 },
        recentServiceDuration: { score: 20 },
        queuePressure: { score: 0 },
        sustainedWorkload: { score: 0, continuousMinutes: 0 },
        relativeWorkload: { score: 10 },
      },
      calculatedAt: new Date(),
    };
  }

  // ── Signal 1: Active Service Load ──
  let activeScore = 0;
  let activeTokenData = null;
  if (counter.currentTokenId) {
    const activeToken = await Token.findById(counter.currentTokenId).lean();
    if (activeToken && ['CALLED', 'SERVING'].includes(activeToken.status)) {
      const startTime = activeToken.servingAt || activeToken.calledAt || counter.servingStartedAt || counter.updatedAt;
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(startTime).getTime()) / 1000));
      const baselineSeconds = (counter.serviceId?.avgServiceTimeMinutes || 10) * 60;
      
      const durationRatio = elapsedSeconds / baselineSeconds;
      activeScore = Math.min(100, Math.round(THRESHOLDS.ACTIVE_SERVING_BASE + Math.min(70, durationRatio * 45)));
      
      activeTokenData = {
        score: activeScore,
        tokenId: activeToken._id,
        tokenCode: activeToken.tokenCode,
        status: activeToken.status,
        elapsedSeconds,
        expectedSeconds: baselineSeconds,
      };
    }
  }

  if (!activeTokenData) {
    activeTokenData = { score: 0, tokenId: null, status: 'IDLE', elapsedSeconds: 0 };
  }

  // ── Signal 2: Recent Service Volume ──
  const windowStart = new Date(Date.now() - THRESHOLDS.RECENT_WINDOW_HOURS * 60 * 60 * 1000);
  let completedRecent = 0;
  if (targetOperatorId) {
    completedRecent = await Token.countDocuments({
      centerId,
      servedBy: targetOperatorId,
      status: 'COMPLETED',
      completedAt: { $gte: windowStart },
    });
  } else {
    completedRecent = await Token.countDocuments({
      centerId,
      counterId: counter._id,
      status: 'COMPLETED',
      completedAt: { $gte: windowStart },
    });
  }

  const expectedVolume = THRESHOLDS.EXPECTED_HOURLY_TOKENS * THRESHOLDS.RECENT_WINDOW_HOURS; // e.g. 12 tokens
  const volumeScore = Math.min(100, Math.round((completedRecent / expectedVolume) * 75));
  const recentVolumeData = {
    score: volumeScore,
    completedCount: completedRecent,
    todayTotal: counter.stats?.served || 0,
    windowHours: THRESHOLDS.RECENT_WINDOW_HOURS,
  };

  // ── Signal 3: Recent Service Duration Complexity ──
  const recentTokens = await Token.find({
    centerId,
    $or: [
      ...(targetOperatorId ? [{ servedBy: targetOperatorId }] : []),
      { counterId: counter._id },
    ],
    status: 'COMPLETED',
  })
    .sort({ completedAt: -1 })
    .limit(5)
    .select('actualServiceSeconds')
    .lean();

  let avgActualSeconds = null;
  let durationScore = 40; // neutral default
  if (recentTokens.length > 0) {
    const validDurations = recentTokens.map((t) => t.actualServiceSeconds).filter((s) => typeof s === 'number' && s > 0);
    if (validDurations.length > 0) {
      avgActualSeconds = Math.round(validDurations.reduce((a, b) => a + b, 0) / validDurations.length);
      const baselineSeconds = (counter.serviceId?.avgServiceTimeMinutes || 10) * 60;
      const ratio = avgActualSeconds / baselineSeconds;
      durationScore = Math.min(100, Math.max(10, Math.round(ratio * 55)));
    }
  }

  const recentDurationData = {
    score: durationScore,
    avgActualSeconds,
    baselineSeconds: (counter.serviceId?.avgServiceTimeMinutes || 10) * 60,
  };

  // ── Signal 4: Queue Pressure ──
  let waitingCount = 0;
  let activeCountersForService = 1;
  if (counter.serviceId) {
    const serviceId = counter.serviceId._id || counter.serviceId;
    waitingCount = await Token.countDocuments({
      centerId,
      serviceId,
      status: 'WAITING',
    });

    activeCountersForService = await Counter.countDocuments({
      centerId,
      serviceId,
      status: 'ACTIVE',
    }) || 1;
  }

  const queuePerCounter = waitingCount / activeCountersForService;
  // 10 waiting per active counter = high pressure (80)
  const pressureScore = Math.min(100, Math.round((queuePerCounter / 10) * 80));
  const queuePressureData = {
    score: pressureScore,
    waitingCount,
    activeCountersForService,
    queuePerCounter: Math.round(queuePerCounter * 10) / 10,
  };

  // ── Signal 5: Sustained Workload ──
  // Check continuous activity from last counter resumption or opening
  let continuousMinutes = 0;
  const lastStateEvent = await QueueEvent.findOne({
    centerId,
    counterId: counter._id,
    eventType: { $in: ['COUNTER_OPENED', 'COUNTER_RESUMED', 'COUNTER_BREAK', 'COUNTER_CLOSED'] },
  }).sort({ createdAt: -1 }).lean();

  if (lastStateEvent && ['COUNTER_OPENED', 'COUNTER_RESUMED'].includes(lastStateEvent.eventType)) {
    continuousMinutes = Math.max(0, Math.round((Date.now() - new Date(lastStateEvent.createdAt).getTime()) / (60 * 1000)));
  } else if (counter.activeMinutesToday) {
    continuousMinutes = counter.activeMinutesToday;
  } else if (counter.servingStartedAt) {
    continuousMinutes = Math.max(0, Math.round((Date.now() - new Date(counter.servingStartedAt).getTime()) / (60 * 1000)));
  }

  const sustainedScore = Math.min(100, Math.round((continuousMinutes / THRESHOLDS.SUSTAINED_MINUTES_HIGH) * 85));
  const sustainedWorkloadData = {
    score: sustainedScore,
    continuousMinutes,
  };

  // ── Signal 6: Relative Workload ──
  // Pre-calculate base score to compare against center peers
  const baseComposite = Math.round(
    0.25 * activeScore +
    0.20 * volumeScore +
    0.15 * durationScore +
    0.20 * pressureScore +
    0.20 * sustainedScore
  );

  // Relative workload compared to other active counters
  const activeCounters = await Counter.find({
    centerId,
    status: 'ACTIVE',
    _id: { $ne: counter._id },
  }).select('stats.served').lean();

  let relativeScore = baseComposite;
  let peerAvgServed = null;
  if (activeCounters.length > 0) {
    const totalPeerServed = activeCounters.reduce((acc, c) => acc + (c.stats?.served || 0), 0);
    peerAvgServed = totalPeerServed / activeCounters.length;
    const myServed = counter.stats?.served || 0;
    if (peerAvgServed > 0) {
      const ratio = myServed / peerAvgServed;
      relativeScore = Math.min(100, Math.round(baseComposite * Math.min(1.5, Math.max(0.7, ratio))));
    }
  }

  const relativeWorkloadData = {
    score: relativeScore,
    peerAvgServed: peerAvgServed !== null ? Math.round(peerAvgServed * 10) / 10 : null,
    operatorServedToday: counter.stats?.served || 0,
  };

  // ── Total Transparent Composite Score ──
  const finalScore = Math.min(100, Math.max(0, Math.round(
    0.25 * activeScore +
    0.20 * volumeScore +
    0.15 * durationScore +
    0.20 * pressureScore +
    0.20 * sustainedScore
  )));

  // Determine Load Level
  let loadLevel = 'LOW';
  if (finalScore >= THRESHOLDS.LEVEL_HIGH || (finalScore >= 75 && continuousMinutes >= THRESHOLDS.SUSTAINED_MINUTES_HIGH)) {
    loadLevel = 'SUSTAINED_HIGH';
  } else if (finalScore >= 70) {
    loadLevel = 'HIGH';
  } else if (finalScore >= 40) {
    loadLevel = 'MODERATE';
  } else {
    loadLevel = 'LOW';
  }

  // Build Transparent Operational Explanation
  const explanationParts = [];
  if (activeTokenData.status !== 'IDLE') {
    explanationParts.push(`Currently serving customer for ${Math.round(activeTokenData.elapsedSeconds / 60)}m`);
  } else {
    explanationParts.push('Counter currently idle awaiting customer');
  }

  if (queuePressureData.waitingCount > 0) {
    explanationParts.push(`Queue pressure is ${queuePressureData.waitingCount} waiting for assigned service (${queuePressureData.queuePerCounter} per active counter)`);
  }

  if (continuousMinutes >= THRESHOLDS.SUSTAINED_MINUTES_MODERATE) {
    explanationParts.push(`Sustained active duty for ${continuousMinutes} continuous minutes`);
  }

  if (completedRecent > 0) {
    explanationParts.push(`${completedRecent} completed service deliveries in the last ${THRESHOLDS.RECENT_WINDOW_HOURS}h`);
  }

  const explanation = explanationParts.join('. ') + '.';

  const result = {
    workloadScore: finalScore,
    loadLevel,
    factors: {
      activeServiceLoad: activeTokenData,
      recentVolume: recentVolumeData,
      recentServiceDuration: recentDurationData,
      queuePressure: queuePressureData,
      sustainedWorkload: sustainedWorkloadData,
      relativeWorkload: relativeWorkloadData,
    },
    counter: {
      _id: counter._id,
      name: counter.name,
      number: counter.number,
      status: counter.status,
      serviceName: counter.serviceId?.name || null,
      serviceId: counter.serviceId?._id || null,
    },
    operator: staff
      ? { _id: staff._id, name: staff.name, email: staff.email, role: staff.role }
      : null,
    explanation,
    dataSufficiency: 'AVAILABLE',
    calculatedAt: new Date(),
  };

  return result;
}

// ─── Center-Level Workload Overview ───────────────────────────────────────────

/**
 * Get comprehensive operational workload overview for an entire service center.
 */
async function getCenterWorkloadOverview(centerId) {
  const cacheKey = `center:${centerId}:overview`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const counters = await Counter.find({ centerId })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .populate('staffId', 'name email role')
    .sort({ number: 1 })
    .lean();

  if (!counters || counters.length === 0) {
    const emptyResult = {
      centerId,
      averageWorkloadScore: 0,
      maxWorkloadScore: 0,
      activeOperatorsCount: 0,
      totalCountersCount: 0,
      distribution: { LOW: 0, MODERATE: 0, HIGH: 0, SUSTAINED_HIGH: 0 },
      overloadedUnits: [],
      availableCapacity: [],
      operatorWorkloads: [],
      dataSufficiency: 'INSUFFICIENT_DATA',
      calculatedAt: new Date(),
    };
    return emptyResult;
  }

  const operatorWorkloads = [];
  const distribution = { LOW: 0, MODERATE: 0, HIGH: 0, SUSTAINED_HIGH: 0 };
  const overloadedUnits = [];
  const availableCapacity = [];
  let totalScore = 0;
  let maxScore = 0;
  let activeCount = 0;

  for (const counter of counters) {
    const workload = await calculateOperatorWorkload({
      counterId: counter._id,
      operatorId: counter.staffId?._id,
      centerId,
    });

    operatorWorkloads.push(workload);

    if (counter.status === 'ACTIVE' && workload.dataSufficiency === 'AVAILABLE') {
      activeCount++;
      totalScore += workload.workloadScore || 0;
      if ((workload.workloadScore || 0) > maxScore) {
        maxScore = workload.workloadScore || 0;
      }

      if (distribution[workload.loadLevel] !== undefined) {
        distribution[workload.loadLevel]++;
      }

      if (['HIGH', 'SUSTAINED_HIGH'].includes(workload.loadLevel)) {
        overloadedUnits.push({
          counterId: counter._id,
          counterName: counter.name,
          operatorName: counter.staffId?.name || 'Unassigned',
          serviceName: counter.serviceId?.name || 'None',
          workloadScore: workload.workloadScore,
          loadLevel: workload.loadLevel,
          explanation: workload.explanation,
        });
      } else if (workload.loadLevel === 'LOW') {
        availableCapacity.push({
          counterId: counter._id,
          counterName: counter.name,
          operatorName: counter.staffId?.name || 'Unassigned',
          serviceName: counter.serviceId?.name || 'None',
          workloadScore: workload.workloadScore,
          loadLevel: workload.loadLevel,
        });
      }
    }
  }

  const averageWorkloadScore = activeCount > 0 ? Math.round(totalScore / activeCount) : 0;

  const result = {
    centerId,
    averageWorkloadScore,
    maxWorkloadScore: maxScore,
    activeOperatorsCount: activeCount,
    totalCountersCount: counters.length,
    distribution,
    overloadedUnits,
    availableCapacity,
    operatorWorkloads,
    dataSufficiency: activeCount > 0 ? 'AVAILABLE' : 'INSUFFICIENT_DATA',
    calculatedAt: new Date(),
  };

  setCache(cacheKey, result);
  return result;
}

// ─── Workload Balancing Recommendations Engine ───────────────────────────────

/**
 * Deterministically evaluate operational imbalance and generate transparent recommendations.
 */
async function getBalancingRecommendations(centerId) {
  const overview = await getCenterWorkloadOverview(centerId);
  const recommendations = [];

  const { overloadedUnits, availableCapacity, operatorWorkloads } = overview;

  // 1. Sustained High Workload Supervisor Alerts
  for (const op of operatorWorkloads) {
    if (op.loadLevel === 'SUSTAINED_HIGH') {
      recommendations.push({
        id: `rec_sustained_${op.counter?._id}_${Date.now()}`,
        type: 'SCHEDULE_ROTATION',
        priority: 'HIGH',
        counterId: op.counter?._id,
        counterName: op.counter?.name,
        operatorName: op.operator?.name || 'Operator',
        reason: `Operator on ${op.counter?.name} has reached sustained elevated workload (score: ${op.workloadScore}). Recommended to schedule an operational break or rotation after current customer completes.`,
        isAutomatic: false,
        createdAt: new Date(),
      });
    }
  }

  // 2. Queue Pressure Redistribution
  // Check if any service has high queue pressure while another compatible counter is idle
  const queues = await Queue.find({
    centerId,
    date: getTodayDateString(),
    waitingCount: { $gt: 5 },
  }).populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes').lean();

  for (const q of queues) {
    const serviceName = q.serviceId?.name || 'Service';
    // Find active counters handling this service
    const activeForService = operatorWorkloads.filter(
      (w) => w.counter?.serviceId?.toString() === q.serviceId?._id?.toString() && w.counter?.status === 'ACTIVE'
    );

    // If active counters on this service have high workload
    const isServiceStrained = activeForService.some((w) => ['HIGH', 'SUSTAINED_HIGH'].includes(w.loadLevel)) || activeForService.length === 0;

    if (isServiceStrained && availableCapacity.length > 0) {
      // Find candidate idle counter serving a different service with 0 waiting
      const idleCandidate = availableCapacity.find((cap) => {
        const capQueue = queues.find((otherQ) => otherQ.serviceId?._id?.toString() === cap.serviceId?.toString());
        return !capQueue; // 0 waiting for candidate's current service
      });

      if (idleCandidate) {
        recommendations.push({
          id: `rec_morph_${idleCandidate.counterId}_${q.serviceId?._id}`,
          type: 'MORPH_COUNTER',
          priority: 'MEDIUM',
          sourceCounterId: idleCandidate.counterId,
          sourceCounterName: idleCandidate.counterName,
          targetServiceId: q.serviceId?._id,
          targetServiceName: serviceName,
          reason: `High queue pressure on ${serviceName} (${q.waitingCount} waiting). Idle ${idleCandidate.counterName} (currently low load on ${idleCandidate.serviceName}) can be temporarily morphed to handle ${serviceName}.`,
          isAutomatic: false,
          createdAt: new Date(),
        });
      }
    }
  }

  // 3. Intra-Service Traffic Balancing
  // If Operator A on Counter 1 is overloaded but Operator B on Counter 2 (same service) has low workload
  const serviceGroups = new Map();
  operatorWorkloads.forEach((w) => {
    if (w.counter?.serviceId && w.counter?.status === 'ACTIVE') {
      const sId = w.counter.serviceId.toString();
      if (!serviceGroups.has(sId)) serviceGroups.set(sId, []);
      serviceGroups.get(sId).push(w);
    }
  });

  for (const [sId, units] of serviceGroups.entries()) {
    if (units.length >= 2) {
      const busyUnit = units.find((u) => ['HIGH', 'SUSTAINED_HIGH'].includes(u.loadLevel));
      const lightUnit = units.find((u) => u.loadLevel === 'LOW');

      if (busyUnit && lightUnit) {
        recommendations.push({
          id: `rec_redirect_${busyUnit.counter?._id}_to_${lightUnit.counter?._id}`,
          type: 'REDIRECT_TRAFFIC',
          priority: 'LOW',
          sourceCounterId: busyUnit.counter?._id,
          sourceCounterName: busyUnit.counter?.name,
          targetCounterId: lightUnit.counter?._id,
          targetCounterName: lightUnit.counter?.name,
          serviceId: sId,
          reason: `Workload imbalance detected for ${busyUnit.counter?.serviceName}: ${busyUnit.counter?.name} is experiencing elevated load (score ${busyUnit.workloadScore}) while ${lightUnit.counter?.name} is at low load (score ${lightUnit.workloadScore}). Recommended to route the next called customer to ${lightUnit.counter?.name}.`,
          isAutomatic: false,
          createdAt: new Date(),
        });
      }
    }
  }

  return {
    centerId,
    recommendationsCount: recommendations.length,
    recommendations,
    calculatedAt: new Date(),
  };
}

// ─── Real-Time Socket.IO & Notification Trigger ───────────────────────────────

/**
 * Broadcast sanitized operational workload updates to center supervisors.
 */
async function broadcastWorkloadUpdate(centerId) {
  if (!centerId) return;
  try {
    invalidateCenterCache(centerId);
    const overview = await getCenterWorkloadOverview(centerId);

    // Sanitize payload: strip any private operator emails or user fields for socket emission
    const sanitizedOverview = {
      centerId: overview.centerId,
      averageWorkloadScore: overview.averageWorkloadScore,
      maxWorkloadScore: overview.maxWorkloadScore,
      activeOperatorsCount: overview.activeOperatorsCount,
      distribution: overview.distribution,
      overloadedCount: overview.overloadedUnits.length,
      calculatedAt: overview.calculatedAt,
    };

    emitToCenter(centerId.toString(), 'workload.updated', sanitizedOverview);
  } catch (err) {
    logger.warn('Failed to broadcast workload update', { error: err.message, centerId });
  }
}

/**
 * Send an administrative notification if an operator sustains high workload.
 */
async function checkAndNotifySustainedWorkload(operatorId, centerId, workload) {
  if (!operatorId || !centerId || !workload || workload.loadLevel !== 'SUSTAINED_HIGH') {
    return;
  }

  try {
    // Dedupe key: one notification per operator per hour
    const dateHourKey = new Date().toISOString().slice(0, 13);
    const dedupeKey = `sustained_workload_${operatorId}_${dateHourKey}`;

    const existing = await Notification.findOne({ dedupeKey });
    if (existing) return; // Anti-spam deduplication

    // Notify center admin / staff
    const adminUsers = await User.find({ role: 'ADMIN' }).select('_id');
    for (const admin of adminUsers) {
      await Notification.create({
        userId: admin._id,
        centerId,
        type: 'OPERATOR_WORKLOAD_ALERT',
        title: 'Elevated Operator Workload Alert',
        body: `Operator on ${workload.counter?.name || 'Counter'} has sustained elevated operational load (Score: ${workload.workloadScore}). Consider scheduling a rotation or reallocating capacity.`,
        dedupeKey: `${dedupeKey}_admin_${admin._id}`,
        metadata: {
          operatorId,
          counterId: workload.counter?._id,
          workloadScore: workload.workloadScore,
          explanation: workload.explanation,
        },
      });
    }

    await QueueEvent.create({
      centerId,
      counterId: workload.counter?._id,
      eventType: 'WORKLOAD_ALERT_TRIGGERED',
      performedBy: operatorId,
      metadata: {
        workloadScore: workload.workloadScore,
        loadLevel: workload.loadLevel,
      },
    });
  } catch (err) {
    logger.warn('Failed to send sustained workload notification', { error: err.message });
  }
}

module.exports = {
  calculateOperatorWorkload,
  getCenterWorkloadOverview,
  getBalancingRecommendations,
  broadcastWorkloadUpdate,
  checkAndNotifySustainedWorkload,
  invalidateCenterCache,
  THRESHOLDS,
};

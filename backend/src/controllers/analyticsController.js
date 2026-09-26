'use strict';

const mongoose = require('mongoose');
const Queue = require('../models/Queue');
const Counter = require('../models/Counter');
const Service = require('../models/Service');
const QueueEvent = require('../models/QueueEvent');
const { Token } = require('../models/Token');
const FootfallEvent = require('../models/FootfallEvent');
const ServiceCenter = require('../models/ServiceCenter');
const recommendationService = require('../services/recommendationService');
const queueService = require('../services/queueService');
const waitTimeService = require('../services/waitTimeService');
const { mlPredictorService } = require('../services/mlPredictorService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendNotFound, sendBadRequest, sendForbidden } = require('../utils/apiResponse');
const { getTodayDateString } = require('../utils/tokenUtils');

/**
 * GET /api/analytics/:centerId
 * Main analytics endpoint for admin dashboard.
 * Returns all data needed for charts, stat pills, and recommendations.
 */
const getDashboard = asyncHandler(async (req, res) => {
  const { centerId } = req.params;
  const date = getTodayDateString();

  const [center, queues, counters, recommendations] = await Promise.all([
    ServiceCenter.findById(centerId).lean({ virtuals: true }),
    Queue.find({ centerId, date }).populate('serviceId', 'name tokenPrefix').lean(),
    Counter.find({ centerId })
      .populate('serviceId', 'name')
      .populate('currentTokenId', 'tokenCode status')
      .lean({ virtuals: true }),
    recommendationService.getRecommendations(centerId),
  ]);

  if (!center) return sendNotFound(res, 'Service center not found');

  // ── Stat pills ──────────────────────────────────────────────────────────────
  const totalWaiting = queues.reduce((s, q) => s + (q.waitingCount || 0), 0);
  const totalServed  = queues.reduce((s, q) => s + (q.completedCount || 0), 0);
  const totalIssued  = queues.reduce((s, q) => s + (q.totalIssued || 0), 0);
  const activeCounters  = counters.filter((c) => c.status === 'ACTIVE').length;
  const closedCounters  = counters.filter((c) => c.status === 'CLOSED').length;

  // Average wait time across queues with real data
  const queuesWithAvg = queues.filter((q) => q.avgServiceTimeSeconds);
  const avgWaitSeconds = queuesWithAvg.length > 0
    ? Math.round(queuesWithAvg.reduce((s, q) => s + q.avgServiceTimeSeconds, 0) / queuesWithAvg.length)
    : null;

  // ── Footfall chart — hourly buckets for today ───────────────────────────────
  const hourlyFootfall = await _getHourlyFootfall(centerId, date);

  // ── Service demand — completed tokens by service ────────────────────────────
  const serviceDemand = queues.map((q) => ({
    serviceId: q.serviceId?._id,
    name: q.serviceId?.name || 'Unknown',
    prefix: q.serviceId?.tokenPrefix || '?',
    completed: q.completedCount || 0,
    waiting: q.waitingCount || 0,
    total: q.totalIssued || 0,
  }));

  // ── Counter utilization ─────────────────────────────────────────────────────
  const counterUtil = counters.map((c) => ({
    counterId: c._id,
    name: c.name,
    number: c.number,
    status: c.status,
    served: c.stats?.served || 0,
    utilizationPercent: c.utilizationPercent ?? 0,
    avgServiceSeconds: c.stats?.avgServiceSeconds || null,
    currentToken: c.currentTokenId,
    service: c.serviceId,
  }));

  return sendSuccess(res, {
    data: {
      summary: {
        totalWaiting,
        totalServed,
        totalIssued,
        activeCounters,
        closedCounters,
        totalCounters: counters.length,
        currentCrowd: center.currentCrowd,
        crowdPercent: center.crowdPercent,
        crowdStatus: center.crowdStatus,
        avgWaitSeconds,
      },
      queues: queues.map((q) => ({
        queueId: q._id,
        service: q.serviceId,
        status: q.status,
        waitingCount: q.waitingCount,
        completedCount: q.completedCount,
        abandonedCount: q.abandonedCount,
        totalIssued: q.totalIssued,
        avgServiceTimeSeconds: q.avgServiceTimeSeconds,
      })),
      counters: counterUtil,
      hourlyFootfall,
      serviceDemand,
      recommendations,
    },
  });
});

/**
 * GET /api/analytics/:centerId/tokens
 * Time-series token data for charts (tokens per hour).
 */
const getTokenTimeSeries = asyncHandler(async (req, res) => {
  const { centerId } = req.params;
  const { hours = 8 } = req.query;

  const since = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);

  const tokens = await Token.find({
    centerId,
    createdAt: { $gte: since },
  })
    .select('createdAt status serviceId')
    .populate('serviceId', 'name')
    .lean();

  // Group by hour
  const byHour = {};
  for (const token of tokens) {
    const hour = new Date(token.createdAt).getHours();
    const key = `${hour}:00`;
    if (!byHour[key]) byHour[key] = { hour: key, created: 0, completed: 0, cancelled: 0 };
    byHour[key].created++;
    if (token.status === 'COMPLETED') byHour[key].completed++;
    if (['CANCELLED', 'SKIPPED', 'EXPIRED'].includes(token.status)) byHour[key].cancelled++;
  }

  const series = Object.values(byHour).sort((a, b) => a.hour.localeCompare(b.hour));

  return sendSuccess(res, { data: { series } });
});

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _getHourlyFootfall(centerId, _date) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const events = await FootfallEvent.find({
    centerId,
    createdAt: { $gte: startOfDay },
  })
    .sort({ createdAt: 1 })
    .lean();

  // Group by hour
  const byHour = {};
  for (const ev of events) {
    const hour = new Date(ev.createdAt).getHours();
    if (!byHour[hour]) byHour[hour] = { hour, entries: 0, exits: 0, peakCount: 0 };
    if (ev.type === 'ENTRY') byHour[hour].entries++;
    if (ev.type === 'EXIT') byHour[hour].exits++;
    byHour[hour].peakCount = Math.max(byHour[hour].peakCount, ev.countAfter || 0);
  }

  return Object.entries(byHour)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([hour, data]) => ({
      hour: `${String(hour).padStart(2, '0')}:00`,
      entries: data.entries,
      exits: data.exits,
      peakCount: data.peakCount,
    }));
}

/**
 * GET /api/analytics/:centerId/operational-overview
 * Centralized Resource Hub live operational overview for a service center. Admin only.
 */
const getOperationalOverview = asyncHandler(async (req, res) => {
  const { centerId } = req.params;

  if (req.user.centerId && req.user.centerId.toString() !== centerId) {
    return sendForbidden(res, 'You are not authorized to access operational overview for this center');
  }

  const center = await ServiceCenter.findById(centerId).lean({ virtuals: true });
  if (!center) return sendNotFound(res, 'Service center not found');

  const [counters, services, recentEvents] = await Promise.all([
    Counter.find({ centerId })
      .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
      .populate('staffId', 'name email role')
      .populate('currentTokenId', 'tokenCode tokenNumber status calledAt servingAt')
      .sort({ number: 1 })
      .lean({ virtuals: true }),
    Service.find({ centerId, isActive: true })
      .sort({ order: 1, name: 1 })
      .lean(),
    QueueEvent.find({ centerId })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('performedBy', 'name role')
      .lean(),
  ]);

  // Aggregate live queues across active services.
  // Tier 3 / Feature 1: `queueService.getQueueStatus(centerId)` returns the
  // array of live queues for the whole center (it does not take a serviceId).
  // The per-service view below therefore joins that real array by serviceId and
  // reads the server-authoritative context-aware EWT from it. No new analytics
  // engine is created here and no value is computed in this controller.
  const centerQueues = await queueService.getQueueStatus(centerId);
  const queueByServiceId = new Map(
    centerQueues
      .filter((q) => q.service && q.service._id)
      .map((q) => [q.service._id.toString(), q])
  );

  const queuesStatus = services.map((svc) => {
    const q = queueByServiceId.get(svc._id.toString());
    return {
      serviceId: svc._id,
      name: svc.name,
      tokenPrefix: svc.tokenPrefix,
      waitingCount: q ? q.waitingCount || 0 : 0,
      servingCount: q ? q.activeCount || 0 : 0,
      completedCount: q ? q.completedCount || 0 : 0,
      estimatedWaitMinutes: q ? q.estimatedWaitMinutes || 0 : 0,
      activeCounters: q ? q.counters.filter((c) => c.status === 'ACTIVE').length : 0,
    };
  });

  // Operational metrics
  const totalCounters = counters.length;
  const activeCounters = counters.filter((c) => c.status === 'ACTIVE').length;
  const idleCounters = counters.filter((c) => c.status === 'ACTIVE' && !c.currentTokenId).length;
  const servingCounters = counters.filter(
    (c) => c.status === 'ACTIVE' && c.currentTokenId && c.currentTokenId.status === 'SERVING'
  ).length;
  const calledCounters = counters.filter(
    (c) => c.status === 'ACTIVE' && c.currentTokenId && c.currentTokenId.status === 'CALLED'
  ).length;
  const breakCounters = counters.filter((c) => c.status === 'BREAK').length;
  const closedCounters = counters.filter((c) => c.status === 'CLOSED').length;

  const totalWaiting = queuesStatus.reduce((acc, q) => acc + q.waitingCount, 0);
  const totalServing = queuesStatus.reduce((acc, q) => acc + q.servingCount, 0);
  const queuesWithWait = queuesStatus.filter((q) => q.waitingCount > 0 && q.estimatedWaitMinutes);
  const avgWaitMinutes = queuesWithWait.length > 0
    ? Math.round(queuesWithWait.reduce((acc, q) => acc + q.estimatedWaitMinutes, 0) / queuesWithWait.length)
    : 0;

  // Formatted counter status list
  const nowMs = Date.now();
  const counterOverview = counters.map((c) => {
    let servingElapsedSeconds = 0;
    if (c.servingStartedAt) {
      servingElapsedSeconds = Math.max(0, Math.round((nowMs - new Date(c.servingStartedAt).getTime()) / 1000));
    } else if (c.currentTokenId?.servingAt) {
      servingElapsedSeconds = Math.max(0, Math.round((nowMs - new Date(c.currentTokenId.servingAt).getTime()) / 1000));
    }

    return {
      _id: c._id,
      name: c.name,
      number: c.number,
      status: c.status,
      displayLabel: c.displayLabel || c.name,
      service: c.serviceId
        ? {
            _id: c.serviceId._id,
            name: c.serviceId.name,
            tokenPrefix: c.serviceId.tokenPrefix,
            avgServiceTimeMinutes: c.serviceId.avgServiceTimeMinutes,
          }
        : null,
      staff: c.staffId
        ? {
            _id: c.staffId._id,
            name: c.staffId.name,
            email: c.staffId.email,
          }
        : null,
      currentToken: c.currentTokenId
        ? {
            _id: c.currentTokenId._id,
            tokenCode: c.currentTokenId.tokenCode,
            tokenNumber: c.currentTokenId.tokenNumber,
            status: c.currentTokenId.status,
            calledAt: c.currentTokenId.calledAt,
            servingAt: c.currentTokenId.servingAt,
          }
        : null,
      servingElapsedSeconds,
      servingStartedAt: c.servingStartedAt,
      stats: c.stats || { served: 0, skipped: 0, avgServiceSeconds: null },
      utilizationPercent: c.utilizationPercent || 0,
    };
  });

  return sendSuccess(res, {
    data: {
      center: {
        _id: center._id,
        name: center.name,
        code: center.code,
        type: center.type,
        isOpen: center.isOpen,
        capacity: center.capacity,
        currentCrowd: center.currentCrowd,
        crowdPercent: center.crowdPercent,
        crowdStatus: center.crowdStatus,
      },
      metrics: {
        totalCounters,
        activeCounters,
        idleCounters,
        servingCounters,
        calledCounters,
        breakCounters,
        closedCounters,
        totalWaiting,
        totalServing,
        totalCalled: calledCounters,
        avgWaitMinutes,
      },
      counters: counterOverview,
      services: queuesStatus,
      recentEvents: recentEvents.map((e) => ({
        _id: e._id,
        eventType: e.eventType,
        metadata: e.metadata,
        performedBy: e.performedBy ? { _id: e.performedBy._id, name: e.performedBy.name, role: e.performedBy.role } : null,
        createdAt: e.createdAt,
      })),
    },
  });
});

/**
 * GET /api/analytics/:centerId/ewt
 * Tier 3 / Feature 1 — Context-Aware EWT with full explainability metadata.
 * ADMIN only. Every value returned is a real backend-derived number; nothing
 * is estimated, sampled or invented on the client.
 */
const getWaitTimeIntelligence = asyncHandler(async (req, res) => {
  const { centerId } = req.params;

  if (req.user.centerId && req.user.centerId.toString() !== centerId) {
    return sendForbidden(res, 'You are not authorized to view wait-time intelligence for this center');
  }

  const center = await ServiceCenter.findById(centerId)
    .select('name code type isOpen capacity currentCrowd noShowTimeoutSeconds')
    .lean({ virtuals: true });
  if (!center) return sendNotFound(res, 'Service center not found');

  const services = await Service.find({ centerId }).sort({ order: 1, name: 1 }).lean();
  const queues = await queueService.getQueueStatus(centerId);

  const now = new Date();
  const results = [];

  for (const svc of services) {
    const live = queues.find((q) => q.service && q.service._id.toString() === svc._id.toString());
    const queueDepth = live ? live.waitingCount || 0 : 0;

    const { minutes, context } = await waitTimeService.estimateContextAwareWait({
      centerId,
      serviceId: svc._id,
      queue: live || null,
      service: svc,
      queueDepth,
      now,
    });

    results.push({
      serviceId: svc._id,
      name: svc.name,
      tokenPrefix: svc.tokenPrefix,
      isActive: svc.isActive,
      queueDepth,
      activeCounters: context.activeCounters,
      estimatedWaitMinutes: minutes,
      // Explainability metadata — internal/admin only, never sent to customers.
      context,
    });
  }

  return sendSuccess(res, {
    data: {
      center: {
        _id: center._id,
        name: center.name,
        code: center.code,
        type: center.type,
        isOpen: center.isOpen,
        capacity: center.capacity,
        currentCrowd: center.currentCrowd,
        crowdPercent: center.crowdPercent,
        noShowTimeoutSeconds: center.noShowTimeoutSeconds,
      },
      config: waitTimeService.CONFIG,
      services: results,
      generatedAt: now.toISOString(),
    },
  });
});

/**
 * Helper to build bounded date filter for historical reporting
 */
function _resolveDateBounds(timeRange = 'today', startDateParam, endDateParam) {
  const now = new Date();
  let startDate;
  let endDate = new Date(now.getTime() + 1000); // include current second

  if (timeRange === 'today') {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
  } else if (timeRange === '7d') {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (timeRange === '30d') {
    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (timeRange === 'custom' && startDateParam) {
    startDate = new Date(startDateParam);
    if (isNaN(startDate.getTime())) {
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
    }
    if (endDateParam) {
      const parsedEnd = new Date(endDateParam);
      if (!isNaN(parsedEnd.getTime())) {
        endDate = parsedEnd;
      }
    }
  } else {
    // Default fallback: today
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
  }

  return { startDate, endDate };
}

/**
 * GET /api/analytics/:centerId/historical
 * Bounded, aggregated historical & SLA performance report. Admin only.
 */
const getHistoricalReport = asyncHandler(async (req, res) => {
  const { centerId } = req.params;
  const {
    timeRange = 'today',
    startDate: startDateParam,
    endDate: endDateParam,
    serviceId,
    counterId,
    targetWaitMinutes,
    page = 1,
    limit = 20,
  } = req.query;

  if (req.user.centerId && req.user.centerId.toString() !== centerId) {
    return sendForbidden(res, 'You are not authorized to view reports for this center');
  }

  const centerObjectId = new mongoose.Types.ObjectId(centerId);
  const { startDate, endDate } = _resolveDateBounds(timeRange, startDateParam, endDateParam);

  const match = {
    centerId: centerObjectId,
    createdAt: { $gte: startDate, $lte: endDate },
  };

  if (serviceId) {
    if (!mongoose.Types.ObjectId.isValid(serviceId)) return sendBadRequest(res, 'Invalid serviceId');
    match.serviceId = new mongoose.Types.ObjectId(serviceId);
  }

  if (counterId) {
    if (!mongoose.Types.ObjectId.isValid(counterId)) return sendBadRequest(res, 'Invalid counterId');
    match.counterId = new mongoose.Types.ObjectId(counterId);
  }

  // 1. Status count aggregation
  const statusCounts = await Token.aggregate([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const countsMap = {};
  for (const s of statusCounts) {
    countsMap[s._id] = s.count;
  }

  const totalIssued = statusCounts.reduce((acc, curr) => acc + curr.count, 0);
  const totalCompleted = countsMap.COMPLETED || 0;
  const totalSkipped = countsMap.SKIPPED || 0;
  const totalCancelled = countsMap.CANCELLED || 0;
  const totalExpired = countsMap.EXPIRED || 0;
  const totalWaiting = countsMap.WAITING || 0;
  const totalServing = countsMap.SERVING || 0;
  const totalCalled = countsMap.CALLED || 0;
  const completionRate = totalIssued > 0 ? Math.round((totalCompleted / totalIssued) * 100) : 0;

  // 2. Wait times and service durations aggregation
  const timingAgg = await Token.aggregate([
    {
      $match: {
        ...match,
        $or: [
          { status: 'COMPLETED' },
          { calledAt: { $ne: null } },
        ],
      },
    },
    {
      $project: {
        waitTimeSeconds: {
          $cond: [
            { $ne: ['$calledAt', null] },
            { $divide: [{ $subtract: ['$calledAt', '$createdAt'] }, 1000] },
            null,
          ],
        },
        serviceDurationSeconds: {
          $cond: [
            { $ne: ['$actualServiceSeconds', null] },
            '$actualServiceSeconds',
            {
              $cond: [
                {
                  $and: [{ $ne: ['$completedAt', null] }, { $ne: ['$servingAt', null] }],
                },
                { $divide: [{ $subtract: ['$completedAt', '$servingAt'] }, 1000] },
                null,
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        avgWaitSeconds: { $avg: '$waitTimeSeconds' },
        minWaitSeconds: { $min: '$waitTimeSeconds' },
        maxWaitSeconds: { $max: '$waitTimeSeconds' },
        avgServiceSeconds: { $avg: '$serviceDurationSeconds' },
      },
    },
  ]);

  const timing = timingAgg[0] || {
    avgWaitSeconds: null,
    minWaitSeconds: null,
    maxWaitSeconds: null,
    avgServiceSeconds: null,
  };

  // 3. Counter utilization breakdown
  const counterUtilAgg = await Token.aggregate([
    {
      $match: {
        ...match,
        counterId: { $ne: null },
      },
    },
    {
      $group: {
        _id: '$counterId',
        totalHandled: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
        },
        skipped: {
          $sum: { $cond: [{ $eq: ['$status', 'SKIPPED'] }, 1, 0] },
        },
        avgServiceSeconds: { $avg: '$actualServiceSeconds' },
      },
    },
  ]);

  const counterIds = counterUtilAgg.map((c) => c._id);
  const countersInfo = await Counter.find({ _id: { $in: counterIds } })
    .select('name number')
    .lean();
  const counterInfoMap = {};
  for (const c of countersInfo) {
    counterInfoMap[c._id.toString()] = c;
  }

  const counterUtilization = counterUtilAgg.map((cu) => {
    const c = counterInfoMap[cu._id.toString()] || {};
    return {
      counterId: cu._id,
      name: c.name || `Counter ${c.number || '?' }`,
      number: c.number || null,
      totalHandled: cu.totalHandled,
      completed: cu.completed,
      skipped: cu.skipped,
      avgServiceSeconds: cu.avgServiceSeconds ? Math.round(cu.avgServiceSeconds) : null,
    };
  });

  // 4. Service performance breakdown
  const servicePerfAgg = await Token.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$serviceId',
        totalIssued: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
        },
        skipped: {
          $sum: { $cond: [{ $eq: ['$status', 'SKIPPED'] }, 1, 0] },
        },
        cancelled: {
          $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] },
        },
      },
    },
  ]);

  const serviceIds = servicePerfAgg.map((s) => s._id);
  const servicesInfo = await Service.find({ _id: { $in: serviceIds } })
    .select('name tokenPrefix avgServiceTimeMinutes')
    .lean();
  const serviceInfoMap = {};
  for (const s of servicesInfo) {
    serviceInfoMap[s._id.toString()] = s;
  }

  const servicePerformance = servicePerfAgg.map((sp) => {
    const s = serviceInfoMap[sp._id.toString()] || {};
    return {
      serviceId: sp._id,
      name: s.name || 'Unknown',
      tokenPrefix: s.tokenPrefix || '?',
      totalIssued: sp.totalIssued,
      completed: sp.completed,
      skipped: sp.skipped,
      cancelled: sp.cancelled,
    };
  });

  // 5. Time series aggregation
  const dateGroupFormat = timeRange === 'today' ? '%H:00' : '%Y-%m-%d';
  const timeSeriesAgg = await Token.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: dateGroupFormat, date: '$createdAt' } },
        created: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        skipped: { $sum: { $cond: [{ $eq: ['$status', 'SKIPPED'] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const timeSeries = timeSeriesAgg.map((item) => ({
    timeBucket: item._id,
    created: item.created,
    completed: item.completed,
    skipped: item.skipped,
  }));

  // 6. SLA Evaluation
  let sla;
  const parsedTarget = targetWaitMinutes ? parseInt(targetWaitMinutes, 10) : null;
  if (parsedTarget && parsedTarget > 0) {
    const targetSeconds = parsedTarget * 60;
    const compliantTokensAgg = await Token.aggregate([
      {
        $match: {
          ...match,
          status: 'COMPLETED',
          calledAt: { $ne: null },
        },
      },
      {
        $project: {
          waitTimeSeconds: { $divide: [{ $subtract: ['$calledAt', '$createdAt'] }, 1000] },
        },
      },
      {
        $match: {
          waitTimeSeconds: { $lte: targetSeconds },
        },
      },
      { $count: 'compliantCount' },
    ]);

    const compliantCount = compliantTokensAgg[0]?.compliantCount || 0;
    const compliancePercent = totalCompleted > 0 ? Math.round((compliantCount / totalCompleted) * 100) : 100;

    sla = {
      status: 'CONFIGURED',
      targetWaitMinutes: parsedTarget,
      totalCompleted,
      compliantCount,
      compliancePercent,
      note: `Evaluated against custom target SLA of ${parsedTarget} minutes.`,
    };
  } else {
    sla = {
      status: 'CONFIGURABLE',
      targetWaitMinutes: null,
      compliancePercent: null,
      note: 'SLA target is not configured for this service center. Provide targetWaitMinutes query parameter (e.g. ?targetWaitMinutes=15) to evaluate SLA compliance.',
    };
  }

  // 7. Paginated sanitized token history records
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skipCount = (pageNum - 1) * limitNum;

  const rawTokens = await Token.find(match)
    .sort({ createdAt: -1 })
    .skip(skipCount)
    .limit(limitNum)
    .populate('serviceId', 'name tokenPrefix')
    .populate('counterId', 'name number')
    .populate('servedBy', 'name email role')
    .lean();

  const tokens = rawTokens.map((t) => {
    let waitSeconds = null;
    if (t.calledAt) {
      waitSeconds = Math.max(0, Math.round((new Date(t.calledAt).getTime() - new Date(t.createdAt).getTime()) / 1000));
    }

    let serviceDurationSeconds = t.actualServiceSeconds || null;
    if (!serviceDurationSeconds && t.completedAt && t.servingAt) {
      serviceDurationSeconds = Math.max(0, Math.round((new Date(t.completedAt).getTime() - new Date(t.servingAt).getTime()) / 1000));
    }

    return {
      _id: t._id,
      tokenCode: t.tokenCode,
      tokenNumber: t.tokenNumber,
      status: t.status,
      serviceName: t.serviceId?.name || 'Unknown',
      tokenPrefix: t.serviceId?.tokenPrefix || '?',
      counterName: t.counterId?.name || (t.counterId?.number ? `Counter ${t.counterId.number}` : null),
      operatorName: t.servedBy?.name || null,
      waitSeconds,
      serviceDurationSeconds,
      createdAt: t.createdAt,
      calledAt: t.calledAt,
      servingAt: t.servingAt,
      completedAt: t.completedAt,
    };
  });

  return sendSuccess(res, {
    data: {
      timeRange,
      startDate,
      endDate,
      summary: {
        totalIssued,
        totalCompleted,
        totalSkipped,
        totalCancelled,
        totalExpired,
        totalWaiting,
        totalServing,
        totalCalled,
        completionRate,
      },
      timing: {
        avgWaitSeconds: timing.avgWaitSeconds ? Math.round(timing.avgWaitSeconds) : null,
        minWaitSeconds: timing.minWaitSeconds ? Math.round(timing.minWaitSeconds) : null,
        maxWaitSeconds: timing.maxWaitSeconds ? Math.round(timing.maxWaitSeconds) : null,
        avgServiceSeconds: timing.avgServiceSeconds ? Math.round(timing.avgServiceSeconds) : null,
      },
      sla,
      counterUtilization,
      servicePerformance,
      timeSeries,
      tokens,
      pagination: {
        total: totalIssued,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalIssued / limitNum) || 1,
      },
    },
  });
});

/**
 * GET /api/analytics/:centerId/historical/export
 * Export historical report data as CSV stream. Admin only.
 */
const exportHistoricalReport = asyncHandler(async (req, res) => {
  const { centerId } = req.params;
  const { timeRange = 'today', startDate: startDateParam, endDate: endDateParam, serviceId, counterId } = req.query;

  if (req.user.centerId && req.user.centerId.toString() !== centerId) {
    return sendForbidden(res, 'You are not authorized to export reports for this center');
  }

  const { startDate, endDate } = _resolveDateBounds(timeRange, startDateParam, endDateParam);
  const match = {
    centerId: new mongoose.Types.ObjectId(centerId),
    createdAt: { $gte: startDate, $lte: endDate },
  };

  if (serviceId && mongoose.Types.ObjectId.isValid(serviceId)) {
    match.serviceId = new mongoose.Types.ObjectId(serviceId);
  }
  if (counterId && mongoose.Types.ObjectId.isValid(counterId)) {
    match.counterId = new mongoose.Types.ObjectId(counterId);
  }

  const tokens = await Token.find(match)
    .sort({ createdAt: -1 })
    .limit(5000)
    .populate('serviceId', 'name tokenPrefix')
    .populate('counterId', 'name number')
    .populate('servedBy', 'name')
    .lean();

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="queueflow_report_${centerId}_${Date.now()}.csv"`
  );

  res.write('Token Code,Token Number,Service,Counter,Operator,Status,Wait Time (min),Service Duration (min),Created At,Called At,Completed At\r\n');

  for (const t of tokens) {
    let waitMinutes = '';
    if (t.calledAt) {
      waitMinutes = ((new Date(t.calledAt).getTime() - new Date(t.createdAt).getTime()) / 60000).toFixed(1);
    }

    let serviceDurationMinutes = '';
    if (t.actualServiceSeconds) {
      serviceDurationMinutes = (t.actualServiceSeconds / 60).toFixed(1);
    } else if (t.completedAt && t.servingAt) {
      serviceDurationMinutes = ((new Date(t.completedAt).getTime() - new Date(t.servingAt).getTime()) / 60000).toFixed(1);
    }

    const serviceName = (t.serviceId?.name || '').replace(/"/g, '""');
    const counterName = (t.counterId?.name || (t.counterId?.number ? `Counter ${t.counterId.number}` : '')).replace(/"/g, '""');
    const operatorName = (t.servedBy?.name || '').replace(/"/g, '""');

    const row = [
      `"${t.tokenCode}"`,
      t.tokenNumber,
      `"${serviceName}"`,
      `"${counterName}"`,
      `"${operatorName}"`,
      t.status,
      waitMinutes,
      serviceDurationMinutes,
      `"${t.createdAt ? t.createdAt.toISOString() : ''}"`,
      `"${t.calledAt ? t.calledAt.toISOString() : ''}"`,
      `"${t.completedAt ? t.completedAt.toISOString() : ''}"`,
    ].join(',');

    res.write(row + '\r\n');
  }

  res.end();
});

/**
 * GET /api/analytics/:centerId/forecast
 * Tier 3 / Feature 2 — ML Footfall & Staffing Predictor
 * ADMIN only.
 * Bounded, reproducible, deterministic arrival forecast and advisory staffing
 * recommendation based solely on real historical tokens.
 */
const getDemandAndStaffingForecast = asyncHandler(async (req, res) => {
  const { centerId } = req.params;
  const { horizonHours, serviceId, refresh } = req.query;

  if (req.user.centerId && req.user.centerId.toString() !== centerId) {
    return sendForbidden(res, 'You are not authorized to view forecasts for this center');
  }

  const forecast = await mlPredictorService.getForecast({
    centerId,
    serviceId: serviceId || null,
    horizonHours: horizonHours ? parseInt(horizonHours, 10) : undefined,
    forceRefresh: refresh === 'true' || refresh === '1',
  });

  return sendSuccess(res, { data: forecast });
});

module.exports = {
  getDashboard,
  getTokenTimeSeries,
  getOperationalOverview,
  getWaitTimeIntelligence,
  getHistoricalReport,
  exportHistoricalReport,
  getDemandAndStaffingForecast,
};


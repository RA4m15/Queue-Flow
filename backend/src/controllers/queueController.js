'use strict';

const queueService = require('../services/queueService');
const waitTimeService = require('../services/waitTimeService');
const Queue = require('../models/Queue');
const { Token } = require('../models/Token');
const { getTodayDateString } = require('../utils/tokenUtils');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendNotFound } = require('../utils/apiResponse');

/**
 * GET /api/queue/:centerId
 * Get live queue status for all services at a center.
 * Public (customer app uses this to show waiting counts before joining).
 */
const getQueueStatus = asyncHandler(async (req, res) => {
  const { centerId } = req.params;
  const status = await queueService.getQueueStatus(centerId);
  return sendSuccess(res, { data: { queues: status } });
});

/**
 * GET /api/queue/:centerId/:serviceId
 * Get queue status for a specific service.
 */
const getServiceQueue = asyncHandler(async (req, res) => {
  const { centerId, serviceId } = req.params;
  const date = getTodayDateString();

  const queue = await Queue.findOne({ centerId, serviceId, date })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .lean({ virtuals: true });

  // Get waiting tokens (first 5 for preview)
  const waitingTokens = await Token.find({ centerId, serviceId, status: 'WAITING' })
    .sort({ createdAt: 1 })
    .limit(5)
    .select('tokenCode currentPosition createdAt')
    .lean();

  const calledTokens = await Token.find({ centerId, serviceId, status: { $in: ['CALLED', 'SERVING'] } })
    .populate('counterId', 'name number')
    .select('tokenCode status counterId calledAt')
    .lean();

  const Counter = require('../models/Counter');
  const Service = require('../models/Service');

  // Currently serving/called token
  const servingToken = calledTokens.length > 0 ? calledTokens[0] : null;

  // Active counters for this service
  const rawCounters = await Counter.find({
    centerId,
    serviceId,
    status: 'ACTIVE',
  })
    .populate('currentTokenId', 'tokenCode status')
    .select('name number displayLabel currentTokenId')
    .lean();

  const activeCounters = rawCounters.map((c) => ({
    _id: c._id,
    number: c.number,
    name: c.name,
    displayLabel: c.displayLabel || c.name,
    status: c.status,
    currentToken: c.currentTokenId ? c.currentTokenId.tokenCode : null,
  }));

  const serviceDoc = await Service.findById(serviceId).select('avgServiceTimeMinutes').lean();

  // Tier 3 / Feature 1: the EWT is produced by the single authoritative
  // context-aware engine. No local arithmetic remains in this controller.
  // A real empty queue returns 0; no placeholder value is ever invented.
  const ewt = await waitTimeService.estimateContextAwareWait({
    centerId,
    serviceId,
    queue,
    service: serviceDoc,
    queueDepth: queue?.waitingCount || 0,
  });

  return sendSuccess(res, {
    data: {
      queue: queue || { waitingCount: 0, completedCount: 0, totalIssued: 0, status: 'OPEN' },
      waitingTokens,
      calledTokens,
      servingToken,
      activeCounters,
      estimatedWaitMinutes: ewt.minutes,
    },
  });
});

/**
 * GET /api/queue/:centerId/display
 * Public: dedicated high-transparency feed for TV monitors, kiosks, and lobby displays.
 * Returns currently serving tokens, upcoming waiting tokens, counters, and latest callout.
 */
const getCenterDisplay = asyncHandler(async (req, res) => {
  const { centerId } = req.params;
  const ServiceCenter = require('../models/ServiceCenter');
  const Counter = require('../models/Counter');

  const center = await ServiceCenter.findById(centerId)
    .select('name code type address capacity isOpen')
    .lean();

  if (!center) {
    return sendNotFound(res, 'Service center not found');
  }

  const date = getTodayDateString();

  // All queues for today at this center
  const queues = await Queue.find({ centerId, date })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes isActive')
    .lean();

  // All counters at this center
  const counters = await Counter.find({ centerId })
    .populate('serviceId', 'name tokenPrefix')
    .populate('currentTokenId', 'tokenCode status calledAt')
    .lean();

  // Currently called or serving tokens
  const nowServing = await Token.find({
    centerId,
    status: { $in: ['CALLED', 'SERVING'] },
  })
    .populate('serviceId', 'name tokenPrefix')
    .populate('counterId', 'name number displayLabel')
    .sort({ calledAt: -1 })
    .select('tokenCode status calledAt servingAt serviceId counterId')
    .lean();

  // Upcoming waiting tokens (top 15)
  const nextInQueue = await Token.find({
    centerId,
    status: 'WAITING',
  })
    .populate('serviceId', 'name tokenPrefix')
    .sort({ createdAt: 1 })
    .limit(15)
    .select('tokenCode currentPosition waitEstimateMinutes serviceId createdAt')
    .lean();

  // Most recent callout for visual/audio prompt
  const latestCallout = nowServing.length > 0 ? nowServing[0] : null;

  return sendSuccess(res, {
    data: {
      center: {
        ...center,
        id: center._id.toString(),
      },
      nowServing,
      nextInQueue,
      counters: counters.map((c) => ({
        _id: c._id,
        number: c.number,
        name: c.name,
        displayLabel: c.displayLabel || c.name,
        status: c.status,
        service: c.serviceId ? { name: c.serviceId.name, tokenPrefix: c.serviceId.tokenPrefix } : null,
        servingToken: c.currentTokenId
          ? {
              tokenCode: c.currentTokenId.tokenCode,
              status: c.currentTokenId.status,
              calledAt: c.currentTokenId.calledAt,
            }
          : null,
      })),
      queues: await Promise.all(
        queues.map(async (q) => {
          // Tier 3 / Feature 1: TV display consumes the same authoritative
          // context-aware EWT as every other surface. No duplicate maths here.
          const ewt = await waitTimeService.estimateContextAwareWait({
            centerId,
            serviceId: q.serviceId?._id || q.serviceId,
            queue: q,
            service: q.serviceId,
            queueDepth: q.waitingCount || 0,
          });

          return {
            queueId: q._id,
            service: q.serviceId,
            status: q.status,
            waitingCount: q.waitingCount,
            activeCount: q.activeCount,
            completedCount: q.completedCount,
            estimatedWaitMinutes: ewt.minutes,
          };
        })
      ),
      latestCallout,
      serverTime: new Date().toISOString(),
    },
  });
});

/**
 * GET /api/queue/:centerId/events
 * Get recent queue events for the live log (admin).
 */
const getRecentEvents = asyncHandler(async (req, res) => {
  const { centerId } = req.params;
  let limitNum = parseInt(req.query.limit, 10);
  if (isNaN(limitNum) || limitNum < 1) limitNum = 20;
  if (limitNum > 100) limitNum = 100;

  const QueueEvent = require('../models/QueueEvent');
  const events = await QueueEvent.find({ centerId })
    .populate('tokenId', 'tokenCode')
    .populate('counterId', 'name number')
    .populate('performedBy', 'name')
    .sort({ createdAt: -1 })
    .limit(limitNum)
    .lean();

  return sendSuccess(res, { data: { events } });
});

module.exports = {
  getQueueStatus,
  getServiceQueue,
  getCenterDisplay,
  getRecentEvents,
};

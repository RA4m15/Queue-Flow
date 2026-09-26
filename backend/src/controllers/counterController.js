'use strict';

const { body } = require('express-validator');
const Counter = require('../models/Counter');
const Service = require('../models/Service');
const User = require('../models/User');
const { Token } = require('../models/Token');
const QueueEvent = require('../models/QueueEvent');
const queueService = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');
const {
  sendSuccess,
  sendCreated,
  sendNotFound,
  sendBadRequest,
  sendForbidden,
  sendConflict,
} = require('../utils/apiResponse');
const { emitToCenter, emitToCounter } = require('../config/socket');
const { logger } = require('../utils/logger');

const { MONGO_ID_REGEX } = require('../middleware/validate');

// ─── Authorization Helper ─────────────────────────
function checkCounterOperatorAuth(req, counter) {
  if (req.user.role === 'STAFF') {
    // Check center assignment
    if (req.user.centerId && counter.centerId && counter.centerId.toString() !== req.user.centerId.toString()) {
      const err = new Error('You are not authorized to operate counters in this center');
      err.status = 403;
      throw err;
    }
    // Check counter assignment
    if (!counter.staffId || counter.staffId.toString() !== req.user._id.toString()) {
      const err = new Error('You are not assigned to operate this counter');
      err.status = 403;
      throw err;
    }
  }
}

// ─── Validation ───────────────────────────────────
const createValidation = [
  body('centerId').isMongoId().withMessage('Valid centerId is required'),
  body('name').trim().notEmpty().withMessage('Counter name is required'),
  body('number').isInt({ min: 1 }).withMessage('Counter number must be a positive integer'),
];

// ─── Controllers ──────────────────────────────────

/**
 * GET /api/counters?centerId=...
 * List all counters for a center. Public.
 */
const list = asyncHandler(async (req, res) => {
  const { centerId } = req.query;
  const filter = {};
  if (centerId) {
    if (typeof centerId !== 'string' || !MONGO_ID_REGEX.test(centerId)) {
      return sendBadRequest(res, 'Invalid centerId');
    }
    filter.centerId = centerId;
  }

  const counters = await Counter.find(filter)
    .populate('serviceId', 'name tokenPrefix')
    .populate('currentTokenId', 'tokenCode status')
    .populate('staffId', 'name email role')
    .sort({ number: 1 })
    .lean({ virtuals: true });

  return sendSuccess(res, { data: { counters }, meta: { total: counters.length } });
});

/**
 * GET /api/counters/:id
 */
const getById = asyncHandler(async (req, res) => {
  const counter = await Counter.findById(req.params.id)
    .populate('serviceId', 'name tokenPrefix')
    .populate('currentTokenId', 'tokenCode status calledAt')
    .populate('staffId', 'name email role')
    .lean({ virtuals: true });

  if (!counter) return sendNotFound(res, 'Counter not found');
  return sendSuccess(res, { data: { counter } });
});

/**
 * GET /api/counters/operator/me
 * Return the assigned counter and active queue state for the authenticated operator.
 */
const getOperatorCounter = asyncHandler(async (req, res) => {
  const { centerId, counterId } = req.query;
  let counter = null;

  if (counterId) {
    if (!MONGO_ID_REGEX.test(counterId)) {
      return sendBadRequest(res, 'Invalid counterId');
    }
    counter = await Counter.findById(counterId);
    if (!counter) return sendNotFound(res, 'Counter not found');
    checkCounterOperatorAuth(req, counter);
  } else if (req.user.role === 'STAFF') {
    const filter = { staffId: req.user._id };
    if (req.user.centerId) filter.centerId = req.user.centerId;
    counter = await Counter.findOne(filter);
  } else if (req.user.role === 'ADMIN') {
    const filter = {};
    if (centerId && MONGO_ID_REGEX.test(centerId)) filter.centerId = centerId;
    counter = await Counter.findOne(filter).sort({ number: 1 });
  }

  if (!counter) {
    return sendSuccess(res, {
      message: 'No counter currently assigned to operator',
      data: { counter: null, queue: null, waitingTokens: [] },
    });
  }

  const populatedCounter = await Counter.findById(counter._id)
    .populate('centerId', 'name code address type isOpen noShowTimeoutSeconds')
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .populate('currentTokenId', 'tokenCode tokenNumber status calledAt servingAt actualServiceSeconds')
    .populate('staffId', 'name email role')
    .lean({ virtuals: true });

  let queue = null;
  let waitingTokens = [];

  if (counter.serviceId && counter.centerId) {
    const sId = counter.serviceId._id || counter.serviceId;
    const cId = counter.centerId._id || counter.centerId;

    queue = await queueService.getQueueStatus(cId, sId);

    // Fetch next waiting tokens without customer PII
    const rawTokens = await Token.find({
      centerId: cId,
      serviceId: sId,
      status: 'WAITING',
    })
      .sort({ createdAt: 1 })
      .limit(10)
      .select('tokenCode tokenNumber currentPosition waitEstimateMinutes createdAt')
      .lean();

    waitingTokens = rawTokens.map((t) => ({
      _id: t._id,
      tokenCode: t.tokenCode,
      tokenNumber: t.tokenNumber,
      position: t.currentPosition,
      waitEstimateMinutes: t.waitEstimateMinutes,
      createdAt: t.createdAt,
    }));
  }

  return sendSuccess(res, {
    data: {
      counter: populatedCounter,
      queue,
      waitingTokens,
    },
  });
});

/**
 * POST /api/counters
 * Create a counter. Admin only.
 */
const create = asyncHandler(async (req, res) => {
  const { centerId, name, number, serviceId, displayLabel } = req.body;

  const counter = await Counter.create({
    centerId,
    name,
    number,
    serviceId: serviceId || null,
    displayLabel: displayLabel || name,
  });

  return sendCreated(res, { message: 'Counter created', data: { counter } });
});

/**
 * PATCH /api/counters/:id/status
 * Open, close, or put a counter on break. Admin/Staff.
 */
const updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'BREAK', 'CLOSED'].includes(status)) {
    return sendBadRequest(res, 'Invalid status. Must be ACTIVE, BREAK, or CLOSED');
  }

  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');
  checkCounterOperatorAuth(req, counter);

  counter.status = status;
  await counter.save();

  const populated = await Counter.findById(counter._id)
    .populate('serviceId', 'name')
    .populate('currentTokenId', 'tokenCode status')
    .populate('staffId', 'name email role')
    .lean({ virtuals: true });

  const eventType =
    status === 'ACTIVE' ? 'COUNTER_OPENED' :
    status === 'BREAK' ? 'COUNTER_BREAK' :
    'COUNTER_CLOSED';

  await QueueEvent.create({
    centerId: counter.centerId,
    counterId: counter._id,
    eventType,
    performedBy: req.user._id,
    metadata: { counterName: counter.name, status },
  });

  // Tier 3 / Feature 1: counter availability is real EWT context. A counter
  // opening, going on break or closing changes the available service capacity,
  // so any memoised EWT context for the affected service must be recomputed.
  const waitTimeService = require('../services/waitTimeService');
  waitTimeService.invalidateServiceContext(counter.centerId, counter.serviceId);

  // Recalculate waiting-token estimates so customers see the real new capacity.
  if (counter.serviceId) {
    try {
      await queueService._updateWaitingPositions(counter.centerId, counter.serviceId);
    } catch (err) {
      logger.warn('[Counter] EWT recalculation after status change failed', {
        counterId: String(counter._id),
        error: err.message,
      });
    }
  }

  emitToCenter(counter.centerId.toString(), 'counter.updated', { counter: populated });

  return sendSuccess(res, { message: `Counter status updated to ${status}`, data: { counter: populated } });
});

/**
 * Helper to safely validate and perform counter morphing / service reassignment
 */
async function _performCounterMorph(req, res, eventType = 'COUNTER_MORPHED') {
  const { serviceId, reason } = req.body;

  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');

  // Verify center ownership if user is scoped
  if (req.user.centerId && req.user.centerId.toString() !== counter.centerId.toString()) {
    return sendForbidden(res, 'You are not authorized to modify counters for this center');
  }

  // Safety check: Cannot morph counter while actively serving or calling a token
  if (counter.currentTokenId) {
    const activeToken = await Token.findById(counter.currentTokenId);
    if (activeToken && ['CALLED', 'SERVING'].includes(activeToken.status)) {
      return sendConflict(
        res,
        `Cannot morph counter while actively serving or calling token ${activeToken.tokenCode}. Please complete, skip, or resolve active token before reassigning services.`
      );
    }
  }

  const concurrentActiveToken = await Token.findOne({
    counterId: counter._id,
    status: { $in: ['CALLED', 'SERVING'] },
  });
  if (concurrentActiveToken) {
    return sendConflict(
      res,
      `Cannot morph counter while actively serving or calling token ${concurrentActiveToken.tokenCode}. Please complete, skip, or resolve active token before reassigning services.`
    );
  }

  let targetService = null;
  if (serviceId) {
    if (typeof serviceId !== 'string' || !MONGO_ID_REGEX.test(serviceId)) {
      return sendBadRequest(res, 'Invalid serviceId');
    }
    targetService = await Service.findById(serviceId);
    if (!targetService) return sendNotFound(res, 'Service not found');

    // Verify service belongs to counter's center
    if (targetService.centerId.toString() !== counter.centerId.toString()) {
      return sendBadRequest(res, 'Service does not belong to this service center');
    }

    // Verify service is active
    if (!targetService.isActive) {
      return sendBadRequest(res, 'Cannot assign an inactive service to counter');
    }
  }

  // Retrieve previous service details for audit trail
  const previousServiceId = counter.serviceId;
  let previousServiceName = 'Unassigned';
  if (previousServiceId) {
    const prev = await Service.findById(previousServiceId);
    if (prev) previousServiceName = prev.name;
  }

  // Reassign service
  counter.serviceId = serviceId || null;
  await counter.save();

  const populated = await Counter.findById(counter._id)
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .populate('currentTokenId', 'tokenCode status')
    .populate('staffId', 'name email role')
    .lean({ virtuals: true });

  // Record audit log event
  await QueueEvent.create({
    centerId: counter.centerId,
    counterId: counter._id,
    eventType,
    performedBy: req.user._id,
    metadata: {
      previousServiceId: previousServiceId || null,
      previousServiceName,
      newServiceId: serviceId || null,
      newServiceName: targetService ? targetService.name : 'Unassigned',
      counterName: counter.name,
      counterNumber: counter.number,
      reason: reason || 'Administrative counter morphing',
    },
  });

  // Tier 3 / Feature 1: morphing moves real serving capacity between service
  // queues, so the EWT of BOTH the previous and the new service changes.
  const waitTimeService = require('../services/waitTimeService');
  const affectedServices = new Set();
  if (previousServiceId) affectedServices.add(previousServiceId.toString());
  if (serviceId) affectedServices.add(serviceId.toString());

  for (const affected of affectedServices) {
    waitTimeService.invalidateServiceContext(counter.centerId, affected);
    try {
      await queueService._updateWaitingPositions(counter.centerId, affected);
    } catch (err) {
      logger.warn('[Counter] EWT recalculation after morphing failed', {
        counterId: String(counter._id),
        serviceId: affected,
        error: err.message,
      });
    }
  }

  // Broadcast real-time updates to center room
  emitToCenter(counter.centerId.toString(), 'counter.updated', { counter: populated });
  emitToCenter(counter.centerId.toString(), 'counter.morphed', {
    counter: populated,
    previousServiceId: previousServiceId || null,
    newServiceId: serviceId || null,
  });

  return sendSuccess(res, {
    message: serviceId ? `Counter morphed to service ${targetService.name}` : 'Counter service unassigned',
    data: { counter: populated },
  });
}

/**
 * PATCH /api/counters/:id/assign
 * Assign a service to a counter. Admin only.
 */
const assignService = asyncHandler(async (req, res) => {
  return _performCounterMorph(req, res, 'COUNTER_ASSIGNED');
});

/**
 * PATCH /api/counters/:id/morph
 * Dynamically reassign service for a counter with strict active-token safety and audit logging. Admin only.
 */
const morphCounter = asyncHandler(async (req, res) => {
  return _performCounterMorph(req, res, 'COUNTER_MORPHED');
});

/**
 * PATCH /api/counters/:id/assign-staff
 * Assign or unassign a staff member to a counter. Admin only.
 */
const assignStaff = asyncHandler(async (req, res) => {
  const { staffId } = req.body;
  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');

  if (staffId) {
    if (!MONGO_ID_REGEX.test(staffId)) {
      return sendBadRequest(res, 'Invalid staffId');
    }
    const staffUser = await User.findById(staffId);
    if (!staffUser || !['STAFF', 'ADMIN'].includes(staffUser.role)) {
      return sendBadRequest(res, 'Target user must be a valid STAFF or ADMIN');
    }

    // Unassign this staff member from other counters in the center
    await Counter.updateMany(
      { staffId, _id: { $ne: counter._id } },
      { $set: { staffId: null } }
    );

    // Sync staffUser assignment
    staffUser.assignedCounterId = counter._id;
    if (!staffUser.centerId) {
      staffUser.centerId = counter.centerId;
    }
    await staffUser.save();
  } else {
    // Unassigning
    if (counter.staffId) {
      await User.findByIdAndUpdate(counter.staffId, { $set: { assignedCounterId: null } });
    }
  }

  counter.staffId = staffId || null;
  await counter.save();

  const populated = await Counter.findById(counter._id)
    .populate('serviceId', 'name tokenPrefix')
    .populate('currentTokenId', 'tokenCode status')
    .populate('staffId', 'name email role')
    .lean({ virtuals: true });

  emitToCenter(counter.centerId.toString(), 'counter.updated', { counter: populated });

  return sendSuccess(res, {
    message: staffId ? 'Staff assigned to counter' : 'Staff unassigned from counter',
    data: { counter: populated },
  });
});

/**
 * POST /api/counters/:id/call-next
 * Call the next waiting token for this counter. Staff/Admin.
 */
const callNext = asyncHandler(async (req, res) => {
  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');
  checkCounterOperatorAuth(req, counter);

  const result = await queueService.callNext({
    counterId: req.params.id,
    centerId: counter.centerId.toString(),
    adminId: req.user._id.toString(),
  });

  if (!result) {
    return sendSuccess(res, { message: 'No waiting tokens in the queue', data: { token: null } });
  }

  return sendSuccess(res, {
    message: `Token ${result.token.tokenCode} called`,
    data: { token: result.token, counter: result.counter },
  });
});

/**
 * POST /api/counters/:id/recall
 * Re-call the current customer token at this counter. Staff/Admin.
 */
const recall = asyncHandler(async (req, res) => {
  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');
  checkCounterOperatorAuth(req, counter);

  const result = await queueService.recallToken({
    counterId: req.params.id,
    centerId: counter.centerId.toString(),
    adminId: req.user._id.toString(),
  });

  return sendSuccess(res, {
    message: `Token ${result.token.tokenCode} re-called`,
    data: { token: result.token, counter: result.counter },
  });
});

/**
 * POST /api/counters/:id/start-serving
 * Mark current token as SERVING. Staff/Admin.
 */
const startServing = asyncHandler(async (req, res) => {
  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');
  checkCounterOperatorAuth(req, counter);

  if (!counter.currentTokenId) {
    return sendBadRequest(res, 'No token is currently called at this counter');
  }

  const token = await queueService.startServing({
    tokenId: counter.currentTokenId.toString(),
    counterId: req.params.id,
    adminId: req.user._id.toString(),
  });

  return sendSuccess(res, {
    message: `Token ${token.tokenCode} is now serving`,
    data: { token },
  });
});

/**
 * POST /api/counters/:id/complete
 * Mark the current token as completed. Staff/Admin.
 */
const complete = asyncHandler(async (req, res) => {
  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');
  checkCounterOperatorAuth(req, counter);

  if (!counter.currentTokenId) {
    return sendBadRequest(res, 'No token is currently being served at this counter');
  }

  const result = await queueService.completeToken({
    tokenId: counter.currentTokenId.toString(),
    counterId: req.params.id,
    adminId: req.user._id.toString(),
  });

  return sendSuccess(res, {
    message: `Token ${result.token.tokenCode} completed`,
    data: { token: result.token, counter: result.counter },
  });
});

/**
 * POST /api/counters/:id/skip
 * Skip the current or a specific token. Staff/Admin.
 */
const skip = asyncHandler(async (req, res) => {
  const { tokenId } = req.body;
  if (tokenId) {
    if (typeof tokenId !== 'string' || !MONGO_ID_REGEX.test(tokenId)) {
      return sendBadRequest(res, 'Invalid tokenId');
    }
  }
  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');
  checkCounterOperatorAuth(req, counter);

  const targetTokenId = tokenId || counter.currentTokenId?.toString();
  if (!targetTokenId) {
    return sendBadRequest(res, 'No token to skip');
  }

  const token = await queueService.skipToken({
    tokenId: targetTokenId,
    counterId: req.params.id,
    adminId: req.user._id.toString(),
  });

  return sendSuccess(res, {
    message: `Token ${token.tokenCode} skipped`,
    data: { token },
  });
});

module.exports = {
  list,
  getById,
  getOperatorCounter,
  create,
  updateStatus,
  assignService,
  morphCounter,
  assignStaff,
  callNext,
  recall,
  startServing,
  complete,
  skip,
  createValidation,
};

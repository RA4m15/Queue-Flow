'use strict';

const { body } = require('express-validator');
const Counter = require('../models/Counter');
const ServiceCenter = require('../models/ServiceCenter');
const Service = require('../models/Service');
const User = require('../models/User');
const { Token } = require('../models/Token');
const QueueEvent = require('../models/QueueEvent');
const queueService = require('../services/queueService');
const workloadBalancerService = require('../services/workloadBalancerService');
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
/**
 * Read an id off a counter field that may be either a raw ObjectId or a
 * populated document, depending on how the caller queried it. Comparing a
 * populated subdocument with `.toString()` silently yields "[object Object]",
 * which would deny a legitimate operator — or, worse, allow one.
 */
function idOf(value) {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function checkCounterOperatorAuth(req, counter) {
  if (req.user.role === 'STAFF') {
    // Check center assignment
    if (req.user.centerId && counter.centerId && idOf(counter.centerId) !== String(req.user.centerId)) {
      const err = new Error('You are not authorized to operate counters in this center');
      err.status = 403;
      throw err;
    }
    // Check counter assignment
    if (idOf(counter.staffId) !== String(req.user._id)) {
      const err = new Error('You are not assigned to operate this counter');
      err.status = 403;
      throw err;
    }
  } else if (req.user.role === 'ADMIN' && req.user.centerId) {
    // A center-scoped ADMIN may only act inside their own facility. An
    // unscoped ADMIN may act in any facility, but never across two at once.
    if (idOf(counter.centerId) !== String(req.user.centerId)) {
      const err = new Error('You are not authorized to operate counters in this center');
      err.status = 403;
      throw err;
    }
  }
}

/**
 * Assert that a counter the client claims to be operating really belongs to the
 * facility the client says it is operating.
 *
 * The operator panel is driven by two independent selectors — the ACTIVE
 * FACILITY in the navbar and the COUNTER picked from the "Choose Counter"
 * list — and they are allowed to drift out of sync on screen. This is the
 * server-side backstop that refuses to let that drift become an action: a
 * request that pairs a College Account counter with a State Bank facility is
 * rejected instead of being quietly executed against the counter's real center.
 *
 * @param {object} req
 * @param {object} counter - a Counter document or lean object
 * @param {string|null} requestedCenterId
 * @throws {Error} status 403 when the counter is not part of the named center
 */
function assertCounterInCenter(counter, requestedCenterId) {
  if (!requestedCenterId) return;
  if (idOf(counter.centerId) !== String(requestedCenterId)) {
    const err = new Error('The selected counter does not belong to the selected facility');
    err.status = 403;
    throw err;
  }
}

/**
 * Resolve the counter named in the URL and fully authorize the caller for it.
 *
 * The optional `centerId` (body or query) is the facility the client believes
 * it is operating. Passing it turns the facility selector into a real
 * constraint rather than a cosmetic label: if the named counter is not part of
 * that facility the request is refused before any queue is touched.
 *
 * @param {object} req
 * @returns {Promise<object>} the authorized Counter document
 * @throws {Error} 404 when the counter does not exist, 403 when unauthorized
 */
async function resolveAuthorizedCounter(req) {
  const counter = await Counter.findById(req.params.id);
  if (!counter) {
    const err = new Error('Counter not found');
    err.status = 404;
    throw err;
  }

  const requestedCenterId = req.body?.centerId || req.query?.centerId || null;
  assertCounterInCenter(counter, requestedCenterId);
  checkCounterOperatorAuth(req, counter);

  return counter;
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
 *
 * This route is reachable without authentication, so it deliberately exposes
 * only what a public queue board needs: the counter identity, its live status
 * and the service it runs. The assigned operator is reduced to a display name
 * and role — no email address, no contact details. Use `/counters/operable`
 * (authenticated) when the operator panel needs the full assignment picture.
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
    .populate('staffId', 'name role')
    .sort({ number: 1 })
    .lean({ virtuals: true });

  return sendSuccess(res, { data: { counters }, meta: { total: counters.length } });
});

/**
 * GET /api/counters/operable?centerId=...
 *
 * Backs the operator panel's "CHOOSE COUNTER" picker. Authenticated
 * (ADMIN/STAFF) and always facility-scoped: the center must be named
 * explicitly, and the counters returned are read from MongoDB, never from a
 * hardcoded list.
 *
 * Each entry carries the real counter number/name, the backend counter status,
 * the service the counter currently runs, the customer currently assigned to
 * it, and the assigned operator. `canOperate` is the server's own verdict on
 * whether the calling user is allowed to run that counter — the UI renders it,
 * it does not compute it.
 */
const getOperableCounters = asyncHandler(async (req, res) => {
  let targetCenterId = req.query.centerId;

  if (targetCenterId && (typeof targetCenterId !== 'string' || !MONGO_ID_REGEX.test(targetCenterId))) {
    return sendBadRequest(res, 'Invalid centerId');
  }

  // A STAFF account is bound to exactly one facility. If it does not name one,
  // the facility comes from the user record instead of from the request body.
  if (req.user.role === 'STAFF') {
    if (!req.user.centerId) {
      return sendForbidden(res, 'Your account is not assigned to a service center');
    }
    if (targetCenterId && String(targetCenterId) !== String(req.user.centerId)) {
      return sendForbidden(res, 'You are not authorized to view counters for another service center');
    }
    targetCenterId = String(req.user.centerId);
  }

  if (!targetCenterId) {
    return sendBadRequest(res, 'centerId query parameter is required');
  }

  const center = await ServiceCenter.findById(targetCenterId).select('name code isOpen').lean();
  if (!center) return sendNotFound(res, 'Service center not found');

  const counters = await Counter.find({ centerId: targetCenterId })
    .populate('serviceId', 'name tokenPrefix isActive')
    .populate('currentTokenId', 'tokenCode status calledAt')
    .populate('staffId', 'name role')
    .sort({ number: 1 })
    .lean({ virtuals: true });

  const userId = String(req.user._id);
  const canSelectAnyCounter = req.user.role === 'ADMIN';

  const operable = counters.map((c) => {
    const isAssignedToCaller = idOf(c.staffId) === userId;
    const hasService = Boolean(c.serviceId);
    return {
      _id: c._id,
      name: c.name,
      number: c.number,
      displayLabel: c.displayLabel || c.name,
      status: c.status,
      service: c.serviceId
        ? {
            _id: c.serviceId._id,
            name: c.serviceId.name,
            tokenPrefix: c.serviceId.tokenPrefix,
            isActive: c.serviceId.isActive !== false,
          }
        : null,
      operator: c.staffId
        ? { _id: c.staffId._id, name: c.staffId.name, role: c.staffId.role }
        : null,
      currentToken: c.currentTokenId
        ? {
            _id: c.currentTokenId._id,
            tokenCode: c.currentTokenId.tokenCode,
            status: c.currentTokenId.status,
            calledAt: c.currentTokenId.calledAt || null,
          }
        : null,
      isAssignedToCaller,
      // Server-authoritative permission. An ADMIN may pick any counter in the
      // facility; a STAFF operator may only run the one assigned to them.
      canOperate: (canSelectAnyCounter || isAssignedToCaller) && hasService,
    };
  });

  return sendSuccess(res, {
    data: {
      center: { _id: center._id, name: center.name, code: center.code, isOpen: center.isOpen },
      counters: operable,
      total: operable.length,
      canSelectAnyCounter,
    },
  });
});

/**
 * GET /api/counters/:id
 *
 * Authenticated and operator-scoped. This payload includes the assigned
 * operator's name and email address, so it must never be readable by an
 * anonymous caller walking ids. STAFF may only read their own counter; ADMIN
 * may read any counter. The public live board uses the separate
 * `/api/queue/:centerId/display` feed, which carries no operator identity.
 */
const getById = asyncHandler(async (req, res) => {
  const counter = await Counter.findById(req.params.id)
    .populate('serviceId', 'name tokenPrefix')
    .populate('currentTokenId', 'tokenCode status calledAt')
    .populate('staffId', 'name email role')
    .lean({ virtuals: true });

  if (!counter) return sendNotFound(res, 'Counter not found');
  checkCounterOperatorAuth(req, counter);
  return sendSuccess(res, { data: { counter } });
});

/**
 * GET /api/counters/operator/me?centerId=...&counterId=...
 *
 * Return the fully scoped operational state of ONE counter: the counter, its
 * facility, its service, the real service queue (waiting count + EWT) and the
 * real waiting tokens.
 *
 * ── Why this endpoint used to mix service centers ──────────────────────────
 * It previously accepted a `centerId` but never required one. An ADMIN calling
 * it with no parameters fell through to `Counter.findOne({})`, i.e. "the first
 * counter in the entire database" — a counter belonging to a completely
 * unrelated facility. The panel then showed that counter's name, center and
 * service while the ACTIVE FACILITY selector in the navigation bar still showed
 * whichever facility the operator had chosen, which is exactly how
 * "College Account" ended up rendered next to "State Bank — Main Branch /
 * Account Opening".
 *
 * The facility is now authoritative:
 *   • a `counterId` is validated to belong to the requested `centerId`;
 *   • an ADMIN must name a facility (or a counter) — there is no global
 *     fallback, and the response says so explicitly via
 *     `requiresCounterSelection` instead of inventing a counter;
 *   • a STAFF operator always resolves their own backend-assigned counter.
 *
 * The service queue and the waiting list are both scoped to
 * `{ centerId, serviceId }` of the SELECTED counter, and to the current
 * business day, so a counter can never display another service's numbers.
 */
const getOperatorCounter = asyncHandler(async (req, res) => {
  const { centerId, counterId } = req.query;

  if (centerId && (typeof centerId !== 'string' || !MONGO_ID_REGEX.test(centerId))) {
    return sendBadRequest(res, 'Invalid centerId');
  }
  if (counterId && (typeof counterId !== 'string' || !MONGO_ID_REGEX.test(counterId))) {
    return sendBadRequest(res, 'Invalid counterId');
  }

  let counter = null;

  if (counterId) {
    counter = await Counter.findById(counterId);
    if (!counter) return sendNotFound(res, 'Counter not found');
    // Facility isolation: never let a counter be rendered under a facility it
    // does not belong to.
    if (centerId) {
      try {
        assertCounterInCenter(counter, centerId);
      } catch (err) {
        return sendForbidden(res, err.message);
      }
    }
    checkCounterOperatorAuth(req, counter);
  } else if (req.user.role === 'STAFF') {
    // A normal operator is bound to their assigned counter. A center-scoped
    // request must agree with that binding.
    const filter = { staffId: req.user._id };
    if (req.user.centerId) filter.centerId = req.user.centerId;
    counter = await Counter.findOne(filter);
    if (!counter && centerId) {
      // The operator has no assignment, but the facility they asked about is
      // still readable so the panel can show them why there is nothing to run.
      counter = null;
    }
  }

  if (!counter) {
    return sendSuccess(res, {
      message: 'No counter currently selected',
      data: {
        counter: null,
        center: null,
        queue: null,
        waitingTokens: [],
        workload: null,
        requiresCounterSelection: true,
        selectedCenterId: centerId || null,
        canSelectAnyCounter: req.user.role === 'ADMIN',
      },
    });
  }

  const resolvedCenterId = idOf(counter.centerId);
  const resolvedServiceId = counter.serviceId ? idOf(counter.serviceId) : null;

  const populatedCounter = await Counter.findById(counter._id)
    .populate('centerId', 'name code address type isOpen noShowTimeoutSeconds')
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes isActive')
    .populate('currentTokenId', 'tokenCode tokenNumber status calledAt servingAt actualServiceSeconds')
    .populate('staffId', 'name role')
    .lean({ virtuals: true });

  // Queue + waiting tokens are read from the SELECTED counter's own
  // { center, service }. If the counter has no service there is no queue to
  // show, and the panel says so instead of borrowing another service's numbers.
  let queue = null;
  let waitingTokens = [];
  let waitingCount = 0;
  let estimatedWaitMinutes = null;

  if (resolvedServiceId) {
    const queues = await queueService.getQueueStatus(resolvedCenterId, resolvedServiceId);
    queue = Array.isArray(queues)
      ? queues.find((q) => {
          const qServiceId = q.service?._id || q.service;
          return qServiceId && String(qServiceId) === resolvedServiceId;
        }) || null
      : queues || null;

    // Real waiting tokens, de-duplicated, FIFO, scoped to this business day.
    waitingTokens = await queueService.getWaitingTokensForQueue(
      resolvedCenterId,
      resolvedServiceId,
      10
    );

    // The authoritative waiting count is the real number of live WAITING token
    // documents, not the queue document's cached counter. The list rendered
    // beside it is built from exactly those same documents, so the headline
    // number and the rows can never disagree.
    waitingCount = await Token.countDocuments(
      queueService.buildLiveQueueFilter(resolvedCenterId, resolvedServiceId, { status: 'WAITING' })
    );

    estimatedWaitMinutes =
      typeof queue?.estimatedWaitMinutes === 'number' ? queue.estimatedWaitMinutes : null;
  }

  let workload = null;
  try {
    workload = await workloadBalancerService.calculateOperatorWorkload({
      operatorId: req.user._id,
      counterId: counter._id,
      centerId: resolvedCenterId,
    });
  } catch (err) {
    logger.warn('[Counter] Workload calculation failed for operator', { error: err.message });
  }

  return sendSuccess(res, {
    data: {
      counter: populatedCounter,
      center: populatedCounter.centerId || null,
      service: populatedCounter.serviceId || null,
      queue,
      waitingTokens,
      waitingCount,
      estimatedWaitMinutes,
      workload,
      requiresCounterSelection: false,
      selectedCenterId: resolvedCenterId,
      canSelectAnyCounter: req.user.role === 'ADMIN',
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

  const counter = await resolveAuthorizedCounter(req);

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

  // Broadcast operational workload update as counter capacity changed
  workloadBalancerService.broadcastWorkloadUpdate(counter.centerId);

  // Centralized Resource Allocation: a counter going ACTIVE creates allocatable
  // capacity, so the allocator gets a chance to fill it immediately.
  if (status === 'ACTIVE') {
    require('../services/resourceAllocationService').triggerAllocation(counter.centerId);
  }
  try {
    require('../services/resourceAllocationService').broadcastAllocationState(counter.centerId);
  } catch (_) {}

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

  // Broadcast operational workload update
  workloadBalancerService.broadcastWorkloadUpdate(counter.centerId);

  // Centralized Resource Allocation: re-pointing an ACTIVE counter at a service
  // makes a different queue allocatable through it.
  if (counter.status === 'ACTIVE' && serviceId) {
    require('../services/resourceAllocationService').triggerAllocation(counter.centerId);
  }

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
 * GET /api/counters/operators?centerId=...
 * List all operators for a center and their current assignment/workload status. Admin only.
 */
const getCenterOperators = asyncHandler(async (req, res) => {
  const targetCenterId = req.query.centerId;
  if (!targetCenterId || !MONGO_ID_REGEX.test(targetCenterId)) {
    return sendBadRequest(res, 'Valid centerId is required');
  }

  // Center-scoped admin check
  if (req.user.centerId && req.user.centerId.toString() !== targetCenterId.toString()) {
    return sendForbidden(res, 'You are not authorized to view operators for this center');
  }

  const center = await ServiceCenter.findById(targetCenterId).lean();
  if (!center) return sendNotFound(res, 'Service center not found');

  // Operators assigned to this center; fall back to unassigned pool staff if none assigned
  let operators = await User.find({
    centerId: targetCenterId,
    role: { $in: ['STAFF', 'ADMIN'] },
    isActive: { $ne: false },
  })
    .select('name email role isActive centerId assignedCounterId lastLogin')
    .sort({ role: 1, name: 1 })
    .lean();

  if (operators.length === 0) {
    operators = await User.find({
      role: { $in: ['STAFF', 'ADMIN'] },
      $or: [{ centerId: null }, { centerId: { $exists: false } }],
      isActive: { $ne: false },
    })
      .select('name email role isActive centerId assignedCounterId lastLogin')
      .sort({ role: 1, name: 1 })
      .lean();
  }

  // Find all counters for this center
  const counters = await Counter.find({ centerId: targetCenterId })
    .populate('serviceId', 'name tokenPrefix')
    .populate('currentTokenId', 'tokenCode status')
    .sort({ number: 1 })
    .lean({ virtuals: true });

  const counterByStaffId = new Map();
  const counterById = new Map();
  for (const c of counters) {
    counterById.set(c._id.toString(), c);
    if (c.staffId) {
      counterByStaffId.set(c.staffId.toString(), c);
    }
  }

  const mappedOperators = operators.map((op) => {
    const opIdStr = op._id.toString();
    let assignedCounter = counterByStaffId.get(opIdStr) || null;
    if (!assignedCounter && op.assignedCounterId) {
      assignedCounter = counterById.get(op.assignedCounterId.toString()) || null;
    }

    const assignedToOtherCenter = Boolean(
      op.assignedCounterId &&
      !assignedCounter &&
      op.centerId &&
      op.centerId.toString() !== targetCenterId.toString()
    );

    return {
      _id: op._id,
      name: op.name,
      email: op.email,
      role: op.role,
      isActive: op.isActive !== false,
      centerId: op.centerId || null,
      lastLogin: op.lastLogin || null,
      isAssigned: Boolean(assignedCounter),
      assignedToOtherCenter,
      assignedCounter: assignedCounter
        ? {
            _id: assignedCounter._id,
            number: assignedCounter.number,
            name: assignedCounter.name,
            status: assignedCounter.status,
            displayLabel: assignedCounter.displayLabel,
            service: assignedCounter.serviceId
              ? {
                  _id: assignedCounter.serviceId._id,
                  name: assignedCounter.serviceId.name,
                  tokenPrefix: assignedCounter.serviceId.tokenPrefix,
                }
              : null,
            currentToken: assignedCounter.currentTokenId
              ? {
                  _id: assignedCounter.currentTokenId._id,
                  tokenCode: assignedCounter.currentTokenId.tokenCode,
                  status: assignedCounter.currentTokenId.status,
                }
              : null,
            stats: assignedCounter.stats || { served: 0, skipped: 0 },
            utilizationPercent: assignedCounter.utilizationPercent || 0,
          }
        : null,
      workload: assignedCounter
        ? {
            servedToday: assignedCounter.stats?.served || 0,
            skippedToday: assignedCounter.stats?.skipped || 0,
            activeMinutesToday: assignedCounter.activeMinutesToday || 0,
            isServing:
              assignedCounter.status === 'ACTIVE' &&
              assignedCounter.currentTokenId?.status === 'SERVING',
          }
        : null,
    };
  });

  return sendSuccess(res, {
    data: {
      operators: mappedOperators,
      total: mappedOperators.length,
    },
  });
});

/**
 * PATCH /api/counters/:id/assign-staff
 * Assign or unassign a staff member to a counter. Admin only.
 */
const assignStaff = asyncHandler(async (req, res) => {
  const { staffId } = req.body;
  const counter = await Counter.findById(req.params.id);
  if (!counter) return sendNotFound(res, 'Counter not found');

  // Verify center ownership if user is center-scoped
  if (req.user.centerId && req.user.centerId.toString() !== counter.centerId.toString()) {
    return sendForbidden(res, 'You are not authorized to modify counters for this center');
  }

  if (staffId) {
    if (!MONGO_ID_REGEX.test(staffId)) {
      return sendBadRequest(res, 'Invalid staffId');
    }
    const staffUser = await User.findById(staffId);
    if (!staffUser || !['STAFF', 'ADMIN'].includes(staffUser.role)) {
      return sendBadRequest(res, 'Target user must be a valid STAFF or ADMIN');
    }

    if (staffUser.isActive === false) {
      return sendBadRequest(res, 'Cannot assign an inactive operator');
    }

    // Cross-center assignment check
    if (staffUser.centerId && staffUser.centerId.toString() !== counter.centerId.toString()) {
      return sendBadRequest(res, 'Operator belongs to a different service center');
    }

    // If counter currently has a DIFFERENT staff assigned, clear their assignment
    if (counter.staffId && counter.staffId.toString() !== staffUser._id.toString()) {
      await User.findByIdAndUpdate(counter.staffId, { $set: { assignedCounterId: null } });
    }

    // Unassign this staff member from other counters
    await Counter.updateMany(
      { staffId: staffUser._id, _id: { $ne: counter._id } },
      { $set: { staffId: null } }
    );

    // Sync staffUser assignment
    staffUser.assignedCounterId = counter._id;
    if (!staffUser.centerId) {
      staffUser.centerId = counter.centerId;
    }
    await staffUser.save();
    counter.staffId = staffUser._id;
  } else {
    // Unassigning
    if (counter.staffId) {
      await User.findByIdAndUpdate(counter.staffId, { $set: { assignedCounterId: null } });
    }
    counter.staffId = null;
  }

  await counter.save();

  const populated = await Counter.findById(counter._id)
    .populate('serviceId', 'name tokenPrefix')
    .populate('currentTokenId', 'tokenCode status')
    .populate('staffId', 'name email role')
    .lean({ virtuals: true });

  emitToCenter(counter.centerId.toString(), 'counter.updated', { counter: populated });

  // Broadcast operational workload update
  workloadBalancerService.broadcastWorkloadUpdate(counter.centerId);

  // Broadcast resource allocation snapshot
  try {
    const resourceAllocationService = require('../services/resourceAllocationService');
    await resourceAllocationService.broadcastAllocationState(counter.centerId);
  } catch (err) {
    logger.warn('[Counter] broadcastAllocationState failed after assignStaff', {
      error: err.message,
    });
  }

  return sendSuccess(res, {
    message: staffId ? 'Staff assigned to counter' : 'Staff unassigned from counter',
    data: { counter: populated },
  });
});

/**
 * POST /api/counters/:id/call-next
 * Call the next waiting token for this counter. Staff/Admin.
 *
 * Phase 2 second-stage geofencing: waiting tokens that are no longer inside the
 * service area are skipped automatically, in strict FIFO order, until the first
 * eligible token is found. The operator presses this once.
 */
const callNext = asyncHandler(async (req, res) => {
  const counter = await resolveAuthorizedCounter(req);

  const result = await queueService.callNext({
    counterId: req.params.id,
    centerId: counter.centerId.toString(),
    adminId: req.user._id.toString(),
  });

  const skipped = (result && result.skipped) || [];
  const blocked = (result && result.blocked) || [];

  // Human-readable summary. Never invents a token: if nobody was eligible the
  // message says so plainly.
  let message;
  if (result && result.token) {
    message = `Token ${result.token.tokenCode} called`;
    if (skipped.length > 0) {
      message = `${skipped.length} customer${skipped.length === 1 ? '' : 's'} skipped — outside service area. ${message}`;
    }
  } else if (skipped.length > 0) {
    message = `${skipped.length} customer${skipped.length === 1 ? '' : 's'} skipped — outside service area. No eligible customer currently in the service area.`;
  } else if (blocked.length > 0) {
    message = 'No eligible customer currently in the service area. The next customer in line has not shared a recent location, so nobody was skipped.';
  } else {
    message = 'No waiting tokens in the queue';
  }

  return sendSuccess(res, {
    message,
    data: {
      token: result ? result.token : null,
      counter: result ? result.counter : null,
      // Operator-facing detail. Deliberately excludes coordinates, GPS accuracy
      // and internal state names.
      skipped,
      blocked: blocked.map((b) => ({
        tokenId: b.tokenId,
        tokenCode: b.tokenCode,
        reason: b.locationStatus === 'LOCATION_STALE' ? 'location unconfirmed' : 'location unavailable',
      })),
      skippedCount: skipped.length,
    },
  });
});

/**
 * POST /api/counters/:id/recall
 * Re-call the current customer token at this counter. Staff/Admin.
 */
const recall = asyncHandler(async (req, res) => {
  const counter = await resolveAuthorizedCounter(req);

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
  const counter = await resolveAuthorizedCounter(req);

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
  const counter = await resolveAuthorizedCounter(req);

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
 * Skip the current token at this counter, or a specific WAITING token from this
 * counter's own queue. Staff/Admin.
 */
const skip = asyncHandler(async (req, res) => {
  const { tokenId } = req.body;
  if (tokenId) {
    if (typeof tokenId !== 'string' || !MONGO_ID_REGEX.test(tokenId)) {
      return sendBadRequest(res, 'Invalid tokenId');
    }
  }
  const counter = await resolveAuthorizedCounter(req);

  const targetTokenId = tokenId || counter.currentTokenId?.toString();
  if (!targetTokenId) {
    return sendBadRequest(res, 'No token to skip');
  }

  // Operational scope check. A client-supplied tokenId is never trusted to
  // belong to the counter being operated: an operator authorised on one counter
  // must not be able to reach into another center's or another service's queue.
  const target = await Token.findById(targetTokenId).select('centerId serviceId status tokenCode');
  if (!target) return sendNotFound(res, 'Token not found');

  const counterCenterId = idOf(counter.centerId);
  const counterServiceId = counter.serviceId ? idOf(counter.serviceId) : null;
  if (idOf(target.centerId) !== counterCenterId) {
    return sendForbidden(res, 'That token does not belong to this service center');
  }
  if (counterServiceId && idOf(target.serviceId) !== counterServiceId) {
    return sendForbidden(res, 'That token does not belong to this counter’s service queue');
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

/**
 * Resolve the center a counter-side request is allowed to act on.
 *
 * A STAFF account is bound to exactly one center. It may not read the
 * allocation state of, or force an allocation in, any other facility — that is
 * the same server-side scoping that already restricts the operator to the
 * counters they are personally assigned to.
 */
function resolveAccessibleCenterId(req, requestedCenterId) {
  if (req.user.role === 'STAFF') {
    if (!req.user.centerId) {
      const err = new Error('Your account is not assigned to a service center');
      err.status = 403;
      throw err;
    }
    if (requestedCenterId && requestedCenterId.toString() !== req.user.centerId.toString()) {
      const err = new Error('You are not authorized to view another service center');
      err.status = 403;
      throw err;
    }
    return req.user.centerId.toString();
  }

  if (!requestedCenterId) return null;
  if (!MONGO_ID_REGEX.test(String(requestedCenterId))) {
    const err = new Error('Invalid centerId');
    err.status = 400;
    throw err;
  }
  return requestedCenterId.toString();
}

/**
 * GET /api/counters/allocation/overview?centerId=...
 * Authoritative, real-time centralized allocation snapshot for a center:
 * every counter with its status, current customer, workload and allocation
 * state, plus live waiting and serving counts.
 */
const getAllocationOverview = asyncHandler(async (req, res) => {
  const targetCenterId = resolveAccessibleCenterId(req, req.query.centerId);
  if (!targetCenterId) {
    return sendBadRequest(res, 'centerId query parameter is required');
  }

  const resourceAllocationService = require('../services/resourceAllocationService');
  const overview = await resourceAllocationService.getResourceAllocationOverview(targetCenterId);
  return sendSuccess(res, { data: overview });
});

/**
 * POST /api/counters/allocation/trigger
 * Run one allocation pass immediately instead of waiting for the next event.
 * Admin only. Returns exactly which customers were sent to which counters.
 */
const triggerAllocationNow = asyncHandler(async (req, res) => {
  const targetCenterId = resolveAccessibleCenterId(req, req.body?.centerId);
  if (!targetCenterId) {
    return sendBadRequest(res, 'centerId is required');
  }

  const resourceAllocationService = require('../services/resourceAllocationService');
  const result = await resourceAllocationService.allocateNextForCenter(targetCenterId);
  return sendSuccess(res, {
    message: `Allocated ${result.allocatedCount} token(s)`,
    data: result,
  });
});

module.exports = {
  list,
  getOperableCounters,
  getById,
  getOperatorCounter,
  getCenterOperators,
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
  getAllocationOverview,
  triggerAllocationNow,
  createValidation,
};

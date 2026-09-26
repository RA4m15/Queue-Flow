'use strict';

const mongoose = require('mongoose');
const Queue = require('../models/Queue');
const { Token, TOKEN_STATUSES } = require('../models/Token');
const Counter = require('../models/Counter');
const ServiceCenter = require('../models/ServiceCenter');
const Service = require('../models/Service');
const QueueEvent = require('../models/QueueEvent');
const { getTodayDateString, formatTokenCode, generateQRData } = require('../utils/tokenUtils');
const waitTimeService = require('./waitTimeService');
const notificationService = require('./notificationService');
const { emitToCenter, emitToUser, emitToCounter } = require('../config/socket');

/**
 * Sanitize a token payload before emitting to public center / counter rooms.
 * Removes customer-identifying fields (userId) to ensure public queue displays
 * and center listeners never receive customer ownership or PII.
 *
 * @param {object} token - Populated or plain token object
 * @returns {object} Sanitized token object safe for public center broadcasts
 */
function _sanitizeTokenForCenter(token) {
  if (!token || typeof token !== 'object') return token;
  const { userId, ...safeToken } = token;
  return safeToken;
}

/**
 * Get or create today's Queue document for a center+service pair.
 * Creates with default values if it does not exist.
 *
 * @param {string} centerId
 * @param {string} serviceId
 * @returns {Promise<Queue>}
 */
async function getOrCreateQueue(centerId, serviceId) {
  const date = getTodayDateString();
  let queue = await Queue.findOne({ centerId, serviceId, date });

  if (!queue) {
    queue = await Queue.create({
      centerId,
      serviceId,
      date,
      status: 'OPEN',
      lastIssuedNumber: 0,
      totalIssued: 0,
      waitingCount: 0,
      activeCount: 0,
      completedCount: 0,
      abandonedCount: 0,
    });
  }

  return queue;
}

/**
 * Join a queue: generate a token atomically.
 *
 * Business rules:
 * - A user may not have more than one active token per center+service (WAITING/CALLED/SERVING).
 * - Service center must exist and be open.
 * - Service must exist, be active, and belong to the requested center.
 * - Queue must be OPEN.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.centerId
 * @param {string} params.serviceId
 * @param {boolean} [params.notifyApp=true]
 * @param {string} [params.channel='WEB']
 * @param {object} [params.channelMetadata={}]
 * @returns {Promise<{ token: Token, queue: Queue }>}
 */
async function joinQueue({
  userId,
  centerId,
  serviceId,
  notifyApp = true,
  notifySms = false,
  channel = 'WEB',
  channelMetadata = {},
}) {
  // 1. Verify service center exists and is open
  const center = await ServiceCenter.findById(centerId);
  if (!center) {
    const err = new Error('Service center not found');
    err.status = 404;
    throw err;
  }

  if (!center.isOpen) {
    const err = new Error('Service center is currently closed');
    err.status = 400;
    throw err;
  }

  // 2. Verify service exists, belongs to center, and is active
  const service = await Service.findById(serviceId);
  if (!service) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }

  if (service.centerId.toString() !== centerId.toString()) {
    const err = new Error('The requested service does not belong to this service center');
    err.status = 400;
    throw err;
  }

  if (!service.isActive) {
    const err = new Error('Service is not currently available');
    err.status = 400;
    throw err;
  }

  // 3. Check for existing active token
  const existingToken = await Token.findOne({
    userId,
    centerId,
    serviceId,
    status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
  });

  if (existingToken) {
    const err = new Error('You already have an active token for this service at this center');
    err.status = 409;
    err.existingToken = existingToken;
    throw err;
  }

  // 3. Atomically increment queue counters and create token inside a MongoDB transaction
  const date = getTodayDateString();
  let token;
  let queue;
  let waitEstimate;
  let tokenCode;
  let position;

  let session = null;
  try {
    session = await mongoose.startSession();
  } catch (_) {
    session = null;
  }

  if (session) {
    try {
      await session.withTransaction(async () => {
        // Re-check for existing active token within transaction snapshot
        const activeInTx = await Token.findOne({
          userId,
          centerId,
          serviceId,
          status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
        }).session(session);

        if (activeInTx) {
          const err = new Error('You already have an active token for this service at this center');
          err.status = 409;
          err.existingToken = activeInTx;
          throw err;
        }

        queue = await Queue.findOneAndUpdate(
          { centerId, serviceId, date },
          {
            $inc: { lastIssuedNumber: 1, totalIssued: 1, waitingCount: 1 },
            $setOnInsert: {
              centerId,
              serviceId,
              date,
              status: 'OPEN',
              completedCount: 0,
              abandonedCount: 0,
              activeCount: 0,
            },
          },
          { new: true, upsert: true, session }
        );

        if (queue.status !== 'OPEN') {
          const err = new Error('This queue is currently not accepting new tokens');
          err.status = 409;
          throw err;
        }

        const tokenNumber = queue.lastIssuedNumber;
        tokenCode = formatTokenCode(service.tokenPrefix, tokenNumber);

        waitEstimate = await waitTimeService.estimateWait({
          centerId,
          serviceId,
          queue,
          service,
        });

        position = queue.waitingCount;
        // Generate temporary placeholder qrData (tokenId not yet known)
        const tmpQrResult = generateQRData('pending', centerId.toString(), serviceId.toString());

        const [created] = await Token.create(
          [
            {
              tokenCode,
              tokenNumber,
              userId,
              centerId,
              serviceId,
              status: 'WAITING',
              initialPosition: position,
              currentPosition: position,
              waitEstimateMinutes: waitEstimate,
              qrData: tmpQrResult.qrData,
              notifyApp,
              notifySms,
              channel,
              channelMetadata,
            },
          ],
          { session }
        );

        // Regenerate signed QR with the real tokenId now that the document exists
        const finalQrResult = generateQRData(created._id.toString(), centerId.toString(), serviceId.toString());
        created.qrData = finalQrResult.qrData;
        created.qrNonce = finalQrResult.nonce;
        created.qrIssuedAt = finalQrResult.issuedAt;
        await created.save({ session });
        token = created;
      });
    } catch (err) {
      if (err.code === 11000) {
        const conflictErr = new Error('You already have an active token for this service at this center');
        conflictErr.status = 409;
        throw conflictErr;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  } else {
    // Non-transactional fallback for standalone Mongo instances without replica set
    queue = await Queue.findOneAndUpdate(
      { centerId, serviceId, date },
      {
        $inc: { lastIssuedNumber: 1, totalIssued: 1, waitingCount: 1 },
        $setOnInsert: {
          centerId,
          serviceId,
          date,
          status: 'OPEN',
          completedCount: 0,
          abandonedCount: 0,
          activeCount: 0,
        },
      },
      { new: true, upsert: true }
    );

    if (queue.status !== 'OPEN') {
      await Queue.findByIdAndUpdate(queue._id, {
        $inc: { lastIssuedNumber: -1, totalIssued: -1, waitingCount: -1 },
      });
      const err = new Error('This queue is currently not accepting new tokens');
      err.status = 409;
      throw err;
    }

    const tokenNumber = queue.lastIssuedNumber;
    tokenCode = formatTokenCode(service.tokenPrefix, tokenNumber);

    waitEstimate = await waitTimeService.estimateWait({
      centerId,
      serviceId,
      queue,
      service,
    });

    position = queue.waitingCount;
    // Generate temporary placeholder (tokenId not yet known)
    const tmpQrResult = generateQRData('pending', centerId.toString(), serviceId.toString());

    try {
      token = await Token.create({
        tokenCode,
        tokenNumber,
        userId,
        centerId,
        serviceId,
        status: 'WAITING',
        initialPosition: position,
        currentPosition: position,
        waitEstimateMinutes: waitEstimate,
        qrData: tmpQrResult.qrData,
        notifyApp,
        notifySms,
        channel,
        channelMetadata,
      });
    } catch (err) {
      if (err.code === 11000) {
        await Queue.findByIdAndUpdate(queue._id, {
          $inc: { lastIssuedNumber: -1, totalIssued: -1, waitingCount: -1 },
        });
        const conflictErr = new Error('You already have an active token for this service at this center');
        conflictErr.status = 409;
        throw conflictErr;
      }
      throw err;
    }

    // Regenerate signed QR with the real tokenId
    const finalQrResult = generateQRData(token._id.toString(), centerId.toString(), serviceId.toString());
    token.qrData = finalQrResult.qrData;
    token.qrNonce = finalQrResult.nonce;
    token.qrIssuedAt = finalQrResult.issuedAt;
    await token.save();
  }

  // 8. Log the event
  await QueueEvent.create({
    centerId,
    tokenId: token._id,
    eventType: 'TOKEN_CREATED',
    performedBy: userId,
    metadata: { tokenCode, serviceId, position, waitEstimate },
  });

  // 9. Emit Socket.IO events
  const populatedToken = await Token.findById(token._id)
    .populate('serviceId', 'name tokenPrefix')
    .populate('centerId', 'name')
    .populate('counterId', 'name number')
    .lean();

  emitToCenter(centerId.toString(), 'queue.updated', {
    centerId,
    serviceId,
    waitingCount: queue.waitingCount,
    totalIssued: queue.totalIssued,
  });

  emitToUser(userId.toString(), 'token.created', { token: populatedToken });

  // 10. Send creation notification
  await notificationService.sendTokenNotification(token, 'TOKEN_CREATED', {
    title: 'Token Generated',
    body: `Your token ${tokenCode} is confirmed. Position: ${position}. Est. wait: ${waitEstimate} min.`,
  });

  return { token: populatedToken, queue };
}

/**
 * Call the next waiting token for a counter.
 *
 * @param {object} params
 * @param {string} params.counterId
 * @param {string} params.centerId
 * @param {string} params.adminId - User performing the action
 * @returns {Promise<{ token: Token, counter: Counter } | null>}
 */
async function callNext({ counterId, centerId, adminId }) {
  const counter = await Counter.findById(counterId).populate('serviceId');

  if (!counter) {
    const err = new Error('Counter not found');
    err.status = 404;
    throw err;
  }

  if (counter.status !== 'ACTIVE') {
    const err = new Error('Counter is not active');
    err.status = 400;
    throw err;
  }

  if (!counter.serviceId) {
    const err = new Error('No service assigned to this counter');
    err.status = 400;
    throw err;
  }

  // Atomically find and claim the next WAITING token (oldest first)
  const now = new Date();
  const nextToken = await Token.findOneAndUpdate(
    {
      centerId,
      serviceId: counter.serviceId._id,
      status: 'WAITING',
    },
    {
      status: 'CALLED',
      calledAt: now,
      counterId: counter._id,
      servedBy: adminId || null,
    },
    {
      sort: { createdAt: 1 },
      new: true,
    }
  ).populate('userId', 'name email preferences');

  if (!nextToken) {
    return null; // Queue is empty — no token to call
  }

  // If the counter was serving or had someone called, complete it defensively
  if (counter.currentTokenId && counter.currentTokenId.toString() !== nextToken._id.toString()) {
    await Token.findOneAndUpdate(
      { _id: counter.currentTokenId, status: { $in: ['CALLED', 'SERVING'] } },
      { status: 'COMPLETED', completedAt: now, servedBy: adminId || null }
    );
  }

  // Update counter
  counter.currentTokenId = nextToken._id;
  counter.servingStartedAt = now;
  await counter.save();

  // Update queue counts
  await Queue.findOneAndUpdate(
    { centerId, serviceId: counter.serviceId._id, date: getTodayDateString() },
    { $inc: { waitingCount: -1, activeCount: 1 } }
  );

  // Log event
  await QueueEvent.create({
    centerId,
    tokenId: nextToken._id,
    counterId: counter._id,
    eventType: 'TOKEN_CALLED',
    performedBy: adminId,
    metadata: { tokenCode: nextToken.tokenCode, counterName: counter.name },
  });

  // Update positions for all remaining waiting tokens
  await _updateWaitingPositions(centerId, counter.serviceId._id);

  // Populate and emit
  const populatedToken = await Token.findById(nextToken._id)
    .populate('serviceId', 'name tokenPrefix')
    .populate('centerId', 'name')
    .populate('counterId', 'name number displayLabel')
    .populate('userId', 'name')
    .lean();

  const populatedCounter = await Counter.findById(counter._id)
    .populate('serviceId', 'name')
    .populate('currentTokenId', 'tokenCode status')
    .lean();

  const publicToken = _sanitizeTokenForCenter(populatedToken);

  // Emit to center room (sanitized for public display boards)
  emitToCenter(centerId.toString(), 'token.called', {
    token: publicToken,
    counter: populatedCounter,
  });

  // Emit to verified customer's private room
  emitToUser(nextToken.userId.toString(), 'token.called', {
    token: populatedToken,
    counter: populatedCounter,
  });

  // Emit to counter display kiosk
  emitToCounter(centerId.toString(), counterId.toString(), 'counter.updated', {
    counter: populatedCounter,
    token: publicToken,
  });

  // Notify the customer
  await notificationService.evaluateTokenCalledAlert({
    token: nextToken,
    counter,
    serviceName: counter.serviceId?.name,
  });

  return { token: populatedToken, counter: populatedCounter };
}

/**
 * Mark a token as SERVING (customer has arrived at counter).
 * Typically triggered by staff at the counter.
 */
async function startServing({ tokenId, counterId, adminId }) {
  const existing = await Token.findById(tokenId);
  if (!existing) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (existing.status !== 'CALLED') {
    const err = new Error(`Cannot start serving: token status is ${existing.status}`);
    err.status = 409;
    throw err;
  }

  const token = await Token.findOneAndUpdate(
    { _id: tokenId, status: 'CALLED' },
    { status: 'SERVING', servingAt: new Date(), servedBy: adminId || null },
    { new: true }
  );

  if (!token) {
    const err = new Error('Cannot start serving: token state changed concurrently');
    err.status = 409;
    throw err;
  }

  const counter = await Counter.findById(counterId);
  if (counter) {
    counter.servingStartedAt = new Date();
    await counter.save();
  }

  await Queue.findOneAndUpdate(
    { centerId: token.centerId, serviceId: token.serviceId, date: getTodayDateString() },
    { $inc: { activeCount: 0 } } // already counted in CALLED→SERVING
  );

  await QueueEvent.create({
    centerId: token.centerId,
    tokenId: token._id,
    counterId,
    eventType: 'TOKEN_SERVING',
    performedBy: adminId,
    metadata: { tokenCode: token.tokenCode },
  });

  const populated = await Token.findById(token._id)
    .populate('serviceId', 'name')
    .populate('counterId', 'name number')
    .lean();

  emitToCenter(token.centerId.toString(), 'token.serving', { token: _sanitizeTokenForCenter(populated) });
  emitToUser(token.userId.toString(), 'token.serving', { token: populated });

  return populated;
}

/**
 * Complete a token (service delivered successfully).
 */
async function completeToken({ tokenId, counterId, adminId }) {
  const existing = await Token.findById(tokenId);
  if (!existing) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (!['CALLED', 'SERVING'].includes(existing.status)) {
    const err = new Error(`Cannot complete: token status is ${existing.status}`);
    err.status = 409;
    throw err;
  }

  const now = new Date();
  const startTime = existing.servingAt || existing.calledAt || existing.createdAt;
  const actualServiceSeconds = Math.round((now - startTime) / 1000);

  const token = await Token.findOneAndUpdate(
    { _id: tokenId, status: { $in: ['CALLED', 'SERVING'] } },
    {
      status: 'COMPLETED',
      completedAt: now,
      actualServiceSeconds,
      currentPosition: null,
      servedBy: adminId || existing.servedBy || null,
    },
    { new: true }
  );

  if (!token) {
    const err = new Error('Cannot complete: token already completed or state changed concurrently');
    err.status = 409;
    throw err;
  }

  // Update counter stats
  const counter = await Counter.findById(counterId);
  if (counter) {
    const prevAvg = counter.stats.avgServiceSeconds || actualServiceSeconds;
    const prevCount = counter.stats.served || 0;
    const newAvg = Math.round((prevAvg * prevCount + actualServiceSeconds) / (prevCount + 1));

    counter.stats.served += 1;
    counter.stats.avgServiceSeconds = newAvg;
    counter.currentTokenId = null;
    counter.servingStartedAt = null;
    await counter.save();
  }

  // Update queue counts and running avg service time
  const queue = await Queue.findOne({
    centerId: token.centerId,
    serviceId: token.serviceId,
    date: getTodayDateString(),
  });

  if (queue) {
    const prevAvg = queue.avgServiceTimeSeconds || actualServiceSeconds;
    const prevDone = queue.completedCount || 0;
    const newQueueAvg = Math.round((prevAvg * prevDone + actualServiceSeconds) / (prevDone + 1));

    await Queue.findByIdAndUpdate(queue._id, {
      $inc: { activeCount: -1, completedCount: 1 },
      $set: { avgServiceTimeSeconds: newQueueAvg },
    });
  }

  await QueueEvent.create({
    centerId: token.centerId,
    tokenId: token._id,
    counterId,
    eventType: 'TOKEN_COMPLETED',
    performedBy: adminId,
    metadata: { tokenCode: token.tokenCode, actualServiceSeconds },
  });

  // Tier 3: a completion changes the real observed service history that the
  // context-aware EWT engine reads. Drop the memoised context immediately.
  waitTimeService.invalidateServiceContext(token.centerId, token.serviceId);

  const populated = await Token.findById(token._id)
    .populate('serviceId', 'name')
    .populate('centerId', 'name')
    .populate('counterId', 'name number')
    .lean();

  const populatedCounter = counter
    ? await Counter.findById(counter._id).populate('serviceId', 'name').lean()
    : null;

  emitToCenter(token.centerId.toString(), 'token.completed', {
    token: _sanitizeTokenForCenter(populated),
    counter: populatedCounter,
  });
  emitToUser(token.userId.toString(), 'token.completed', { token: populated });
  if (populatedCounter) {
    emitToCounter(token.centerId.toString(), counterId.toString(), 'counter.updated', {
      counter: populatedCounter,
      token: null,
    });
  }

  await notificationService.sendTokenNotification(token, 'TOKEN_COMPLETED', {
    title: 'Service Completed',
    body: `Thank you! Your service for token ${token.tokenCode} has been completed.`,
  });

  return { token: populated, counter: populatedCounter };
}

/**
 * Skip a token (customer no-show or admin action).
 */
async function skipToken({ tokenId, counterId, adminId }) {
  const existing = await Token.findById(tokenId);
  if (!existing) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (!['WAITING', 'CALLED'].includes(existing.status)) {
    const err = new Error(`Cannot skip: token status is ${existing.status}`);
    err.status = 409;
    throw err;
  }

  const wasWaiting = existing.status === 'WAITING';
  const token = await Token.findOneAndUpdate(
    { _id: tokenId, status: { $in: ['WAITING', 'CALLED'] } },
    {
      status: 'SKIPPED',
      completedAt: new Date(),
      currentPosition: null,
      servedBy: adminId || null,
    },
    { new: true }
  );

  if (!token) {
    const err = new Error('Cannot skip: token already skipped or state changed concurrently');
    err.status = 409;
    throw err;
  }

  if (counterId) {
    const counter = await Counter.findById(counterId);
    if (counter && counter.currentTokenId?.toString() === tokenId.toString()) {
      counter.currentTokenId = null;
      counter.servingStartedAt = null;
      counter.stats.skipped = (counter.stats.skipped || 0) + 1;
      await counter.save();
    }
  }

  // Update queue counts
  const queueUpdate = wasWaiting
    ? { $inc: { waitingCount: -1, abandonedCount: 1 } }
    : { $inc: { activeCount: -1, abandonedCount: 1 } };

  await Queue.findOneAndUpdate(
    { centerId: token.centerId, serviceId: token.serviceId, date: getTodayDateString() },
    queueUpdate
  );

  await QueueEvent.create({
    centerId: token.centerId,
    tokenId: token._id,
    counterId,
    eventType: 'TOKEN_SKIPPED',
    performedBy: adminId,
    metadata: { tokenCode: token.tokenCode, wasWaiting },
  });

  // Tier 3: skipping changes the real abandonment context used for explainability.
  waitTimeService.invalidateServiceContext(token.centerId, token.serviceId);

  if (wasWaiting) {
    await _updateWaitingPositions(token.centerId, token.serviceId);
  }

  const populated = await Token.findById(token._id)
    .populate('serviceId', 'name')
    .populate('centerId', 'name')
    .populate('counterId', 'name number')
    .lean();

  emitToCenter(token.centerId.toString(), 'token.skipped', { token: _sanitizeTokenForCenter(populated) });
  emitToUser(token.userId.toString(), 'token.skipped', { token: populated });

  await notificationService.sendTokenNotification(token, 'TOKEN_SKIPPED', {
    title: 'Token Skipped',
    body: `Your token ${token.tokenCode} was skipped. Please contact the front desk if you need assistance.`,
  });

  return populated;
}

/**
 * Re-call the customer token currently at this counter.
 *
 * @param {object} params
 * @param {string} params.counterId
 * @param {string} params.centerId
 * @param {string} params.adminId
 * @returns {Promise<{ token: Token, counter: Counter }>}
 */
async function recallToken({ counterId, centerId, adminId }) {
  const counter = await Counter.findById(counterId).populate('serviceId');
  if (!counter) {
    const err = new Error('Counter not found');
    err.status = 404;
    throw err;
  }

  if (!counter.currentTokenId) {
    const err = new Error('No token currently called at this counter to re-call');
    err.status = 400;
    throw err;
  }

  const token = await Token.findById(counter.currentTokenId)
    .populate('serviceId', 'name tokenPrefix')
    .populate('centerId', 'name')
    .populate('counterId', 'name number displayLabel')
    .populate('userId', 'name preferences');

  if (!token) {
    const err = new Error('Current token not found');
    err.status = 404;
    throw err;
  }

  if (token.status !== 'CALLED') {
    const err = new Error(`Cannot re-call: token status is ${token.status}. Only CALLED tokens can be re-called.`);
    err.status = 409;
    throw err;
  }

  const populatedCounter = await Counter.findById(counter._id)
    .populate('serviceId', 'name')
    .populate('currentTokenId', 'tokenCode status')
    .lean();

  const publicToken = _sanitizeTokenForCenter(token);

  // Emit recall to center display (TTS callout and TV display)
  emitToCenter(centerId.toString(), 'token.called', {
    token: publicToken,
    counter: populatedCounter,
    isRecall: true,
  });

  // Emit to user private room
  const customerUserId = token.userId._id ? token.userId._id.toString() : token.userId.toString();
  emitToUser(customerUserId, 'token.called', {
    token,
    counter: populatedCounter,
    isRecall: true,
  });

  // Emit to counter kiosk
  emitToCounter(centerId.toString(), counterId.toString(), 'counter.updated', {
    counter: populatedCounter,
    token: publicToken,
  });

  // Log event
  await QueueEvent.create({
    centerId,
    tokenId: token._id,
    counterId: counter._id,
    eventType: 'TOKEN_CALLED',
    performedBy: adminId,
    metadata: { tokenCode: token.tokenCode, counterName: counter.name, isRecall: true },
  });

  // Send notification to customer
  await notificationService.sendTokenNotification(token, 'TOKEN_CALLED', {
    title: 'Token Re-Called!',
    body: `Recall: Token ${token.tokenCode} — please proceed immediately to Counter ${counter.number} (${counter.serviceId?.name || ''}).`,
    dedupeKey: `${token._id}_RECALL_${Date.now()}`,
  });

  return { token, counter: populatedCounter };
}

/**
 * Customer cancels their own token.
 */
async function cancelToken({ tokenId, userId }) {
  const token = await Token.findById(tokenId);
  if (!token) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (token.userId.toString() !== userId.toString()) {
    const err = new Error('You can only cancel your own tokens');
    err.status = 403;
    throw err;
  }

  if (!['WAITING'].includes(token.status)) {
    const err = new Error(`Token cannot be cancelled in status: ${token.status}`);
    err.status = 400;
    throw err;
  }

  token.status = 'CANCELLED';
  await token.save();

  await Queue.findOneAndUpdate(
    { centerId: token.centerId, serviceId: token.serviceId, date: getTodayDateString() },
    { $inc: { waitingCount: -1, abandonedCount: 1 } }
  );

  await _updateWaitingPositions(token.centerId, token.serviceId);

  await QueueEvent.create({
    centerId: token.centerId,
    tokenId: token._id,
    eventType: 'TOKEN_CANCELLED',
    performedBy: userId,
    metadata: { tokenCode: token.tokenCode },
  });

  // Tier 3: cancellation changes the real abandonment context.
  waitTimeService.invalidateServiceContext(token.centerId, token.serviceId);

  const populated = await Token.findById(token._id).populate('serviceId', 'name').lean();

  emitToCenter(token.centerId.toString(), 'token.cancelled', { token: _sanitizeTokenForCenter(populated) });
  emitToUser(userId.toString(), 'token.cancelled', { token: populated });

  return populated;
}

/**
 * Expire a token that was called but the customer didn't show up.
 * Called by a scheduled job or the no-show handler.
 */
async function expireToken({ tokenId, counterId }) {
  const token = await Token.findById(tokenId);
  if (!token || token.status !== 'CALLED') return null;

  token.status = 'EXPIRED';
  await token.save();

  if (counterId) {
    await Counter.findByIdAndUpdate(counterId, {
      $set: { currentTokenId: null, servingStartedAt: null },
    });
  }

  await Queue.findOneAndUpdate(
    { centerId: token.centerId, serviceId: token.serviceId, date: getTodayDateString() },
    { $inc: { activeCount: -1, abandonedCount: 1 } }
  );

  await QueueEvent.create({
    centerId: token.centerId,
    tokenId: token._id,
    counterId: counterId || null,
    eventType: 'TOKEN_EXPIRED',
    metadata: { tokenCode: token.tokenCode },
  });

  // Tier 3: expiry changes the real abandonment context.
  waitTimeService.invalidateServiceContext(token.centerId, token.serviceId);

  const populated = await Token.findById(token._id).populate('serviceId', 'name').lean();
  emitToCenter(token.centerId.toString(), 'token.expired', { token: _sanitizeTokenForCenter(populated) });
  emitToUser(token.userId.toString(), 'token.expired', { token: populated });

  await notificationService.sendTokenNotification(token, 'TOKEN_EXPIRED', {
    title: 'Token Expired',
    body: `Your token ${token.tokenCode} has expired as you were not present at the counter.`,
  });

  return populated;
}

/**
 * Get live queue status for a center (all services).
 *
 * Tier 3 / Feature 1: each entry carries the server-authoritative,
 * context-aware `estimatedWaitMinutes`. Clients render that value and must not
 * recompute an estimate locally.
 */
async function getQueueStatus(centerId) {
  const date = getTodayDateString();
  const queues = await Queue.find({ centerId, date })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .lean();

  const counters = await Counter.find({ centerId })
    .populate('serviceId', 'name')
    .populate('currentTokenId', 'tokenCode status')
    .lean();

  const result = await Promise.all(
    queues.map(async (q) => {
      const serviceId = q.serviceId?._id || q.serviceId;
      const ewt = await waitTimeService.estimateContextAwareWait({
        centerId,
        serviceId,
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
        abandonedCount: q.abandonedCount,
        totalIssued: q.totalIssued,
        avgServiceTimeSeconds: q.avgServiceTimeSeconds,
        lastIssuedNumber: q.lastIssuedNumber,
        estimatedWaitMinutes: ewt.minutes,
        counters: counters.filter(
          (c) => c.serviceId && c.serviceId._id.toString() === serviceId.toString()
        ),
      };
    })
  );

  return result;
}

/**
 * Internal: recalculate and update currentPosition for all WAITING tokens
 * in a service queue. Called after any token state change.
 *
 * Positions are assigned 1, 2, 3... based on createdAt order.
 *
 * Tier 3 / Feature 1: the per-token wait estimate is produced by the single
 * authoritative context-aware EWT engine (waitTimeService), not by local maths.
 * It reads the real Queue document, the real Service document, the real live
 * Counter state and the real bounded service history, so the estimate changes
 * automatically on join / call / serve / complete / skip / cancel / expire and
 * whenever a counter opens, closes, breaks or is re-assigned.
 */
async function _updateWaitingPositions(centerId, serviceId) {
  const waitingTokens = await Token.find({
    centerId,
    serviceId,
    status: 'WAITING',
  })
    .sort({ createdAt: 1 })
    .select('_id userId centerId serviceId tokenCode status notifyApp notifySms channel channelMetadata waitEstimateMinutes');

  const queue = await Queue.findOne({ centerId, serviceId, date: getTodayDateString() });
  const service = await Service.findById(serviceId).select('name avgServiceTimeMinutes');

  // Tier 1 semantics preserved: a token at position p is estimated for a queue
  // of depth p (this is the exact depth the legacy formula used here).
  const estimate = await _estimatePositionWait({ centerId, serviceId, queue, service });

  const bulkOps = waitingTokens.map((token, idx) => {
    const position = idx + 1;
    const newWait = estimate(position);
    return {
      updateOne: {
        filter: { _id: token._id },
        update: { $set: { currentPosition: position, waitEstimateMinutes: newWait } },
      },
    };
  });

  if (bulkOps.length > 0) {
    await Token.bulkWrite(bulkOps);
  }

  // Emit position updates to each affected user and evaluate rule-based alerts
  for (const [idx, token] of waitingTokens.entries()) {
    const position = idx + 1;
    const newWait = estimate(position);
    const peopleAhead = Math.max(0, position - 1);
    emitToUser(token.userId.toString(), 'token.position_updated', {
      tokenId: token._id,
      currentPosition: position,
      position,
      peopleAhead,
      waitEstimateMinutes: newWait,
      estimatedWaitMinutes: newWait,
    });

    // Evaluate 5-tokens-away and next-in-line alerts
    await notificationService.evaluateQueuePositionAlerts({
      token,
      position,
      peopleAhead,
      serviceName: service?.name,
    });
  }

  // Emit queue.updated to center room for live display boards, monitors, and dashboards
  emitToCenter(centerId.toString(), 'queue.updated', {
    serviceId: serviceId.toString(),
    waitingCount: waitingTokens.length,
    activeCount: queue ? queue.activeCount : 0,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Build a per-position wait estimator bound to the current real queue context.
 *
 * The historical context is fetched ONCE per recalculation (not once per token),
 * then the real live capacity is read once, so this stays cheap even for a long
 * queue. Positions scale linearly with the Tier 1 depth semantics.
 *
 * @returns {Promise<(position:number) => number>} minutes for a queue position
 */
async function _estimatePositionWait({ centerId, serviceId, queue, service }) {
  try {
    // One real capacity snapshot shared by every position in this queue.
    const snapshot = await waitTimeService.getServiceContext({ centerId, serviceId });
    const history = snapshot ? snapshot.history : null;

    const Counter = require('../models/Counter');
    const counters = await Counter.find({
      centerId,
      serviceId,
      status: 'ACTIVE',
    })
      .select('servingStartedAt currentTokenId')
      .lean();

    // Effective service time, resolved with the engine's documented precedence.
    let effectiveSeconds = null;
    let source = 'SERVICE_CONFIG';
    if (history) {
      if (history.hourOfDayCount >= waitTimeService.CONFIG.MIN_SAMPLES && history.hourOfDayMeanSeconds > 0) {
        effectiveSeconds = history.hourOfDayMeanSeconds;
        source = 'RECENT_HOUR';
      } else if (history.recentCount >= waitTimeService.CONFIG.MIN_SAMPLES && history.recentMeanSeconds > 0) {
        effectiveSeconds = history.recentMeanSeconds;
        source = 'RECENT_WINDOW';
      } else if (history.dailyCount >= 1 && history.dailyMeanSeconds > 0) {
        effectiveSeconds = history.dailyMeanSeconds;
        source = 'DAILY_WINDOW';
      }
    }
    if (!effectiveSeconds && queue && queue.avgServiceTimeSeconds > 0) {
      effectiveSeconds = queue.avgServiceTimeSeconds;
      source = 'QUEUE_RUNNING_AVERAGE';
    }
    if (!effectiveSeconds && service && service.avgServiceTimeMinutes > 0) {
      effectiveSeconds = Math.round(service.avgServiceTimeMinutes * 60);
      source = 'SERVICE_CONFIG';
    }
    if (!effectiveSeconds) {
      effectiveSeconds = waitTimeService.CONFIG.SERVICE_CONFIG_FALLBACK_MINUTES * 60;
      source = 'SERVICE_CONFIG_FALLBACK';
    }

    const now = Date.now();
    let residualSeconds = 0;
    for (const counter of counters) {
      if (counter.servingStartedAt && counter.currentTokenId) {
        const startedAt = new Date(counter.servingStartedAt).getTime();
        const elapsed = Number.isFinite(startedAt) ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
        residualSeconds += Math.max(0, effectiveSeconds - elapsed);
      } else {
        residualSeconds += effectiveSeconds;
      }
    }

    const freeCapacity = effectiveSeconds > 0 ? residualSeconds / effectiveSeconds : 0;

    return (position) => {
      const depth = Number.isFinite(Number(position)) ? Math.max(0, Math.floor(Number(position))) : 0;
      if (depth === 0) return 0;

      // Degraded capacity: sequential service, mirroring the Tier 1 guard.
      const seconds = freeCapacity > 0 ? (depth * effectiveSeconds) / freeCapacity : depth * effectiveSeconds;
      if (!Number.isFinite(seconds) || seconds < 0) return Math.max(1, depth);
      // Math.round matches the context-aware engine's rounding convention.
      return Math.max(1, Math.min(Math.round(seconds / 60), 525600));
    };
  } catch (_err) {
    // Deterministic Tier 1 fallback: never block a queue mutation on estimation.
    const avgMinutes =
      queue?.avgServiceTimeSeconds
        ? Math.ceil(queue.avgServiceTimeSeconds / 60)
        : service?.avgServiceTimeMinutes || 8;
    return (position) => {
      const depth = Number.isFinite(Number(position)) ? Math.max(0, Math.floor(Number(position))) : 0;
      return depth === 0 ? 0 : Math.max(1, Math.round(depth * avgMinutes));
    };
  }
}

/**
 * Check and issue no-show warnings for tokens in CALLED state
 * approaching the center's configured no-show timeout.
 *
 * @param {string} centerId
 * @returns {Promise<Array>} Array of generated warning notifications
 */
async function checkNoShowWarnings(centerId) {
  const center = await ServiceCenter.findById(centerId);
  if (!center) return [];

  const timeoutSeconds = center.noShowTimeoutSeconds || 120;
  const warningThresholdSec = Math.floor(timeoutSeconds / 2);
  const now = new Date();

  const calledTokens = await Token.find({
    centerId,
    status: 'CALLED',
    calledAt: { $ne: null },
  }).populate('counterId', 'name number displayLabel');

  const warnings = [];
  for (const token of calledTokens) {
    const elapsedSeconds = Math.round((now - new Date(token.calledAt)) / 1000);
    if (elapsedSeconds >= warningThresholdSec) {
      const notif = await notificationService.evaluateNoShowWarning({
        token,
        counter: token.counterId,
        center,
        elapsedSeconds,
      });
      if (notif) warnings.push(notif);
    }
  }

  return warnings;
}

module.exports = {
  getOrCreateQueue,
  joinQueue,
  callNext,
  recallToken,
  startServing,
  completeToken,
  skipToken,
  cancelToken,
  expireToken,
  getQueueStatus,
  _updateWaitingPositions,
  _estimatePositionWait,
  checkNoShowWarnings,
};

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
const queueMetricsService = require('./queueMetricsService');
const notificationService = require('./notificationService');
const documentGateService = require('./documentGateService');
const workloadBalancerService = require('./workloadBalancerService');
const geofenceService = require('./geofenceService');
const { emitToCenter, emitToUser, emitToCounter } = require('../config/socket');
const { logger } = require('../utils/logger');

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
 * Today's live-queue window as a `createdAt` range.
 *
 * Token numbers are allocated per Queue document, and a Queue document is keyed
 * by `{ centerId, serviceId, date }` (see the unique index in models/Queue.js).
 * That means the SAME token code (e.g. `C-001`) is legitimately re-issued on
 * every new business day.
 *
 * Tokens carry no `date` field, so any operational query that selects live
 * tokens WITHOUT this range silently merges several business days into one
 * list. The observable symptom is the exact bug that was reported: a token code
 * such as `A-001` appearing two or more times in the "Next in Line" panel,
 * because today's `A-001` and a stale, still-WAITING `A-001` from an earlier
 * day were both returned.
 *
 * `callNext` has the same exposure in a worse direction: without this range a
 * counter could call a customer who joined the queue days ago, ahead of people
 * who are actually waiting right now.
 *
 * The window uses the same local-time calendar day as `getTodayDateString()`,
 * so it always agrees with the Queue document the counters read from.
 *
 * The keys MUST carry the `$` prefix: a bare `{ gte, lt }` is not a MongoDB
 * query operator, and Mongoose would try to cast the whole object to the
 * `createdAt` Date and throw.
 *
 * @returns {{ $gte: Date, $lt: Date }}
 */
function getTodayTokenRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { $gte: start, $lt: end };
}

/**
 * The canonical filter for "tokens currently in line at this center+service".
 *
 * Every place that reads or mutates the live queue MUST use this so that
 * center scope, service scope and business-day scope can never drift apart.
 *
 * @param {string|ObjectId} centerId
 * @param {string|ObjectId} serviceId
 * @param {object} [extra] additional filter clauses (e.g. `{ status: 'WAITING' }`)
 */
function buildLiveQueueFilter(centerId, serviceId, extra = {}) {
  return {
    centerId,
    serviceId,
    // MUST stay nested under `createdAt`. Spreading the range at the top level
    // would produce unknown root-level keys, which Mongoose strips under
    // strictQuery — silently disabling the day scope instead of applying it.
    createdAt: getTodayTokenRange(),
    ...extra,
  };
}

/**
 * Read the real waiting tokens for a center+service queue, in strict FIFO
 * order, de-duplicated.
 *
 * De-duplication is by MongoDB `_id` first (the true identity of a token) and
 * then by `tokenCode` as a defensive second pass. Two genuinely different
 * documents can share a token code only when they were issued on different
 * business days, and the day range above already excludes those; the code-level
 * pass therefore only removes a duplicate that slipped past the range, and it
 * always keeps the OLDEST record so FIFO order is preserved.
 *
 * No customer PII is selected: the operator panel only needs the code, the
 * position and the server-authoritative wait estimate.
 *
 * @param {string|ObjectId} centerId
 * @param {string|ObjectId} serviceId
 * @param {number} [limit=10]
 * @returns {Promise<Array<object>>}
 */
async function getWaitingTokensForQueue(centerId, serviceId, limit = 10) {
  if (!centerId || !serviceId) return [];

  const rawTokens = await Token.find(buildLiveQueueFilter(centerId, serviceId, { status: 'WAITING' }))
    .sort({ createdAt: 1, _id: 1 })
    .limit(Math.max(0, limit) * 2) // over-fetch so de-duplication can still fill the page
    .select('_id tokenCode tokenNumber currentPosition waitEstimateMinutes createdAt')
    .lean();

  const seenIds = new Set();
  const seenCodes = new Set();
  const unique = [];

  for (const t of rawTokens) {
    const id = String(t._id);
    const code = t.tokenCode;
    if (seenIds.has(id)) continue;
    if (code && seenCodes.has(code)) continue;
    seenIds.add(id);
    if (code) seenCodes.add(code);
    unique.push(t);
    if (unique.length >= limit) break;
  }

  return unique.map((t) => ({
    _id: t._id,
    tokenCode: t.tokenCode,
    tokenNumber: t.tokenNumber,
    position: t.currentPosition ?? null,
    waitEstimateMinutes: t.waitEstimateMinutes ?? null,
    createdAt: t.createdAt,
  }));
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
 * Broadcast the ONE canonical `queue.updated` payload for a center.
 *
 * Every queue mutation funnels through here so subscribers (Admin Panel stat
 * pills, Live Counter board, TV monitors) always receive the same shape with
 * the same fields. Previously each mutation site emitted a different partial
 * object — some without `centerId`, some without `totalIssued` — which made
 * consumers silently drop updates or overwrite good values with `undefined`.
 *
 * The payload carries BOTH:
 *   • per-service counters (`serviceId`, `waitingCount`, `activeCount`,
 *     `totalIssued`) for queue tables, and
 *   • center-scoped live metrics from queueMetricsService (the authoritative
 *     Token-derived counts) for stat pills.
 *
 * @param {string|ObjectId} centerId
 * @param {string|ObjectId|null} serviceId - service the mutation affected, if any
 */
async function _emitQueueUpdated(centerId, serviceId = null) {
  try {
    const date = getTodayDateString();
    const [metrics, queue] = await Promise.all([
      queueMetricsService.getLiveQueueMetrics(centerId),
      serviceId
        ? Queue.findOne({ centerId, serviceId, date }).select('waitingCount activeCount totalIssued').lean()
        : Promise.resolve(null),
    ]);

    emitToCenter(centerId.toString(), 'queue.updated', {
      centerId: centerId.toString(),
      serviceId: serviceId ? serviceId.toString() : null,
      waitingCount: queue ? queue.waitingCount || 0 : 0,
      activeCount: queue ? queue.activeCount || 0 : 0,
      totalIssued: queue ? queue.totalIssued || 0 : 0,
      // Authoritative center-wide counts derived from real Token documents.
      metrics,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // A broadcast failure must never fail the underlying queue mutation.
    console.error('[QueueService] Failed to broadcast queue.updated:', err.message);
  }
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
  journeyId = null,
  previousTokenId = null,
  latitude = null,
  longitude = null,
  accuracy = null,
  timestamp = null,
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

  // 1b. Location / Geofence verification for joining queue
  // If the service center has geographic coordinates configured, verify client proximity authoritatively.
  let joinDistanceMeters = null;
  let joinLatitude = null;
  let joinLongitude = null;
  const centerLat = center.latitude !== undefined && center.latitude !== null
    ? center.latitude
    : (center.location ? center.location.latitude : null);
  const centerLng = center.longitude !== undefined && center.longitude !== null
    ? center.longitude
    : (center.location ? center.location.longitude : null);
  const joiningRadiusMeters = center.joiningRadiusMeters !== undefined && center.joiningRadiusMeters !== null
    ? center.joiningRadiusMeters
    : ((center.geofence && center.geofence.radiusMeters) ? center.geofence.radiusMeters : 100);

  if (centerLat !== null && centerLng !== null) {
    if (latitude === undefined || latitude === null || longitude === undefined || longitude === null || latitude === '' || longitude === '') {
      const err = new Error('You must share your location to join the queue at this service center.');
      err.status = 400;
      err.code = 'LOCATION_REQUIRED';
      throw err;
    }

    const numLat = Number(latitude);
    const numLng = Number(longitude);

    if (
      !Number.isFinite(numLat) ||
      Number.isNaN(numLat) ||
      !Number.isFinite(numLng) ||
      Number.isNaN(numLng) ||
      numLat < -90 ||
      numLat > 90 ||
      numLng < -180 ||
      numLng > 180
    ) {
      const err = new Error('Invalid location coordinates');
      err.status = 400;
      err.code = 'INVALID_COORDINATES';
      throw err;
    }

    if (accuracy !== undefined && accuracy !== null && accuracy !== '') {
      const numAccuracy = Number(accuracy);
      // If accuracy is negative, non-finite, or worse than the allowed radius threshold, reject as uncertain.
      if (!Number.isFinite(numAccuracy) || numAccuracy < 0 || numAccuracy > Math.max(joiningRadiusMeters, 100)) {
        const err = new Error('Your device location is not accurate enough to verify the joining area.');
        err.status = 400;
        err.code = 'LOCATION_UNCERTAIN';
        err.accuracy = numAccuracy;
        throw err;
      }
    }

    if (timestamp !== undefined && timestamp !== null && timestamp !== '') {
      const timeMs = new Date(timestamp).getTime();
      if (Number.isNaN(timeMs)) {
        const err = new Error('Invalid location timestamp format');
        err.status = 400;
        err.code = 'INVALID_COORDINATES';
        throw err;
      }

      const now = Date.now();
      // Allow up to 60s future clock skew
      if (timeMs > now + 60 * 1000) {
        const err = new Error('Location timestamp cannot be in the future');
        err.status = 400;
        err.code = 'LOCATION_STALE';
        throw err;
      }

      // Freshness check: reject if location reading is older than 90s (LOCATION_STALE_THRESHOLD_MS)
      if (now - timeMs > 90 * 1000) {
        const err = new Error('Location reading is stale. Fresh GPS reading required to join.');
        err.status = 400;
        err.code = 'LOCATION_STALE';
        throw err;
      }
    }

    const distanceMeters = geofenceService.calculateHaversineDistance(
      centerLat,
      centerLng,
      numLat,
      numLng
    );

    if (distanceMeters > joiningRadiusMeters) {
      const err = new Error(`You must be within ${joiningRadiusMeters} meters of this service center to join the queue.`);
      err.status = 400;
      err.code = 'OUT_OF_RANGE';
      err.distanceMeters = distanceMeters;
      err.radiusMeters = joiningRadiusMeters;
      throw err;
    }

    joinDistanceMeters = distanceMeters;
    joinLatitude = numLat;
    joinLongitude = numLng;
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

  // 3b. Tier 4 Feature 4: Document-Ready Gatekeeping
  // Authoritative server-side evaluation of service document requirements
  if (userId) {
    const readiness = await documentGateService.checkServiceReadiness({ serviceId, userId });
    if (!readiness.isReady) {
      try {
        await QueueEvent.create({
          centerId,
          eventType: 'DOCUMENT_GATE_BLOCKED',
          performedBy: userId,
          metadata: {
            serviceId,
            status: readiness.status,
            missingRequirements: readiness.missingRequirements,
          },
        });
      } catch (_) {}

      const err = new Error(readiness.message || 'Service requires document verification before queueing');
      err.status = 403;
      err.code = 'DOCUMENT_GATE_BLOCKED';
      err.gateData = readiness;
      throw err;
    }

    if (readiness.status === 'READY') {
      try {
        await QueueEvent.create({
          centerId,
          eventType: 'DOCUMENT_GATE_PASSED',
          performedBy: userId,
          metadata: {
            serviceId,
            status: readiness.status,
          },
        });
      } catch (_) {}
    }
  }

  // 4. Atomically increment queue counters and create token inside a MongoDB transaction
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
              journeyId: journeyId || null,
              previousTokenId: previousTokenId || null,
              proximityState: joinDistanceMeters !== null ? 'INSIDE' : 'UNKNOWN',
              proximityDistanceMeters: joinDistanceMeters,
              proximityUpdatedAt: joinDistanceMeters !== null ? new Date() : null,
              // Phase 2 baseline. The join geofence already proved this customer
              // is inside the radius, so the token starts its life with a
              // verifiable, timestamped position. Later eligibility decisions
              // are then made against a real reading rather than "unknown",
              // while the customer is still free to walk out afterwards.
              locationStatus: joinDistanceMeters !== null ? 'IN_RANGE' : 'LOCATION_UNAVAILABLE',
              lastLocation:
                joinDistanceMeters !== null
                  ? {
                      latitude: joinLatitude,
                      longitude: joinLongitude,
                      accuracy:
                        accuracy === undefined || accuracy === null || accuracy === ''
                          ? null
                          : Number(accuracy),
                      updatedAt: new Date(),
                      distanceMeters: joinDistanceMeters,
                      status: 'IN_RANGE',
                    }
                  : undefined,
            },
          ],
          { session }
        );

        // Regenerate signed QR with the real tokenId now that the document exists
        const finalQrResult = generateQRData(created._id.toString(), centerId.toString(), serviceId.toString());
        created.qrData = finalQrResult.qrData;
        created.qrNonce = finalQrResult.nonce;
        created.qrIssuedAt = finalQrResult.issuedAt;
        if (!created.journeyId) {
          created.journeyId = created._id;
        }
        await created.save({ session });
        token = created;

        if (previousTokenId) {
          await Token.findByIdAndUpdate(previousTokenId, { nextTokenId: created._id }, { session });
        }
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
        journeyId: journeyId || null,
        previousTokenId: previousTokenId || null,
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
    if (!token.journeyId) {
      token.journeyId = token._id;
    }
    await token.save();

    if (previousTokenId) {
      await Token.findByIdAndUpdate(previousTokenId, { nextTokenId: token._id });
    }
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

  await _emitQueueUpdated(centerId, serviceId);

  emitToUser(userId.toString(), 'token.created', { token: populatedToken });

  // 10. Send creation notification
  await notificationService.sendTokenNotification(token, 'TOKEN_CREATED', {
    title: 'Token Generated',
    body: `Your token ${tokenCode} is confirmed. Position: ${position}. Est. wait: ${waitEstimate} min.`,
  });

  // Centralized Resource Allocation: if ready counters are available, dispatch immediately
  const resourceAllocationService = require('./resourceAllocationService');
  resourceAllocationService.triggerAllocation(centerId);

  return { token: populatedToken, queue };
}

/**
 * Phase 2 second-stage geofencing: mark a single WAITING token as
 * SKIPPED_OUT_OF_RANGE and persist the full audit trail.
 *
 * The status change is an atomic conditional update on `status: 'WAITING'`.
 * If a concurrent CALL NEXT already claimed this token, the update matches
 * nothing and this function reports `claimed: false` so the caller can move on
 * without double-processing. Exactly one token record ever exists per join.
 *
 * @returns {Promise<{ claimed: boolean, token: object|null }>}
 */
async function _skipOutOfRangeToken({ token, center, verdict, adminId }) {
  const now = new Date();

  const updated = await Token.findOneAndUpdate(
    { _id: token._id, status: 'WAITING' },
    {
      status: 'SKIPPED_OUT_OF_RANGE',
      completedAt: now,
      currentPosition: null,
      skipReason: 'OUT_OF_RANGE',
      skippedAt: now,
      checkedDistanceMeters:
        verdict.distanceMeters !== null && verdict.distanceMeters !== undefined
          ? verdict.distanceMeters
          : null,
      locationStatus: verdict.locationStatus,
      // Keep the checked proximity + location timestamp together for audit.
      proximityUpdatedAt: token.lastLocation?.updatedAt || token.proximityUpdatedAt || now,
    },
    { new: true }
  );

  if (!updated) {
    return { claimed: false, token: null };
  }

  // Queue day aggregate: a customer who never arrived is abandoned, not served.
  await Queue.findOneAndUpdate(
    { centerId: token.centerId, serviceId: token.serviceId, date: getTodayDateString() },
    { $inc: { waitingCount: -1, abandonedCount: 1 } }
  );

  await QueueEvent.create({
    centerId: token.centerId,
    tokenId: token._id,
    eventType: 'TOKEN_SKIPPED_OUT_OF_RANGE',
    performedBy: adminId || null,
    metadata: {
      tokenCode: token.tokenCode,
      skipReason: 'OUT_OF_RANGE',
      locationStatus: verdict.locationStatus,
      // Distance and age are operator-useful audit context, not coordinates.
      distanceMeters: verdict.distanceMeters ?? null,
      radiusMeters: verdict.radiusMeters ?? null,
      locationAgeMs: verdict.ageMs ?? null,
      locationUpdatedAt: token.lastLocation?.updatedAt || null,
      centerJoiningRadiusMeters: geofenceService.getCenterJoiningRadiusMeters(center),
    },
  });

  // Truthful customer notification. No coordinates, no internal state names.
  try {
    await notificationService.sendTokenNotification(updated, 'TOKEN_SKIPPED_OUT_OF_RANGE', {
      title: 'Token skipped',
      body: 'Your token was skipped because you were outside the service area. You can rejoin the queue from the app.',
      dedupeKey: `geofence_skip_${token._id}`,
      metadata: {
        skipReason: 'OUT_OF_RANGE',
        tokenCode: token.tokenCode,
      },
    });
  } catch (err) {
    logger.error('queueService.out_of_range_skip_notification_failed', {
      tokenId: token._id.toString(),
      error: err.message,
    });
  }

  // Own private room: the customer learns of their own state change.
  const populated = await Token.findById(token._id)
    .populate('serviceId', 'name tokenPrefix')
    .populate('centerId', 'name')
    .lean();

  emitToUser(token.userId.toString(), 'token.skipped', {
    token: populated,
    skipReason: 'OUT_OF_RANGE',
  });

  // Center room: Admin Panel and Live Counter show the temporary announcement.
  // Sanitized (no userId) exactly like every other center-facing token event.
  emitToCenter(token.centerId.toString(), 'token.skipped', {
    token: _sanitizeTokenForCenter({
      _id: token._id,
      tokenCode: token.tokenCode,
      tokenNumber: token.tokenNumber,
      status: 'SKIPPED_OUT_OF_RANGE',
      skipReason: 'OUT_OF_RANGE',
      skipReasonText: 'outside service area',
      skippedAt: now,
    }),
    skipReason: 'OUT_OF_RANGE',
  });

  return { claimed: true, token: updated };
}

/**
 * Call the next waiting token for a counter, automatically skipping any
 * earlier waiting tokens that are no longer inside the service area.
 *
 * Strict FIFO is preserved. Candidates are examined in `createdAt` order and
 * the first IN_RANGE one is claimed. Geography never reorders the queue — it
 * only decides who may be called when their turn arrives.
 *
 * Safety rule for uncertain location: LOCATION_STALE and LOCATION_UNAVAILABLE
 * stop the scan. Such a token is neither called (we cannot confirm presence)
 * nor skipped (we have no evidence they left). The operator gets a truthful
 * result instead of a fabricated or destructive one.
 *
 * @param {object} params
 * @param {string} params.counterId
 * @param {string} params.centerId
 * @param {string} params.adminId - User performing the action
 * @returns {Promise<{ token: object, counter: object, skipped: object[], blocked: object[] } | null>}
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

  const serviceId = counter.serviceId._id;
  const now = new Date();

  // Authoritative service center position. Phase 2 never invents a radius or a
  // coordinate: if the center has no position, nobody is auto-skipped.
  const center = await ServiceCenter.findById(centerId);
  const centerHasPosition =
    center && geofenceService.getCenterCoordinates(center).latitude !== null;

  // Queue candidates in strict FIFO order.
  //
  // Scoped to TODAY on purpose: the Queue document that owns the token numbers
  // is keyed by { centerId, serviceId, date }, so without the day range a token
  // that joined on an earlier business day (and is still WAITING because
  // nobody worked that queue) would be considered ahead of everyone actually
  // waiting right now, and its code would collide with today's.
  const candidates = await Token.find(buildLiveQueueFilter(centerId, serviceId, { status: 'WAITING' }))
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const skipped = [];
  const blocked = [];
  let nextToken = null;

  if (centerHasPosition) {
    for (const candidate of candidates) {
      const verdict = geofenceService.classifyTokenLocation(candidate, center, now.getTime());

      if (verdict.inRange) {
        // Attempt the atomic claim. A concurrent CALL NEXT may have taken this
        // one already; if so we simply continue to the next FIFO candidate.
        const claimed = await Token.findOneAndUpdate(
          { _id: candidate._id, status: 'WAITING' },
          {
            status: 'CALLED',
            calledAt: now,
            counterId: counter._id,
            servedBy: adminId || null,
          },
          { new: true }
        ).populate('userId', 'name email preferences');

        if (claimed) {
          nextToken = claimed;
          break;
        }
        continue;
      }

      if (verdict.locationStatus === 'OUT_OF_RANGE') {
        // Only skip when we are confident the customer is genuinely away. Very
        // large or unbounded distances are reported but not acted on, because
        // destroying a place in line on a single reading is worse than waiting.
        const distance = verdict.distanceMeters;
        if (distance === null || distance <= geofenceService.AUTO_SKIP_MAX_DISTANCE_METERS) {
          const result = await _skipOutOfRangeToken({
            token: candidate,
            center,
            verdict,
            adminId,
          });
          if (result.claimed) {
            skipped.push({
              tokenId: candidate._id.toString(),
              tokenCode: candidate.tokenCode,
              skipReason: 'OUT_OF_RANGE',
              distanceMeters: verdict.distanceMeters ?? null,
            });
          }
          continue;
        }
        blocked.push({
          tokenId: candidate._id.toString(),
          tokenCode: candidate.tokenCode,
          locationStatus: 'OUT_OF_RANGE',
          distanceMeters: verdict.distanceMeters ?? null,
        });
        continue;
      }

      // LOCATION_STALE / LOCATION_UNAVAILABLE. Stop the scan here: we will not
      // call this token on unverified presence, and we will not destroy it on
      // the absence of information. The operator sees the truthful reason.
      blocked.push({
        tokenId: candidate._id.toString(),
        tokenCode: candidate.tokenCode,
        locationStatus: verdict.locationStatus,
        distanceMeters: verdict.distanceMeters ?? null,
      });
      break;
    }
  } else {
    // No authoritative center position configured. Preserve the original
    // behaviour exactly: call the head of the queue, skip nobody.
    const claimed = await Token.findOneAndUpdate(
      buildLiveQueueFilter(centerId, serviceId, { status: 'WAITING' }),
      {
        status: 'CALLED',
        calledAt: now,
        counterId: counter._id,
        servedBy: adminId || null,
      },
      { sort: { createdAt: 1, _id: 1 }, new: true }
    ).populate('userId', 'name email preferences');

    nextToken = claimed || null;
  }

  if (!nextToken) {
    if (skipped.length > 0) {
      // Skips did happen, so the queue really did change and every waiting
      // surface must be told, even though nobody could be called.
      await _emitQueueUpdated(centerId, serviceId);
    }
    return { token: null, counter: null, skipped, blocked };
  }

  // If the counter was still holding somebody, finish that visit and free the
  // counter BEFORE trying to claim the new one. Doing it in this order is what
  // lets the compare-and-swap below require a genuinely free counter: if the
  // free step is skipped, a late-arriving dispatch could steal a counter that
  // is already in use and orphan the customer sitting there.
  if (counter.currentTokenId && counter.currentTokenId.toString() !== nextToken._id.toString()) {
    await Token.findOneAndUpdate(
      { _id: counter.currentTokenId, status: { $in: ['CALLED', 'SERVING'] } },
      { status: 'COMPLETED', completedAt: now, servedBy: adminId || null }
    );
    // Conditional on the pointer still being the one we just finished, so a
    // dispatch that arrived in the meantime is never cleared out.
    await Counter.updateOne(
      { _id: counterId, currentTokenId: counter.currentTokenId },
      { $set: { currentTokenId: null, servingStartedAt: null } }
    );
  }

  // ─── Atomic counter claim (compare-and-swap on allocationVersion) ───────
  //
  // The token claim above is already atomic, so two counters can never take
  // the SAME customer. The mirror image is also possible: two concurrent
  // dispatches (a manual CALL NEXT racing the central allocator, or two
  // allocator loops) could each win a DIFFERENT token for the SAME counter.
  //
  // Re-reading the counter and saving it is not safe. Instead the write is
  // conditional on the version AND on the counter still being free, so only the
  // first writer lands. A loser releases its token claim and returns no token,
  // which means two dispatches aimed at one counter can never both "succeed".
  let claimedCounter = null;
  for (let attempt = 0; attempt < 3 && !claimedCounter; attempt++) {
    const observed = await Counter.findById(counterId).lean();
    if (!observed) break;

    // Re-verify under the claim: the counter may have closed, been re-pointed
    // at another service, or been claimed by a competing dispatch while we
    // were claiming a token.
    if (observed.status !== 'ACTIVE') break;
    if (!observed.serviceId || observed.serviceId.toString() !== serviceId.toString()) break;
    if (observed.currentTokenId) break;

    claimedCounter = await Counter.findOneAndUpdate(
      {
        _id: counterId,
        allocationVersion: observed.allocationVersion || 0,
        status: 'ACTIVE',
        // The counter must still be free at the instant of the write. Without
        // this clause a dispatch that read the counter a moment earlier could
        // take it over from whoever is already being served there.
        currentTokenId: null,
      },
      {
        $set: { currentTokenId: nextToken._id, servingStartedAt: now },
        $inc: { allocationVersion: 1 },
      },
      { new: true }
    );
  }

  if (!claimedCounter) {
    // We lost the race for this counter. Put the customer back in the queue
    // exactly where they were, so no place is destroyed and no token is left
    // CALLED at a counter that is not actually serving them.
    await Token.findOneAndUpdate(
      { _id: nextToken._id, status: 'CALLED', counterId: counterId },
      { $set: { status: 'WAITING', counterId: null, calledAt: null, servedBy: null } }
    );
    logger.info('queueService.call_next_counter_claim_lost', {
      counterId,
      tokenId: String(nextToken._id),
    });
    return { token: null, counter: null, skipped: [], blocked: [] };
  }

  counter.currentTokenId = claimedCounter.currentTokenId;
  counter.servingStartedAt = claimedCounter.servingStartedAt;

  // Update queue counts
  await Queue.findOneAndUpdate(
    { centerId, serviceId, date: getTodayDateString() },
    { $inc: { waitingCount: -1, activeCount: 1 } }
  );

  // Log event
  await QueueEvent.create({
    centerId,
    tokenId: nextToken._id,
    counterId: counter._id,
    eventType: 'TOKEN_CALLED',
    performedBy: adminId,
    metadata: {
      tokenCode: nextToken.tokenCode,
      counterName: counter.name,
      ...(skipped.length > 0 ? { autoSkippedCount: skipped.length } : {}),
    },
  });

  // Update positions for all remaining waiting tokens
  await _updateWaitingPositions(centerId, serviceId);

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

  // Emit to verified customer's private room.
  // nextToken.userId is populated above, so the room must be keyed on the
  // underlying _id - `userId.toString()` would stringify the whole document and
  // produce a room nobody is ever joined to.
  emitToUser(nextToken.userId._id.toString(), 'token.called', {
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

  // Tier 4 Feature 5: Real-time operational workload broadcast
  workloadBalancerService.broadcastWorkloadUpdate(centerId);

  return { token: populatedToken, counter: populatedCounter, skipped, blocked };
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
    err.status = 400;
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

  // Field-scoped update, not `counter.save()`: this completion path must never
  // be able to write back a stale `currentTokenId` over a concurrent
  // allocation claim.
  await Counter.updateOne(
    { _id: counterId, currentTokenId: token._id },
    { $set: { servingStartedAt: new Date() } }
  );

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

  // Start-serving moves a token from CALLED into SERVING, which changes the
  // authoritative servingCount. Broadcast so live surfaces stay in step.
  await _emitQueueUpdated(token.centerId, token.serviceId);

  // Tier 4 Feature 5: Real-time operational workload broadcast
  workloadBalancerService.broadcastWorkloadUpdate(token.centerId);

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

  // Update counter stats.
  //
  // Deliberately NOT `counter.save()`: saving a document read earlier can
  // overwrite a newer `currentTokenId` written by a concurrent allocation
  // claim. A conditional `$set` + `$inc` touches only the fields this
  // completion owns, and the guard makes it a no-op if the counter is no
  // longer showing the token that just completed.
  const counterObjectId =
    counterId && mongoose.Types.ObjectId.isValid(String(counterId))
      ? new mongoose.Types.ObjectId(String(counterId))
      : null;

  if (counterObjectId) {
    await Counter.updateOne(
      { _id: counterObjectId, currentTokenId: token._id },
      {
        $set: { currentTokenId: null, servingStartedAt: null },
        $inc: { 'stats.served': 1 },
      }
    );

    // Running average service time is a read-modify-write on one counter field,
    // so it is computed with a single atomic pipeline update. `stats.served` was
    // already incremented above, so the previous sample count is `served - 1`.
    await Counter.collection.updateOne(
      { _id: counterObjectId },
      [
        {
          $set: {
            'stats.avgServiceSeconds': {
              $cond: [
                { $gt: [{ $ifNull: ['$stats.served', 0] }, 0] },
                {
                  $round: [
                    {
                      $add: [
                        {
                          $multiply: [
                            { $ifNull: ['$stats.avgServiceSeconds', actualServiceSeconds] },
                            {
                              $subtract: [
                                { $ifNull: ['$stats.served', 0] },
                                1,
                              ],
                            },
                          ],
                        },
                        actualServiceSeconds,
                      ],
                    },
                    { $ifNull: ['$stats.served', 0] },
                  ],
                },
                actualServiceSeconds,
              ],
            },
          },
        },
      ]
    );
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

  const populatedCounter = counterObjectId
    ? await Counter.findById(counterObjectId).populate('serviceId', 'name').lean()
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

  // A completion changes the authoritative center metrics (activeCount drops,
  // completedToday increments) but does not reorder the waiting line, so
  // _updateWaitingPositions is not called here. Broadcast queue.updated so the
  // Admin Panel and Live Counter counters advance without a refresh.
  await _emitQueueUpdated(token.centerId, token.serviceId);

  await notificationService.sendTokenNotification(token, 'TOKEN_COMPLETED', {
    title: 'Service Completed',
    body: `Thank you! Your service for token ${token.tokenCode} has been completed.`,
  });

  // Tier 4 Feature 2: Service Graph Multi-Hop check for next services
  try {
    const { ServiceRelationship } = require('../models/ServiceRelationship');
    const nextEdges = await ServiceRelationship.find({
      centerId: token.centerId,
      sourceServiceId: token.serviceId,
      isActive: true,
    }).lean();

    if (nextEdges && nextEdges.length > 0) {
      await notificationService.sendTokenNotification(token, 'NEXT_SERVICE_AVAILABLE', {
        title: 'Next Service Available',
        body: `Your service for token ${token.tokenCode} is complete. Next step is available in your workflow.`,
        dedupeKey: `next_svc_${token._id}`,
      });
    }
  } catch (_) {
    // Non-fatal if relationship lookup fails
  }

  // Tier 4 Feature 5: Real-time operational workload evaluation & broadcast
  if (token.servedBy) {
    workloadBalancerService.calculateOperatorWorkload({ operatorId: token.servedBy, centerId: token.centerId })
      .then((workload) => {
        if (workload && workload.loadLevel === 'SUSTAINED_HIGH') {
          workloadBalancerService.checkAndNotifySustainedWorkload(token.servedBy, token.centerId, workload);
        }
      })
      .catch(() => {});
  }
  workloadBalancerService.broadcastWorkloadUpdate(token.centerId);

  // Centralized Resource Allocation: counter is now free, allocate next waiting customer
  const resourceAllocationService = require('./resourceAllocationService');
  resourceAllocationService.triggerAllocation(token.centerId);

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
    // Conditional, field-scoped update. The `currentTokenId` guard means a skip
    // only frees a counter that really was showing this token, and it can never
    // write back a stale document over a concurrent allocation claim.
    await Counter.updateOne(
      { _id: counterId, currentTokenId: token._id },
      {
        $set: { currentTokenId: null, servingStartedAt: null },
        $inc: { 'stats.skipped': 1 },
      }
    );
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

  // Tier 4 Feature 5: Real-time operational workload broadcast
  workloadBalancerService.broadcastWorkloadUpdate(token.centerId);

  // Centralized Resource Allocation: counter is now free, allocate next waiting customer
  require('./resourceAllocationService').triggerAllocation(token.centerId);

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

  // Centralized Resource Allocation: a no-show frees the counter, so the
  // allocator must be given the chance to fill it immediately.
  require('./resourceAllocationService').triggerAllocation(token.centerId);

  return populated;
}

/**
 * Get live queue status for a center.
 *
 * @param {string|ObjectId} centerId
 * @param {string|ObjectId} [serviceId] - Restrict the result to a single
 *   service. Callers that pass one MUST consume the matching entry rather than
 *   assuming they received only their own service's queue: this function has
 *   always returned an array, and the per-service filter is what stops a
 *   counter from rendering another service's waiting count and EWT.
 *
 * Tier 3 / Feature 1: each entry carries the server-authoritative,
 * context-aware `estimatedWaitMinutes`. Clients render that value and must not
 * recompute an estimate locally.
 *
 * @returns {Promise<Array<object>>}
 */
async function getQueueStatus(centerId, serviceId = null) {
  const date = getTodayDateString();
  const query = { centerId, date };
  if (serviceId) query.serviceId = serviceId;
  const queues = await Queue.find(query)
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
  // Same business-day scope as `callNext`. Without it, stale WAITING tokens from
  // earlier days were given queue positions, which inflated
  // `queue.waitingCount` above the real number of people waiting and pushed the
  // "Next in Line" list out of sync with the headline count.
  const waitingTokens = await Token.find(
    buildLiveQueueFilter(centerId, serviceId, { status: 'WAITING' })
  )
    .sort({ createdAt: 1, _id: 1 })
    .select('_id userId centerId serviceId tokenCode status notifyApp notifySms channel channelMetadata waitEstimateMinutes lastLocation proximityUpdatedAt proximityDistanceMeters locationStatus');

  const queue = await Queue.findOne({ centerId, serviceId, date: getTodayDateString() });
  const service = await Service.findById(serviceId).select('name avgServiceTimeMinutes');

  // Phase 2: the service center is needed to evaluate location eligibility for
  // the approaching warnings. Loaded once, and only if a candidate is close
  // enough to the front of the line to warrant a warning.
  let geofenceCenter = null;

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

  if (queue && queue.waitingCount !== waitingTokens.length) {
    await Queue.updateOne(
      { _id: queue._id },
      { $set: { waitingCount: waitingTokens.length } }
    );
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

    // Phase 2: location-aware approaching warning. Only fires for customers who
    // are actually outside the radius, and is deduplicated per token+level, so
    // repeated position recalculation can never spam the same customer.
    if (peopleAhead >= 1 && peopleAhead <= 4) {
      if (!geofenceCenter) {
        geofenceCenter = await ServiceCenter.findById(centerId);
      }
      if (geofenceCenter) {
        try {
          await geofenceService.evaluateGeofenceApproachingWarning({
            token,
            center: geofenceCenter,
            peopleAhead,
          });
        } catch (err) {
          logger.warn('queueService.geofence_warning_failed', {
            tokenId: token._id.toString(),
            error: err.message,
          });
        }
      }
    }
  }

  // Emit the canonical queue.updated to the center room for live display
  // boards, monitors, and dashboards.
  await _emitQueueUpdated(centerId, serviceId);
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
  _skipOutOfRangeToken,
  recallToken,
  startServing,
  completeToken,
  skipToken,
  cancelToken,
  expireToken,
  getQueueStatus,
  getTodayTokenRange,
  buildLiveQueueFilter,
  getWaitingTokensForQueue,
  emitQueueUpdated: _emitQueueUpdated,
  _updateWaitingPositions,
  _estimatePositionWait,
  checkNoShowWarnings,
};

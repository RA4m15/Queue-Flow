'use strict';

/**
 * QueueFlow — Tier 4 / Feature 3: P2P Slot Swapping Service
 *
 * Implements the complete server-side logic for voluntary queue position
 * swaps between eligible customers within the same center + service + queue.
 *
 * Architecture notes:
 * ─────────────────────────────────────────────────────────────────────────────
 * Queue ordering mechanism:
 *   Positions are server-derived: _updateWaitingPositions() assigns
 *   currentPosition 1,2,3… based on Token.find().sort({createdAt:1}).
 *   The safe way to reorder two WAITING tokens without changing tokenCode,
 *   tokenNumber, or userId is to atomically swap their `createdAt` values
 *   inside a MongoDB transaction. After the swap, _updateWaitingPositions()
 *   rebuilds currentPosition and emits socket updates.
 *
 * Privacy:
 *   Offer list returned to customer shows only position + tokenCode (not name/
 *   email/phone). The backend never leaks PII to swap-offer discovery endpoints.
 *
 * Security:
 *   - Every mutation verifies ownership, same-center, same-service, same-queue.
 *   - Offer expiry is checked server-side on every read and mutation.
 *   - Atomic swap uses MongoDB transaction with pre-commit re-validation.
 *   - IDOR prevented: customers can only see/act on their own offers or eligible
 *     offers in the same queue (with PII removed).
 *   - Rate limiting applied at the route layer using existing infrastructure.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const mongoose = require('mongoose');
const { SwapOffer, DEFAULT_OFFER_TTL_SECONDS } = require('../models/SwapOffer');
const { Token } = require('../models/Token');
const Queue = require('../models/Queue');
const QueueEvent = require('../models/QueueEvent');
const Notification = require('../models/Notification');
const { emitToUser, emitToCenter } = require('../config/socket');
const notificationService = require('./notificationService');
const queueService = require('./queueService');
const { logger } = require('../utils/logger');
const { getTodayDateString } = require('../utils/tokenUtils');

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fetch a WAITING token and assert it is eligible to participate in a swap.
 * Returns the raw (non-populated) token document.
 *
 * Throws a tagged error with .status for caller to forward to HTTP response.
 */
async function _assertEligibleWaitingToken(tokenId, userId, session = null) {
  const query = Token.findById(tokenId);
  if (session) query.session(session);
  const token = await query;

  if (!token) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (token.userId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You do not own this token');
    err.status = 403;
    throw err;
  }

  if (token.status !== 'WAITING') {
    const err = new Error(`Token is not eligible for swap: current status is ${token.status}`);
    err.status = 409;
    throw err;
  }

  return token;
}

/**
 * Mark an offer as expired in-place (side effect only — does NOT throw).
 * Emits the appropriate socket event to both affected users.
 */
async function _expireOffer(offer) {
  offer.status = 'EXPIRED';
  offer.expiresAt = new Date(); // seal the timestamp
  await offer.save();

  emitToUser(offer.offeringUserId.toString(), 'swap.offer.expired', {
    offerId: offer._id,
    tokenId: offer.offeringTokenId,
  });

  if (offer.targetUserId) {
    emitToUser(offer.targetUserId.toString(), 'swap.offer.expired', {
      offerId: offer._id,
    });
  }

  try {
    const offeringToken = await Token.findById(offer.offeringTokenId).select('tokenCode centerId serviceId');
    if (offeringToken) {
      await notificationService.sendTokenNotification(
        { _id: offer.offeringTokenId, userId: offer.offeringUserId, centerId: offeringToken.centerId },
        'SWAP_EXPIRED',
        {
          title: 'Swap Offer Expired',
          body: `Your swap offer for token ${offeringToken.tokenCode} has expired without being accepted.`,
          dedupeKey: `swap_expired_${offer._id}`,
        }
      );
    }
  } catch (_) {
    // non-fatal
  }
}

/**
 * Build the anonymous public representation of a swap offer for eligible-offer listing.
 * NO PII (name, email, phone) is returned.
 */
function _sanitizeOfferForPublic(offer, offeringToken) {
  return {
    offerId: offer._id,
    centerId: offer.centerId,
    serviceId: offer.serviceId,
    offeringPosition: offeringToken ? offeringToken.currentPosition : null,
    offeringTokenCode: offeringToken ? offeringToken.tokenCode : null,
    createdAt: offer.createdAt,
    expiresAt: offer.expiresAt,
    status: offer.status,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the list of tokens in the same center+service queue that are eligible
 * to swap with the requesting customer's token.
 *
 * Returns anonymized entries only (position, tokenCode — no PII).
 *
 * @param {string} tokenId - The requesting customer's token
 * @param {string} userId  - Authenticated user
 */
async function getEligibleSwapPartners(tokenId, userId) {
  if (!mongoose.Types.ObjectId.isValid(tokenId)) {
    const err = new Error('Invalid tokenId format');
    err.status = 400;
    throw err;
  }

  const myToken = await Token.findById(tokenId).lean();
  if (!myToken) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (myToken.userId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You do not own this token');
    err.status = 403;
    throw err;
  }

  if (myToken.status !== 'WAITING') {
    return {
      eligible: false,
      reason: `Token status is ${myToken.status}. Only WAITING tokens can participate in swaps.`,
      partners: [],
    };
  }

  // Fetch all other WAITING tokens in the same center+service queue (excluding self)
  const others = await Token.find({
    centerId: myToken.centerId,
    serviceId: myToken.serviceId,
    status: 'WAITING',
    _id: { $ne: myToken._id },
  })
    .sort({ createdAt: 1 })
    .select('_id tokenCode currentPosition createdAt')
    .lean();

  // Anonymize — expose only positional / queue-identity data
  const partners = others.map((t) => ({
    tokenId: t._id,
    tokenCode: t.tokenCode,
    currentPosition: t.currentPosition,
  }));

  return {
    eligible: partners.length > 0,
    myPosition: myToken.currentPosition,
    myTokenCode: myToken.tokenCode,
    partners,
  };
}

/**
 * Create a new swap offer.
 *
 * Business rules enforced:
 * - Requesting token must be WAITING
 * - Must belong to authenticated user
 * - targetTokenId (if provided) must be in the same center+service+queue and WAITING
 * - Offering user may not have an existing PENDING offer for this token
 * - Offer is bounded by DEFAULT_OFFER_TTL_SECONDS
 *
 * @param {object} params
 * @param {string} params.offeringTokenId
 * @param {string} params.userId
 * @param {string} [params.targetTokenId] - Optional directed offer
 * @param {string} [params.reason]
 */
async function createOffer({ offeringTokenId, userId, targetTokenId = null, reason = null }) {
  if (!mongoose.Types.ObjectId.isValid(offeringTokenId)) {
    const err = new Error('Invalid offeringTokenId format');
    err.status = 400;
    throw err;
  }
  if (targetTokenId && !mongoose.Types.ObjectId.isValid(targetTokenId)) {
    const err = new Error('Invalid targetTokenId format');
    err.status = 400;
    throw err;
  }
  if (targetTokenId && targetTokenId.toString() === offeringTokenId.toString()) {
    const err = new Error('Cannot create a swap offer with your own token as the target');
    err.status = 400;
    throw err;
  }

  const offeringToken = await Token.findById(offeringTokenId).lean();
  if (!offeringToken) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (offeringToken.userId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You do not own this token');
    err.status = 403;
    throw err;
  }

  if (offeringToken.status !== 'WAITING') {
    const err = new Error(`Token is not eligible for swap: status is ${offeringToken.status}. Only WAITING tokens can create swap offers.`);
    err.status = 409;
    throw err;
  }

  // Service Graph compatibility: tokens in a multi-hop journey may only swap
  // within the same service. Cross-service swaps are not permitted.
  // journeyId only indicates the journey chain; same-service check is already
  // guaranteed by requiring the same center+service+queue.

  let targetToken = null;
  let targetUserId = null;

  if (targetTokenId) {
    targetToken = await Token.findById(targetTokenId).lean();
    if (!targetToken) {
      const err = new Error('Target token not found');
      err.status = 404;
      throw err;
    }

    if (targetToken.status !== 'WAITING') {
      const err = new Error('Target token is not eligible for swap: must be in WAITING status');
      err.status = 409;
      throw err;
    }

    // Same-center, same-service, same-queue validation
    if (targetToken.centerId.toString() !== offeringToken.centerId.toString()) {
      const err = new Error('Target token belongs to a different service center');
      err.status = 400;
      throw err;
    }
    if (targetToken.serviceId.toString() !== offeringToken.serviceId.toString()) {
      const err = new Error('Target token belongs to a different service. Swaps are only permitted within the same queue.');
      err.status = 400;
      throw err;
    }

    targetUserId = targetToken.userId;
  }

  // Check for existing PENDING offer on this token (database-level unique index is the
  // authoritative guard; this pre-check improves error message quality)
  const existingPending = await SwapOffer.findOne({
    offeringTokenId,
    status: 'PENDING',
  });
  if (existingPending) {
    const err = new Error('You already have a pending swap offer for this token. Cancel it before creating a new one.');
    err.status = 409;
    throw err;
  }

  const expiresAt = new Date(Date.now() + DEFAULT_OFFER_TTL_SECONDS * 1000);

  let offer;
  try {
    offer = await SwapOffer.create({
      offeringUserId: userId,
      offeringTokenId,
      centerId: offeringToken.centerId,
      serviceId: offeringToken.serviceId,
      targetTokenId: targetTokenId || null,
      targetUserId: targetUserId || null,
      reason: reason ? String(reason).slice(0, 200) : null,
      status: 'PENDING',
      expiresAt,
    });
  } catch (createErr) {
    if (createErr.code === 11000) {
      const err = new Error('You already have a pending swap offer for this token.');
      err.status = 409;
      throw err;
    }
    throw createErr;
  }

  // Audit trail
  await QueueEvent.create({
    centerId: offeringToken.centerId,
    tokenId: offeringTokenId,
    eventType: 'SWAP_OFFER_CREATED',
    performedBy: userId,
    metadata: {
      offerId: offer._id,
      offeringTokenCode: offeringToken.tokenCode,
      targetTokenId: targetTokenId || null,
      expiresAt,
    },
  });

  // Emit socket event to center (sanitized — no PII)
  emitToCenter(offeringToken.centerId.toString(), 'swap.offer.created', {
    offerId: offer._id,
    centerId: offer.centerId,
    serviceId: offer.serviceId,
    offeringPosition: offeringToken.currentPosition,
  });

  // If directed at a specific customer, notify them
  if (targetUserId) {
    emitToUser(targetUserId.toString(), 'swap.offer.received', {
      offerId: offer._id,
      offeringPosition: offeringToken.currentPosition,
      offeringTokenCode: offeringToken.tokenCode,
    });

    try {
      await notificationService.sendTokenNotification(
        { _id: offeringTokenId, userId: targetUserId, centerId: offeringToken.centerId },
        'SWAP_OFFER_RECEIVED',
        {
          title: 'Swap Offer Received',
          body: `A customer at queue position ${offeringToken.currentPosition} has offered to swap their position with you.`,
          dedupeKey: `swap_offer_recv_${offer._id}`,
          metadata: { offerId: offer._id.toString() },
        }
      );
    } catch (_) {
      // Notification failure must not block offer creation
    }
  }

  return offer;
}

/**
 * Get all active (PENDING) swap offers visible to a customer.
 * Returns open offers in the same center+service queue as the customer's token,
 * excluding their own. No PII exposed.
 *
 * Also returns their own offers (any status) for status tracking.
 *
 * @param {string} userId
 * @param {string} tokenId - The customer's active token (defines the queue context)
 */
async function getMyOffers(userId, tokenId) {
  if (!mongoose.Types.ObjectId.isValid(tokenId)) {
    const err = new Error('Invalid tokenId format');
    err.status = 400;
    throw err;
  }

  const myToken = await Token.findById(tokenId).lean();
  if (!myToken) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (myToken.userId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You do not own this token');
    err.status = 403;
    throw err;
  }

  // Expire any stale PENDING offers inline before returning
  const now = new Date();

  // My own offers (any status, recent)
  const myOffers = await SwapOffer.find({
    offeringUserId: userId,
    offeringTokenId: tokenId,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  // Expire stale ones
  for (const offer of myOffers) {
    if (offer.status === 'PENDING' && new Date(offer.expiresAt) <= now) {
      const doc = await SwapOffer.findById(offer._id);
      if (doc && doc.status === 'PENDING') {
        await _expireOffer(doc);
        offer.status = 'EXPIRED'; // reflect in response
      }
    }
  }

  // Eligible open offers by others in the same queue (only if my token is WAITING)
  let eligibleOffers = [];
  if (myToken.status === 'WAITING') {
    const rawEligible = await SwapOffer.find({
      centerId: myToken.centerId,
      serviceId: myToken.serviceId,
      status: 'PENDING',
      offeringUserId: { $ne: userId },
      expiresAt: { $gt: now },
      // Either undirected or directed at this user
      $or: [
        { targetUserId: null },
        { targetUserId: userId },
      ],
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .lean();

    // Fetch offering token metadata for anonymized display
    const offeringTokenIds = rawEligible.map((o) => o.offeringTokenId);
    const offeringTokens = await Token.find({ _id: { $in: offeringTokenIds } })
      .select('_id tokenCode currentPosition status')
      .lean();
    const tokenMap = Object.fromEntries(offeringTokens.map((t) => [t._id.toString(), t]));

    eligibleOffers = rawEligible
      .filter((o) => {
        const t = tokenMap[o.offeringTokenId.toString()];
        return t && t.status === 'WAITING'; // Double-check token is still WAITING
      })
      .map((o) => _sanitizeOfferForPublic(o, tokenMap[o.offeringTokenId.toString()]));
  }

  return { myOffers, eligibleOffers };
}

/**
 * Accept a swap offer and execute the atomic position swap.
 *
 * This is the most critical operation. The sequence is:
 * 1. Load and validate the offer (not expired, PENDING)
 * 2. Load accepting token and validate eligibility
 * 3. Re-validate offering token is still WAITING
 * 4. Start a MongoDB transaction
 * 5. Inside transaction: re-fetch both tokens (for snapshot isolation)
 *    and re-validate they are both WAITING with correct ownership/center/service
 * 6. Atomically swap their `createdAt` values (which drives queue ordering)
 * 7. Mark offer COMPLETED
 * 8. Commit transaction
 * 9. Outside transaction: _updateWaitingPositions → recalculate EWT
 * 10. Emit socket events, create QueueEvent, send notifications
 *
 * @param {object} params
 * @param {string} params.offerId
 * @param {string} params.acceptingTokenId
 * @param {string} params.userId - Authenticated accepting user
 */
async function acceptOffer({ offerId, acceptingTokenId, userId }) {
  if (!mongoose.Types.ObjectId.isValid(offerId)) {
    const err = new Error('Invalid offerId format');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(acceptingTokenId)) {
    const err = new Error('Invalid acceptingTokenId format');
    err.status = 400;
    throw err;
  }

  const offer = await SwapOffer.findById(offerId);
  if (!offer) {
    const err = new Error('Swap offer not found');
    err.status = 404;
    throw err;
  }

  // Offer must be PENDING
  if (offer.status !== 'PENDING') {
    const err = new Error(`Swap offer is no longer available: status is ${offer.status}`);
    err.status = 409;
    throw err;
  }

  // Server-side expiry check
  if (new Date() > offer.expiresAt) {
    await _expireOffer(offer);
    const err = new Error('Swap offer has expired');
    err.status = 409;
    throw err;
  }

  // The accepting customer cannot be the one who created the offer
  if (offer.offeringUserId.toString() === userId.toString()) {
    const err = new Error('You cannot accept your own swap offer');
    err.status = 400;
    throw err;
  }

  // If the offer is directed at a specific user, enforce that restriction
  if (offer.targetUserId && offer.targetUserId.toString() !== userId.toString()) {
    const err = new Error('This swap offer is not directed at you');
    err.status = 403;
    throw err;
  }

  // Load accepting token (pre-transaction validation for better error messages)
  const acceptingToken = await Token.findById(acceptingTokenId).lean();
  if (!acceptingToken) {
    const err = new Error('Your token not found');
    err.status = 404;
    throw err;
  }

  if (acceptingToken.userId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You do not own this token');
    err.status = 403;
    throw err;
  }

  if (acceptingToken.status !== 'WAITING') {
    const err = new Error(`Your token cannot participate in a swap: current status is ${acceptingToken.status}`);
    err.status = 409;
    throw err;
  }

  if (acceptingToken.centerId.toString() !== offer.centerId.toString()) {
    const err = new Error('Your token belongs to a different service center than the offer');
    err.status = 400;
    throw err;
  }

  if (acceptingToken.serviceId.toString() !== offer.serviceId.toString()) {
    const err = new Error('Your token belongs to a different service than the offer. Swaps are only permitted within the same queue.');
    err.status = 400;
    throw err;
  }

  // Cannot swap with the offering token itself
  if (acceptingTokenId.toString() === offer.offeringTokenId.toString()) {
    const err = new Error('Cannot swap a token with itself');
    err.status = 400;
    throw err;
  }

  // Tier 4 Feature 4: Document-Ready Gatekeeping
  // Enforce document readiness for the swap participant
  const documentGateService = require('./documentGateService');
  const acceptingReadiness = await documentGateService.checkServiceReadiness({
    serviceId: offer.serviceId,
    userId,
  });
  if (!acceptingReadiness.isReady) {
    const err = new Error('Cannot complete swap: You have not satisfied the document requirements for this service');
    err.status = 403;
    err.code = 'DOCUMENT_GATE_BLOCKED';
    err.gateData = acceptingReadiness;
    throw err;
  }

  // ─── Atomic Transaction ────────────────────────────────────────────────────

  let session = null;
  let swapResult = null;

  try {
    session = await mongoose.startSession();
  } catch (_) {
    session = null;
  }

  const executeSwap = async (sess) => {
    // Re-fetch both tokens with session isolation
    const offeringTx = await Token.findById(offer.offeringTokenId).session(sess);
    const acceptingTx = await Token.findById(acceptingTokenId).session(sess);

    if (!offeringTx || !acceptingTx) {
      const err = new Error('One or both tokens no longer exist');
      err.status = 409;
      throw err;
    }

    // Re-validate both are still WAITING (race condition guard)
    if (offeringTx.status !== 'WAITING') {
      const err = new Error(`Offering token status changed to ${offeringTx.status}. Swap is no longer possible.`);
      err.status = 409;
      throw err;
    }
    if (acceptingTx.status !== 'WAITING') {
      const err = new Error(`Your token status changed to ${acceptingTx.status}. Swap is no longer possible.`);
      err.status = 409;
      throw err;
    }

    // Re-validate center/service match
    if (offeringTx.centerId.toString() !== acceptingTx.centerId.toString() ||
        offeringTx.serviceId.toString() !== acceptingTx.serviceId.toString()) {
      const err = new Error('Tokens belong to different queues. Swap aborted.');
      err.status = 409;
      throw err;
    }

    // Re-validate ownership
    if (offeringTx.userId.toString() !== offer.offeringUserId.toString()) {
      const err = new Error('Offering token ownership changed. Swap aborted.');
      err.status = 409;
      throw err;
    }
    if (acceptingTx.userId.toString() !== userId.toString()) {
      const err = new Error('Accepting token ownership mismatch. Swap aborted.');
      err.status = 409;
      throw err;
    }

    // Re-check offer state (race: another accept came in simultaneously)
    const offerTx = await SwapOffer.findById(offer._id).session(sess);
    if (!offerTx || offerTx.status !== 'PENDING') {
      const err = new Error('Swap offer is no longer available (race condition)');
      err.status = 409;
      throw err;
    }

    // Re-check expiry inside transaction
    if (new Date() > offerTx.expiresAt) {
      const err = new Error('Swap offer expired');
      err.status = 409;
      throw err;
    }

    // Capture positions before swap for audit snapshot
    const offeringPositionBefore = offeringTx.currentPosition;
    const acceptingPositionBefore = acceptingTx.currentPosition;

    // THE CORE SWAP: exchange createdAt values atomically.
    // Since queue ordering is sort({ createdAt: 1 }), swapping createdAt
    // swaps the logical positions while preserving all identity fields
    // (tokenCode, tokenNumber, userId, centerId, serviceId, QR, etc.)
    let newOfferingCreatedAt = acceptingTx.createdAt;
    let newAcceptingCreatedAt = offeringTx.createdAt;

    if (newOfferingCreatedAt.getTime() === newAcceptingCreatedAt.getTime()) {
      if (offeringPositionBefore < acceptingPositionBefore) {
        newOfferingCreatedAt = new Date(newAcceptingCreatedAt.getTime() + 1000);
      } else {
        newOfferingCreatedAt = new Date(newAcceptingCreatedAt.getTime() - 1000);
      }
    }

    // Direct collection.updateOne is required because Mongoose schema timestamps: true
    // protects createdAt from modification via Model.findOneAndUpdate / Model.updateOne.
    await Token.collection.updateOne(
      { _id: offer.offeringTokenId, status: 'WAITING' },
      { $set: { createdAt: newOfferingCreatedAt } },
      sess ? { session: sess } : {}
    );

    await Token.collection.updateOne(
      { _id: acceptingTokenId, status: 'WAITING' },
      { $set: { createdAt: newAcceptingCreatedAt } },
      sess ? { session: sess } : {}
    );

    // Mark offer as ACCEPTED then COMPLETED atomically
    await SwapOffer.findOneAndUpdate(
      { _id: offer._id, status: 'PENDING' },
      {
        $set: {
          status: 'COMPLETED',
          acceptedAt: new Date(),
          completedAt: new Date(),
          acceptingTokenId,
          acceptingUserId: userId,
          'auditSnapshot.offeringTokenCode': offeringTx.tokenCode,
          'auditSnapshot.targetTokenCode': acceptingTx.tokenCode,
          'auditSnapshot.offeringPositionBefore': offeringPositionBefore,
          'auditSnapshot.targetPositionBefore': acceptingPositionBefore,
        },
      },
      { session: sess, new: true }
    );

    return {
      offeringTokenId: offer.offeringTokenId,
      acceptingTokenId,
      offeringPositionBefore,
      acceptingPositionBefore,
      offeringTokenCode: offeringTx.tokenCode,
      acceptingTokenCode: acceptingTx.tokenCode,
      centerId: offeringTx.centerId,
      serviceId: offeringTx.serviceId,
      offeringUserId: offer.offeringUserId,
      acceptingUserId: userId,
    };
  };

  try {
    if (session) {
      await session.withTransaction(async () => {
        swapResult = await executeSwap(session);
      });
    } else {
      // Fallback for non-replica-set environments (integration test setups).
      // Uses findOneAndUpdate with status: 'WAITING' condition as optimistic lock.
      swapResult = await executeSwap(null);
    }
  } catch (err) {
    throw err;
  } finally {
    if (session) await session.endSession();
  }

  // ─── Post-transaction: Rebuild positions, emit events, notify ─────────────

  // Rebuild currentPosition + waitEstimateMinutes for all WAITING tokens
  // This uses the existing canonical EWT engine — no second EWT.
  await queueService._updateWaitingPositions(swapResult.centerId, swapResult.serviceId);

  // Fetch updated positions for audit snapshot completion
  const [offeringFinal, acceptingFinal] = await Promise.all([
    Token.findById(swapResult.offeringTokenId).select('currentPosition').lean(),
    Token.findById(swapResult.acceptingTokenId).select('currentPosition').lean(),
  ]);

  // Update audit snapshot with post-swap positions
  await SwapOffer.findByIdAndUpdate(offer._id, {
    $set: {
      'auditSnapshot.offeringPositionAfter': offeringFinal ? offeringFinal.currentPosition : null,
      'auditSnapshot.targetPositionAfter': acceptingFinal ? acceptingFinal.currentPosition : null,
    },
  });

  // QueueEvent audit log
  await QueueEvent.create({
    centerId: swapResult.centerId,
    tokenId: swapResult.offeringTokenId,
    eventType: 'SWAP_COMPLETED',
    performedBy: null, // system-executed on behalf of both users
    metadata: {
      offerId: offer._id.toString(),
      offeringTokenId: swapResult.offeringTokenId.toString(),
      offeringTokenCode: swapResult.offeringTokenCode,
      offeringUserId: swapResult.offeringUserId.toString(),
      acceptingTokenId: swapResult.acceptingTokenId.toString(),
      acceptingTokenCode: swapResult.acceptingTokenCode,
      acceptingUserId: swapResult.acceptingUserId.toString(),
      positionsBefore: {
        offering: swapResult.offeringPositionBefore,
        accepting: swapResult.acceptingPositionBefore,
      },
      positionsAfter: {
        offering: offeringFinal ? offeringFinal.currentPosition : null,
        accepting: acceptingFinal ? acceptingFinal.currentPosition : null,
      },
    },
  });

  // Socket events — user-private rooms (no PII to center room)
  const swapCompletedPayload = {
    offerId: offer._id,
    centerId: swapResult.centerId,
    serviceId: swapResult.serviceId,
  };
  emitToUser(swapResult.offeringUserId.toString(), 'swap.completed', {
    ...swapCompletedPayload,
    yourPosition: offeringFinal ? offeringFinal.currentPosition : null,
    yourTokenCode: swapResult.offeringTokenCode,
  });
  emitToUser(swapResult.acceptingUserId.toString(), 'swap.completed', {
    ...swapCompletedPayload,
    yourPosition: acceptingFinal ? acceptingFinal.currentPosition : null,
    yourTokenCode: swapResult.acceptingTokenCode,
  });

  // Emit the canonical queue.updated to the center (no PII). A swap reorders the
  // real waiting line, so this must carry the same authoritative payload every
  // other queue mutation emits.
  await queueService.emitQueueUpdated(swapResult.centerId, swapResult.serviceId);

  // Notifications — reuse existing notificationService.sendTokenNotification
  try {
    await Promise.all([
      notificationService.sendTokenNotification(
        { _id: swapResult.offeringTokenId, userId: swapResult.offeringUserId, centerId: swapResult.centerId },
        'SWAP_COMPLETED',
        {
          title: 'Position Swap Complete',
          body: `Your queue position has been swapped. You are now at position ${offeringFinal ? offeringFinal.currentPosition : '?'}.`,
          dedupeKey: `swap_completed_offering_${offer._id}`,
        }
      ),
      notificationService.sendTokenNotification(
        { _id: swapResult.acceptingTokenId, userId: swapResult.acceptingUserId, centerId: swapResult.centerId },
        'SWAP_COMPLETED',
        {
          title: 'Position Swap Complete',
          body: `Your queue position has been swapped. You are now at position ${acceptingFinal ? acceptingFinal.currentPosition : '?'}.`,
          dedupeKey: `swap_completed_accepting_${offer._id}`,
        }
      ),
    ]);
  } catch (_) {
    // Notification failures must not roll back a completed swap
  }

  // Centralized Resource Allocation: a swap reorders the real waiting line, so
  // a free counter may now be able to serve a customer it previously could not
  // reach. Re-evaluate rather than assume the queue is unchanged.
  require('./resourceAllocationService').triggerAllocation(swapResult.centerId);

  return {
    offerId: offer._id,
    offeringTokenId: swapResult.offeringTokenId,
    offeringTokenCode: swapResult.offeringTokenCode,
    offeringPositionAfter: offeringFinal ? offeringFinal.currentPosition : null,
    acceptingTokenId: swapResult.acceptingTokenId,
    acceptingTokenCode: swapResult.acceptingTokenCode,
    acceptingPositionAfter: acceptingFinal ? acceptingFinal.currentPosition : null,
  };
}

/**
 * Decline a swap offer.
 *
 * @param {object} params
 * @param {string} params.offerId
 * @param {string} params.userId - Authenticated declining user
 */
async function declineOffer({ offerId, userId }) {
  if (!mongoose.Types.ObjectId.isValid(offerId)) {
    const err = new Error('Invalid offerId format');
    err.status = 400;
    throw err;
  }

  const offer = await SwapOffer.findById(offerId);
  if (!offer) {
    const err = new Error('Swap offer not found');
    err.status = 404;
    throw err;
  }

  if (offer.status !== 'PENDING') {
    const err = new Error(`Cannot decline: offer status is ${offer.status}`);
    err.status = 409;
    throw err;
  }

  // Server-side expiry check
  if (new Date() > offer.expiresAt) {
    await _expireOffer(offer);
    const err = new Error('Swap offer has already expired');
    err.status = 409;
    throw err;
  }

  // Decline must be done by the target user (if directed) or any eligible customer
  if (offer.targetUserId && offer.targetUserId.toString() !== userId.toString()) {
    const err = new Error('This offer is not directed at you');
    err.status = 403;
    throw err;
  }

  // Cannot decline your own offer
  if (offer.offeringUserId.toString() === userId.toString()) {
    const err = new Error('You cannot decline your own offer. Use cancel instead.');
    err.status = 400;
    throw err;
  }

  offer.status = 'DECLINED';
  offer.declinedAt = new Date();
  await offer.save();

  // Notify the offering customer
  emitToUser(offer.offeringUserId.toString(), 'swap.offer.declined', {
    offerId: offer._id,
    tokenId: offer.offeringTokenId,
  });

  try {
    const offeringToken = await Token.findById(offer.offeringTokenId).select('tokenCode centerId');
    if (offeringToken) {
      await notificationService.sendTokenNotification(
        { _id: offer.offeringTokenId, userId: offer.offeringUserId, centerId: offeringToken.centerId },
        'SWAP_DECLINED',
        {
          title: 'Swap Offer Declined',
          body: `Your swap offer for token ${offeringToken.tokenCode} was declined.`,
          dedupeKey: `swap_declined_${offer._id}`,
        }
      );
    }
  } catch (_) {
    // non-fatal
  }

  return { offerId: offer._id, status: 'DECLINED' };
}

/**
 * Cancel a swap offer (by the offering customer only).
 *
 * @param {object} params
 * @param {string} params.offerId
 * @param {string} params.userId - Must be the offering user
 */
async function cancelOffer({ offerId, userId }) {
  if (!mongoose.Types.ObjectId.isValid(offerId)) {
    const err = new Error('Invalid offerId format');
    err.status = 400;
    throw err;
  }

  const offer = await SwapOffer.findById(offerId);
  if (!offer) {
    const err = new Error('Swap offer not found');
    err.status = 404;
    throw err;
  }

  if (offer.offeringUserId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You can only cancel your own swap offers');
    err.status = 403;
    throw err;
  }

  if (offer.status !== 'PENDING') {
    const err = new Error(`Cannot cancel: offer status is ${offer.status}`);
    err.status = 409;
    throw err;
  }

  offer.status = 'CANCELLED';
  offer.cancelledAt = new Date();
  await offer.save();

  emitToUser(offer.offeringUserId.toString(), 'swap.offer.cancelled', {
    offerId: offer._id,
    tokenId: offer.offeringTokenId,
  });

  if (offer.targetUserId) {
    emitToUser(offer.targetUserId.toString(), 'swap.offer.cancelled', {
      offerId: offer._id,
    });
  }

  return { offerId: offer._id, status: 'CANCELLED' };
}

/**
 * Expire all pending offers that have passed their expiresAt.
 * Called periodically or on-demand; non-fatal.
 *
 * @param {string} centerId  - Optional filter by center
 * @param {string} serviceId - Optional filter by service
 */
async function expireStaleOffers(centerId = null, serviceId = null) {
  const filter = {
    status: 'PENDING',
    expiresAt: { $lte: new Date() },
  };
  if (centerId) filter.centerId = centerId;
  if (serviceId) filter.serviceId = serviceId;

  const stale = await SwapOffer.find(filter).limit(100);
  const expired = [];

  for (const offer of stale) {
    try {
      await _expireOffer(offer);
      expired.push(offer._id);
    } catch (_) {
      // Non-fatal; continue with next
    }
  }

  return expired;
}

/**
 * Get a single offer by ID, with access scoped to participants only.
 */
async function getOfferById(offerId, userId) {
  if (!mongoose.Types.ObjectId.isValid(offerId)) {
    const err = new Error('Invalid offerId format');
    err.status = 400;
    throw err;
  }

  const offer = await SwapOffer.findById(offerId).lean();
  if (!offer) {
    const err = new Error('Swap offer not found');
    err.status = 404;
    throw err;
  }

  // Only participants (offering user or target user) may view the full offer
  const isParticipant =
    offer.offeringUserId.toString() === userId.toString() ||
    (offer.targetUserId && offer.targetUserId.toString() === userId.toString()) ||
    (offer.acceptingUserId && offer.acceptingUserId.toString() === userId.toString());

  if (!isParticipant) {
    const err = new Error('Unauthorized: You are not a participant in this swap offer');
    err.status = 403;
    throw err;
  }

  // Check and update expiry
  if (offer.status === 'PENDING' && new Date() > new Date(offer.expiresAt)) {
    const doc = await SwapOffer.findById(offerId);
    if (doc && doc.status === 'PENDING') {
      await _expireOffer(doc);
      offer.status = 'EXPIRED';
    }
  }

  return offer;
}

module.exports = {
  getEligibleSwapPartners,
  createOffer,
  getMyOffers,
  acceptOffer,
  declineOffer,
  cancelOffer,
  expireStaleOffers,
  getOfferById,
};

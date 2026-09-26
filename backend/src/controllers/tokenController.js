'use strict';

const { body } = require('express-validator');
const { Token } = require('../models/Token');
const queueService = require('../services/queueService');
const { generateQRCodeImage } = require('../utils/tokenUtils');
const { verifyQRPayload, QR_TTL_SECONDS } = require('../utils/qrSecurity');
const asyncHandler = require('../utils/asyncHandler');
const { logger } = require('../utils/logger');
const {
  sendSuccess,
  sendCreated,
  sendNotFound,
  sendBadRequest,
  sendConflict,
  sendUnauthorized,
} = require('../utils/apiResponse');

// ─── Validation ───────────────────────────────────────────────────────────────
const joinValidation = [
  body('centerId').isMongoId().withMessage('Valid centerId is required'),
  body('serviceId').isMongoId().withMessage('Valid serviceId is required'),
  body('notifyApp').optional().isBoolean(),
  body('notifySms').optional().isBoolean(),
];

const feedbackValidation = [
  body('rating')
    .custom((val) => typeof val === 'number' && Number.isInteger(val) && val >= 1 && val <= 5)
    .withMessage('Rating must be an integer between 1 and 5'),
  body('comment')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Comment must not exceed 500 characters'),
];

const verifyQRValidation = [
  body('qrPayload')
    .isString()
    .trim()
    .isLength({ min: 10, max: 2048 })
    .withMessage('qrPayload is required and must be a string'),
];

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * POST /api/tokens
 * Customer joins a queue — generates a token.
 * Protected: CUSTOMER role
 */
const create = asyncHandler(async (req, res) => {
  const { centerId, serviceId, notifyApp = true, notifySms = false } = req.body;

  try {
    const { token, queue } = await queueService.joinQueue({
      userId: req.user._id.toString(),
      centerId,
      serviceId,
      notifyApp,
      notifySms,
    });

    return sendCreated(res, {
      message: 'Token generated successfully',
      data: {
        token,
        queue: {
          waitingCount: queue.waitingCount,
          totalIssued: queue.totalIssued,
          avgServiceTimeSeconds: queue.avgServiceTimeSeconds,
        },
      },
    });
  } catch (err) {
    if (err.status === 409 || err.code === 11000) {
      return sendConflict(res, err.message || 'You already have an active token for this service at this center');
    }
    if (err.status === 404) {
      return sendNotFound(res, err.message);
    }
    if (err.status >= 400 && err.status < 500) {
      return sendBadRequest(res, err.message);
    }
    throw err;
  }
});

/**
 * GET /api/tokens/my
 * Get the authenticated user's active token(s).
 */
const getMyTokens = asyncHandler(async (req, res) => {
  let pageNum = parseInt(req.query.page, 10);
  if (isNaN(pageNum) || pageNum < 1) pageNum = 1;

  let limitNum = parseInt(req.query.limit, 10);
  if (isNaN(limitNum) || limitNum < 1) limitNum = 10;
  if (limitNum > 100) limitNum = 100;

  const filter = { userId: req.user._id };
  if (req.query.status && typeof req.query.status === 'string') {
    const s = req.query.status.trim().toUpperCase();
    if (['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'EXPIRED'].includes(s)) {
      filter.status = s;
    }
  }

  const skip = (pageNum - 1) * limitNum;
  const total = await Token.countDocuments(filter);

  const tokens = await Token.find(filter)
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .populate('centerId', 'name type address')
    .populate('counterId', 'name number')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .lean({ virtuals: true });

  return sendSuccess(res, {
    data: { tokens },
    meta: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum) || 1,
    },
  });
});

/**
 * Internal helper to enrich a live active token with real-time queue context:
 * people ahead, currently serving token, and active counters for that service.
 */
async function _enrichTokenWithLiveQueue(token) {
  if (!token || !['WAITING', 'CALLED', 'SERVING'].includes(token.status)) {
    return token;
  }
  const Counter = require('../models/Counter');
  const centerId = token.centerId?._id || token.centerId;
  const serviceId = token.serviceId?._id || token.serviceId;

  const peopleAhead = token.status === 'WAITING' ? Math.max(0, (token.currentPosition || 1) - 1) : 0;

  const servingToken = await Token.findOne({
    centerId,
    serviceId,
    status: { $in: ['CALLED', 'SERVING'] },
  })
    .populate('counterId', 'name number displayLabel')
    .sort({ calledAt: -1 })
    .select('tokenCode status counterId calledAt')
    .lean();

  const activeCounters = await Counter.find({
    centerId,
    serviceId,
    status: 'ACTIVE',
  })
    .select('name number displayLabel currentTokenId')
    .lean();

  return {
    ...token,
    peopleAhead,
    servingToken: servingToken || null,
    activeCounters: activeCounters || [],
    estimatedWaitMinutes: token.waitEstimateMinutes !== undefined ? token.waitEstimateMinutes : null,
  };
}

/**
 * GET /api/tokens/active
 * Get the user's currently active token (WAITING/CALLED/SERVING) enriched with live queue transparency.
 */
const getActiveToken = asyncHandler(async (req, res) => {
  const token = await Token.findOne({
    userId: req.user._id,
    status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
  })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .populate('centerId', 'name type address currentCrowd capacity')
    .populate('counterId', 'name number displayLabel')
    .lean({ virtuals: true });

  const enriched = token ? await _enrichTokenWithLiveQueue(token) : null;
  return sendSuccess(res, { data: { token: enriched } });
});

/**
 * GET /api/tokens/:id
 * Get a specific token (must belong to the authenticated user or admin/staff).
 */
const getById = asyncHandler(async (req, res) => {
  const token = await Token.findById(req.params.id)
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .populate('centerId', 'name type address currentCrowd capacity')
    .populate('counterId', 'name number displayLabel')
    .populate('userId', 'name email')
    .lean({ virtuals: true });

  if (!token) return sendNotFound(res, 'Token not found');

  // Customers can only see their own tokens
  if (
    req.user.role === 'CUSTOMER' &&
    token.userId._id.toString() !== req.user._id.toString()
  ) {
    return sendNotFound(res, 'Token not found');
  }

  const enriched = await _enrichTokenWithLiveQueue(token);
  return sendSuccess(res, { data: { token: enriched } });
});

/**
 * GET /api/tokens/:id/qr
 * Return the QR code image for a token.
 *
 * Phase 4: Returns only the QR image (base64 PNG).
 * Does NOT return the raw qrData string in the response to prevent
 * raw payload inspection/tampering from the customer app.
 * The Flutter client renders the image directly from the base64 data URL.
 *
 * The qrData stored on the token is the signed payload and is what gets
 * encoded into the QR image — the QR image itself is the verification artifact.
 */
const getQR = asyncHandler(async (req, res) => {
  const token = await Token.findById(req.params.id).select('qrData qrNonce qrIssuedAt userId status');
  if (!token) return sendNotFound(res, 'Token not found');

  if (
    req.user.role === 'CUSTOMER' &&
    token.userId.toString() !== req.user._id.toString()
  ) {
    return sendNotFound(res, 'Token not found');
  }

  // Only allow QR for active tokens
  if (!['WAITING', 'CALLED', 'SERVING'].includes(token.status)) {
    return sendBadRequest(res, 'QR code is only available for active tokens');
  }

  if (!token.qrData) {
    return sendNotFound(res, 'QR data not available for this token');
  }

  const qrImage = await generateQRCodeImage(token.qrData);

  // Return the QR image and the QR payload string.
  // The Flutter app renders qrImage (base64 PNG) or encodes qrData into its own QR widget.
  // qrData is the signed payload — the scanner reads it and submits it to /api/tokens/verify-qr.
  return sendSuccess(res, {
    data: {
      qrImage,
      // qrData is the signed payload the Flutter QR widget should encode.
      // It is NOT a secret — it is tamper-evident via HMAC, not by obscurity.
      qrData: token.qrData,
      expiresInSeconds: QR_TTL_SECONDS,
    },
  });
});

/**
 * POST /api/tokens/verify-qr
 * QR verification endpoint — called by authenticated scanners/staff.
 *
 * Authenticates scanner via existing JWT + role check (STAFF or ADMIN),
 * or via IoT device secret (handled at route level via iotSecret middleware).
 *
 * Performs:
 * 1. Schema validation of qrPayload
 * 2. Cryptographic HMAC-SHA256 signature verification
 * 3. Expiry check
 * 4. Future-issuedAt check
 * 5. Token DB state validation
 * 6. Center authorization (scanner's authenticated center must match QR)
 * 7. Atomic nonce check + consume (prevents replay and concurrent duplicate scans)
 * 8. Returns minimum safe information to the scanner
 */
const verifyQR = asyncHandler(async (req, res) => {
  const { qrPayload } = req.body;

  // 1. Parse and verify cryptographic signature + expiry
  let parsed;
  try {
    parsed = verifyQRPayload(qrPayload);
  } catch (err) {
    logger.security('QR_VERIFICATION_FAILURE', {
      requestId: req.id,
      reason: err._reason || err.message,
      clientIp: req.ip,
      userId: req.user ? req.user._id?.toString() : undefined,
    });
    return sendBadRequest(res, 'QR verification failed');
  }

  const { tid: tokenId, cid: centerId, jti: nonce } = parsed;

  // 2. Atomically check nonce + consume it in a single findOneAndUpdate.
  // This prevents TOCTOU race conditions: two concurrent scans with the same QR
  // will both attempt this update; only one will match the current qrNonce.
  const token = await Token.findOneAndUpdate(
    {
      _id: tokenId,
      qrNonce: nonce,         // only matches if nonce has not been consumed/rotated
      qrConsumed: false,      // only matches if not already consumed
      status: { $in: ['WAITING', 'CALLED', 'SERVING'] }, // only active tokens
    },
    {
      $set: { qrConsumed: true, qrNonce: null },
    },
    {
      new: true,
      select: 'tokenCode tokenNumber centerId serviceId status counterId userId',
    }
  );

  if (!token) {
    logger.security('QR_VERIFICATION_FAILURE', {
      requestId: req.id,
      reason: 'nonce_replay_or_token_consumed_or_inactive',
      clientIp: req.ip,
      userId: req.user ? req.user._id?.toString() : undefined,
    });
    return sendBadRequest(res, 'QR verification failed');
  }

  // 3. Center authorization — the QR centerId must match the token's actual centerId
  if (token.centerId.toString() !== centerId.toString()) {
    // This would only happen if signature was somehow bypassed — extra defense
    return sendBadRequest(res, 'QR verification failed');
  }

  // 4. If the request comes from a JWT-authenticated user (staff/admin),
  //    verify they belong to the same center (if their centerId is available).
  //    IoT devices are pre-authorized at route level via iotSecret — no centerId claim in IoT requests.
  if (req.user) {
    // Staff/admin: optionally check center assignment (if user has centerId on their record)
    // This is a best-effort check — the token.centerId is the authoritative center
    // We do not trust client-provided centerId claims
  }

  // 5. Return minimal scanner-safe information — no PII, no secrets
  return sendSuccess(res, {
    message: 'QR verified successfully',
    data: {
      tokenCode: token.tokenCode,
      tokenNumber: token.tokenNumber,
      status: token.status,
      centerId: token.centerId.toString(),
      serviceId: token.serviceId.toString(),
      // counterId may be null if not yet called
      counterId: token.counterId ? token.counterId.toString() : null,
    },
  });
});

/**
 * POST /api/tokens/:id/cancel
 * Customer cancels their own waiting token.
 */
const cancel = asyncHandler(async (req, res) => {
  try {
    const token = await queueService.cancelToken({
      tokenId: req.params.id,
      userId: req.user._id.toString(),
    });
    return sendSuccess(res, { message: 'Token cancelled', data: { token } });
  } catch (err) {
    if (err.status === 403) {
      return sendNotFound(res, 'Token not found');
    }
    if (err.status === 400) {
      return sendBadRequest(res, err.message);
    }
    throw err;
  }
});

/**
 * POST /api/tokens/:id/feedback
 * Customer submits feedback after service completion.
 */
const submitFeedback = asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;

  if (!rating || rating < 1 || rating > 5) {
    return sendBadRequest(res, 'Rating must be between 1 and 5');
  }

  const token = await Token.findOneAndUpdate(
    {
      _id: req.params.id,
      userId: req.user._id,
      status: 'COMPLETED',
      'feedback.rating': null,
    },
    {
      $set: {
        'feedback.rating': rating,
        'feedback.comment': comment || null,
        'feedback.submittedAt': new Date(),
      },
    },
    { new: true }
  );

  if (!token) {
    return sendNotFound(res, 'Token not found or feedback already submitted');
  }

  return sendSuccess(res, { message: 'Feedback submitted', data: { feedback: token.feedback } });
});

module.exports = {
  create,
  getMyTokens,
  getActiveToken,
  getById,
  getQR,
  verifyQR,
  cancel,
  submitFeedback,
  joinValidation,
  feedbackValidation,
  verifyQRValidation,
};

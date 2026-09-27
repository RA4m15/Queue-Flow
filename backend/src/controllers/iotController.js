'use strict';

const { body } = require('express-validator');
const User = require('../models/User');
const ServiceCenter = require('../models/ServiceCenter');
const FootfallEvent = require('../models/FootfallEvent');
const { Token } = require('../models/Token');
const queueService = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendBadRequest, sendNotFound } = require('../utils/apiResponse');
const { emitToCenter } = require('../config/socket');
const { verifyQRPayload } = require('../utils/qrSecurity');
const { logger } = require('../utils/logger');

// ─── Validation ───────────────────────────────────
const rfidValidation = [
  body('uid').trim().notEmpty().withMessage('RFID UID is required'),
  body('centerId').isMongoId().withMessage('Valid centerId is required'),
];

const crowdValidation = [
  body('centerId').isMongoId().withMessage('Valid centerId is required'),
  body('type').isIn(['ENTRY', 'EXIT', 'COUNT']).withMessage('Type must be ENTRY, EXIT, or COUNT'),
  body('count').optional().isInt({ min: 0 }).withMessage('Count must be a non-negative integer'),
  body('sensorId').optional().isString(),
];

const scanQRValidation = [
  body('qrPayload')
    .isString()
    .trim()
    .isLength({ min: 10, max: 2048 })
    .withMessage('qrPayload is required'),
  body('centerId')
    .optional()
    .isMongoId()
    .withMessage('centerId must be a valid MongoId'),
];

// ─── IoT Controllers ──────────────────────────────

/**
 * POST /api/iot/rfid
 * ESP32 sends an RFID UID. Look up the customer and return their profile.
 * Auth: x-iot-secret header
 */
const handleRfid = asyncHandler(async (req, res) => {
  const { uid, centerId } = req.body;

  const user = await User.findOne({ rfidUid: uid.toUpperCase() });

  if (!user) {
    return sendNotFound(res, 'No registered user found for this RFID card');
  }

  // Check if user has an active token at this center
  const activeToken = await Token.findOne({
    userId: user._id,
    centerId,
    status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
  })
    .populate('serviceId', 'name tokenPrefix')
    .lean();

  return sendSuccess(res, {
    message: 'RFID verified',
    data: {
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        rfidUid: user.rfidUid,
      },
      activeToken: activeToken || null,
    },
  });
});

/**
 * POST /api/iot/crowd
 * ESP32 or crowd_monitor sensor sends an ENTRY, EXIT, or live COUNT event.
 * Updates service center currentCrowd and records FootfallEvent.
 * Auth: x-iot-secret header
 */
const handleCrowd = asyncHandler(async (req, res) => {
  const { centerId, type, sensorId, rawPayload, count, currentCrowd } = req.body;

  const center = await ServiceCenter.findById(centerId);
  if (!center) return sendNotFound(res, 'Service center not found');

  let updatedCenter;
  if (type === 'COUNT') {
    const rawVal = typeof count === 'number' ? count : (typeof currentCrowd === 'number' ? currentCrowd : 0);
    const newCount = Math.max(0, parseInt(rawVal, 10) || 0);
    // A COUNT is an absolute reading of current occupancy, so it replaces the
    // stored value outright (including 0). crowdUpdatedAt records freshness so the
    // display can distinguish "zero people" from "sensor stopped reporting".
    updatedCenter = await ServiceCenter.findByIdAndUpdate(
      centerId,
      { $set: { currentCrowd: newCount, crowdUpdatedAt: new Date() } },
      { new: true }
    ).lean({ virtuals: true });
  } else {
    // Update crowd count atomically for ENTRY / EXIT
    const increment = type === 'ENTRY' ? 1 : -1;
    updatedCenter = await ServiceCenter.findByIdAndUpdate(
      centerId,
      { $inc: { currentCrowd: increment }, $set: { crowdUpdatedAt: new Date() } },
      { new: true }
    ).lean({ virtuals: true });

    // Ensure count doesn't go below 0
    if (updatedCenter.currentCrowd < 0) {
      await ServiceCenter.findByIdAndUpdate(centerId, { $set: { currentCrowd: 0 } });
      updatedCenter.currentCrowd = 0;
    }
  }

  // Record the event
  const event = await FootfallEvent.create({
    centerId,
    type,
    countAfter: updatedCenter.currentCrowd,
    source: 'IOT',
    sensorId: sensorId || null,
    rawPayload: rawPayload || null,
  });

  const capacity = updatedCenter.capacity || center.capacity || 200;
  const crowdPercent = Math.round((updatedCenter.currentCrowd / capacity) * 100);
  const crowdStatus = crowdPercent >= 80 ? 'HIGH' : (crowdPercent >= 50 ? 'MODERATE' : 'LOW');

  // Emit real-time update to all admin/user listeners for this center
  emitToCenter(centerId.toString(), 'crowd.updated', {
    centerId,
    currentCrowd: updatedCenter.currentCrowd,
    crowdPercent,
    crowdStatus,
    capacity,
    // Freshness stamp so clients can age out a silent sensor
    crowdUpdatedAt: updatedCenter.crowdUpdatedAt,
    event: {
      type,
      sensorId,
      timestamp: event.createdAt,
    },
  });

  return sendSuccess(res, {
    message: `Crowd ${type} recorded`,
    data: {
      currentCrowd: updatedCenter.currentCrowd,
      crowdPercent,
      crowdStatus,
      crowdUpdatedAt: updatedCenter.crowdUpdatedAt,
    },
  });
});

/**
 * POST /api/iot/scan-qr
 * Physical scanner (ESP32 or kiosk) submits a scanned QR payload for verification.
 * Auth: x-iot-secret header (shared device secret — never embedded in Flutter app).
 *
 * The IoT device does NOT need to know the signing secret or perform any
 * cryptographic operation itself. It sends the raw QR string to the server,
 * and the server verifies the signature, expiry, nonce, and token state.
 *
 * Returns only the minimum information needed for the scanner to display
 * the result (token code, status, center). Never returns PII, JWT, or secrets.
 */
const scanQR = asyncHandler(async (req, res) => {
  const { qrPayload } = req.body;

  // 1. Cryptographic verification
  let parsed;
  try {
    parsed = verifyQRPayload(qrPayload);
  } catch (err) {
    logger.security('IOT_QR_VERIFICATION_FAILURE', {
      requestId: req.id,
      reason: err._reason || err.message,
      clientIp: req.ip,
    });
    return sendBadRequest(res, 'QR verification failed');
  }

  const { tid: tokenId, cid: centerId, jti: nonce } = parsed;

  // 2. Atomic nonce consumption — prevents replay and concurrent duplicate scans
  const token = await Token.findOneAndUpdate(
    {
      _id: tokenId,
      qrNonce: nonce,
      qrConsumed: false,
      status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
    },
    {
      $set: { qrConsumed: true, qrNonce: null },
    },
    {
      new: true,
      select: 'tokenCode tokenNumber centerId serviceId status counterId',
    }
  );

  if (!token) {
    logger.security('IOT_QR_VERIFICATION_FAILURE', {
      requestId: req.id,
      reason: 'nonce_replay_or_token_consumed_or_inactive',
      clientIp: req.ip,
    });
    return sendBadRequest(res, 'QR verification failed');
  }

  // 3. Center authorization — QR centerId must match token's actual centerId
  if (token.centerId.toString() !== centerId.toString()) {
    return sendBadRequest(res, 'QR verification failed');
  }

  // 4. Return minimal safe info to the scanner device
  return sendSuccess(res, {
    message: 'QR verified',
    data: {
      tokenCode: token.tokenCode,
      tokenNumber: token.tokenNumber,
      status: token.status,
      centerId: token.centerId.toString(),
    },
  });
});

module.exports = { handleRfid, handleCrowd, scanQR, rfidValidation, crowdValidation, scanQRValidation };

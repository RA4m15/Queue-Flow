'use strict';

const router = require('express').Router();
const { protect, iotSecret, requireRole } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const {
  tokenCreateLimiter,
  feedbackLimiter,
  verifyQRLimiter,
  locationLimiter,
} = require('../middleware/rateLimiter');
const {
  create,
  getMyTokens,
  getActiveToken,
  getById,
  getQR,
  verifyQR,
  cancel,
  submitFeedback,
  updateLocation,
  getProximity,
  joinValidation,
  feedbackValidation,
  verifyQRValidation,
  locationValidation,
} = require('../controllers/tokenController');

// All standard token routes require customer/staff/admin authentication
router.use(protect);

router.post('/', tokenCreateLimiter, joinValidation, validate, create);
router.get('/my', getMyTokens);
router.get('/active', getActiveToken);
router.get('/:id', validateObjectId('id'), getById);
router.get('/:id/qr', validateObjectId('id'), getQR);
router.post('/:id/cancel', validateObjectId('id'), cancel);
router.post('/:id/feedback', validateObjectId('id'), feedbackLimiter, feedbackValidation, validate, submitFeedback);

// ─── Tier 4 Feature 1: Ghost Queue Geofencing ────────────────────────────────
router.post(
  '/:id/location',
  validateObjectId('id'),
  locationLimiter,
  locationValidation,
  validate,
  updateLocation
);
router.get('/:id/proximity', validateObjectId('id'), getProximity);

// ─── Tier 4 Feature 2: Service Graph Multi-Hop Journey ────────────────────────
const {
  getNextServices,
  confirmNextHop,
  getJourney,
  confirmNextHopValidation,
} = require('../controllers/serviceGraphController');

router.get('/:id/next-service', validateObjectId('id'), getNextServices);
router.post(
  '/:id/next-service/confirm',
  validateObjectId('id'),
  tokenCreateLimiter,
  confirmNextHopValidation,
  validate,
  confirmNextHop
);
router.get('/:id/journey', validateObjectId('id'), getJourney);

// ─── QR Verification — STAFF/ADMIN only ───────────────────────────────────────
// Requires a valid JWT with STAFF or ADMIN role.
// IoT scanners authenticating via X-IoT-Secret header use the separate /api/iot/scan-qr route.
router.post(
  '/verify-qr',
  verifyQRLimiter,
  requireRole('STAFF', 'ADMIN'),
  verifyQRValidation,
  validate,
  verifyQR
);

module.exports = router;


'use strict';

const router = require('express').Router();
const { protect, iotSecret, requireRole } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const {
  tokenCreateLimiter,
  feedbackLimiter,
  verifyQRLimiter,
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
  joinValidation,
  feedbackValidation,
  verifyQRValidation,
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

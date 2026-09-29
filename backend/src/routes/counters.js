'use strict';

const router = require('express').Router();
const { protect, requireRole } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const {
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
} = require('../controllers/counterController');

// Operator dedicated endpoint (MUST be before /:id)
router.get('/operator/me', protect, requireRole('ADMIN', 'STAFF'), getOperatorCounter);

// Facility-scoped counter picker for the operator panel's "CHOOSE COUNTER".
// MUST be registered before `/:id` so the literal path is not read as an id.
router.get('/operable', protect, requireRole('ADMIN', 'STAFF'), getOperableCounters);

// Center operators list for Resource Hub (MUST be before /:id)
router.get('/operators', protect, requireRole('ADMIN'), getCenterOperators);

// Centralized Resource Allocation endpoints (MUST be before /:id)
router.get('/allocation/overview', protect, requireRole('ADMIN', 'STAFF'), getAllocationOverview);
router.post('/allocation/trigger', protect, requireRole('ADMIN'), triggerAllocationNow);

// Public: list counters (customer app shows counter count)
router.get('/', list);
router.get(
  '/:id',
  protect,
  requireRole('ADMIN', 'STAFF'),
  validateObjectId('id'),
  getById
);

// Admin operations
router.post('/', protect, requireRole('ADMIN'), createValidation, validate, create);
router.patch('/:id/assign', protect, requireRole('ADMIN'), validateObjectId('id'), assignService);
router.patch('/:id/morph', protect, requireRole('ADMIN'), validateObjectId('id'), morphCounter);
router.patch('/:id/assign-staff', protect, requireRole('ADMIN'), validateObjectId('id'), assignStaff);

// Staff/Admin counter operations (server checks staff counter/center assignment)
router.patch('/:id/status', protect, requireRole('ADMIN', 'STAFF'), validateObjectId('id'), updateStatus);
router.post('/:id/call-next', protect, requireRole('ADMIN', 'STAFF'), validateObjectId('id'), callNext);
router.post('/:id/recall', protect, requireRole('ADMIN', 'STAFF'), validateObjectId('id'), recall);
router.post('/:id/start-serving', protect, requireRole('ADMIN', 'STAFF'), validateObjectId('id'), startServing);
router.post('/:id/complete', protect, requireRole('ADMIN', 'STAFF'), validateObjectId('id'), complete);
router.post('/:id/skip', protect, requireRole('ADMIN', 'STAFF'), validateObjectId('id'), skip);

module.exports = router;

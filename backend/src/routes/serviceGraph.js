'use strict';

const router = require('express').Router();
const { protect, requireRole } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const {
  getGraphByCenter,
  createEdge,
  updateEdge,
  deleteEdge,
  createEdgeValidation,
  updateEdgeValidation,
} = require('../controllers/serviceGraphController');

// All graph routes require authentication
router.use(protect);

// Retrieve graph for a center (STAFF/ADMIN and authenticated customers can view service workflows)
router.get('/:centerId', validateObjectId('centerId'), getGraphByCenter);

// Graph mutation endpoints — strictly ADMIN role
router.post(
  '/edges',
  requireRole('ADMIN'),
  createEdgeValidation,
  validate,
  createEdge
);

router.patch(
  '/edges/:id',
  requireRole('ADMIN'),
  validateObjectId('id'),
  updateEdgeValidation,
  validate,
  updateEdge
);

router.delete(
  '/edges/:id',
  requireRole('ADMIN'),
  validateObjectId('id'),
  deleteEdge
);

module.exports = router;

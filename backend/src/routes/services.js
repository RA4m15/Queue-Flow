'use strict';

const router = require('express').Router();
const { protect, requireRole } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const {
  listByCenter,
  listAllAdmin,
  getById,
  create,
  update,
  createValidation,
  updateValidation,
} = require('../controllers/serviceController');

// ─── Public Routes ─────────────────────────────────────────────────────────────
// Customer-facing: only active services. Used by Flutter and Customer Web.
router.get('/', listByCenter);

// ─── Admin Routes ──────────────────────────────────────────────────────────────
// IMPORTANT: /admin must be declared before /:id so it isn't swallowed by the param route.
router.get('/admin', protect, requireRole('ADMIN', 'STAFF'), listAllAdmin);

// Get single service (public — needed by token detail view)
router.get('/:id', validateObjectId('id'), getById);

// Admin CRUD
router.post('/', protect, requireRole('ADMIN'), createValidation, validate, create);
router.patch('/:id', protect, requireRole('ADMIN'), validateObjectId('id'), updateValidation, validate, update);

module.exports = router;

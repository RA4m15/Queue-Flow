'use strict';

const router = require('express').Router();
const { protect, requireRole } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const {
  list, getById, create, update, setCrowd, createValidation,
} = require('../controllers/serviceCenterController');

// Public
router.get('/', list);
router.get('/:id', validateObjectId('id'), getById);

// Admin only
router.post('/', protect, requireRole('ADMIN'), createValidation, validate, create);
router.patch('/:id', protect, requireRole('ADMIN'), validateObjectId('id'), update);
router.patch('/:id/crowd', protect, requireRole('ADMIN', 'STAFF'), validateObjectId('id'), setCrowd);

module.exports = router;

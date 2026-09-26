'use strict';

const { body } = require('express-validator');
const Service = require('../models/Service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendCreated, sendNotFound, sendBadRequest } = require('../utils/apiResponse');

const createValidation = [
  body('centerId').isMongoId().withMessage('Valid centerId is required'),
  body('name').trim().notEmpty().isLength({ max: 100 }).withMessage('Service name is required'),
  body('tokenPrefix').trim().notEmpty().isLength({ max: 3 }).withMessage('Token prefix is required'),
  body('avgServiceTimeMinutes').optional().isInt({ min: 1, max: 120 }).withMessage('Must be 1–120 minutes'),
  body('order').optional().isInt({ min: 0 }).withMessage('Order must be a non-negative integer'),
];

const updateValidation = [
  body('name').optional().trim().notEmpty().isLength({ max: 100 }).withMessage('Service name must not be empty'),
  body('description').optional().trim().isLength({ max: 300 }).withMessage('Description too long'),
  body('avgServiceTimeMinutes').optional().isInt({ min: 1, max: 120 }).withMessage('Must be 1–120 minutes'),
  body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  body('order').optional().isInt({ min: 0 }).withMessage('Order must be a non-negative integer'),
];

const { MONGO_ID_REGEX } = require('../middleware/validate');

/**
 * GET /api/services?centerId=...
 * List ACTIVE services for a center. Public — used by Customer Web and Flutter.
 * IMPORTANT: must always filter isActive:true so inactive services are hidden from customers.
 */
const listByCenter = asyncHandler(async (req, res) => {
  const { centerId } = req.query;

  const filter = { isActive: true };
  if (centerId) {
    if (typeof centerId !== 'string' || !MONGO_ID_REGEX.test(centerId)) {
      return sendBadRequest(res, 'Invalid centerId');
    }
    filter.centerId = centerId;
  }

  const services = await Service.find(filter).sort({ order: 1, name: 1 }).lean();

  return sendSuccess(res, {
    data: { services },
    meta: { total: services.length },
  });
});

/**
 * GET /api/services/admin?centerId=...
 * Admin-only endpoint: returns ALL services for a center, including inactive ones.
 * The centerId query param is required for admin use.
 */
const listAllAdmin = asyncHandler(async (req, res) => {
  const { centerId } = req.query;

  if (!centerId || typeof centerId !== 'string' || !MONGO_ID_REGEX.test(centerId)) {
    return sendBadRequest(res, 'Valid centerId is required');
  }

  const services = await Service.find({ centerId }).sort({ order: 1, name: 1 }).lean();

  return sendSuccess(res, {
    data: { services },
    meta: { total: services.length },
  });
});

/**
 * GET /api/services/:id
 */
const getById = asyncHandler(async (req, res) => {
  const service = await Service.findById(req.params.id).lean();
  if (!service) return sendNotFound(res, 'Service not found');
  return sendSuccess(res, { data: { service } });
});

/**
 * POST /api/services
 * Admin only.
 */
const create = asyncHandler(async (req, res) => {
  const { centerId, name, tokenPrefix, description, avgServiceTimeMinutes, order } = req.body;

  const service = await Service.create({
    centerId,
    name,
    tokenPrefix: tokenPrefix.toUpperCase(),
    description,
    avgServiceTimeMinutes,
    order,
  });

  return sendCreated(res, { message: 'Service created', data: { service } });
});

/**
 * PATCH /api/services/:id
 * Admin only. tokenPrefix is intentionally excluded from updates to preserve
 * existing token numbering sequences for active queues.
 */
const update = asyncHandler(async (req, res) => {
  const allowed = ['name', 'description', 'avgServiceTimeMinutes', 'isActive', 'order'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const service = await Service.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });

  if (!service) return sendNotFound(res, 'Service not found');
  return sendSuccess(res, { message: 'Service updated', data: { service } });
});

module.exports = { listByCenter, listAllAdmin, getById, create, update, createValidation, updateValidation };

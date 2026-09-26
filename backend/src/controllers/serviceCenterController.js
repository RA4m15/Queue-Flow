'use strict';

const { body } = require('express-validator');
const ServiceCenter = require('../models/ServiceCenter');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendCreated, sendNotFound, sendBadRequest } = require('../utils/apiResponse');

// ─── Validation ───────────────────────────────────
const createValidation = [
  body('name').trim().notEmpty().isLength({ max: 120 }).withMessage('Name is required (max 120 chars)'),
  body('code').trim().notEmpty().isLength({ max: 20 }).withMessage('Code is required (max 20 chars)'),
  body('type').isIn(['BANK', 'HOSPITAL', 'GOVT', 'RAILWAY', 'SUPPORT', 'OTHER']).withMessage('Invalid center type'),
  body('capacity').isInt({ min: 1 }).withMessage('Capacity must be a positive integer'),
];

// ─── Controllers ──────────────────────────────────

/**
 * GET /api/service-centers
 * List all service centers. Public.
 */
const list = asyncHandler(async (req, res) => {
  const { type, isOpen } = req.query;
  const filter = {};
  if (type && typeof type === 'string') {
    const t = type.trim().toUpperCase();
    if (['BANK', 'HOSPITAL', 'GOVT', 'RAILWAY', 'SUPPORT', 'OTHER'].includes(t)) {
      filter.type = t;
    }
  }
  if (isOpen !== undefined) {
    filter.isOpen = isOpen === 'true' || isOpen === true;
  }

  const centers = await ServiceCenter.find(filter)
    .select('-__v')
    .sort({ name: 1 })
    .lean();

  return sendSuccess(res, {
    data: { centers },
    meta: { total: centers.length },
  });
});

/**
 * GET /api/service-centers/:id
 * Get a single service center with crowd info. Public.
 */
const getById = asyncHandler(async (req, res) => {
  const center = await ServiceCenter.findById(req.params.id).lean({ virtuals: true });
  if (!center) return sendNotFound(res, 'Service center not found');

  return sendSuccess(res, { data: { center } });
});

/**
 * POST /api/service-centers
 * Create a service center. Admin only.
 */
const create = asyncHandler(async (req, res) => {
  const { name, code, type, address, phone, email, capacity, capacityAlertThreshold, operatingHours, noShowTimeoutSeconds } = req.body;

  const center = await ServiceCenter.create({
    name,
    code: code.toUpperCase(),
    type,
    address,
    phone,
    email,
    capacity,
    capacityAlertThreshold,
    operatingHours,
    noShowTimeoutSeconds,
  });

  return sendCreated(res, { message: 'Service center created', data: { center } });
});

/**
 * PATCH /api/service-centers/:id
 * Update a service center. Admin only.
 */
const update = asyncHandler(async (req, res) => {
  const allowed = ['name', 'type', 'address', 'phone', 'email', 'capacity', 'capacityAlertThreshold', 'isOpen', 'operatingHours', 'noShowTimeoutSeconds'];
  const updates = {};

  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const center = await ServiceCenter.findByIdAndUpdate(
    req.params.id,
    updates,
    { new: true, runValidators: true }
  ).lean({ virtuals: true });

  if (!center) return sendNotFound(res, 'Service center not found');

  return sendSuccess(res, { message: 'Service center updated', data: { center } });
});

/**
 * PATCH /api/service-centers/:id/crowd
 * Manually set crowd count. Admin only (IoT uses /api/iot/crowd).
 */
const setCrowd = asyncHandler(async (req, res) => {
  const { currentCrowd } = req.body;
  if (typeof currentCrowd !== 'number' || currentCrowd < 0) {
    return sendBadRequest(res, 'currentCrowd must be a non-negative number');
  }

  const center = await ServiceCenter.findByIdAndUpdate(
    req.params.id,
    { currentCrowd },
    { new: true }
  ).lean({ virtuals: true });

  if (!center) return sendNotFound(res, 'Service center not found');

  return sendSuccess(res, { message: 'Crowd updated', data: { center } });
});

module.exports = { list, getById, create, update, setCrowd, createValidation };

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

const SEED_CENTERS = [
  {
    _id: '64f1a2b3c4d5e6f7a8b9c001',
    name: 'City Hall — Branch 01',
    code: 'CITYHAL01',
    type: 'GOVT',
    address: { street: '1 Civic Centre Road', city: 'Ahmedabad', state: 'Gujarat', pincode: '380001' },
    capacity: 200,
    isOpen: true,
    currentCrowd: 14,
    capacityAlertThreshold: 75,
  },
  {
    _id: '64f1a2b3c4d5e6f7a8b9c002',
    name: 'State Bank — Main Branch',
    code: 'SBANK001',
    type: 'BANK',
    address: { street: 'MG Road', city: 'Ahmedabad', state: 'Gujarat', pincode: '380009' },
    capacity: 150,
    isOpen: true,
    currentCrowd: 8,
    capacityAlertThreshold: 80,
  },
];

/**
 * GET /api/service-centers
 * List all service centers. Public.
 */
const list = asyncHandler(async (req, res) => {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    return sendSuccess(res, {
      data: { centers: SEED_CENTERS },
      meta: { total: SEED_CENTERS.length },
    });
  }

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
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    const center = SEED_CENTERS.find((c) => c._id === req.params.id) || SEED_CENTERS[0];
    return sendSuccess(res, { data: { center } });
  }

  const center = await ServiceCenter.findById(req.params.id).lean({ virtuals: true });
  if (!center) return sendNotFound(res, 'Service center not found');

  return sendSuccess(res, { data: { center } });
});

/**
 * POST /api/service-centers
 * Create a service center. Admin only.
 */
const create = asyncHandler(async (req, res) => {
  const {
    name,
    code,
    type,
    address,
    phone,
    email,
    capacity,
    capacityAlertThreshold,
    operatingHours,
    noShowTimeoutSeconds,
    location,
    geofence,
    latitude,
    longitude,
    joiningRadiusMeters,
  } = req.body;

  const resolvedLat = latitude !== undefined ? latitude : (location ? location.latitude : null);
  const resolvedLng = longitude !== undefined ? longitude : (location ? location.longitude : null);
  const resolvedRadius = joiningRadiusMeters !== undefined ? joiningRadiusMeters : ((geofence && geofence.radiusMeters) ? geofence.radiusMeters : 100);

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
    latitude: resolvedLat,
    longitude: resolvedLng,
    joiningRadiusMeters: resolvedRadius,
    location: {
      latitude: resolvedLat,
      longitude: resolvedLng,
    },
    geofence: {
      enabled: resolvedLat !== null && resolvedLng !== null,
      radiusMeters: resolvedRadius,
      nearRadiusMeters: 500,
      approachingRadiusMeters: 1000,
      ...(geofence || {}),
    },
  });

  return sendCreated(res, { message: 'Service center created', data: { center } });
});

/**
 * PATCH /api/service-centers/:id
 * Update a service center. Admin only.
 */
const update = asyncHandler(async (req, res) => {
  const allowed = [
    'name',
    'type',
    'address',
    'phone',
    'email',
    'capacity',
    'capacityAlertThreshold',
    'isOpen',
    'operatingHours',
    'noShowTimeoutSeconds',
    'location',
    'geofence',
    'latitude',
    'longitude',
    'joiningRadiusMeters',
    'autoResourceAllocation',
  ];
  const updates = {};

  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // Synchronize top-level coordinates and nested location subdocument
  if (updates.latitude !== undefined || updates.longitude !== undefined) {
    const lat = updates.latitude !== undefined ? updates.latitude : null;
    const lng = updates.longitude !== undefined ? updates.longitude : null;
    if (lat !== null || lng !== null) {
      updates.location = {
        ...(updates.location || {}),
        ...(lat !== null ? { latitude: lat } : {}),
        ...(lng !== null ? { longitude: lng } : {}),
      };
      updates['geofence.enabled'] = true;
    }
  }

  if (updates.joiningRadiusMeters !== undefined) {
    updates['geofence.radiusMeters'] = updates.joiningRadiusMeters;
  }

  if (updates.autoResourceAllocation !== undefined) {
    if (typeof updates.autoResourceAllocation !== 'boolean') {
      return sendBadRequest(res, 'autoResourceAllocation must be a boolean');
    }
  }

  const center = await ServiceCenter.findByIdAndUpdate(
    req.params.id,
    updates,
    { new: true, runValidators: true }
  ).lean({ virtuals: true });

  if (!center) return sendNotFound(res, 'Service center not found');

  // Switching allocation on makes the existing waiting line immediately
  // allocatable, so run a pass now instead of waiting for the next event.
  if (updates.autoResourceAllocation === true) {
    require('../services/resourceAllocationService').triggerAllocation(req.params.id);
  }

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

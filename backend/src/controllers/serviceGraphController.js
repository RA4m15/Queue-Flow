'use strict';

const { body, param } = require('express-validator');
const serviceGraphService = require('../services/serviceGraphService');
const asyncHandler = require('../utils/asyncHandler');
const {
  sendSuccess,
  sendCreated,
  sendNotFound,
  sendBadRequest,
  sendConflict,
  sendUnauthorized,
} = require('../utils/apiResponse');

// ─── Validations ─────────────────────────────────────────────────────────────

const createEdgeValidation = [
  body('centerId').isMongoId().withMessage('Valid centerId is required'),
  body('sourceServiceId').isMongoId().withMessage('Valid sourceServiceId is required'),
  body('targetServiceId').isMongoId().withMessage('Valid targetServiceId is required'),
  body('relationshipType')
    .optional()
    .isIn(['REQUIRED', 'OPTIONAL', 'TRANSFER', 'RECOMMENDED'])
    .withMessage('relationshipType must be one of REQUIRED, OPTIONAL, TRANSFER, RECOMMENDED'),
  body('order').optional().isInt({ min: 0 }).withMessage('Order must be a non-negative integer'),
  body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
];

const updateEdgeValidation = [
  body('relationshipType')
    .optional()
    .isIn(['REQUIRED', 'OPTIONAL', 'TRANSFER', 'RECOMMENDED'])
    .withMessage('relationshipType must be one of REQUIRED, OPTIONAL, TRANSFER, RECOMMENDED'),
  body('order').optional().isInt({ min: 0 }).withMessage('Order must be a non-negative integer'),
  body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
];

const confirmNextHopValidation = [
  body('nextServiceId').isMongoId().withMessage('Valid nextServiceId is required'),
  body('notifyApp').optional().isBoolean(),
  body('notifySms').optional().isBoolean(),
  body('channel').optional().isIn(['WEB', 'MOBILE', 'QR', 'WHATSAPP', 'SMS', 'TELEGRAM']),
  // A next hop is a join, so the join geofence applies. The app may send a fresh
  // reading; if it does not, the service falls back to the position already
  // verified for the token the customer just finished.
  body('latitude').optional({ nullable: true }),
  body('longitude').optional({ nullable: true }),
  body('accuracy').optional({ nullable: true }),
];

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/service-graph/:centerId
 * Retrieve the full service graph for a center (nodes and edges).
 */
const getGraphByCenter = asyncHandler(async (req, res) => {
  const result = await serviceGraphService.getGraphByCenter(req.params.centerId);
  return sendSuccess(res, { data: result });
});

/**
 * POST /api/service-graph/edges
 * Create a new service graph edge.
 * Protected: ADMIN only
 */
const createEdge = asyncHandler(async (req, res) => {
  const {
    centerId,
    sourceServiceId,
    targetServiceId,
    relationshipType,
    order,
    isActive,
    description,
  } = req.body;

  try {
    const edge = await serviceGraphService.createEdge({
      centerId,
      sourceServiceId,
      targetServiceId,
      relationshipType,
      order,
      isActive,
      description,
    });

    return sendCreated(res, {
      message: 'Service relationship created successfully',
      data: { edge },
    });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 409 || err.code === 11000) return sendConflict(res, err.message);
    throw err;
  }
});

/**
 * PATCH /api/service-graph/edges/:id
 * Update an existing service graph edge.
 * Protected: ADMIN only
 */
const updateEdge = asyncHandler(async (req, res) => {
  try {
    const edge = await serviceGraphService.updateEdge(req.params.id, req.body);
    return sendSuccess(res, {
      message: 'Service relationship updated successfully',
      data: { edge },
    });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 409) return sendConflict(res, err.message);
    throw err;
  }
});

/**
 * DELETE /api/service-graph/edges/:id
 * Delete a service graph edge.
 * Protected: ADMIN only
 */
const deleteEdge = asyncHandler(async (req, res) => {
  try {
    const result = await serviceGraphService.deleteEdge(req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

/**
 * GET /api/tokens/:id/next-service
 * Get candidate next services for a completed token.
 * Protected: Token owner (CUSTOMER) or STAFF/ADMIN
 */
const getNextServices = asyncHandler(async (req, res) => {
  try {
    const result = await serviceGraphService.getNextServicesForToken(
      req.params.id,
      req.user._id
    );
    return sendSuccess(res, { data: result });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 403) return sendUnauthorized(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

/**
 * POST /api/tokens/:id/next-service/confirm
 * Customer confirms choice to proceed to the next service in the graph.
 * Protected: Token owner (CUSTOMER)
 */
const confirmNextHop = asyncHandler(async (req, res) => {
  const {
    nextServiceId,
    notifyApp = true,
    notifySms = false,
    channel = 'WEB',
    latitude,
    longitude,
    accuracy,
  } = req.body;

  try {
    const result = await serviceGraphService.confirmNextHop({
      tokenId: req.params.id,
      nextServiceId,
      userId: req.user._id.toString(),
      notifyApp,
      notifySms,
      channel,
      latitude,
      longitude,
      accuracy,
    });

    return sendCreated(res, {
      message: 'Next service token created successfully',
      data: result,
    });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 403) return sendUnauthorized(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 409 || err.code === 11000) return sendConflict(res, err.message);
    throw err;
  }
});

/**
 * GET /api/tokens/:id/journey
 * Retrieve the full lineage of tokens in a customer's multi-hop journey.
 */
const getJourney = asyncHandler(async (req, res) => {
  try {
    const result = await serviceGraphService.getJourneyForToken(
      req.params.id,
      req.user._id.toString()
    );
    return sendSuccess(res, { data: result });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 403) return sendUnauthorized(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

module.exports = {
  getGraphByCenter,
  createEdge,
  updateEdge,
  deleteEdge,
  getNextServices,
  confirmNextHop,
  getJourney,
  createEdgeValidation,
  updateEdgeValidation,
  confirmNextHopValidation,
};

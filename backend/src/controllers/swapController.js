'use strict';

/**
 * QueueFlow — Tier 4 / Feature 3: P2P Slot Swapping Controller
 *
 * HTTP handlers for the swap API.
 * All routes require JWT authentication (protect middleware applied at router level).
 * Business logic is fully delegated to swapService.
 */

const { body, param } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const swapService = require('../services/swapService');
const {
  sendSuccess,
  sendCreated,
  sendNotFound,
  sendBadRequest,
  sendConflict,
  sendForbidden,
} = require('../utils/apiResponse');

// ─── Validation Chains ────────────────────────────────────────────────────────

/**
 * Validation for POST /api/swaps (create offer)
 */
const createOfferValidation = [
  body('offeringTokenId')
    .isMongoId()
    .withMessage('Valid offeringTokenId (MongoId) is required'),
  body('targetTokenId')
    .optional({ nullable: true })
    .isMongoId()
    .withMessage('targetTokenId must be a valid MongoId when provided'),
  body('reason')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 200 })
    .withMessage('reason must be a string up to 200 characters'),
];

/**
 * Validation for POST /api/swaps/:id/accept
 */
const acceptOfferValidation = [
  body('acceptingTokenId')
    .isMongoId()
    .withMessage('Valid acceptingTokenId (MongoId) is required'),
];

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET /api/swaps/eligible?tokenId=:tokenId
 * Returns anonymized list of eligible swap partners for the customer's token.
 * Protected: CUSTOMER
 */
const getEligible = asyncHandler(async (req, res) => {
  const { tokenId } = req.query;
  if (!tokenId) {
    return sendBadRequest(res, 'tokenId query parameter is required');
  }

  const result = await swapService.getEligibleSwapPartners(tokenId, req.user._id.toString());
  return sendSuccess(res, { message: 'Eligible swap partners retrieved', data: result });
});

/**
 * GET /api/swaps/my?tokenId=:tokenId
 * Returns the customer's own offers and eligible open offers in their queue.
 * Protected: CUSTOMER
 */
const getMyOffers = asyncHandler(async (req, res) => {
  const { tokenId } = req.query;
  if (!tokenId) {
    return sendBadRequest(res, 'tokenId query parameter is required');
  }

  const result = await swapService.getMyOffers(req.user._id.toString(), tokenId);
  return sendSuccess(res, { message: 'Swap offers retrieved', data: result });
});

/**
 * GET /api/swaps/:id
 * Get a single offer by ID. Only accessible by participants.
 * Protected: CUSTOMER
 */
const getOfferById = asyncHandler(async (req, res) => {
  try {
    const offer = await swapService.getOfferById(req.params.id, req.user._id.toString());
    return sendSuccess(res, { message: 'Swap offer retrieved', data: { offer } });
  } catch (err) {
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 403) return sendForbidden(res, err.message);
    throw err;
  }
});

/**
 * POST /api/swaps
 * Create a new swap offer.
 * Protected: CUSTOMER
 */
const createOffer = asyncHandler(async (req, res) => {
  const { offeringTokenId, targetTokenId = null, reason = null } = req.body;

  try {
    const offer = await swapService.createOffer({
      offeringTokenId,
      userId: req.user._id.toString(),
      targetTokenId,
      reason,
    });
    return sendCreated(res, { message: 'Swap offer created', data: { offer } });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 403) return sendForbidden(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 409) return sendConflict(res, err.message);
    throw err;
  }
});

/**
 * POST /api/swaps/:id/accept
 * Accept a pending swap offer and execute the atomic position swap.
 * Protected: CUSTOMER
 */
const acceptOffer = asyncHandler(async (req, res) => {
  const { acceptingTokenId } = req.body;

  try {
    const result = await swapService.acceptOffer({
      offerId: req.params.id,
      acceptingTokenId,
      userId: req.user._id.toString(),
    });
    return sendSuccess(res, { message: 'Swap completed successfully', data: result });
  } catch (err) {
    if (err.code === 'DOCUMENT_GATE_BLOCKED' || (err.status === 403 && err.gateData)) {
      return res.status(403).json({
        success: false,
        code: 'DOCUMENT_GATE_BLOCKED',
        message: err.message,
        data: err.gateData,
      });
    }
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 403) return sendForbidden(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 409) return sendConflict(res, err.message);
    throw err;
  }
});

/**
 * POST /api/swaps/:id/decline
 * Decline a pending swap offer.
 * Protected: CUSTOMER
 */
const declineOffer = asyncHandler(async (req, res) => {
  try {
    const result = await swapService.declineOffer({
      offerId: req.params.id,
      userId: req.user._id.toString(),
    });
    return sendSuccess(res, { message: 'Swap offer declined', data: result });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 403) return sendForbidden(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 409) return sendConflict(res, err.message);
    throw err;
  }
});

/**
 * POST /api/swaps/:id/cancel
 * Cancel your own pending swap offer.
 * Protected: CUSTOMER (must be offer creator)
 */
const cancelOffer = asyncHandler(async (req, res) => {
  try {
    const result = await swapService.cancelOffer({
      offerId: req.params.id,
      userId: req.user._id.toString(),
    });
    return sendSuccess(res, { message: 'Swap offer cancelled', data: result });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 403) return sendForbidden(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 409) return sendConflict(res, err.message);
    throw err;
  }
});

module.exports = {
  getEligible,
  getMyOffers,
  getOfferById,
  createOffer,
  acceptOffer,
  declineOffer,
  cancelOffer,
  createOfferValidation,
  acceptOfferValidation,
};

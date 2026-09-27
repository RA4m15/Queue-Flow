'use strict';

/**
 * QueueFlow — Tier 4 / Feature 3: P2P Slot Swapping Routes
 *
 * All routes require customer authentication (protect applied at router level).
 * Rate limiting applied per endpoint to prevent abuse.
 */

const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const { swapOfferLimiter, swapActionLimiter } = require('../middleware/rateLimiter');
const {
  getEligible,
  getMyOffers,
  getOfferById,
  createOffer,
  acceptOffer,
  declineOffer,
  cancelOffer,
  createOfferValidation,
  acceptOfferValidation,
} = require('../controllers/swapController');

// All swap routes require authentication
router.use(protect);

// ─── Discovery ─────────────────────────────────────────────────────────────────
// GET /api/swaps/eligible?tokenId=:tokenId
// Returns anonymized eligible swap partners for the caller's token.
router.get('/eligible', getEligible);

// GET /api/swaps/my?tokenId=:tokenId
// Returns caller's own offers + eligible open offers in their queue.
router.get('/my', getMyOffers);

// GET /api/swaps/:id
// Get a single offer by ID (participants only).
router.get('/:id', validateObjectId('id'), getOfferById);

// ─── Mutations ─────────────────────────────────────────────────────────────────
// POST /api/swaps — create a swap offer
router.post('/', swapOfferLimiter, createOfferValidation, validate, createOffer);

// POST /api/swaps/:id/accept — accept an offer and execute the atomic swap
router.post('/:id/accept', validateObjectId('id'), swapActionLimiter, acceptOfferValidation, validate, acceptOffer);

// POST /api/swaps/:id/decline — decline an offer
router.post('/:id/decline', validateObjectId('id'), swapActionLimiter, declineOffer);

// POST /api/swaps/:id/cancel — cancel your own offer
router.post('/:id/cancel', validateObjectId('id'), swapActionLimiter, cancelOffer);

module.exports = router;

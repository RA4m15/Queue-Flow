'use strict';

const mongoose = require('mongoose');

/**
 * SWAP OFFER STATES (server-authoritative state machine):
 *
 *   PENDING   — Offer created by offeringUser; awaiting acceptance
 *   ACCEPTED  — Target customer has accepted; swap execution in progress
 *   DECLINED  — Target customer explicitly declined
 *   CANCELLED — Offering customer cancelled their own offer
 *   EXPIRED   — Offer TTL elapsed without acceptance
 *   COMPLETED — Atomic swap executed successfully
 *   FAILED    — Swap execution failed after acceptance (e.g. token state changed)
 */
const SWAP_OFFER_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'FAILED'];

/**
 * Default offer TTL in seconds.
 * Configurable via SWAP_OFFER_TTL_SECONDS env var.
 * Must be bounded — never unlimited.
 */
const DEFAULT_OFFER_TTL_SECONDS = parseInt(process.env.SWAP_OFFER_TTL_SECONDS || '300', 10); // 5 minutes

const swapOfferSchema = new mongoose.Schema(
  {
    // The customer initiating the swap and their token
    offeringUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Offering user is required'],
    },
    offeringTokenId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Token',
      required: [true, 'Offering token is required'],
    },

    // Scoping fields — offer is strictly bounded to one center+service+queue
    centerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: [true, 'Center reference is required'],
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      required: [true, 'Service reference is required'],
    },

    // Optional: if directed at a specific customer/token
    // null = open offer (any eligible same-queue customer may accept)
    targetTokenId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Token',
      default: null,
    },
    targetUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Optional reason provided by the offering customer (not required)
    reason: {
      type: String,
      maxlength: 200,
      default: null,
    },

    // Server-authoritative state machine
    status: {
      type: String,
      enum: SWAP_OFFER_STATUSES,
      default: 'PENDING',
    },

    // Bounded expiration — set at creation time, validated at every mutation
    expiresAt: {
      type: Date,
      required: true,
    },

    // Lifecycle timestamps
    acceptedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },

    // Snapshot of queue positions at the time of completion (for audit trail)
    // Stored once on completion; never exposed as live position data
    auditSnapshot: {
      offeringTokenCode: { type: String, default: null },
      targetTokenCode: { type: String, default: null },
      offeringPositionBefore: { type: Number, default: null },
      targetPositionBefore: { type: Number, default: null },
      offeringPositionAfter: { type: Number, default: null },
      targetPositionAfter: { type: Number, default: null },
    },

    // Token that accepted (populated on completion for audit)
    acceptingTokenId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Token',
      default: null,
    },
    acceptingUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────

// Efficient offer lookup by offering token
swapOfferSchema.index({ offeringTokenId: 1, status: 1 });
// Efficient lookup of open offers for a service queue
swapOfferSchema.index({ centerId: 1, serviceId: 1, status: 1, expiresAt: 1 });
// Lookup by offering user
swapOfferSchema.index({ offeringUserId: 1, status: 1, createdAt: -1 });
// Directed offer lookup
swapOfferSchema.index({ targetTokenId: 1, status: 1 });

// Prevent a customer from having more than one PENDING offer per token.
// This is a partial unique index: only enforced when status = PENDING.
swapOfferSchema.index(
  { offeringTokenId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'PENDING' },
    name: 'unique_pending_offer_per_token',
  }
);

// Auto-expire documents after TTL (MongoDB TTL index on expiresAt)
// Note: this removes the document. Application-level expiry (status=EXPIRED)
// is enforced at read/write time; this TTL is a data-hygiene backup.
swapOfferSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SwapOffer = mongoose.model('SwapOffer', swapOfferSchema);

module.exports = { SwapOffer, SWAP_OFFER_STATUSES, DEFAULT_OFFER_TTL_SECONDS };

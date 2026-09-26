'use strict';

const mongoose = require('mongoose');

/**
 * TOKEN STATUSES:
 *  WAITING   — In queue, waiting to be called
 *  CALLED    — Counter called this token; customer has noShowTimeoutSeconds to arrive
 *  SERVING   — Customer is currently at the counter
 *  COMPLETED — Service successfully delivered
 *  SKIPPED   — Admin skipped this token
 *  CANCELLED — Customer cancelled the token
 *  EXPIRED   — Customer did not arrive in time after being called (no-show)
 */
const TOKEN_STATUSES = ['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'EXPIRED'];

const tokenSchema = new mongoose.Schema(
  {
    // Human-readable token code, e.g. A-047
    tokenCode: {
      type: String,
      required: true,
      trim: true,
    },
    // Sequential number within the queue for this service on this day
    tokenNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    centerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: [true, 'Service center reference is required'],
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      required: [true, 'Service reference is required'],
    },
    // Counter assigned when token is called/serving
    counterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Counter',
      default: null,
    },
    // Staff/Operator who served, called, or completed this token
    servedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: TOKEN_STATUSES,
      default: 'WAITING',
    },
    // Position in queue at the time of joining (not live position)
    initialPosition: {
      type: Number,
      min: 1,
    },
    // Live queue position — updated by queueService as tokens are served
    currentPosition: {
      type: Number,
      min: 0,
      default: null,
    },
    // Estimated wait in minutes at time of joining
    waitEstimateMinutes: {
      type: Number,
      default: null,
    },
    // QR code data (signed compact payload string to be encoded as QR)
    qrData: {
      type: String,
    },
    // Current active QR nonce (jti) — used for one-time replay protection.
    // Stored and checked atomically during verify-qr. Cleared when token becomes terminal.
    qrNonce: {
      type: String,
      default: null,
    },
    // When the current qrNonce was issued (for audit and freshness reference)
    qrIssuedAt: {
      type: Date,
      default: null,
    },
    // Whether the QR has been successfully consumed (one-time check-in enforced)
    qrConsumed: {
      type: Boolean,
      default: false,
    },
    // Notification preferences captured at token creation time
    notifyApp: {
      type: Boolean,
      default: true,
    },
    notifySms: {
      type: Boolean,
      default: false,
    },
    // Intake channel attribution (Phase D)
    channel: {
      type: String,
      enum: ['WEB', 'MOBILE', 'QR', 'WHATSAPP', 'SMS', 'TELEGRAM'],
      default: 'WEB',
    },
    channelMetadata: {
      externalMessageId: { type: String, default: null },
      externalUserId: { type: String, default: null },
    },
    // Timestamps for lifecycle events
    calledAt: { type: Date, default: null },
    servingAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Actual service duration in seconds (set on completion)
    actualServiceSeconds: {
      type: Number,
      default: null,
    },
    // Feedback
    feedback: {
      rating: { type: Number, min: 1, max: 5, default: null },
      comment: { type: String, maxlength: 500, default: null },
      submittedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// ─── Virtuals ─────────────────────────────────────
tokenSchema.virtual('isActive').get(function () {
  return ['WAITING', 'CALLED', 'SERVING'].includes(this.status);
});

// ─── Indexes ──────────────────────────────────────
// Primary query patterns:
tokenSchema.index({ centerId: 1, serviceId: 1, status: 1 });
tokenSchema.index({ userId: 1, status: 1 });
tokenSchema.index({ userId: 1, createdAt: -1 });
tokenSchema.index({ centerId: 1, createdAt: -1 });
tokenSchema.index({ centerId: 1, status: 1, createdAt: -1 });
tokenSchema.index({ centerId: 1, completedAt: -1 });
tokenSchema.index({ counterId: 1, status: 1 });
// Tier 3 / Feature 1 — Context-Aware EWT: bounded service-time history lookup
// for a single service queue (center + service + completion time). Additive only.
tokenSchema.index({ centerId: 1, serviceId: 1, completedAt: -1 });
// Database-level concurrency guarantee: exactly one active token per user per service
tokenSchema.index(
  { userId: 1, centerId: 1, serviceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
    },
    name: 'unique_active_user_token_per_service',
  }
);

const Token = mongoose.model('Token', tokenSchema);

module.exports = { Token, TOKEN_STATUSES };

'use strict';

const mongoose = require('mongoose');

/**
 * ExternalIdentity
 * Safely maps external channel users (WhatsApp phone, SMS phone, Telegram chat/user ID)
 * to a canonical QueueFlow User entity without exposing JWTs or credentials.
 */
const externalIdentitySchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      required: true,
      enum: ['WHATSAPP', 'SMS', 'TELEGRAM'],
    },
    // Normalized external identifier (E.164 phone or Telegram chat/user ID)
    externalId: {
      type: String,
      required: true,
      trim: true,
    },
    // QueueFlow User reference
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // True if phone or account ownership was explicitly verified via code/OTP
    isVerified: {
      type: Boolean,
      default: false,
    },
    // Transient verification code for explicit account linking (hashed)
    verificationCodeHash: {
      type: String,
      default: null,
      select: false,
    },
    verificationExpires: {
      type: Date,
      default: null,
    },
    // Provider-specific metadata (e.g. sender display name, telegram username)
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Interactive conversation state (e.g. selected center, pending confirmation)
    conversationState: {
      selectedCenterId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCenter', default: null },
      pendingAction: { type: String, default: null },
      updatedAt: { type: Date, default: Date.now },
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Unique compound index: an external ID per channel must be unique
externalIdentitySchema.index({ channel: 1, externalId: 1 }, { unique: true });
externalIdentitySchema.index({ userId: 1 });

const ExternalIdentity = mongoose.model('ExternalIdentity', externalIdentitySchema);

module.exports = ExternalIdentity;

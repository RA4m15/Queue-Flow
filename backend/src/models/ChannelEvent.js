'use strict';

const mongoose = require('mongoose');

/**
 * ChannelEvent
 * Stores incoming provider event IDs to enforce idempotency.
 * Repeated webhook delivery with the same externalEventId will NOT create duplicate tokens.
 */
const channelEventSchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      required: true,
      enum: ['WHATSAPP', 'SMS', 'TELEGRAM'],
    },
    externalEventId: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'PROCESSED', 'FAILED'],
      default: 'PENDING',
    },
    // Reference to created token if this event minted one
    tokenId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Token',
      default: null,
    },
    // Cached response payload returned on duplicate delivery
    responsePayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Unique compound index: prevent duplicate processing of the same event from the provider
channelEventSchema.index({ channel: 1, externalEventId: 1 }, { unique: true });

// TTL index: automatically expire processed webhook logs after 7 days
channelEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const ChannelEvent = mongoose.model('ChannelEvent', channelEventSchema);

module.exports = ChannelEvent;

'use strict';

const mongoose = require('mongoose');

/**
 * Audit log for every significant queue operation.
 * Used by admin to see history and by analytics for reporting.
 */
const queueEventSchema = new mongoose.Schema(
  {
    centerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: true,
    },
    tokenId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Token',
      default: null,
    },
    counterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Counter',
      default: null,
    },
    eventType: {
      type: String,
      enum: [
        'TOKEN_CREATED',
        'TOKEN_CALLED',
        'TOKEN_SERVING',
        'TOKEN_COMPLETED',
        'TOKEN_SKIPPED',
        'TOKEN_CANCELLED',
        'TOKEN_EXPIRED',
        'COUNTER_OPENED',
        'COUNTER_CLOSED',
        'COUNTER_BREAK',
        'COUNTER_RESUMED',
        'COUNTER_ASSIGNED',
        'COUNTER_MORPHED',
        'QUEUE_PAUSED',
        'QUEUE_RESUMED',
      ],
      required: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // null = system/IoT
    },
    // Extra context (token code, counter name, etc.)
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────
queueEventSchema.index({ centerId: 1, createdAt: -1 });
queueEventSchema.index({ centerId: 1, eventType: 1, createdAt: -1 });
queueEventSchema.index({ tokenId: 1 });

const QueueEvent = mongoose.model('QueueEvent', queueEventSchema);

module.exports = QueueEvent;

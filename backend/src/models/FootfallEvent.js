'use strict';

const mongoose = require('mongoose');

/**
 * Records each entry/exit event from IoT sensors.
 * The service center's currentCrowd field is the live state;
 * FootfallEvent is the audit trail.
 */
const footfallEventSchema = new mongoose.Schema(
  {
    centerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: true,
    },
    type: {
      type: String,
      enum: ['ENTRY', 'EXIT', 'COUNT'],
      required: true,
    },
    // Crowd count after this event
    countAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    // Where this event came from
    source: {
      type: String,
      enum: ['IOT', 'MANUAL', 'SIMULATOR'],
      default: 'IOT',
    },
    // Sensor/device identifier
    sensorId: {
      type: String,
      trim: true,
    },
    // Raw payload from the sensor (for debugging)
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────
footfallEventSchema.index({ centerId: 1, createdAt: -1 });
footfallEventSchema.index({ centerId: 1, type: 1, createdAt: -1 });

const FootfallEvent = mongoose.model('FootfallEvent', footfallEventSchema);

module.exports = FootfallEvent;

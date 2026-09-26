'use strict';

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema(
  {
    centerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Counter name is required'],
      trim: true,
      maxlength: [60, 'Counter name must not exceed 60 characters'],
    },
    number: {
      type: Number,
      required: [true, 'Counter number is required'],
      min: 1,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'BREAK', 'CLOSED'],
      default: 'CLOSED',
    },
    // Which service this counter is currently handling (can be reassigned)
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      default: null,
    },
    // Currently serving token
    currentTokenId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Token',
      default: null,
    },
    // Staff member operating this counter
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Today's statistics (reset each day in seed/reset process)
    stats: {
      served: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      avgServiceSeconds: { type: Number, default: null },
    },
    // Total active minutes today (for utilization % calculation)
    activeMinutesToday: {
      type: Number,
      default: 0,
    },
    // Timestamp when current serving started
    servingStartedAt: {
      type: Date,
      default: null,
    },
    // Display label shown on counter display board
    displayLabel: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// ─── Virtuals ─────────────────────────────────────
counterSchema.virtual('utilizationPercent').get(function () {
  // Returns a rough utilization based on today's served count
  // A more precise version uses activeMinutesToday vs total open minutes
  if (!this.stats || !this.stats.served) return 0;
  return Math.min(100, Math.round((this.stats.served / 40) * 100)); // 40 = target tokens/day
});

// ─── Indexes ──────────────────────────────────────
counterSchema.index({ centerId: 1 });
counterSchema.index({ centerId: 1, status: 1 });
counterSchema.index({ centerId: 1, number: 1 }, { unique: true });
counterSchema.index({ staffId: 1 }, { sparse: true });

const Counter = mongoose.model('Counter', counterSchema);

module.exports = Counter;

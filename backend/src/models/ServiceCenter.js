'use strict';

const mongoose = require('mongoose');

const operatingHoursSchema = new mongoose.Schema(
  {
    day: {
      type: String,
      enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
      required: true,
    },
    open: { type: String, default: '09:00' },  // HH:MM 24h
    close: { type: String, default: '17:00' },
    isClosed: { type: Boolean, default: false },
  },
  { _id: false }
);

const serviceCenterSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Service center name is required'],
      trim: true,
      maxlength: [120, 'Name must not exceed 120 characters'],
    },
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [20, 'Code must not exceed 20 characters'],
    },
    type: {
      type: String,
      required: true,
      enum: ['BANK', 'HOSPITAL', 'GOVT', 'RAILWAY', 'SUPPORT', 'OTHER'],
    },
    address: {
      street: String,
      city: String,
      state: String,
      pincode: String,
    },
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    capacity: {
      type: Number,
      required: [true, 'Capacity is required'],
      min: [1, 'Capacity must be at least 1'],
      default: 200,
    },
    // Crowd capacity alert threshold (0–100 %)
    capacityAlertThreshold: {
      type: Number,
      default: 80,
      min: 0,
      max: 100,
    },
    isOpen: {
      type: Boolean,
      default: true,
    },
    operatingHours: [operatingHoursSchema],
    // No-show timeout in seconds (how long to wait after calling before marking expired)
    noShowTimeoutSeconds: {
      type: Number,
      default: 120,
    },
    // Current crowd count — updated by IoT events
    currentCrowd: {
      type: Number,
      default: 0,
      min: 0,
    },
    // When currentCrowd was last reported by a live sensor. Lets the display tell
    // a genuine zero-person reading apart from a sensor that stopped reporting.
    crowdUpdatedAt: {
      type: Date,
      default: null,
    },
    // Center Location & Geofence (Top-level + subdocument compatibility)
    latitude: {
      type: Number,
      min: [-90, 'Latitude must be between -90 and 90'],
      max: [90, 'Latitude must be between -90 and 90'],
      default: null,
    },
    longitude: {
      type: Number,
      min: [-180, 'Longitude must be between -180 and 180'],
      max: [180, 'Longitude must be between -180 and 180'],
      default: null,
    },
    joiningRadiusMeters: {
      type: Number,
      min: [1, 'Joining radius must be at least 1 meter'],
      max: [50000, 'Joining radius must not exceed 50,000 meters'],
      default: 100,
    },
    // Centralized Resource Allocation — automatic distribution of eligible waiting customers to ready counters
    autoResourceAllocation: {
      type: Boolean,
      default: false,
    },
    // Tier 4 Feature 1: Ghost Queue Geofencing Configuration
    // Location coordinates (latitude / longitude). Centers without coordinates must not participate in geofencing.
    location: {
      latitude: {
        type: Number,
        min: [-90, 'Latitude must be between -90 and 90'],
        max: [90, 'Latitude must be between -90 and 90'],
        default: null,
      },
      longitude: {
        type: Number,
        min: [-180, 'Longitude must be between -180 and 180'],
        max: [180, 'Longitude must be between -180 and 180'],
        default: null,
      },
    },
    geofence: {
      enabled: {
        type: Boolean,
        default: false,
      },
      // Inner radius: inside center / immediate service area (meters)
      radiusMeters: {
        type: Number,
        min: [10, 'Geofence radius must be at least 10 meters'],
        max: [50000, 'Geofence radius must not exceed 50,000 meters'],
        default: 100,
      },
      // Near radius: in immediate vicinity of center (meters)
      nearRadiusMeters: {
        type: Number,
        min: [20, 'Near radius must be at least 20 meters'],
        max: [50000, 'Near radius must not exceed 50,000 meters'],
        default: 500,
      },
      // Outer radius: approaching notification boundary (meters)
      approachingRadiusMeters: {
        type: Number,
        min: [50, 'Approaching radius must be at least 50 meters'],
        max: [100000, 'Approaching radius must not exceed 100,000 meters'],
        default: 1000,
      },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// ─── Pre-save synchronization hook ───────────────
serviceCenterSchema.pre('save', function (next) {
  if (this.latitude !== undefined && this.latitude !== null) {
    if (!this.location) this.location = {};
    this.location.latitude = this.latitude;
  } else if (this.location && this.location.latitude !== undefined && this.location.latitude !== null) {
    this.latitude = this.location.latitude;
  }

  if (this.longitude !== undefined && this.longitude !== null) {
    if (!this.location) this.location = {};
    this.location.longitude = this.longitude;
  } else if (this.location && this.location.longitude !== undefined && this.location.longitude !== null) {
    this.longitude = this.location.longitude;
  }

  if (this.joiningRadiusMeters !== undefined && this.joiningRadiusMeters !== null) {
    if (!this.geofence) this.geofence = {};
    this.geofence.radiusMeters = this.joiningRadiusMeters;
    if (this.latitude !== null && this.longitude !== null) {
      this.geofence.enabled = true;
    }
  } else if (this.geofence && this.geofence.radiusMeters !== undefined && this.geofence.radiusMeters !== null) {
    this.joiningRadiusMeters = this.geofence.radiusMeters;
  }

  next();
});

// ─── Virtuals ─────────────────────────────────────
serviceCenterSchema.virtual('crowdPercent').get(function () {
  if (!this.capacity) return 0;
  return Math.round((this.currentCrowd / this.capacity) * 100);
});

serviceCenterSchema.virtual('crowdStatus').get(function () {
  const pct = this.crowdPercent;
  if (pct >= 80) return 'HIGH';
  if (pct >= 50) return 'MODERATE';
  return 'LOW';
});

serviceCenterSchema.virtual('isLocationConfigured').get(function () {
  const lat = this.latitude ?? this.location?.latitude;
  const lng = this.longitude ?? this.location?.longitude;
  return Boolean(
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
  );
});

// ─── Indexes ──────────────────────────────────────
serviceCenterSchema.index({ type: 1 });
serviceCenterSchema.index({ isOpen: 1 });

const ServiceCenter = mongoose.model('ServiceCenter', serviceCenterSchema);

module.exports = ServiceCenter;

'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [80, 'Name must not exceed 80 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
    },
    phone: {
      type: String,
      trim: true,
      match: [/^\+?[1-9]\d{6,14}$/, 'Please provide a valid phone number'],
    },
    passwordHash: {
      type: String,
      required: true,
      select: false, // Never returned in queries by default
    },
    role: {
      type: String,
      enum: ['CUSTOMER', 'STAFF', 'ADMIN'],
      default: 'CUSTOMER',
    },
    // Center assignment for STAFF/ADMIN
    centerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      default: null,
    },
    // Counter assignment for STAFF operator
    assignedCounterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Counter',
      default: null,
    },
    rfidUid: {
      type: String,
      sparse: true,
      unique: true,
      trim: true,
    },
    fcmToken: {
      type: String,
      default: null,
    },
    preferences: {
      notifyApp: { type: Boolean, default: true },
      notifySms: { type: Boolean, default: false },
      notifyAheadCount: { type: Number, default: 5 }, // Notify when N people ahead
      language: { type: String, default: 'en' },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
    lastLogin: {
      type: Date,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ─── Indexes ──────────────────────────────────────
userSchema.index({ phone: 1 }, { sparse: true });
userSchema.index({ role: 1 });
// Unique non-null device token ownership: exactly one user can own an active fcmToken
userSchema.index(
  { fcmToken: 1 },
  {
    unique: true,
    partialFilterExpression: { fcmToken: { $type: 'string' } },
    name: 'unique_non_null_fcm_token',
  }
);

// ─── Account deactivation hooks (clear device token on deactivation) ────
userSchema.pre('save', function (next) {
  if (this.isModified('isActive') && this.isActive === false) {
    this.fcmToken = null;
  }
  next();
});

userSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update) {
    if (update.isActive === false || (update.$set && update.$set.isActive === false)) {
      if (update.$set) {
        update.$set.fcmToken = null;
      } else {
        update.fcmToken = null;
      }
    }
  }
  next();
});

// ─── Instance methods ─────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// ─── Static methods ───────────────────────────────
userSchema.statics.hashPassword = async function (plainPassword) {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(plainPassword, salt);
};

// ─── Socket session revocation hooks ──────────────
userSchema.post('save', function (doc) {
  if (!doc || !doc._id) return;
  if (
    this.isModified('tokenVersion') ||
    this.isModified('passwordHash') ||
    this.isModified('isActive') ||
    this.isModified('role')
  ) {
    try {
      const { disconnectUserSockets } = require('../config/socket');
      disconnectUserSockets(doc._id.toString());
    } catch (_) {}
  }
});

userSchema.post('findOneAndUpdate', function (doc) {
  if (!doc || !doc._id) return;
  const update = this.getUpdate();
  if (!update) return;

  const hasInvalidation =
    (update.$inc && update.$inc.tokenVersion !== undefined) ||
    update.tokenVersion !== undefined ||
    (update.$set && update.$set.tokenVersion !== undefined) ||
    update.passwordHash !== undefined ||
    (update.$set && update.$set.passwordHash !== undefined) ||
    update.isActive !== undefined ||
    (update.$set && update.$set.isActive !== undefined) ||
    update.role !== undefined ||
    (update.$set && update.$set.role !== undefined);

  if (hasInvalidation) {
    try {
      const { disconnectUserSockets } = require('../config/socket');
      disconnectUserSockets(doc._id.toString());
    } catch (_) {}
  }
});

const User = mongoose.model('User', userSchema);

module.exports = User;

'use strict';

const mongoose = require('mongoose');

const RELATIONSHIP_TYPES = ['REQUIRED', 'OPTIONAL', 'TRANSFER', 'RECOMMENDED'];

const serviceRelationshipSchema = new mongoose.Schema(
  {
    centerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: [true, 'Service center reference is required'],
      index: true,
    },
    sourceServiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      required: [true, 'Source service reference is required'],
      index: true,
    },
    targetServiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      required: [true, 'Target service reference is required'],
      index: true,
    },
    relationshipType: {
      type: String,
      enum: RELATIONSHIP_TYPES,
      default: 'REQUIRED',
    },
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [300, 'Description must not exceed 300 characters'],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────
// Ensure unique directed edge between source and target service within a center
serviceRelationshipSchema.index(
  { centerId: 1, sourceServiceId: 1, targetServiceId: 1 },
  { unique: true, name: 'unique_center_service_edge' }
);
serviceRelationshipSchema.index({ centerId: 1, sourceServiceId: 1, isActive: 1 });
serviceRelationshipSchema.index({ centerId: 1, targetServiceId: 1, isActive: 1 });

const ServiceRelationship = mongoose.model('ServiceRelationship', serviceRelationshipSchema);

module.exports = {
  ServiceRelationship,
  RELATIONSHIP_TYPES,
};

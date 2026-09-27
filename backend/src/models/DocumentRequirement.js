'use strict';

const mongoose = require('mongoose');

/**
 * QueueFlow — Tier 4 / Feature 4: Document Requirement Schema
 *
 * Defines explicit service-level documentation requirements.
 * Requirements are configured per service and are strictly database-persisted
 * (no hardcoded frontend or backend lists).
 */
const documentRequirementSchema = new mongoose.Schema(
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      required: [true, 'Service reference is required'],
      index: true,
    },
    documentType: {
      type: String,
      required: [true, 'Document type identifier is required'],
      uppercase: true,
      trim: true,
      maxlength: [50, 'Document type must not exceed 50 characters'],
    },
    name: {
      type: String,
      required: [true, 'Requirement display name is required'],
      trim: true,
      maxlength: [100, 'Name must not exceed 100 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [300, 'Description must not exceed 300 characters'],
    },
    isRequired: {
      type: Boolean,
      default: true,
    },
    verificationRequired: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: exactly one requirement definition per documentType per service
documentRequirementSchema.index({ serviceId: 1, documentType: 1 }, { unique: true });
documentRequirementSchema.index({ serviceId: 1, isActive: 1 });

const DocumentRequirement = mongoose.model('DocumentRequirement', documentRequirementSchema);

module.exports = { DocumentRequirement };

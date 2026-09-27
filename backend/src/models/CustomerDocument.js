'use strict';

const mongoose = require('mongoose');

/**
 * DOCUMENT STATUSES:
 *  UPLOADED  — File received and stored, awaiting verification
 *  PENDING   — Under review by staff/admin
 *  VERIFIED  — Approved by staff/admin (or auto-verified if verification not required)
 *  REJECTED  — Rejected by staff/admin (customer must re-upload)
 */
const DOCUMENT_STATUSES = ['UPLOADED', 'PENDING', 'VERIFIED', 'REJECTED'];

const customerDocumentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
      index: true,
    },
    documentType: {
      type: String,
      required: [true, 'Document type is required'],
      uppercase: true,
      trim: true,
      maxlength: [50, 'Document type must not exceed 50 characters'],
    },
    fileName: {
      type: String,
      required: [true, 'File name is required'],
      trim: true,
      maxlength: [255, 'File name must not exceed 255 characters'],
    },
    mimeType: {
      type: String,
      required: [true, 'MIME type is required'],
      trim: true,
      enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    },
    fileSizeBytes: {
      type: Number,
      required: [true, 'File size is required'],
      min: [1, 'File must not be empty'],
      max: [10 * 1024 * 1024, 'File size cannot exceed 10MB'],
    },
    fileHash: {
      type: String,
      required: [true, 'File SHA-256 hash is required for integrity verification'],
      trim: true,
    },
    storageReference: {
      type: String,
      required: [true, 'Storage reference identifier is required'],
      trim: true,
    },
    status: {
      type: String,
      enum: DOCUMENT_STATUSES,
      default: 'PENDING',
      index: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    rejectionReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: [500, 'Rejection reason must not exceed 500 characters'],
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        // Strip sensitive internal storage details in customer/API responses
        delete ret.storageReference;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// One active document record per documentType per user (new upload replaces previous)
customerDocumentSchema.index({ userId: 1, documentType: 1 }, { unique: true });
customerDocumentSchema.index({ status: 1, uploadedAt: -1 });

const CustomerDocument = mongoose.model('CustomerDocument', customerDocumentSchema);

module.exports = { CustomerDocument, DOCUMENT_STATUSES };

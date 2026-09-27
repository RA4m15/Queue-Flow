'use strict';

/**
 * QueueFlow — Tier 4 / Feature 4: Document-Ready Gatekeeping Service
 *
 * Implements server-authoritative document requirements, customer document
 * management, secure local storage, staff/admin verification, and queue gate
 * readiness calculation.
 *
 * Authoritative Readiness States:
 *  - NOT_REQUIRED               : Service has requirements, but none are mandatory
 *  - REQUIREMENTS_NOT_CONFIGURED: Service has zero active requirement definitions
 *  - INCOMPLETE                 : Missing one or more mandatory documents
 *  - PENDING_VERIFICATION       : Required document(s) uploaded but pending staff approval
 *  - READY                      : All mandatory requirements satisfied and verified
 *  - REJECTED                   : One or more uploaded required documents were rejected
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const { DocumentRequirement } = require('../models/DocumentRequirement');
const { CustomerDocument } = require('../models/CustomerDocument');
const Service = require('../models/Service');
const QueueEvent = require('../models/QueueEvent');
const Notification = require('../models/Notification');
const { emitToUser } = require('../config/socket');
const notificationService = require('./notificationService');
const { logger } = require('../utils/logger');

// Local secure document storage directory (not served as static public folder)
const STORAGE_DIR = path.resolve(__dirname, '../../storage/documents');
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

const ALLOWED_MIME_TYPES = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── Requirement Management (Admin) ──────────────────────────────────────────

/**
 * Get active document requirements for a service.
 */
async function getServiceRequirements(serviceId, includeInactive = false) {
  const filter = { serviceId };
  if (!includeInactive) {
    filter.isActive = true;
  }
  return DocumentRequirement.find(filter).sort({ isRequired: -1, name: 1 }).lean();
}

/**
 * Create a new document requirement for a service.
 */
async function createRequirement({
  serviceId,
  documentType,
  name,
  description = '',
  isRequired = true,
  verificationRequired = true,
  isActive = true,
}) {
  const service = await Service.findById(serviceId);
  if (!service) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }

  const normalizedType = documentType.trim().toUpperCase();

  const existing = await DocumentRequirement.findOne({ serviceId, documentType: normalizedType });
  if (existing) {
    const err = new Error(`Requirement for document type '${normalizedType}' already exists for this service`);
    err.status = 409;
    throw err;
  }

  const requirement = await DocumentRequirement.create({
    serviceId,
    documentType: normalizedType,
    name: name.trim(),
    description: (description || '').trim(),
    isRequired: Boolean(isRequired),
    verificationRequired: Boolean(verificationRequired),
    isActive: Boolean(isActive),
  });

  return requirement;
}

/**
 * Update an existing requirement.
 */
async function updateRequirement(requirementId, updateData) {
  const requirement = await DocumentRequirement.findById(requirementId);
  if (!requirement) {
    const err = new Error('Document requirement not found');
    err.status = 404;
    throw err;
  }

  const allowedFields = ['name', 'description', 'isRequired', 'verificationRequired', 'isActive'];
  allowedFields.forEach((field) => {
    if (updateData[field] !== undefined) {
      requirement[field] = updateData[field];
    }
  });

  await requirement.save();
  return requirement;
}

/**
 * Delete a requirement definition.
 */
async function deleteRequirement(requirementId) {
  const requirement = await DocumentRequirement.findByIdAndDelete(requirementId);
  if (!requirement) {
    const err = new Error('Document requirement not found');
    err.status = 404;
    throw err;
  }
  return { message: 'Document requirement deleted successfully' };
}

// ─── Readiness Calculation ───────────────────────────────────────────────────

/**
 * Authoritatively calculate whether a customer is document-ready for a service.
 *
 * @param {object} params
 * @param {string} params.serviceId
 * @param {string} params.userId
 * @returns {Promise<{ isReady: boolean, status: string, checklist: Array, missingRequirements: Array }>}
 */
async function checkServiceReadiness({ serviceId, userId }) {
  if (!serviceId) {
    const err = new Error('serviceId is required to evaluate readiness');
    err.status = 400;
    throw err;
  }

  // 1. Fetch active requirements for the target service
  const requirements = await DocumentRequirement.find({
    serviceId,
    isActive: true,
  }).sort({ isRequired: -1, name: 1 }).lean();

  // If no requirements configured on the service
  if (!requirements || requirements.length === 0) {
    return {
      isReady: true,
      status: 'REQUIREMENTS_NOT_CONFIGURED',
      message: 'Requirements not configured',
      checklist: [],
      missingRequirements: [],
      serviceId,
    };
  }

  const requiredReqs = requirements.filter((r) => r.isRequired);

  // If requirements exist, but none are mandatory (all optional)
  if (requiredReqs.length === 0) {
    return {
      isReady: true,
      status: 'NOT_REQUIRED',
      message: 'No mandatory documents required for this service',
      checklist: requirements.map((r) => ({
        requirementId: r._id,
        documentType: r.documentType,
        name: r.name,
        description: r.description,
        isRequired: false,
        verificationRequired: r.verificationRequired,
        customerStatus: 'NOT_UPLOADED',
        customerDocument: null,
      })),
      missingRequirements: [],
      serviceId,
    };
  }

  // 2. Fetch customer's uploaded documents if user is authenticated
  let customerDocs = [];
  if (userId) {
    customerDocs = await CustomerDocument.find({
      userId,
      documentType: { $in: requirements.map((r) => r.documentType) },
    }).lean();
  }

  const docMap = new Map();
  customerDocs.forEach((d) => {
    docMap.set(d.documentType, d);
  });

  // 3. Build detailed checklist and evaluate gates
  const checklist = [];
  const missingRequirements = [];
  let hasRejected = false;
  let hasPendingVerification = false;
  let hasIncomplete = false;

  for (const req of requirements) {
    const userDoc = docMap.get(req.documentType) || null;
    let itemStatus = 'NOT_UPLOADED';

    if (userDoc) {
      itemStatus = userDoc.status; // UPLOADED, PENDING, VERIFIED, REJECTED
    }

    const item = {
      requirementId: req._id,
      documentType: req.documentType,
      name: req.name,
      description: req.description,
      isRequired: req.isRequired,
      verificationRequired: req.verificationRequired,
      customerStatus: itemStatus,
      customerDocument: userDoc
        ? {
            _id: userDoc._id,
            fileName: userDoc.fileName,
            mimeType: userDoc.mimeType,
            fileSizeBytes: userDoc.fileSizeBytes,
            status: userDoc.status,
            uploadedAt: userDoc.uploadedAt,
            verifiedAt: userDoc.verifiedAt,
            rejectedAt: userDoc.rejectedAt,
            rejectionReason: userDoc.rejectionReason,
          }
        : null,
    };

    checklist.push(item);

    if (req.isRequired) {
      if (!userDoc) {
        hasIncomplete = true;
        missingRequirements.push({
          documentType: req.documentType,
          name: req.name,
          reason: 'Document not uploaded',
        });
      } else if (userDoc.status === 'REJECTED') {
        hasRejected = true;
        missingRequirements.push({
          documentType: req.documentType,
          name: req.name,
          reason: `Document rejected: ${userDoc.rejectionReason || 'Did not meet requirements'}`,
        });
      } else if (req.verificationRequired && userDoc.status !== 'VERIFIED') {
        hasPendingVerification = true;
        missingRequirements.push({
          documentType: req.documentType,
          name: req.name,
          reason: 'Document uploaded and awaiting staff verification',
        });
      }
    }
  }

  // 4. Calculate authoritative status
  let status = 'READY';
  let isReady = true;
  let message = 'All required documentation satisfied';

  if (hasIncomplete) {
    status = 'INCOMPLETE';
    isReady = false;
    message = 'Missing required documentation';
  } else if (hasRejected) {
    status = 'REJECTED';
    isReady = false;
    message = 'One or more required documents were rejected. Please re-upload.';
  } else if (hasPendingVerification) {
    status = 'PENDING_VERIFICATION';
    isReady = false;
    message = 'Required documents are pending verification by service staff';
  }

  return {
    isReady,
    status,
    message,
    checklist,
    missingRequirements,
    serviceId,
  };
}

// ─── Upload and Storage Layer ────────────────────────────────────────────────

/**
 * Securely store customer document file and create/update CustomerDocument.
 */
async function uploadDocument({
  userId,
  documentType,
  fileName,
  mimeType,
  fileBuffer,
  serviceId = null,
}) {
  if (!userId) {
    const err = new Error('Authenticated user is required for document upload');
    err.status = 401;
    throw err;
  }

  const normalizedType = (documentType || '').trim().toUpperCase();
  if (!normalizedType) {
    const err = new Error('documentType is required');
    err.status = 400;
    throw err;
  }

  // Validate MIME type
  if (!ALLOWED_MIME_TYPES[mimeType]) {
    const err = new Error(`Unsupported file type: ${mimeType}. Allowed: PDF, JPEG, PNG, WEBP`);
    err.status = 400;
    throw err;
  }

  // Validate file buffer
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    const err = new Error('File content is empty or invalid');
    err.status = 400;
    throw err;
  }

  if (fileBuffer.length > MAX_FILE_SIZE) {
    const err = new Error('File size exceeds the 10MB limit');
    err.status = 400;
    throw err;
  }

  // If serviceId was provided, verify documentType is a configured requirement for this service
  let autoVerify = false;
  if (serviceId) {
    const req = await DocumentRequirement.findOne({
      serviceId,
      documentType: normalizedType,
      isActive: true,
    });
    if (!req) {
      const err = new Error(`Document type '${normalizedType}' is not a valid requirement for this service`);
      err.status = 400;
      throw err;
    }
    // If requirement doesn't mandate staff verification, auto-approve on upload
    if (req.verificationRequired === false) {
      autoVerify = true;
    }
  }

  // Compute SHA-256 hash for integrity
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Generate safe storage reference on disk (random UUID name to avoid path traversal / collision)
  const extension = ALLOWED_MIME_TYPES[mimeType];
  const storageId = `${userId.toString()}_${crypto.randomBytes(16).toString('hex')}${extension}`;
  const filePath = path.join(STORAGE_DIR, storageId);

  // Write file to secure storage directory
  fs.writeFileSync(filePath, fileBuffer);

  // Upsert customer document record
  const initialStatus = autoVerify ? 'VERIFIED' : 'PENDING';
  const now = new Date();

  const customerDoc = await CustomerDocument.findOneAndUpdate(
    { userId, documentType: normalizedType },
    {
      $set: {
        fileName: path.basename(fileName || `document${extension}`),
        mimeType,
        fileSizeBytes: fileBuffer.length,
        fileHash,
        storageReference: storageId,
        status: initialStatus,
        uploadedAt: now,
        verifiedAt: autoVerify ? now : null,
        rejectedAt: null,
        verifiedBy: null,
        rejectionReason: null,
      },
    },
    { new: true, upsert: true, runValidators: true }
  );

  // Send real-time notification to user
  try {
    emitToUser(userId.toString(), 'document.updated', {
      documentId: customerDoc._id,
      documentType: normalizedType,
      status: customerDoc.status,
    });

    await Notification.create({
      userId,
      type: 'DOCUMENT_UPLOADED',
      title: 'Document Uploaded',
      body: `Your ${normalizedType} has been uploaded and is ${autoVerify ? 'ready' : 'pending verification'}.`,
      dedupeKey: `doc_up_${customerDoc._id}_${Date.now()}`,
      metadata: { documentType: normalizedType, documentId: customerDoc._id },
    });
  } catch (err) {
    logger.warn('Failed to emit document notification', { error: err.message });
  }

  // Return clean document object without storageReference
  return customerDoc.toJSON();
}

/**
 * Staff/Admin verifies or rejects a customer document.
 */
async function verifyDocument({
  documentId,
  verifierUser,
  status,
  rejectionReason = '',
}) {
  if (!verifierUser || !['ADMIN', 'STAFF'].includes(verifierUser.role)) {
    const err = new Error('Unauthorized: Only staff or admin can verify documents');
    err.status = 403;
    throw err;
  }

  const normalizedStatus = (status || '').trim().toUpperCase();
  if (!['VERIFIED', 'REJECTED'].includes(normalizedStatus)) {
    const err = new Error("Invalid status. Must be 'VERIFIED' or 'REJECTED'");
    err.status = 400;
    throw err;
  }

  const customerDoc = await CustomerDocument.findById(documentId);
  if (!customerDoc) {
    const err = new Error('Customer document not found');
    err.status = 404;
    throw err;
  }

  // Enforce no self-verification: staff/admin cannot approve their own documents
  if (customerDoc.userId.toString() === verifierUser._id.toString()) {
    const err = new Error('Self-verification is not permitted: You cannot verify your own documents');
    err.status = 403;
    throw err;
  }

  const now = new Date();
  customerDoc.status = normalizedStatus;
  customerDoc.verifiedBy = verifierUser._id;

  if (normalizedStatus === 'VERIFIED') {
    customerDoc.verifiedAt = now;
    customerDoc.rejectedAt = null;
    customerDoc.rejectionReason = null;
  } else {
    customerDoc.rejectedAt = now;
    customerDoc.verifiedAt = null;
    customerDoc.rejectionReason = (rejectionReason || 'Document did not meet requirements').trim();
  }

  await customerDoc.save();

  // Audit event
  try {
    await QueueEvent.create({
      centerId: verifierUser.centerId || new mongoose.Types.ObjectId(),
      eventType: normalizedStatus === 'VERIFIED' ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED',
      performedBy: verifierUser._id,
      metadata: {
        documentId: customerDoc._id,
        targetUserId: customerDoc.userId,
        documentType: customerDoc.documentType,
        rejectionReason: customerDoc.rejectionReason,
      },
    });
  } catch (err) {
    logger.warn('Failed to record QueueEvent for document verification', { error: err.message });
  }

  // Emit private socket update and notification to customer
  const socketEvent = normalizedStatus === 'VERIFIED' ? 'document.verified' : 'document.rejected';
  const notifType = normalizedStatus === 'VERIFIED' ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED';
  const notifTitle = normalizedStatus === 'VERIFIED' ? 'Document Verified' : 'Document Rejected';
  const notifBody = normalizedStatus === 'VERIFIED'
    ? `Your ${customerDoc.documentType} has been approved.`
    : `Your ${customerDoc.documentType} was rejected: ${customerDoc.rejectionReason}`;

  try {
    emitToUser(customerDoc.userId.toString(), socketEvent, {
      documentId: customerDoc._id,
      documentType: customerDoc.documentType,
      status: customerDoc.status,
      rejectionReason: customerDoc.rejectionReason,
    });

    await Notification.create({
      userId: customerDoc.userId,
      type: notifType,
      title: notifTitle,
      body: notifBody,
      dedupeKey: `doc_verify_${customerDoc._id}_${normalizedStatus}_${Date.now()}`,
      metadata: {
        documentId: customerDoc._id,
        documentType: customerDoc.documentType,
        status: customerDoc.status,
      },
    });
  } catch (err) {
    logger.warn('Failed to emit customer notification for verification', { error: err.message });
  }

  return customerDoc.toJSON();
}

/**
 * Get all documents for a customer (stripped of storageReference).
 */
async function getCustomerDocuments(userId) {
  return CustomerDocument.find({ userId }).sort({ uploadedAt: -1 });
}

/**
 * Staff/Admin review queue: list pending documents awaiting verification.
 */
async function getPendingDocumentsForReview({ page = 1, limit = 20 }) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const filter = { status: { $in: ['PENDING', 'UPLOADED'] } };
  const total = await CustomerDocument.countDocuments(filter);

  const documents = await CustomerDocument.find(filter)
    .populate('userId', 'name email phone')
    .sort({ uploadedAt: 1 })
    .skip(skip)
    .limit(limitNum);

  return {
    documents,
    meta: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum) || 1,
    },
  };
}

/**
 * Securely get file for downloading/streaming.
 * Validates requester has authorization to access the specific document.
 */
async function getSecureDocumentFile({ documentId, requestingUser }) {
  const customerDoc = await CustomerDocument.findById(documentId);
  if (!customerDoc) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }

  // Privacy: only document owner or ADMIN/STAFF can download
  const isOwner = customerDoc.userId.toString() === requestingUser._id.toString();
  const isStaffOrAdmin = ['ADMIN', 'STAFF'].includes(requestingUser.role);

  if (!isOwner && !isStaffOrAdmin) {
    const err = new Error('Forbidden: You do not have permission to access this document');
    err.status = 403;
    throw err;
  }

  const filePath = path.join(STORAGE_DIR, customerDoc.storageReference);
  if (!fs.existsSync(filePath)) {
    const err = new Error('Document file not found in storage');
    err.status = 404;
    throw err;
  }

  return {
    filePath,
    mimeType: customerDoc.mimeType,
    fileName: customerDoc.fileName,
  };
}

module.exports = {
  getServiceRequirements,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  checkServiceReadiness,
  uploadDocument,
  verifyDocument,
  getCustomerDocuments,
  getPendingDocumentsForReview,
  getSecureDocumentFile,
  STORAGE_DIR,
};

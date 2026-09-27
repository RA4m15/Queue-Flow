'use strict';

/**
 * QueueFlow — Tier 4 / Feature 4: Document Controller
 *
 * REST endpoints for service document requirements, customer document uploads,
 * readiness evaluation, staff verification, and secure streaming.
 */

const { body, param, query } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const documentGateService = require('../services/documentGateService');
const {
  sendSuccess,
  sendCreated,
  sendNotFound,
  sendBadRequest,
  sendConflict,
  sendForbidden,
} = require('../utils/apiResponse');

// ─── Validation Chains ────────────────────────────────────────────────────────

const createRequirementValidation = [
  param('serviceId').isMongoId().withMessage('Valid serviceId is required'),
  body('documentType')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 50 })
    .withMessage('documentType is required (max 50 chars)'),
  body('name')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 100 })
    .withMessage('name is required (max 100 chars)'),
  body('description')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 300 })
    .withMessage('description must not exceed 300 chars'),
  body('isRequired').optional().isBoolean(),
  body('verificationRequired').optional().isBoolean(),
  body('isActive').optional().isBoolean(),
];

const updateRequirementValidation = [
  param('id').isMongoId().withMessage('Valid requirement id is required'),
  body('name').optional().isString().trim().isLength({ max: 100 }),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
  body('isRequired').optional().isBoolean(),
  body('verificationRequired').optional().isBoolean(),
  body('isActive').optional().isBoolean(),
];

const uploadValidation = [
  body('documentType')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('documentType is required'),
  body('fileName')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('fileName is required'),
  body('mimeType')
    .isString()
    .trim()
    .isIn(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    .withMessage('Valid mimeType is required (PDF, JPEG, PNG, WEBP)'),
  body('fileData')
    .isString()
    .notEmpty()
    .withMessage('fileData (base64 string) is required'),
  body('serviceId')
    .optional({ nullable: true })
    .isMongoId()
    .withMessage('Valid serviceId format required if provided'),
];

const verifyValidation = [
  param('id').isMongoId().withMessage('Valid document id is required'),
  body('status')
    .isString()
    .trim()
    .toUpperCase()
    .isIn(['VERIFIED', 'REJECTED'])
    .withMessage("Status must be 'VERIFIED' or 'REJECTED'"),
  body('rejectionReason')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage('rejectionReason must not exceed 500 chars'),
];

// ─── Requirement Handlers ────────────────────────────────────────────────────

/**
 * GET /api/documents/services/:serviceId/requirements
 */
const getServiceRequirements = asyncHandler(async (req, res) => {
  const includeInactive = req.user && ['ADMIN', 'STAFF'].includes(req.user.role);
  const requirements = await documentGateService.getServiceRequirements(
    req.params.serviceId,
    includeInactive
  );
  return sendSuccess(res, {
    message: 'Service document requirements retrieved',
    data: { requirements },
  });
});

/**
 * POST /api/documents/services/:serviceId/requirements
 * Admin only
 */
const createRequirement = asyncHandler(async (req, res) => {
  try {
    const requirement = await documentGateService.createRequirement({
      serviceId: req.params.serviceId,
      ...req.body,
    });
    return sendCreated(res, {
      message: 'Document requirement created successfully',
      data: { requirement },
    });
  } catch (err) {
    if (err.status === 404) return sendNotFound(res, err.message);
    if (err.status === 409) return sendConflict(res, err.message);
    throw err;
  }
});

/**
 * PATCH /api/documents/requirements/:id
 * Admin only
 */
const updateRequirement = asyncHandler(async (req, res) => {
  try {
    const requirement = await documentGateService.updateRequirement(req.params.id, req.body);
    return sendSuccess(res, {
      message: 'Document requirement updated successfully',
      data: { requirement },
    });
  } catch (err) {
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

/**
 * DELETE /api/documents/requirements/:id
 * Admin only
 */
const deleteRequirement = asyncHandler(async (req, res) => {
  try {
    const result = await documentGateService.deleteRequirement(req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

// ─── Customer Document Handlers ──────────────────────────────────────────────

/**
 * GET /api/documents/services/:serviceId/readiness
 * Evaluates whether current user is ready to join the service queue.
 */
const checkReadiness = asyncHandler(async (req, res) => {
  try {
    const readiness = await documentGateService.checkServiceReadiness({
      serviceId: req.params.serviceId,
      userId: req.user._id,
    });
    return sendSuccess(res, {
      message: readiness.message,
      data: readiness,
    });
  } catch (err) {
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

/**
 * POST /api/documents/upload
 * Customer uploads a document.
 */
const upload = asyncHandler(async (req, res) => {
  const { documentType, fileName, mimeType, fileData, serviceId } = req.body;

  // Clean base64 header if present (e.g. data:image/png;base64,...)
  let base64Clean = fileData;
  if (base64Clean.includes(';base64,')) {
    base64Clean = base64Clean.split(';base64,')[1];
  }

  const fileBuffer = Buffer.from(base64Clean, 'base64');

  try {
    const document = await documentGateService.uploadDocument({
      userId: req.user._id,
      documentType,
      fileName,
      mimeType,
      fileBuffer,
      serviceId: serviceId || null,
    });

    return sendCreated(res, {
      message: 'Document uploaded successfully',
      data: { document },
    });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

/**
 * GET /api/documents/my
 * Customer views their own uploaded documents.
 */
const getMyDocuments = asyncHandler(async (req, res) => {
  const documents = await documentGateService.getCustomerDocuments(req.user._id);
  return sendSuccess(res, {
    message: 'Customer documents retrieved',
    data: { documents },
  });
});

/**
 * GET /api/documents/pending
 * Staff/Admin review queue for customer documents.
 */
const getPendingReviews = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const result = await documentGateService.getPendingDocumentsForReview({ page, limit });
  return sendSuccess(res, {
    message: 'Pending documents retrieved for review',
    data: result,
  });
});

/**
 * PATCH /api/documents/:id/verify
 * Staff/Admin verifies or rejects a document.
 */
const verifyDocument = asyncHandler(async (req, res) => {
  const { status, rejectionReason } = req.body;

  try {
    const document = await documentGateService.verifyDocument({
      documentId: req.params.id,
      verifierUser: req.user,
      status,
      rejectionReason,
    });

    return sendSuccess(res, {
      message: `Document ${status.toLowerCase()} successfully`,
      data: { document },
    });
  } catch (err) {
    if (err.status === 400) return sendBadRequest(res, err.message);
    if (err.status === 403) return sendForbidden(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

/**
 * GET /api/documents/:id/download
 * Secure streaming of document file.
 */
const downloadDocument = asyncHandler(async (req, res) => {
  try {
    const fileInfo = await documentGateService.getSecureDocumentFile({
      documentId: req.params.id,
      requestingUser: req.user,
    });

    res.setHeader('Content-Type', fileInfo.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.fileName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const readStream = require('fs').createReadStream(fileInfo.filePath);
    readStream.on('error', (err) => {
      res.status(500).json({ success: false, message: 'Error reading document stream' });
    });
    readStream.pipe(res);
  } catch (err) {
    if (err.status === 403) return sendForbidden(res, err.message);
    if (err.status === 404) return sendNotFound(res, err.message);
    throw err;
  }
});

module.exports = {
  getServiceRequirements,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  checkReadiness,
  upload,
  getMyDocuments,
  getPendingReviews,
  verifyDocument,
  downloadDocument,
  createRequirementValidation,
  updateRequirementValidation,
  uploadValidation,
  verifyValidation,
};

'use strict';

/**
 * QueueFlow — Tier 4 / Feature 4: Document Routes
 */

const express = require('express');
const router = express.Router();
const { protect, requireRole } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const { documentUploadLimiter, documentActionLimiter } = require('../middleware/rateLimiter');
const documentController = require('../controllers/documentController');

// Allow up to 10MB JSON body specifically for base64 file payloads
const jsonUploadParser = express.json({ limit: '10mb' });

// ─── Public / Client Requirement Discovery ────────────────────────────────────
// GET /api/documents/services/:serviceId/requirements
router.get(
  '/services/:serviceId/requirements',
  validateObjectId('serviceId'),
  documentController.getServiceRequirements
);

// ─── Protected Routes ─────────────────────────────────────────────────────────
router.use(protect);

// GET /api/documents/services/:serviceId/readiness (check if caller meets requirements)
router.get(
  '/services/:serviceId/readiness',
  validateObjectId('serviceId'),
  documentActionLimiter,
  documentController.checkReadiness
);

// POST /api/documents/upload (customer uploads document)
router.post(
  '/upload',
  jsonUploadParser,
  documentUploadLimiter,
  documentController.uploadValidation,
  validate,
  documentController.upload
);

// GET /api/documents/my (customer's uploaded documents)
router.get('/my', documentActionLimiter, documentController.getMyDocuments);

// GET /api/documents/:id/download (secure download of file)
router.get(
  '/:id/download',
  validateObjectId('id'),
  documentActionLimiter,
  documentController.downloadDocument
);

// ─── Staff / Admin Review Routes ──────────────────────────────────────────────
// GET /api/documents/pending (list documents pending review)
router.get(
  '/pending',
  requireRole('ADMIN', 'STAFF'),
  documentActionLimiter,
  documentController.getPendingReviews
);

// PATCH /api/documents/:id/verify (approve or reject document)
router.patch(
  '/:id/verify',
  requireRole('ADMIN', 'STAFF'),
  validateObjectId('id'),
  documentActionLimiter,
  documentController.verifyValidation,
  validate,
  documentController.verifyDocument
);

// ─── Admin Requirement Management Routes ──────────────────────────────────────
// POST /api/documents/services/:serviceId/requirements (configure requirement)
router.post(
  '/services/:serviceId/requirements',
  requireRole('ADMIN'),
  validateObjectId('serviceId'),
  documentController.createRequirementValidation,
  validate,
  documentController.createRequirement
);

// PATCH /api/documents/requirements/:id (update requirement)
router.patch(
  '/requirements/:id',
  requireRole('ADMIN'),
  validateObjectId('id'),
  documentController.updateRequirementValidation,
  validate,
  documentController.updateRequirement
);

// DELETE /api/documents/requirements/:id (delete requirement)
router.delete(
  '/requirements/:id',
  requireRole('ADMIN'),
  validateObjectId('id'),
  documentController.deleteRequirement
);

module.exports = router;

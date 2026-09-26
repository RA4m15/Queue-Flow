'use strict';

/**
 * QueueFlow — Request ID Correlation Middleware
 * Phase 5 — Step 6: Request Correlation & Log Injection Protection
 *
 * Validates incoming X-Request-Id or generates a cryptographically random UUID.
 * Injects safe req.id into request context and attaches X-Request-Id to response headers.
 */

const crypto = require('crypto');
const { cleanLogString } = require('../utils/redact');

// Safe request ID pattern: alphanumeric, hyphen, underscore, 8 to 64 chars
const SAFE_REQUEST_ID_REGEX = /^[a-zA-Z0-9\-_]{8,64}$/;

/**
 * Validates a candidate request ID.
 * Returns true only if the ID matches the safe pattern and contains no CRLF/control characters.
 *
 * @param {*} id
 * @returns {boolean}
 */
function isValidRequestId(id) {
  if (!id || typeof id !== 'string') return false;
  return SAFE_REQUEST_ID_REGEX.test(id.trim());
}

/**
 * Express middleware to attach and return a validated X-Request-Id.
 */
function requestIdMiddleware(req, res, next) {
  const incomingHeader = req.headers['x-request-id'];

  let finalRequestId;
  if (isValidRequestId(incomingHeader)) {
    finalRequestId = cleanLogString(incomingHeader);
  } else {
    finalRequestId = crypto.randomUUID();
  }

  // Attach safe identifier to request context
  req.id = finalRequestId;

  // Return correlated ID in response header
  res.setHeader('X-Request-Id', finalRequestId);

  next();
}

module.exports = {
  requestIdMiddleware,
  isValidRequestId,
};

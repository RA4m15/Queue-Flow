'use strict';

/**
 * QueueFlow — Structured HTTP Access Logger Middleware
 * Phase 5 — Step 6: HTTP Access Logging & Request Tracing
 *
 * Emits structured JSON access logs on response finish.
 * Sanitizes URLs, prevents query-string leakage, and attaches request correlation IDs.
 */

const { logger } = require('../utils/logger');

function accessLoggerMiddleware(req, res, next) {
  // Skip access logging during automated unit/integration test runs unless explicitly requested
  if (process.env.NODE_ENV === 'test' && !process.env.ENABLE_TEST_ACCESS_LOGS) {
    return next();
  }

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    try {
      const end = process.hrtime.bigint();
      const durationMs = Number((end - start) / 1000000n);

      // Extract path without query parameters to prevent leaking sensitive search/query tokens
      const rawUrl = req.originalUrl || req.url || '/';
      const cleanPath = rawUrl.split('?')[0];

      // Extract client IP safely
      const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1';

      logger.info({
        event: 'HTTP_REQUEST',
        requestId: req.id,
        method: req.method,
        path: cleanPath,
        status: res.statusCode,
        durationMs,
        clientIp,
        userId: req.user ? (req.user._id || req.user.id) : undefined,
      });
    } catch (_) {
      // Access logging failure must never affect response delivery
    }
  });

  next();
}

module.exports = {
  accessLoggerMiddleware,
};

'use strict';

/**
 * QueueFlow — Health, Liveness & Readiness Endpoints
 * Phase 5 — Step 7: Production-Safe Health Probes
 *
 * Exposes:
 *   - GET /health/live   : Lightweight liveness probe (HTTP 200 if process is running).
 *   - GET /health/ready  : Readiness probe (HTTP 200 if dependencies ready, HTTP 503 if unready).
 *   - GET /health        : Backward-compatible alias delegating to liveness (HTTP 200).
 *
 * Guarantees:
 *   - Zero extra database queries or writes (reads mongoose.connection.readyState).
 *   - Zero extra Redis connections or commands (reads existing singleton isRedisReady()).
 *   - Zero extra Socket.IO connections (reads existing getAdapterStatus()).
 *   - Never exposes internal credentials, URIs, passwords, or NODE_ENV.
 */

const express = require('express');
const mongoose = require('mongoose');
const redisConfig = require('../config/redis');
const socketConfig = require('../config/socket');
const { logger } = require('../utils/logger');
const { isShuttingDown } = require('../utils/shutdown');

const router = express.Router();

/**
 * GET /health/live
 * Process liveness check.
 * Returns HTTP 200 when the Node.js event loop and Express server are alive.
 * Does NOT depend on MongoDB, Redis, or Socket.IO adapter.
 */
router.get('/live', (_req, res) => {
  res.status(200).json({
    success: true,
    status: 'alive',
  });
});

/**
 * GET /health/ready
 * Instance readiness check.
 * Verifies that required operational dependencies are active:
 *   - MongoDB: mongoose.connection.readyState === 1
 *   - Redis: redisConfig.isRedisReady() in production or when required
 *   - Socket.IO Adapter: socketConfig.getAdapterStatus().isReady in production
 *   - Application is not currently draining or shutting down
 *
 * Returns HTTP 200 when ready, HTTP 503 when unready.
 * Never leaks internal topology, connection strings, or stack traces in the response.
 */
router.get('/ready', (req, res) => {
  const shuttingDown = isShuttingDown();
  const isProd = process.env.NODE_ENV === 'production';
  const redisRequired = isProd || redisConfig.isRedisRequired();

  // 1. Check MongoDB state (instantaneous, 0ms in-memory inspection)
  const mongoReady = mongoose.connection.readyState === 1;

  // 2. Check Redis state (instantaneous, 0ms in-memory inspection)
  const redisReady = redisConfig.isRedisReady();

  // 3. Check Socket.IO adapter state (instantaneous, 0ms in-memory inspection)
  const adapterStatus = socketConfig.getAdapterStatus();
  const socketAdapterReady = Boolean(adapterStatus && adapterStatus.isReady);

  // Evaluate readiness against environment policy and shutdown state
  const isReady =
    !shuttingDown &&
    mongoReady &&
    (!redisRequired || redisReady) &&
    (!isProd || socketAdapterReady);

  if (!isReady) {
    const reason = shuttingDown ? 'shutdown_in_progress' : undefined;

    // Log safe diagnostic metadata internally through structured logger
    logger.warn('Health readiness check failed', {
      event: 'HEALTH_READINESS_FAILED',
      requestId: req.id,
      reason,
      mongoReady,
      redisReady,
      socketAdapterReady,
      shuttingDown,
      environment: process.env.NODE_ENV,
    });

    return res.status(503).json({
      success: false,
      status: 'unready',
    });
  }

  return res.status(200).json({
    success: true,
    status: 'ready',
  });
});

/**
 * GET /health
 * Backward-compatibility endpoint for existing tests and deployment monitors.
 * Delegates to lightweight liveness behavior with zero NODE_ENV leakage.
 */
router.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    status: 'alive',
  });
});

module.exports = router;

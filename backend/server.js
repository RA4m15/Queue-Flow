'use strict';

require('dotenv').config();

const { getConfig, ALLOWED_ORIGINS } = require('./src/config/env');
const config = getConfig();

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { requestIdMiddleware } = require('./src/middleware/requestId');
const { accessLoggerMiddleware } = require('./src/middleware/accessLogger');
const { logger } = require('./src/utils/logger');

const connectDB = require('./src/config/database');
const { closeDB } = require('./src/config/database');
const { initRedis, closeRedis } = require('./src/config/redis');
const { initSocket, closeSocket, closeSocketAdapter } = require('./src/config/socket');
const { shutdown, registerShutdownTargets } = require('./src/utils/shutdown');
const { generalLimiter, authLimiter } = require('./src/middleware/rateLimiter');

// ─── Route Imports ────────────────────────────────
const authRoutes = require('./src/routes/auth');
const serviceCenterRoutes = require('./src/routes/serviceCenters');
const serviceRoutes = require('./src/routes/services');
const tokenRoutes = require('./src/routes/tokens');
const queueRoutes = require('./src/routes/queue');
const counterRoutes = require('./src/routes/counters');
const crowdRoutes = require('./src/routes/crowd');
const analyticsRoutes = require('./src/routes/analytics');
const notificationRoutes = require('./src/routes/notifications');
const iotRoutes = require('./src/routes/iot');
const devRoutes = require('./src/routes/dev');
const healthRoutes = require('./src/routes/health');
const channelRoutes = require('./src/routes/channels');

// ─── App Init ─────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(requestIdMiddleware);
const server = http.createServer(app);

// ─── Database & Distributed Services ──────────────
connectDB();
initRedis().catch((err) => {
  if (process.env.NODE_ENV === 'production') {
    console.error('[Redis] FATAL: Production startup halted due to Redis requirement:', err.message);
    process.exit(1);
  } else if (process.env.NODE_ENV !== 'test') {
    console.warn('[Redis] Startup notice:', err.message);
  }
});

// ─── Socket.IO ────────────────────────────────────
try {
  initSocket(server);
} catch (err) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[Socket] FATAL: Production startup halted due to Socket.IO adapter requirement:', err.message);
    process.exit(1);
  } else {
    throw err;
  }
}

// ─── Coordinated Shutdown Target Registration ─────
registerShutdownTargets({
  server,
  closeSocket,
  closeAdapter: closeSocketAdapter,
  closeRedis,
  closeDB,
});

// ─── Middleware ───────────────────────────────────

// ─── HTTP Method Filtering ────────────────────────
const ALLOWED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
app.use((req, res, next) => {
  const effectiveMethod = (req.headers['x-http-method-override'] || req.method).toUpperCase();
  if (!ALLOWED_HTTP_METHODS.has(effectiveMethod)) {
    res.setHeader('Allow', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    return res.status(405).json({
      success: false,
      message: `Method ${effectiveMethod} not allowed`,
    });
  }
  next();
});

// ─── Security Headers (Helmet) ────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false, // APIs return JSON; avoid breaking Flutter/mobile clients and webviews
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: { action: 'deny' }, // X-Frame-Options: DENY
    noSniff: true, // X-Content-Type-Options: nosniff
    referrerPolicy: { policy: 'no-referrer' }, // Referrer-Policy: no-referrer
    hsts:
      process.env.NODE_ENV === 'production'
        ? { maxAge: 31536000, includeSubDomains: false, preload: false }
        : false,
    hidePoweredBy: true,
  })
);

// ─── CORS Configuration ───────────────────────────
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    const normalizedOrigin = origin.trim().replace(/\/$/, '');
    if (ALLOWED_ORIGINS.includes(normalizedOrigin)) {
      return callback(null, true);
    }
    const err = new Error('CORS_ORIGIN_DENIED');
    err.status = 403;
    err.statusCode = 403;
    return callback(err);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-iot-secret'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

const { sanitizeNoSql, preventParameterPollution } = require('./src/middleware/validate');

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(preventParameterPollution);
app.use(sanitizeNoSql);

app.use(accessLoggerMiddleware);

// ─── Rate Limiting ────────────────────────────────
app.use('/api/', generalLimiter);

// ─── Health Probes (Liveness & Readiness) ─────────
app.use('/health', healthRoutes);

// ─── API Routes ───────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/service-centers', serviceCenterRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/counters', counterRoutes);
app.use('/api/crowd', crowdRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/iot', iotRoutes);
app.use('/api/channels', channelRoutes);

// Dev simulator — only available in non-production environments when enabled
if (config.DEV_SIMULATOR_ENABLED) {
  app.use('/api/dev', devRoutes);
  console.log('[DEV] Simulator routes enabled at /api/dev');
}

// ─── 404 Handler ──────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ─── Global Error Handler ─────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (process.env.NODE_ENV !== 'test') {
    logger.error('Unhandled request exception', {
      requestId: req ? req.id : undefined,
      method: req ? req.method : undefined,
      path: req ? (req.originalUrl ? req.originalUrl.split('?')[0] : req.path) : undefined,
      errorName: err.name,
      errorMessage: err.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    });
  }

  // CORS origin denial (HTTP 403)
  if (err.message === 'CORS_ORIGIN_DENIED' || (err.message && err.message.startsWith('CORS:'))) {
    return res.status(403).json({
      success: false,
      message: 'CORS: Origin not allowed',
    });
  }

  // Body parser: Malformed JSON (HTTP 400)
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400 && 'body' in err)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON payload',
    });
  }

  // Body parser: Oversized payload (HTTP 413)
  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    return res.status(413).json({
      success: false,
      message: 'Payload too large. Maximum allowed size is 10KB.',
    });
  }

  // Mongoose validation error (HTTP 400)
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: 'Validation error', errors });
  }

  // MongoDB duplicate key error (HTTP 409)
  if (err.code === 11000) {
    const field = err.keyValue ? Object.keys(err.keyValue)[0] : 'resource';
    return res.status(409).json({ success: false, message: `${field} already exists` });
  }

  // Mongoose cast error (HTTP 400)
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid ID format' });
  }

  // Rate limiting / service unavailable (HTTP 503)
  if (err.status === 503 || err.statusCode === 503) {
    return res.status(503).json({
      success: false,
      message: err.message || 'Rate limiting service unavailable. Request blocked for safety.',
    });
  }

  // Explicit 4xx status codes (preserve 400, 401, 403, 404, 409, 422, 429)
  const status = err.status || err.statusCode || 500;
  if (status >= 400 && status < 500) {
    const safeMessage =
      process.env.NODE_ENV === 'production' &&
      /mongodb|redis:\/\/|jwt|secret|password|\/.*\/|\\.*\\/i.test(err.message)
        ? 'Bad request'
        : err.message || 'Bad request';
    return res.status(status).json({
      success: false,
      message: safeMessage,
    });
  }

  // Production 5xx: strictly sanitized
  const isProd = process.env.NODE_ENV === 'production';
  const message = isProd ? 'Internal server error' : err.message || 'Internal server error';

  const response = {
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };
  if (isProd && req && req.id) {
    response.requestId = req.id;
  }

  res.status(status >= 500 ? status : 500).json(response);
});

// ─── Start Server ─────────────────────────────────
const PORT = config.PORT;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n🚀 QueueFlow Backend running on port ${PORT}`);
    console.log(`   Environment : ${process.env.NODE_ENV}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   API base    : http://localhost:${PORT}/api\n`);
  });
}

// ─── Graceful Shutdown ────────────────────────────
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    errorName: reason && reason.name,
    errorMessage: reason && reason.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : (reason && reason.stack),
  });
});

module.exports = { app, server };

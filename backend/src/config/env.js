'use strict';

/**
 * QueueFlow — Centralized Environment & Configuration Validator
 * Phase 5 — Step 5: Startup Security Validation
 *
 * Enforces fail-fast validation before database, Redis, Socket.IO, or HTTP servers initialize.
 * Ensures production instances never start with missing, weak, placeholder, or inconsistent secrets.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'https://queue-flow-4308.onrender.com',
];

const BLACKLISTED_PLACEHOLDERS = [
  'your_super_secret',
  'change_this_in_production',
  'your_iot_device_secret_key',
  'changeme',
  'password',
  'secret',
  'admin123',
  'placeholder',
  'default_secret',
  'example',
];

const TRIVIAL_SEQUENCES = ['123456', '12345678', '123456789', '1234567890', 'qwerty'];

class ConfigValidationError extends Error {
  constructor(errors) {
    const formatted = errors
      .map((e) => `  - ${e.field}: ${e.reason} (Requirement: ${e.requirement})`)
      .join('\n');
    super(`CONFIGURATION ERROR:\n${formatted}`);
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

/**
 * Checks if a secret string is a known placeholder, trivial, or lacks minimal entropy.
 * NEVER prints or returns the secret value.
 *
 * @param {string} val
 * @param {number} minLen
 * @returns {boolean} true if weak or placeholder
 */
function isPlaceholderOrWeak(val, minLen = 32) {
  if (!val || typeof val !== 'string') return true;
  const trimmed = val.trim();
  if (trimmed.length < minLen) return true;
  const lower = trimmed.toLowerCase();
  for (const ph of BLACKLISTED_PLACEHOLDERS) {
    if (lower.includes(ph)) return true;
  }
  for (const seq of TRIVIAL_SEQUENCES) {
    if (lower === seq) return true;
  }
  const uniqueChars = new Set(trimmed);
  if (uniqueChars.size < 6) return true;
  return false;
}

/**
 * Validate an environment object (defaults to process.env).
 * Throws ConfigValidationError if validation fails.
 *
 * @param {object} [env=process.env]
 * @returns {object} Validated, normalized configuration
 */
function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];

  // ─── 1. NODE_ENV ─────────────────────────────────────────────
  const rawNodeEnv = env.NODE_ENV;
  const validEnvs = ['development', 'test', 'production'];
  if (!rawNodeEnv || !validEnvs.includes(rawNodeEnv)) {
    errors.push({
      field: 'NODE_ENV',
      reason: rawNodeEnv ? 'Invalid environment specified' : 'Variable is missing or empty',
      requirement: 'Must be exactly one of: development, test, production',
    });
  }
  const isProd = rawNodeEnv === 'production';
  const isTest = rawNodeEnv === 'test';
  const isDev = rawNodeEnv === 'development';

  // ─── 2. PORT ─────────────────────────────────────────────────
  let port = 5000;
  if (env.PORT !== undefined && env.PORT !== '') {
    const portStr = String(env.PORT).trim();
    const parsedPort = Number(portStr);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      errors.push({
        field: 'PORT',
        reason: 'Invalid port number',
        requirement: 'Must be an integer between 1 and 65535',
      });
    } else {
      port = parsedPort;
    }
  }

  // ─── 3. MONGODB_URI ──────────────────────────────────────────
  const mongoUri = env.MONGODB_URI;
  if (!mongoUri || typeof mongoUri !== 'string' || !mongoUri.trim()) {
    errors.push({
      field: 'MONGODB_URI',
      reason: 'Variable is missing or empty',
      requirement: 'Must be a valid MongoDB connection string starting with mongodb:// or mongodb+srv://',
    });
  } else {
    const trimmedUri = mongoUri.trim();
    const hasValidScheme = trimmedUri.startsWith('mongodb://') || trimmedUri.startsWith('mongodb+srv://');
    if (!hasValidScheme) {
      errors.push({
        field: 'MONGODB_URI',
        reason: 'Invalid connection scheme',
        requirement: 'Scheme must start with mongodb:// or mongodb+srv://',
      });
    }
    if (trimmedUri.includes('<username>') || trimmedUri.includes('<password>') || trimmedUri.includes('<cluster>')) {
      errors.push({
        field: 'MONGODB_URI',
        reason: 'Contains unreplaced template placeholders (<username> or <password>)',
        requirement: 'Must contain actual credentials and host for database persistence',
      });
    }
  }

  // ─── 3b. MongoDB Pool Settings ───────────────────────────────
  let maxPoolSize = isProd ? 25 : 10;
  if (env.MONGODB_MAX_POOL_SIZE !== undefined && env.MONGODB_MAX_POOL_SIZE !== '') {
    const parsed = parseInt(env.MONGODB_MAX_POOL_SIZE, 10);
    if (isNaN(parsed) || parsed < 2 || parsed > 100) {
      errors.push({
        field: 'MONGODB_MAX_POOL_SIZE',
        reason: 'Invalid pool size',
        requirement: 'Must be an integer between 2 and 100',
      });
    } else {
      maxPoolSize = parsed;
    }
  }

  let minPoolSize = isProd ? 5 : 1;
  if (env.MONGODB_MIN_POOL_SIZE !== undefined && env.MONGODB_MIN_POOL_SIZE !== '') {
    const parsed = parseInt(env.MONGODB_MIN_POOL_SIZE, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > maxPoolSize) {
      errors.push({
        field: 'MONGODB_MIN_POOL_SIZE',
        reason: 'Invalid min pool size',
        requirement: `Must be an integer between 0 and maxPoolSize (${maxPoolSize})`,
      });
    } else {
      minPoolSize = parsed;
    }
  }

  let shutdownTimeoutMs = 15000;
  if (env.SHUTDOWN_TIMEOUT_MS !== undefined && env.SHUTDOWN_TIMEOUT_MS !== '') {
    const parsed = parseInt(env.SHUTDOWN_TIMEOUT_MS, 10);
    if (isNaN(parsed) || parsed < 1000 || parsed > 60000) {
      errors.push({
        field: 'SHUTDOWN_TIMEOUT_MS',
        reason: 'Invalid shutdown timeout',
        requirement: 'Must be an integer between 1000 and 60000 ms',
      });
    } else {
      shutdownTimeoutMs = parsed;
    }
  }

  // ─── 4. JWT_SECRET ───────────────────────────────────────────
  const jwtSecret = env.JWT_SECRET;
  if (isProd) {
    if (!jwtSecret || typeof jwtSecret !== 'string') {
      errors.push({
        field: 'JWT_SECRET',
        reason: 'Variable is missing or empty in production',
        requirement: 'Production requires a cryptographically strong secret with at least 32 characters',
      });
    } else if (isPlaceholderOrWeak(jwtSecret, 32)) {
      errors.push({
        field: 'JWT_SECRET',
        reason: 'Secret is too short (< 32 chars), trivial, or matches a known placeholder',
        requirement: 'Production requires a high-entropy secret with at least 32 characters',
      });
    }
  } else if (!jwtSecret) {
    warnings.push('JWT_SECRET is unset in development/test. Using default fallback.');
  }

  // ─── 5. QR_SIGNING_SECRET ────────────────────────────────────
  const qrSecret = env.QR_SIGNING_SECRET;
  if (isProd) {
    if (!qrSecret || typeof qrSecret !== 'string') {
      errors.push({
        field: 'QR_SIGNING_SECRET',
        reason: 'Variable is missing or empty in production',
        requirement: 'Production requires a cryptographically strong secret with at least 32 characters',
      });
    } else if (isPlaceholderOrWeak(qrSecret, 32)) {
      errors.push({
        field: 'QR_SIGNING_SECRET',
        reason: 'Secret is too short (< 32 chars), trivial, or matches a known placeholder',
        requirement: 'Production requires a high-entropy secret with at least 32 characters',
      });
    } else if (jwtSecret && qrSecret === jwtSecret) {
      errors.push({
        field: 'QR_SIGNING_SECRET',
        reason: 'Secret is identical to JWT_SECRET',
        requirement: 'QR signing secret must be distinct from JWT secret for key isolation',
      });
    }
  }

  // ─── 6. IOT_SECRET ───────────────────────────────────────────
  const iotSecret = env.IOT_SECRET;
  if (isProd) {
    if (!iotSecret || typeof iotSecret !== 'string') {
      errors.push({
        field: 'IOT_SECRET',
        reason: 'Variable is missing or empty in production',
        requirement: 'Production requires an IoT shared secret with at least 16 characters',
      });
    } else if (isPlaceholderOrWeak(iotSecret, 16)) {
      errors.push({
        field: 'IOT_SECRET',
        reason: 'Secret is too short (< 16 chars), trivial, or matches a known placeholder',
        requirement: 'Production requires a strong IoT secret with at least 16 characters',
      });
    }
  }

  // ─── 7. REDIS CONFIGURATION ──────────────────────────────────
  if (isProd) {
    if (env.REDIS_ENABLED === 'false') {
      errors.push({
        field: 'REDIS_ENABLED',
        reason: 'Redis is explicitly disabled in production',
        requirement: 'Production strictly requires Redis for distributed rate limiting and horizontal scaling',
      });
    }
    const hasRedisConfig = Boolean(env.REDIS_URL || env.REDIS_HOST);
    if (!hasRedisConfig) {
      errors.push({
        field: 'REDIS_URL / REDIS_HOST',
        reason: 'Redis connection configuration is missing in production',
        requirement: 'Production requires REDIS_URL or REDIS_HOST (+ REDIS_PORT)',
      });
    }
    if (env.REDIS_PORT) {
      const parsedRedisPort = parseInt(env.REDIS_PORT, 10);
      if (isNaN(parsedRedisPort) || parsedRedisPort < 1 || parsedRedisPort > 65535) {
        errors.push({
          field: 'REDIS_PORT',
          reason: 'Invalid Redis port number',
          requirement: 'Must be an integer between 1 and 65535',
        });
      }
    }
  }

  // ─── 8. ALLOWED_ORIGINS ──────────────────────────────────────
  let parsedOrigins = [...DEFAULT_ALLOWED_ORIGINS];
  if (env.ALLOWED_ORIGINS) {
    const rawOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
    for (const origin of rawOrigins) {
      if (origin === '*') {
        if (isProd) {
          errors.push({
            field: 'ALLOWED_ORIGINS',
            reason: 'Wildcard origin "*" is prohibited in production',
            requirement: 'Must specify explicit, trusted origin URLs with credentials enabled',
          });
        }
      } else {
        const isUrl = origin.startsWith('http://') || origin.startsWith('https://');
        if (!isUrl) {
          errors.push({
            field: 'ALLOWED_ORIGINS',
            reason: 'Invalid origin format (missing protocol or malformed)',
            requirement: 'Each origin must start with http:// or https:// and contain a valid host',
          });
        }
      }
    }
    parsedOrigins = Array.from(new Set([...parsedOrigins, ...rawOrigins]));
  }

  // ─── 9. DEV_SIMULATOR_ENABLED ────────────────────────────────
  const devSimulatorRequested = env.DEV_SIMULATOR_ENABLED === 'true';
  if (isProd && devSimulatorRequested) {
    errors.push({
      field: 'DEV_SIMULATOR_ENABLED',
      reason: 'Simulator routes cannot be enabled in production',
      requirement: 'DEV_SIMULATOR_ENABLED must be false or omitted in production',
    });
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  // Log non-fatal development warnings if needed
  if (!isProd && !isTest) {
    for (const w of warnings) {
      console.warn(`[Config] Notice: ${w}`);
    }
  }

  return {
    NODE_ENV: rawNodeEnv,
    isProduction: isProd,
    isTest: isTest,
    isDevelopment: isDev,
    PORT: port,
    MONGODB_URI: mongoUri,
    JWT_SECRET: jwtSecret || 'dev-fallback-jwt-secret-not-for-production-min32chars',
    JWT_EXPIRES_IN: env.JWT_EXPIRES_IN || '7d',
    QR_SIGNING_SECRET: qrSecret || '',
    IOT_SECRET: iotSecret || '',
    ALLOWED_ORIGINS: parsedOrigins,
    DEV_SIMULATOR_ENABLED: !isProd && devSimulatorRequested,
    REDIS_URL: env.REDIS_URL || undefined,
    REDIS_HOST: env.REDIS_HOST || '127.0.0.1',
    REDIS_PORT: parseInt(env.REDIS_PORT || '6379', 10),
    REDIS_PASSWORD: env.REDIS_PASSWORD || undefined,
    REDIS_TLS: env.REDIS_TLS === 'true',
    REDIS_ENABLED: env.REDIS_ENABLED !== 'false',
    FCM_SERVER_KEY: env.FCM_SERVER_KEY || undefined,
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || undefined,
    MONGODB_MAX_POOL_SIZE: maxPoolSize,
    MONGODB_MIN_POOL_SIZE: minPoolSize,
    SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMs,
    WHATSAPP_ENABLED: env.WHATSAPP_ENABLED === 'true',
    WHATSAPP_API_TOKEN: env.WHATSAPP_API_TOKEN || undefined,
    WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID || undefined,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || undefined,
    WHATSAPP_APP_SECRET: env.WHATSAPP_APP_SECRET || undefined,
    SMS_ENABLED: env.SMS_ENABLED === 'true',
    SMS_PROVIDER: env.SMS_PROVIDER || 'twilio',
    SMS_ACCOUNT_SID: env.SMS_ACCOUNT_SID || undefined,
    SMS_AUTH_TOKEN: env.SMS_AUTH_TOKEN || undefined,
    SMS_FROM_NUMBER: env.SMS_FROM_NUMBER || undefined,
    SMS_WEBHOOK_SECRET: env.SMS_WEBHOOK_SECRET || undefined,
    TELEGRAM_ENABLED: env.TELEGRAM_ENABLED === 'true',
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || undefined,
    TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET || undefined,
  };
}

// ─── Configuration Accessor & Exports ────────────────────────────────────────
let cachedConfig = null;

function getConfig() {
  if (!cachedConfig) {
    try {
      cachedConfig = validateEnv(process.env);
    } catch (err) {
      if (process.env.NODE_ENV === 'test') {
        throw err;
      }
      console.error(`\n❌ ${err.message}\n`);
      console.error('[Config] Startup halted due to configuration errors. Exiting.\n');
      process.exit(1);
    }
  }
  return cachedConfig;
}

module.exports = {
  validateEnv,
  getConfig,
  ConfigValidationError,
  BLACKLISTED_PLACEHOLDERS,
  isPlaceholderOrWeak,
  DEFAULT_ALLOWED_ORIGINS,
  get ALLOWED_ORIGINS() {
    try {
      return (cachedConfig || validateEnv(process.env)).ALLOWED_ORIGINS;
    } catch (_) {
      return DEFAULT_ALLOWED_ORIGINS;
    }
  },
};

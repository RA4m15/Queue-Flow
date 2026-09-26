'use strict';

/**
 * QueueFlow — Centralized Redaction & Log Sanitization Utility
 * Phase 5 — Step 6: Structured Logging, Request IDs & Secret Redaction
 *
 * Provides recursive scrubbing for objects, arrays, strings, and Error instances.
 * Ensures credentials, tokens, passwords, and secrets NEVER enter logs.
 */

// Keys whose values must always be redacted (matched case-insensitively)
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-iot-secret',
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'token',
  'secret',
  'jwt',
  'qrpayload',
  'fcmtoken',
  'apikey',
  'api_key',
  'iotsecret',
  'qrsecret',
  'jwtsecret',
  'client_secret',
  'privatekey',
  'private_key',
  'x-hub-signature-256',
  'x-twilio-signature',
  'x-telegram-bot-api-secret-token',
  'x-sms-secret-token',
  'webhook_secret',
  'webhooksecret',
  'bot_token',
  'bottoken',
  'verify_token',
  'verifytoken',
]);

// URI credential redaction regular expressions (matches user:pass or user up to @)
const MONGODB_URI_REGEX = /(mongodb(?:\+srv)?:\/\/)[^/\s?#]+@/gi;
const REDIS_URI_REGEX = /(redis(?:s)?:\/\/)[^/\s?#]+@/gi;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+(?:\.[A-Za-z0-9-_.+/=]*)?/gi;
const JWT_STRING_REGEX = /\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+(?:\.[A-Za-z0-9-_.+/=]*)?\b/g;

// Strip ANSI color / escape sequences
const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;

// Control characters (\x00-\x08, \x0B, \x0C, \x0E-\x1F, \x7F) excluding standard printable chars
// Also CRLF \r and \n are handled explicitly
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Clean a string to prevent log injection (CRLF, ANSI escapes, control codes).
 *
 * @param {string} str
 * @returns {string}
 */
function cleanLogString(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(ANSI_REGEX, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(CONTROL_CHAR_REGEX, '')
    .trim();
}

/**
 * Sanitize a string containing sensitive URLs, bearer tokens, or JWTs.
 *
 * @param {string} str
 * @returns {string}
 */
function redactString(str) {
  if (typeof str !== 'string') return str;

  let result = str;

  // Redact MongoDB connection credentials: mongodb+srv://user:pass@host -> mongodb+srv://[REDACTED]@host
  result = result.replace(MONGODB_URI_REGEX, '$1[REDACTED]@');

  // Redact Redis connection credentials: redis://user:pass@host -> redis://[REDACTED]@host
  result = result.replace(REDIS_URI_REGEX, '$1[REDACTED]@');

  // Redact Bearer authorization headers/strings
  result = result.replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED]');

  // Redact standalone JWT strings
  result = result.replace(JWT_STRING_REGEX, '[REDACTED_JWT]');

  return result;
}

/**
 * Deep-clone and sanitize an input value (object, array, string, Error).
 * Never mutates the original object.
 * Handles circular references safely.
 *
 * @param {*} val - Value to sanitize
 * @param {WeakSet} [seen=new WeakSet()] - Cycle detector
 * @returns {*} Redacted clone
 */
function redact(val, seen = new WeakSet()) {
  if (val === null || val === undefined) {
    return val;
  }

  // Primitive types
  if (typeof val === 'string') {
    return redactString(val);
  }

  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return val;
  }

  if (typeof val === 'function') {
    return '[Function]';
  }

  // Handle Error instances
  if (val instanceof Error) {
    return {
      name: val.name,
      message: redactString(val.message),
      code: val.code || val.status || val.statusCode,
      stack: val.stack ? redactString(val.stack) : undefined,
    };
  }

  // Handle Dates
  if (val instanceof Date) {
    return val.toISOString();
  }

  // Prevent circular references
  if (typeof val === 'object') {
    if (seen.has(val)) {
      return '[Circular]';
    }
    seen.add(val);
  }

  // Handle Arrays
  if (Array.isArray(val)) {
    return val.map((item) => redact(item, seen));
  }

  // Handle Plain Objects
  const sanitized = {};
  for (const [key, value] of Object.entries(val)) {
    const lowerKey = key.toLowerCase();

    // Check if key itself is sensitive
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = redact(value, seen);
    }
  }

  return sanitized;
}

/**
 * Safe email scrubber for authentication audit logs.
 * Example: 'shiva.soni@gmail.com' -> 's***i@gmail.com'
 * Avoids recording full plain-text email while retaining operational searchability.
 *
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '[UNKNOWN]';
  const parts = email.trim().split('@');
  if (parts.length !== 2) return '[REDACTED_EMAIL]';
  const [local, domain] = parts;
  if (local.length <= 2) {
    return `${local[0] || '*'}***@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

module.exports = {
  redact,
  redactString,
  cleanLogString,
  maskEmail,
  SENSITIVE_KEYS,
};

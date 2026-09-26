'use strict';

/**
 * QueueFlow — Centralized Structured Logger
 * Phase 5 — Step 6: Structured Logging, Request IDs & Secret Redaction
 *
 * Emits machine-readable structured JSON in production (ideal for Render/Datadog/CloudWatch)
 * and clean, sanitized output in development/test.
 *
 * Every message passes through centralized secret redaction. Logger failures fail safe.
 */

const { redact, cleanLogString } = require('./redact');

const SERVICE_NAME = 'queueflow-backend';

class Logger {
  constructor(options = {}) {
    this.service = options.service || SERVICE_NAME;
    this.stream = options.stream || process.stdout;
    this.errorStream = options.errorStream || process.stderr;
  }

  /**
   * Determine whether current environment is production.
   */
  isProduction() {
    return process.env.NODE_ENV === 'production';
  }

  /**
   * Format and serialize a structured log record.
   *
   * @param {string} level - 'info' | 'warn' | 'error' | 'security'
   * @param {string|object} messageOrMeta
   * @param {object} [meta={}]
   * @returns {string} Serialized log string
   */
  formatRecord(level, messageOrMeta, meta = {}) {
    let message = '';
    let extra = {};

    if (typeof messageOrMeta === 'string') {
      message = cleanLogString(messageOrMeta);
      extra = meta && typeof meta === 'object' ? meta : {};
    } else if (messageOrMeta && typeof messageOrMeta === 'object') {
      extra = messageOrMeta;
      message = extra.message ? cleanLogString(String(extra.message)) : '';
    }

    // Sanitize extra metadata through redaction
    const sanitizedExtra = redact(extra) || {};

    const record = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
    };

    if (sanitizedExtra.requestId) record.requestId = cleanLogString(String(sanitizedExtra.requestId));
    if (sanitizedExtra.event) record.event = cleanLogString(String(sanitizedExtra.event));
    if (sanitizedExtra.method) record.method = String(sanitizedExtra.method).toUpperCase();
    if (sanitizedExtra.path) record.path = cleanLogString(String(sanitizedExtra.path));
    if (sanitizedExtra.status !== undefined) record.status = Number(sanitizedExtra.status);
    if (sanitizedExtra.durationMs !== undefined) record.durationMs = Number(sanitizedExtra.durationMs);
    if (sanitizedExtra.userId) record.userId = cleanLogString(String(sanitizedExtra.userId));
    if (sanitizedExtra.centerId) record.centerId = cleanLogString(String(sanitizedExtra.centerId));
    if (sanitizedExtra.role) record.role = cleanLogString(String(sanitizedExtra.role));
    if (sanitizedExtra.errorCode) record.errorCode = cleanLogString(String(sanitizedExtra.errorCode));

    if (message) {
      record.message = message;
    }

    // Attach remaining fields from sanitizedExtra that are not top-level duplicates
    const topLevelKeys = new Set([
      'timestamp', 'level', 'service', 'requestId', 'event', 'method',
      'path', 'status', 'durationMs', 'userId', 'centerId', 'role', 'errorCode', 'message',
    ]);

    for (const [k, v] of Object.entries(sanitizedExtra)) {
      if (!topLevelKeys.has(k) && v !== undefined) {
        record[k] = v;
      }
    }

    return JSON.stringify(record);
  }

  /**
   * Safely writes a line to stdout or stderr without throwing.
   */
  _write(level, line) {
    try {
      if (level === 'error') {
        this.errorStream.write(line + '\n');
      } else {
        this.stream.write(line + '\n');
      }
    } catch (_) {
      // Fail-safe: Fallback to minimal console if stream writing fails
      try {
        process.stderr.write(`{"fallback":true,"level":"${level}"}\n`);
      } catch (__) {
        // Complete silence rather than application crash
      }
    }
  }

  info(messageOrMeta, meta) {
    try {
      const line = this.formatRecord('info', messageOrMeta, meta);
      this._write('info', line);
    } catch (err) {
      this._write('error', `{"level":"error","message":"logger_serialization_failed"}`);
    }
  }

  warn(messageOrMeta, meta) {
    try {
      const line = this.formatRecord('warn', messageOrMeta, meta);
      this._write('warn', line);
    } catch (err) {
      this._write('error', `{"level":"error","message":"logger_serialization_failed"}`);
    }
  }

  error(messageOrMeta, meta) {
    try {
      const line = this.formatRecord('error', messageOrMeta, meta);
      this._write('error', line);
    } catch (err) {
      this._write('error', `{"level":"error","message":"logger_serialization_failed"}`);
    }
  }

  /**
   * Dedicated method for security audit events.
   *
   * @param {string} event - e.g. 'AUTH_LOGIN_SUCCESS', 'AUTH_LOGIN_FAILURE', etc.
   * @param {object} meta - Context metadata (e.g. userId, clientIp, reason)
   */
  security(event, meta = {}) {
    try {
      const combined = { event, ...meta };
      const line = this.formatRecord('security', combined);
      this._write('security', line);
    } catch (err) {
      this._write('error', `{"level":"error","message":"security_logger_failed"}`);
    }
  }
}

// Singleton instance
const logger = new Logger();

module.exports = {
  logger,
  Logger,
};

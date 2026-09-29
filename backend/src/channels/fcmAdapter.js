'use strict';

/**
 * QueueFlow — Firebase Cloud Messaging (FCM HTTP v1) outbound push adapter.
 *
 * Scope: OUTBOUND push delivery only.
 *
 * Design rules:
 *  - Firebase Admin SDK is loaded lazily.
 *  - Firebase initialization happens only when a push is actually attempted.
 *  - Credentials are never logged or embedded in configuration.
 *  - Credentials may come from:
 *      1. FIREBASE_SERVICE_ACCOUNT_PATH
 *      2. GOOGLE_APPLICATION_CREDENTIALS
 *      3. Application Default Credentials
 *  - FCM failures never throw to the queue/token layer.
 *  - Raw FCM tokens and Firebase error objects are never logged.
 *  - Notification sound/channel configuration is intentionally NOT handled here.
 */

const fs = require('fs');
const path = require('path');

const { logger } = require('../utils/logger');
const { getConfig } = require('../config/env');

/**
 * Firebase Admin SDK v14 modular imports.
 *
 * IMPORTANT:
 * Do NOT use:
 *   admin.credential.cert()
 *   admin.messaging()
 *
 * Firebase Admin v14 exposes these through modular APIs.
 */
const {
  initializeApp,
  getApps,
  cert,
  applicationDefault,
} = require('firebase-admin/app');

const {
  getMessaging,
} = require('firebase-admin/messaging');

const FCM_DATA_MAX_BYTES = 4000;

const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
  'messaging/invalid-recipient',
  'registration-token-not-registered',
  'invalid-argument',
  'invalid-recipient',
]);

const FORBIDDEN_DATA_KEYS = new Set([
  'token',
  'fcmtoken',
  'devicetoken',
  'registrationtoken',
  'authorization',
  'apikey',
  'api_key',
  'client_secret',
  'private_key',
  'privatekey',
]);

/**
 * Reads validated configuration when available.
 * Falls back to process.env when the module is used independently.
 */
function readConfig() {
  try {
    return getConfig();
  } catch (_) {
    return process.env;
  }
}

/**
 * Returns a trimmed configuration string or null.
 */
function envStr(cfg, key) {
  const fromConfig = cfg ? cfg[key] : undefined;

  if (typeof fromConfig === 'string' && fromConfig.trim()) {
    return fromConfig.trim();
  }

  const fromEnv = process.env[key];

  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }

  return null;
}

/**
 * Reads a boolean configuration flag.
 */
function envFlag(cfg, key) {
  if (typeof cfg?.[key] === 'boolean') {
    return cfg[key];
  }

  return process.env[key] === 'true';
}

/**
 * Converts metadata into a flat string-only FCM data payload.
 *
 * Sensitive/token-like keys are intentionally removed.
 */
function sanitizeData(data) {
  const sanitized = {};

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return sanitized;
  }

  for (const [key, value] of Object.entries(data)) {
    if (FORBIDDEN_DATA_KEYS.has(key.toLowerCase())) {
      continue;
    }

    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'object' || typeof value === 'function') {
      continue;
    }

    sanitized[key] = String(value);
  }

  return sanitized;
}

/**
 * Safely extracts Firebase error code.
 */
function extractFirebaseErrorCode(err) {
  if (!err) {
    return null;
  }

  const code = err.code || (err.errorInfo && err.errorInfo.code);

  return typeof code === 'string' && code ? code : null;
}

class FcmAdapter {
  constructor() {
    /**
     * Cached Firebase Messaging initialization promise.
     * Firebase is NOT initialized when this module is imported.
     */
    this._messagingPromise = null;
  }

  /**
   * Returns true only when FCM has explicitly been enabled.
   */
  isEnabled() {
    return envFlag(readConfig(), 'FCM_ENABLED');
  }

  /**
   * Checks whether FCM has enough configuration to attempt delivery.
   *
   * Credential source can be:
   * - explicit service-account file
   * - explicit GOOGLE_APPLICATION_CREDENTIALS file
   * - ambient Application Default Credentials
   */
  isConfigured() {
    if (!this.isEnabled()) {
      return false;
    }

    if (!envStr(readConfig(), 'FIREBASE_PROJECT_ID')) {
      return false;
    }

    return this._resolveCredential().source !== null;
  }

  /**
   * Resolves the Firebase credential source.
   */
  _resolveCredential() {
    const cfg = readConfig();

    const serviceAccountPath = envStr(
      cfg,
      'FIREBASE_SERVICE_ACCOUNT_PATH',
    );

    if (serviceAccountPath) {
      return {
        source: 'SERVICE_ACCOUNT_FILE',
        path: serviceAccountPath,
      };
    }

    const adcPath = envStr(
      cfg,
      'GOOGLE_APPLICATION_CREDENTIALS',
    );

    if (adcPath) {
      return {
        source: 'ADC_FILE',
        path: adcPath,
      };
    }

    /**
     * Application Default Credentials may be provided by the runtime.
     */
    return {
      source: 'ADC',
      path: null,
    };
  }

  /**
   * Sends a push notification to one FCM registration token.
   *
   * Never throws.
   */
  async sendPush({
    token,
    deviceToken: altToken,
    title,
    body,
    data,
  } = {}) {
    const rawToken = token || altToken;
    const deviceToken =
      typeof rawToken === 'string'
        ? rawToken.trim()
        : '';

    if (!deviceToken) {
      return {
        success: false,
        delivered: false,
        errorCode: 'INVALID_PAYLOAD',
        reason: 'A destination device token is required.',
        invalidToken: true,
      };
    }

    const safeData = sanitizeData(data);

    if (
      Buffer.byteLength(
        JSON.stringify(safeData),
        'utf8',
      ) > FCM_DATA_MAX_BYTES
    ) {
      return {
        success: false,
        delivered: false,
        errorCode: 'INVALID_PAYLOAD',
        reason:
          `Data payload exceeds the ${FCM_DATA_MAX_BYTES} byte FCM limit.`,
        invalidToken: false,
      };
    }

    if (!this.isConfigured()) {
      return {
        success: false,
        delivered: false,
        errorCode: 'PROVIDER_NOT_CONFIGURED',
        reason:
          'FCM is disabled or Firebase credentials are unavailable.',
        invalidToken: false,
      };
    }

    let messaging;

    try {
      messaging = await this._getMessaging();
    } catch (_) {
      return {
        success: false,
        delivered: false,
        errorCode: 'FCM_INIT_FAILED',
        reason:
          'Firebase Admin SDK initialization failed.',
        invalidToken: false,
      };
    }

    /**
     * Basic FCM notification.
     *
     * IMPORTANT:
     * Sound/channel configuration is intentionally NOT added here.
     * We will handle Android custom sound in the later phase.
     */
    const message = {
      token: deviceToken,

      notification: {
        title:
          title !== null && title !== undefined
            ? String(title)
            : '',

        body:
          body !== null && body !== undefined
            ? String(body)
            : '',
      },

      android: {
        notification: {
          sound: 'token_approaching',
          channelId: 'queueflow_alerts',
        },
      },
    };

    if (Object.keys(safeData).length > 0) {
      message.data = safeData;
    }

    try {
      const response = await messaging.send(message);

      return {
        success: true,
        delivered: true,
        messageId:
          typeof response === 'string'
            ? response
            : (response && response.messageId) || response,
        reason: null,
        invalidToken: false,
      };
    } catch (err) {
      return this._toFailureResult(err);
    }
  }

  /**
   * Returns cached Firebase Messaging instance,
   * initializing Firebase only when required.
   */
  _getMessaging() {
    if (!this._messagingPromise) {
      this._messagingPromise = this._initialize();
    }

    return this._messagingPromise;
  }

  /**
   * Lazily initializes Firebase Admin SDK.
   *
   * Firebase Admin SDK v14 modular API.
   */
  async _initialize() {
    try {
      const projectId = envStr(
        readConfig(),
        'FIREBASE_PROJECT_ID',
      );

      const credential = this._resolveCredential();

      /**
       * Reuse an existing Firebase Admin app if another
       * part of the backend already initialized one.
       */
      const existingApps = getApps();

      if (existingApps.length > 0) {
        logger.info('FCM_INITIALIZED', {
          projectId,
          credentialSource: 'EXISTING_APP',
        });

        return getMessaging(existingApps[0]);
      }

      let app;

      if (credential.source === 'SERVICE_ACCOUNT_FILE') {
        const serviceAccount =
          this._readServiceAccount(
            credential.path,
          );

        app = initializeApp({
          credential: cert(serviceAccount),
          projectId,
        });
      } else {
        /**
         * Covers:
         * - ADC_FILE
         * - ADC
         */
        app = initializeApp({
          credential: applicationDefault(),
          projectId,
        });
      }

      logger.info('FCM_INITIALIZED', {
        projectId,
        credentialSource: credential.source,
      });

      return getMessaging(app);
    } catch (err) {
      /**
       * Clear the cached promise so another attempt can retry.
       */
      this._messagingPromise = null;

      /**
       * Only log a safe Firebase error code.
       * Never log err.message or the raw error.
       */
      logger.warn('FCM_INIT_FAILED', {
        errorCode:
          extractFirebaseErrorCode(err) ||
          'FCM_INIT_FAILED',
      });

      throw err;
    }
  }

  /**
   * Reads and validates Firebase service-account JSON.
   *
   * The credential is never logged or returned outside
   * the Firebase initialization flow.
   */
  _readServiceAccount(serviceAccountPath) {
    let raw;
    const resolvedPath = path.isAbsolute(serviceAccountPath)
      ? serviceAccountPath
      : (fs.existsSync(serviceAccountPath)
          ? serviceAccountPath
          : (fs.existsSync(path.resolve(__dirname, '../../', serviceAccountPath))
              ? path.resolve(__dirname, '../../', serviceAccountPath)
              : path.resolve(process.cwd(), serviceAccountPath)));

    try {
      raw = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      const error = new Error(
        'FCM_SERVICE_ACCOUNT_UNREADABLE',
      );

      error.code =
        'FCM_SERVICE_ACCOUNT_UNREADABLE';

      error.causeCode =
        err && err.code
          ? String(err.code)
          : null;

      throw error;
    }

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      raw = null;

      const error = new Error(
        'FCM_SERVICE_ACCOUNT_MALFORMED',
      );

      error.code =
        'FCM_SERVICE_ACCOUNT_MALFORMED';

      throw error;
    }

    raw = null;

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.private_key ||
      !parsed.client_email
    ) {
      const error = new Error(
        'FCM_SERVICE_ACCOUNT_INCOMPLETE',
      );

      error.code =
        'FCM_SERVICE_ACCOUNT_INCOMPLETE';

      throw error;
    }

    /**
     * Some secret managers store PEM newlines
     * as literal "\n" characters.
     */
    if (
      typeof parsed.private_key === 'string' &&
      parsed.private_key.includes('\\n')
    ) {
      parsed.private_key =
        parsed.private_key.replace(
          /\\n/g,
          '\n',
        );
    }

    return parsed;
  }

  /**
   * Converts Firebase send errors into safe structured results.
   */
  _toFailureResult(err) {
    const firebaseErrorCode =
      extractFirebaseErrorCode(err);

    if (
      INVALID_TOKEN_ERROR_CODES.has(
        firebaseErrorCode,
      )
    ) {
      logger.warn(
        'FCM_SEND_REJECTED_INVALID_TOKEN',
        {
          firebaseErrorCode,
        },
      );

      return {
        success: false,
        delivered: false,
        errorCode: 'INVALID_TOKEN',
        firebaseErrorCode,
        invalidToken: true,
        reason:
          'The destination registration token is no longer valid.',
      };
    }

    logger.warn('FCM_SEND_FAILED', {
      firebaseErrorCode:
        firebaseErrorCode || 'UNKNOWN',
    });

    return {
      success: false,
      delivered: false,
      errorCode: 'FCM_SEND_FAILED',
      firebaseErrorCode,
      invalidToken: false,
      reason:
        'Firebase Cloud Messaging could not deliver the message.',
    };
  }
}

const fcmAdapter = new FcmAdapter();

module.exports = {
  FcmAdapter,
  fcmAdapter,
};
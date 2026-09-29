'use strict';

const { logger } = require('../utils/logger');

/**
 * fcmPushProvider
 * ---------------------------------------------------------------------------
 * Server-side Firebase Cloud Messaging delivery.
 *
 * This is an OUTBOUND-ONLY provider. It deliberately does NOT extend
 * BaseChannelAdapter: FCM has no inbound webhook surface for QueueFlow (users
 * never send commands through push), so the inbound verification/parsing
 * contract does not apply. It follows the same conventions as the other
 * provider adapters — `isConfigured()`, no work until real credentials exist,
 * redacted logging, and a structured result instead of thrown provider errors.
 *
 * CREDENTIALS
 * Credentials are read from the environment only. Two strategies are
 * supported, in priority order:
 *
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON  — the full service account JSON pasted
 *      into a single environment variable. This is the strategy to use on
 *      Render, where there is no writable filesystem.
 *   2. GOOGLE_APPLICATION_CREDENTIALS — a path to a service account JSON file
 *      on disk, used together with FIREBASE_PROJECT_ID (the standard Google
 *      Application Default Credentials variable name).
 *
 * Nothing is ever hardcoded and nothing is ever logged. The private key, the
 * client email and the project id are only ever passed to the SDK.
 * TRUTHFUL DELIVERY REPORTING
 * `sendPush()` never reports success unless Firebase acknowledged the message.
 * When credentials are absent, or the provider rejects the request, it returns
 * an explicit reason so the caller can record the notification honestly.
 */

/** Named Firebase app so repeated calls in one process reuse one client. */
const FIREBASE_APP_NAME = 'queueflow-push';

/**
 * firebase-admin error codes that mean "this device token is dead". FCM does
 * not distinguish between a token for an uninstalled app and a malformed one,
 * so both are treated as "stop sending to this token".
 */
const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration',
  'messaging/invalid-argument',
]);

/**
 * Why a send did not result in delivery. Every value is a non-sensitive,
 * stable identifier safe to persist and to log.
 */
const FcmSkipReason = {
  NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  NO_DEVICE_TOKEN: 'NO_DEVICE_TOKEN',
  UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  FAILED: 'PROVIDER_ERROR',
};

let cachedCredentialState = null;
let cachedApp = null;
let cachedMessaging = null;
let cachedAppError = null;

/**
 * Reads and validates the credential configuration from the environment.
 *
 * Returns a discriminated result rather than throwing, because "no credentials
 * configured" is a normal, expected state that must never break notification
 * persistence.
 *
 * @returns {{configured: boolean, strategy: string|null, error: string|null, projectId: string|null}}
 */
function resolveCredentials() {
  if (cachedCredentialState) {
    return cachedCredentialState;
  }

  const inlineJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const credentialsFile = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  const envProjectId = (process.env.FIREBASE_PROJECT_ID || '').trim();

  if (inlineJson) {
    let parsed;
    try {
      parsed = JSON.parse(inlineJson);
    } catch (_err) {
      cachedCredentialState = {
        configured: false,
        strategy: 'inline-json',
        error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON',
        projectId: null,
      };
      return cachedCredentialState;
    }

    const hasKey = typeof parsed?.private_key === 'string' && parsed.private_key.length > 0;
    const hasEmail = typeof parsed?.client_email === 'string' && parsed.client_email.length > 0;
    if (!hasKey || !hasEmail) {
      // Never echo the parsed object — it holds the private key.
      cachedCredentialState = {
        configured: false,
        strategy: 'inline-json',
        error: 'FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email or private_key',
        projectId: null,
      };
      return cachedCredentialState;
    }

    cachedCredentialState = {
      configured: true,
      strategy: 'inline-json',
      error: null,
      projectId: envProjectId || (typeof parsed.project_id === 'string' ? parsed.project_id : null),
      credential: parsed,
    };
    return cachedCredentialState;
  }

  if (credentialsFile) {
    if (!envProjectId) {
      cachedCredentialState = {
        configured: false,
        strategy: 'credentials-file',
        error: 'FIREBASE_PROJECT_ID is required when using GOOGLE_APPLICATION_CREDENTIALS',
        projectId: null,
      };
      return cachedCredentialState;
    }
    // The file itself is read lazily by the SDK; existence is not checked here
    // so a credential mounted just after process start still works.
    cachedCredentialState = {
      configured: true,
      strategy: 'credentials-file',
      error: null,
      projectId: envProjectId,
      credentialsFile,
    };
    return cachedCredentialState;
  }

  cachedCredentialState = {
    configured: false,
    strategy: null,
    error: 'no Firebase credentials in the environment',
    projectId: null,
  };
  return cachedCredentialState;
}

let fcmAdapterInstance = null;
function getFcmAdapter() {
  if (!fcmAdapterInstance) {
    try {
      fcmAdapterInstance = require('./fcmAdapter').fcmAdapter;
    } catch (_) {}
  }
  return fcmAdapterInstance;
}

/**
 * True when real Firebase credentials are present in the environment.
 * Mirrors the `isConfigured()` convention of the other channel adapters.
 *
 * @returns {boolean}
 */
function isConfigured() {
  const adapter = getFcmAdapter();
  if (adapter && adapter.isConfigured()) {
    return true;
  }
  return resolveCredentials().configured;
}

/**
 * A non-sensitive description of provider readiness, suitable for a health
 * endpoint or a log line. Contains no credential material.
 *
 * @returns {{configured: boolean, strategy: string|null, projectId: string|null, ready: boolean, error: string|null}}
 */
function getStatus() {
  const state = resolveCredentials();
  return {
    configured: state.configured,
    strategy: state.strategy,
    projectId: state.projectId || null,
    ready: state.configured && cachedMessaging != null,
    error: cachedAppError || state.error,
  };
}

/**
 * Lazily initialises the Firebase Admin SDK. Returns null (never throws) when
 * the SDK is unavailable or initialisation fails, so notification delivery is
 * always best-effort.
 */
function getMessaging() {
  if (cachedAppError) {
    return null;
  }
  if (cachedApp) {
    // The Firebase app and the Messaging service are cached separately: a
    // second call must hand back the Messaging instance, not the app it wraps.
    return cachedMessaging;
  }

  const state = resolveCredentials();
  if (!state.configured) {
    return null;
  }

  let admin;
  let messagingModule;
  try {
    admin = require('firebase-admin');
    messagingModule = require('firebase-admin/messaging');
  } catch (err) {
    cachedAppError = `firebase-admin could not be loaded (${err.message})`;
    logger.warn('fcm.provider.unavailable', { reason: cachedAppError });
    return null;
  }

  try {
    if (admin.apps.some((app) => app.name === FIREBASE_APP_NAME)) {
      cachedApp = admin.getApp(FIREBASE_APP_NAME);
    } else {
      const options = { projectId: state.projectId || undefined };
      const credential =
        state.strategy === 'inline-json'
          ? admin.credential.cert(state.credential)
          : admin.credential.applicationDefault();
      cachedApp = admin.initializeApp({ ...options, credential }, FIREBASE_APP_NAME);
    }
    cachedMessaging = messagingModule.getMessaging(cachedApp);
    return cachedMessaging;
  } catch (err) {
    // err.message from the SDK can embed credential paths but never key
    // material; it is safe, and necessary, to record why the provider is down.
    cachedAppError = err.message;
    logger.warn('fcm.provider.initialisation_failed', { reason: err.message });
    return null;
  }
}

/**
 * True when a provider error means the device token is permanently invalid and
 * should be cleared from the user record so the backend stops trying.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isInvalidTokenError(error) {
  const code = error?.code;
  if (typeof code === 'string' && INVALID_TOKEN_ERROR_CODES.has(code)) {
    return true;
  }
  // Some transports surface the code as `error.code` on a nested cause.
  const cause = error?.cause;
  if (cause && typeof cause.code === 'string' && INVALID_TOKEN_ERROR_CODES.has(cause.code)) {
    return true;
  }
  return false;
}

/**
 * Builds the wire payload. Every value must be a string, so structured
 * metadata is JSON-encoded rather than passed as an object.
 *
 * The payload carries a routing hint (`tokenId`, `type`) and NOTHING about
 * queue state. Clients must re-fetch authoritative state on open; a push
 * payload is never a source of truth.
 */
function buildMessage({ deviceToken, title, body, data }) {
  const stringData = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === null || value === undefined) continue;
    stringData[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  return {
    token: deviceToken,
    notification: { title, body },
    // QueueFlow dedupes on `dedupeKey`, which is also the backend's own
    // idempotency key, so a push and a socket alert collapse to one alert.
    data: stringData,
    android: {
      priority: 'high',
      notification: {
        // Without a channel id, Android drops the notification on API 26+.
        channelId: process.env.FCM_ANDROID_CHANNEL_ID || 'queueflow_alerts',
        sound: 'token_approaching',
      },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default' } },
    },
  };
}

/**
 * Sends one push notification to a single device.
 *
 * @param {object} params
 * @param {string} params.deviceToken  - FCM registration token for the device
 * @param {string} params.title
 * @param {string} params.body
 * @param {object} [params.data]      - routing hint payload (never authoritative)
 * @returns {Promise<{delivered: boolean, reason: string|null, invalidToken: boolean}>}
 */
async function sendPush({ deviceToken, title, body, data }) {
  if (!deviceToken || typeof deviceToken !== 'string') {
    return { delivered: false, reason: FcmSkipReason.NO_DEVICE_TOKEN, invalidToken: true };
  }
  if (!isConfigured()) {
    return { delivered: false, reason: FcmSkipReason.NOT_CONFIGURED, invalidToken: false };
  }

  const adapter = getFcmAdapter();
  if (adapter && adapter.isConfigured()) {
    const res = await adapter.sendPush({
      token: deviceToken,
      title,
      body,
      data,
    });
    return {
      delivered: Boolean(res.delivered || res.success),
      reason: res.reason || (res.success ? null : res.errorCode),
      invalidToken: Boolean(res.invalidToken),
    };
  }

  const messaging = getMessaging();
  if (!messaging) {
    return { delivered: false, reason: FcmSkipReason.UNAVAILABLE, invalidToken: false };
  }

  try {
    // The device token is intentionally never logged or included in errors.
    await messaging.send(buildMessage({ deviceToken, title, body, data }));
    return { delivered: true, reason: null, invalidToken: false };
  } catch (err) {
    const invalidToken = isInvalidTokenError(err);
    logger.warn('fcm.delivery.failed', {
      reason: err?.code || 'unknown',
      invalidToken,
    });
    return {
      delivered: false,
      reason: invalidToken ? 'DEVICE_TOKEN_REJECTED' : FcmSkipReason.FAILED,
      invalidToken,
    };
  }
}

/**
 * Test seam: clears the memoised credential state and Firebase app so a test
 * can re-evaluate configuration after changing the environment.
 */
function resetForTesting() {
  cachedCredentialState = null;
  cachedApp = null;
  cachedMessaging = null;
  cachedAppError = null;
}

module.exports = {
  sendPush,
  isConfigured,
  getStatus,
  isInvalidTokenError,
  resetForTesting,
  FcmSkipReason,
  INVALID_TOKEN_ERROR_CODES,
};

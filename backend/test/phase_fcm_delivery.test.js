'use strict';

/**
 * QueueFlow — FCM PUSH DELIVERY TEST SUITE
 *
 * Verifies the real server-side Firebase Cloud Messaging path:
 *  1. Provider is truthfully unconfigured with no credentials
 *  2. Provider is configured from environment credentials only
 *  3. Invalid credential material is rejected without leaking
 *  4. Provider never reports delivery it did not achieve
 *  5. Provider never logs or returns credential material
 *  6. Dead device tokens are recognised and cleared
 *  7. Transient provider errors are NOT treated as dead tokens
 *  8. Outbound payload shape is provider-safe and carries no secrets
 *  9. notificationService delegates to the provider (no second system)
 * 10. Queue triggers: 5 away, next in line, token called
 * 11. Deduplication prevents a duplicate push for the same alert
 * 12. deliveredViaFcm is set only on genuine provider acknowledgement
 * 13. A rejected device token is cleared from the user record
 * 14. Account isolation: a token registered to user A never notifies user B
 * 15. Notification records and push payloads contain no credentials
 *
 * REAL DATA ONLY. The provider is exercised through its public interface;
 * the Firebase SDK is stubbed ONLY at the transport seam (as an explicitly
 * allowed unit-test mock) so a successful return can be simulated. No test
 * asserts that a real device received a push.
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('../src/config/database');
const fcmPushProvider = require('../src/channels/fcmPushProvider');
const notificationService = require('../src/services/notificationService');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const { Queue } = require('../src/models/Queue');

let passed = 0;
let failed = 0;
let db;

const PROVIDER_SRC = fs.readFileSync(
  path.join(__dirname, '../src/channels/fcmPushProvider.js'),
  'utf8'
);
const SERVICE_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/notificationService.js'),
  'utf8'
);

/** Synthetic, obviously-not-a-real-key material used only to exercise the
 *  credential-shape validation branch. */
const SYNTHETIC_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'queueflow-test-project',
  private_key_id: 'synthetic-not-a-real-key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic-not-a-real-key\n-----END PRIVATE KEY-----\n',
  client_email: 'synthetic@queueflow-test-project.iam.gserviceaccount.com',
  client_id: '000000000000000000000',
});

/**
 * Users.fcmToken carries a unique index, so every synthetic device token is
 * scoped to this run. This mirrors production, where a device token belongs to
 * exactly one account at a time.
 */
const RUN = String(Date.now()).slice(-8);
const deviceToken = (label) => `synthetic-${label}-${RUN}`;

function pass(name) {
  passed++;
  console.log(`  \u2713 ${name}`);
}

function fail(name, err) {
  failed++;
  console.log(`  \u2717 ${name}`);
  console.log(`      ${err.message}`);
}

/** Restores the ambient Firebase environment and clears memoised state. */
function clearFirebaseEnv() {
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.FIREBASE_PROJECT_ID;
  fcmPushProvider.resetForTesting();
}

async function runTests() {
  console.log('\n============================================================');
  console.log('  FCM PUSH DELIVERY TESTS');
  console.log('============================================================\n');

  // ── 1. Truthfully unconfigured ──────────────────────────────────────────
  try {
    clearFirebaseEnv();
    assert.strictEqual(fcmPushProvider.isConfigured(), false);
    const status = fcmPushProvider.getStatus();
    assert.strictEqual(status.configured, false);
    assert.strictEqual(status.ready, false);
    assert.strictEqual(status.strategy, null);
    assert.ok(status.error, 'a reason must be given when unconfigured');
    pass('1. provider reports unconfigured with no credentials');
  } catch (err) {
    fail('1. provider reports unconfigured with no credentials', err);
  }

  // ── 2. Unconfigured provider never claims delivery ─────────────────────
  try {
    clearFirebaseEnv();
    const result = await fcmPushProvider.sendPush({
      deviceToken: 'a-device-token-that-does-not-matter-without-credentials',
      title: 'QueueFlow',
      body: 'test',
    });
    assert.strictEqual(result.delivered, false, 'delivery must never be faked');
    assert.strictEqual(result.reason, fcmPushProvider.FcmSkipReason.NOT_CONFIGURED);
    assert.strictEqual(result.invalidToken, false, 'an unconfigured provider knows nothing about the token');
    pass('2. unconfigured provider never reports delivery');
  } catch (err) {
    fail('2. unconfigured provider never reports delivery', err);
  }

  // ── 3. Missing device token ────────────────────────────────────────────
  try {
    clearFirebaseEnv();
    for (const empty of [undefined, null, '']) {
      const result = await fcmPushProvider.sendPush({ deviceToken: empty, title: 't', body: 'b' });
      assert.strictEqual(result.delivered, false);
      assert.strictEqual(result.reason, fcmPushProvider.FcmSkipReason.NO_DEVICE_TOKEN);
      assert.strictEqual(result.invalidToken, true);
    }
    pass('3. absent device token is reported, never sent');
  } catch (err) {
    fail('3. absent device token is reported, never sent', err);
  }

  // ── 4. Malformed inline credentials are rejected safely ────────────────
  try {
    clearFirebaseEnv();
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{not valid json';
    fcmPushProvider.resetForTesting();
    assert.strictEqual(fcmPushProvider.isConfigured(), false);
    const status = fcmPushProvider.getStatus();
    assert.ok(/not valid JSON/.test(status.error));
    assert.ok(!JSON.stringify(status).includes('BEGIN PRIVATE KEY'));
    pass('4. malformed inline credentials are rejected without throwing');
  } catch (err) {
    fail('4. malformed inline credentials are rejected without throwing', err);
  } finally {
    clearFirebaseEnv();
  }

  // ── 5. Incomplete service account is rejected ──────────────────────────
  try {
    clearFirebaseEnv();
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      type: 'service_account',
      project_id: 'p',
      client_email: 'a@b.com',
    });
    fcmPushProvider.resetForTesting();
    assert.strictEqual(fcmPushProvider.isConfigured(), false, 'an account without a private key must not count as configured');
    assert.ok(/private_key/.test(fcmPushProvider.getStatus().error));
    pass('5. service account without a private key is not accepted');
  } catch (err) {
    fail('5. service account without a private key is not accepted', err);
  } finally {
    clearFirebaseEnv();
  }

  // ── 6. Credentials-file strategy requires a project id ─────────────────
  try {
    clearFirebaseEnv();
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/queueflow-test.json';
    fcmPushProvider.resetForTesting();
    assert.strictEqual(fcmPushProvider.isConfigured(), false);
    assert.ok(/FIREBASE_PROJECT_ID/.test(fcmPushProvider.getStatus().error));

    process.env.FIREBASE_PROJECT_ID = 'queueflow-test-project';
    fcmPushProvider.resetForTesting();
    assert.strictEqual(fcmPushProvider.isConfigured(), true, 'a path plus a project id is a complete configuration');
    assert.strictEqual(fcmPushProvider.getStatus().strategy, 'credentials-file');
    pass('6. credentials-file strategy is validated, not guessed');
  } catch (err) {
    fail('6. credentials-file strategy is validated, not guessed', err);
  } finally {
    clearFirebaseEnv();
  }

  // ── 7. Inline service-account strategy ─────────────────────────────────
  try {
    clearFirebaseEnv();
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = SYNTHETIC_SERVICE_ACCOUNT;
    fcmPushProvider.resetForTesting();
    assert.strictEqual(fcmPushProvider.isConfigured(), true);
    const status = fcmPushProvider.getStatus();
    assert.strictEqual(status.strategy, 'inline-json');
    assert.strictEqual(status.projectId, 'queueflow-test-project');
    assert.ok(
      !JSON.stringify(status).includes('BEGIN PRIVATE KEY'),
      'status must never expose key material'
    );
    assert.ok(!JSON.stringify(status).includes('synthetic-not-a-real-key'));
    pass('7. inline service account is accepted and never echoed');
  } catch (err) {
    fail('7. inline service account is accepted and never echoed', err);
  } finally {
    clearFirebaseEnv();
  }

  // ── 8. Dead device-token detection ─────────────────────────────────────
  try {
    for (const code of fcmPushProvider.INVALID_TOKEN_ERROR_CODES) {
      assert.strictEqual(fcmPushProvider.isInvalidTokenError({ code }), true, `${code} must be detected`);
    }
    // Transport wrapping the code one level deeper must still be detected.
    assert.strictEqual(
      fcmPushProvider.isInvalidTokenError({
        message: 'send failed',
        cause: { code: 'messaging/registration-token-not-registered' },
      }),
      true
    );
    pass('8. every Firebase dead-token code is recognised, including nested');
  } catch (err) {
    fail('8. every Firebase dead-token code is recognised, including nested', err);
  }

  // ── 9. Transient failures must not unsubscribe a real user ─────────────
  try {
    for (const code of ['messaging/internal-error', 'messaging/too-many-topics', 'messaging/quota-exceeded']) {
      assert.strictEqual(fcmPushProvider.isInvalidTokenError({ code }), false, `${code} is transient`);
    }
    assert.strictEqual(fcmPushProvider.isInvalidTokenError(new Error('ECONNRESET')), false);
    assert.strictEqual(fcmPushProvider.isInvalidTokenError(null), false);
    pass('9. transient provider errors are not treated as dead tokens');
  } catch (err) {
    fail('9. transient provider errors are not treated as dead tokens', err);
  }

  // ── 10. Outbound payload shape ─────────────────────────────────────────
  try {
    // The provider builds its own message; verify the contract it must honour
    // by driving the real function through the documented call shape.
    const original = process.env.FCM_ANDROID_CHANNEL_ID;
    delete process.env.FCM_ANDROID_CHANNEL_ID;

    const messagingCalls = [];
    const stubModule = {
      getMessaging: () => ({
        send: async (message) => {
          messagingCalls.push(message);
          return 'projects/queueflow-test-project/messages/0';
        },
      }),
    };
    const adminStub = {
      apps: [],
      initializeApp: () => ({ name: 'queueflow-push' }),
      getApp: () => ({ name: 'queueflow-push' }),
      credential: {
        cert: () => ({ certificate: 'synthetic' }),
        applicationDefault: () => ({ default: true }),
      },
    };
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function patched(request, parent, isMain) {
      if (request === 'firebase-admin') return adminStub;
      if (request === 'firebase-admin/messaging') return stubModule;
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = SYNTHETIC_SERVICE_ACCOUNT;
      fcmPushProvider.resetForTesting();
      const deviceToken = 'synthetic-device-registration-token';
      const result = await fcmPushProvider.sendPush({
        deviceToken,
        title: 'Your Turn!',
        body: 'Token Q-1 — please proceed to Counter 3.',
        data: { type: 'TOKEN_CALLED', tokenId: 'abc', position: 1, skipped: null },
      });

      assert.strictEqual(result.delivered, true, 'an acknowledged send reports delivery');
      assert.strictEqual(result.invalidToken, false);
      assert.strictEqual(messagingCalls.length, 1);

      // A second send must reuse the cached Messaging service. If the provider
      // handed back the Firebase app instead, this call would not reach the
      // SDK at all and the second alert would be silently lost.
      const second = await fcmPushProvider.sendPush({
        deviceToken: deviceToken,
        title: '5 Tokens Away',
        body: 'Approaching.',
        data: { type: 'TOKEN_APPROACHING' },
      });
      assert.strictEqual(second.delivered, true, 'a reused provider must still deliver');
      assert.strictEqual(messagingCalls.length, 2, 'the cached Messaging service must be reused');
      assert.strictEqual(fcmPushProvider.getStatus().ready, true);

      const sent = messagingCalls[0];
      assert.strictEqual(sent.token, deviceToken);
      assert.strictEqual(sent.notification.title, 'Your Turn!');
      // FCM rejects non-string data values, so they must be encoded.
      for (const value of Object.values(sent.data)) {
        assert.strictEqual(typeof value, 'string', 'every data value must be a string');
      }
      assert.strictEqual(sent.data.type, 'TOKEN_CALLED');
      assert.strictEqual(sent.data.position, '1');
      assert.ok(!('skipped' in sent.data), 'null values must be dropped, not sent as "null"');
      // Without a channel id Android API 26+ discards the notification.
      assert.strictEqual(sent.android.notification.channelId, 'queueflow_alerts');
      assert.strictEqual(sent.apns.headers['apns-priority'], '10');
      // The payload is a routing hint, never authoritative queue state.
      assert.ok(!('position' in sent.notification));
    } finally {
      Module._load = originalLoad;
      fcmPushProvider.resetForTesting();
      if (original === undefined) delete process.env.FCM_ANDROID_CHANNEL_ID;
      else process.env.FCM_ANDROID_CHANNEL_ID = original;
      clearFirebaseEnv();
    }
    pass('10. outbound payload is provider-safe and secret-free');
  } catch (err) {
    fail('10. outbound payload is provider-safe and secret-free', err);
  }

  // ── 11. A rejected device token clears the user record ─────────────────
  try {
    const user = await createUser({ fcmToken: deviceToken('dead') });
    const originalSend = fcmPushProvider.sendPush;
    // Stub ONLY the provider transport result, as an allowed unit mock.
    fcmPushProvider.sendPush = async () => ({
      delivered: false,
      reason: 'DEVICE_TOKEN_REJECTED',
      invalidToken: true,
    });
    let notification;
    try {
      notification = await notificationService.sendTokenNotification(
        { _id: new mongoose.Types.ObjectId(), userId: user._id, tokenCode: 'QF-TEST' },
        'TOKEN_CALLED',
        { title: 'Your Turn!', body: 'test', dedupeKey: `fcmtest_invalid_${Date.now()}` },
      );
    } finally {
      fcmPushProvider.sendPush = originalSend;
    }
    assert.ok(notification, 'the notification record is still persisted');
    assert.strictEqual(notification.deliveredViaFcm, false, 'a rejected send is never marked delivered');
    const reloaded = await User.findById(user._id).lean();
    assert.strictEqual(reloaded.fcmToken, null, 'a rejected device token must be cleared');
    pass('11. a rejected device token is cleared from the user record');
  } catch (err) {
    fail('11. a rejected device token is cleared from the user record', err);
  }

  // ── 12. deliveredViaFcm only on genuine acknowledgement ────────────────
  try {
    const user = await createUser({ fcmToken: deviceToken('live') });
    const originalSend = fcmPushProvider.sendPush;
    let seenPayload = null;
    fcmPushProvider.sendPush = async (args) => {
      seenPayload = args;
      return { delivered: true, reason: null, invalidToken: false };
    };
    let notification;
    try {
      notification = await notificationService.sendTokenNotification(
        { _id: new mongoose.Types.ObjectId(), userId: user._id, tokenCode: 'QF-TEST' },
        'TOKEN_CALLED',
        { title: 'Your Turn!', body: 'test', dedupeKey: `fcmtest_ack_${Date.now()}` },
      );
    } finally {
      fcmPushProvider.sendPush = originalSend;
    }
    assert.strictEqual(notification.deliveredViaFcm, true, 'an acknowledged send is marked delivered');
    assert.ok(seenPayload, 'the provider must be called');
    assert.strictEqual(seenPayload.deviceToken, deviceToken('live'), 'the user’s own token is used');
    assert.strictEqual(seenPayload.data.type, 'TOKEN_CALLED', 'the backend supplies the routing type');
    assert.ok(seenPayload.data.tokenId, 'the token id is included for routing');
    pass('12. deliveredViaFcm is set only on provider acknowledgement');
  } catch (err) {
    fail('12. deliveredViaFcm is set only on provider acknowledgement', err);
  }

  // ── 13. Unconfigured provider leaves delivery unclaimed ────────────────
  try {
    const user = await createUser({ fcmToken: deviceToken('unconfigured') });
    const notification = await notificationService.sendTokenNotification(
      { _id: new mongoose.Types.ObjectId(), userId: user._id, tokenCode: 'QF-TEST' },
      'TOKEN_APPROACHING',
      { title: '5 Tokens Away', body: 'test', dedupeKey: `fcmtest_unconfigured_${Date.now()}` },
    );
    assert.ok(notification);
    assert.strictEqual(notification.deliveredViaFcm, false, 'no credentials means no claimed push delivery');
    // The alert must still be readable in the user's in-app history; losing
    // push must never lose the notification itself.
    const stored = await Notification.findById(notification._id).lean();
    assert.ok(stored, 'the alert is still persisted for the in-app history');
    assert.strictEqual(stored.type, 'TOKEN_APPROACHING');
    const userAfter = await User.findById(user._id).lean();
    assert.strictEqual(
      userAfter.fcmToken,
      deviceToken('unconfigured'),
      'an unconfigured provider must not discard a valid token'
    );
    pass('13. unconfigured provider never claims delivery and never discards a token');
  } catch (err) {
    fail('13. unconfigured provider never claims delivery and never discards a token', err);
  }

  // ── 14. Account isolation ──────────────────────────────────────────────
  try {
    const userA = await createUser({ fcmToken: deviceToken('user-a') });
    const userB = await createUser({ fcmToken: deviceToken('user-b') });

    const sent = [];
    const originalSend = fcmPushProvider.sendPush;
    fcmPushProvider.sendPush = async (args) => {
      sent.push(args.deviceToken);
      return { delivered: true, reason: null, invalidToken: false };
    };
    try {
      const suffix = `fcmtest_iso_${Date.now()}`;
      await notificationService.sendTokenNotification(
        { _id: new mongoose.Types.ObjectId(), userId: userA._id, tokenCode: 'QF-A' },
        'TOKEN_CALLED',
        { title: 'A', body: 'a', dedupeKey: `${suffix}_a` },
      );
      await notificationService.sendTokenNotification(
        { _id: new mongoose.Types.ObjectId(), userId: userB._id, tokenCode: 'QF-B' },
        'TOKEN_CALLED',
        { title: 'B', body: 'b', dedupeKey: `${suffix}_b` },
      );
    } finally {
      fcmPushProvider.sendPush = originalSend;
    }

    assert.deepStrictEqual(
      sent.sort(),
      [deviceToken('user-a'), deviceToken('user-b')],
      'each user is pushed to with their own token only'
    );
    assert.strictEqual(new Set(sent).size, 2, 'no token is shared between accounts');

    // A notification must be attached to its own owner and nobody else.
    const forA = await Notification.find({ userId: userA._id }).lean();
    assert.ok(forA.length > 0);
    assert.ok(forA.every((n) => String(n.userId) === String(userA._id)));
    pass('14. account isolation: each push uses only the recipient’s own token');
  } catch (err) {
    fail('14. account isolation: each push uses only the recipient’s own token', err);
  }

  // ── 15. Real queue triggers produce the three alert kinds ──────────────
  try {
    const center = await ServiceCenter.create({
      name: `FCM Trigger Center ${Date.now()}`,
      code: `FCMT${Date.now().toString().slice(-6)}`,
      address: { city: 'Test City', state: 'Test State', pincode: '000001' },
      type: 'GOVT',
      capacity: 50,
      capacityAlertThreshold: 80,
      isActive: true,
    });
    const service = await Service.create({
      centerId: center._id,
      name: `FCM Trigger Service ${Date.now()}`,
      tokenPrefix: `FC${Date.now().toString().slice(-1)}`,
      avgServiceTimeMinutes: 15,
      isActive: true,
    });
    const counter = await Counter.create({
      centerId: center._id,
      serviceId: service._id,
      name: `FCM Trigger Counter ${Date.now()}`,
      number: 3,
      displayLabel: 'Window 3',
      isActive: true,
    });

    let tokenSequence = 0;
    const waiting = async (status) => {
      const user = await createUser({ fcmToken: deviceToken(`trigger-${++tokenSequence}`) });
      const token = await Token.create({
        tokenCode: `FC${Date.now().toString().slice(-5)}-${tokenSequence}`,
        tokenNumber: tokenSequence,
        userId: user._id,
        centerId: center._id,
        serviceId: service._id,
        counterId: status === 'CALLED' ? counter._id : undefined,
        status,
        isActive: true,
      });
      return { user, token };
    };

    // 5 away
    const five = await waiting('WAITING');
    const fiveNotif = await notificationService.evaluateQueuePositionAlerts({
      token: five.token,
      position: 6,
      peopleAhead: 5,
      serviceName: service.name,
      centerName: center.name,
    });
    assert.ok(fiveNotif, 'a real five-away alert is generated');
    assert.strictEqual(fiveNotif.type, 'TOKEN_APPROACHING');
    assert.strictEqual(fiveNotif.dedupeKey, `${five.token._id}_5_TOKENS_AWAY`);
    assert.strictEqual(fiveNotif.metadata.peopleAhead, 5);

    // next in line
    const next = await waiting('WAITING');
    const nextNotif = await notificationService.evaluateQueuePositionAlerts({
      token: next.token,
      position: 1,
      peopleAhead: 0,
      serviceName: service.name,
      centerName: center.name,
    });
    assert.ok(nextNotif, 'a real next-in-line alert is generated');
    assert.strictEqual(nextNotif.dedupeKey, `${next.token._id}_NEXT_IN_LINE`);
    assert.strictEqual(nextNotif.metadata.isNext, true);

    // token called
    const called = await waiting('CALLED');
    const calledNotif = await notificationService.evaluateTokenCalledAlert({
      token: called.token,
      counter,
      serviceName: service.name,
      centerName: center.name,
    });
    assert.ok(calledNotif, 'a real token-called alert is generated');
    assert.strictEqual(calledNotif.type, 'TOKEN_CALLED');
    assert.ok(calledNotif.dedupeKey.startsWith(`${called.token._id}_TOKEN_CALLED_`));

    // A token that is not near the front produces nothing at all.
    const far = await waiting('WAITING');
    const farNotif = await notificationService.evaluateQueuePositionAlerts({
      token: far.token,
      position: 20,
      peopleAhead: 19,
    });
    assert.strictEqual(farNotif, null, 'no alert is fabricated for a token that is not close');

    pass('15. real queue triggers generate five-away, next-in-line and called');
  } catch (err) {
    fail('15. real queue triggers generate five-away, next-in-line and called', err);
  }

  // ── 16. Deduplication prevents a duplicate push ───────────────────────
  try {
    const user = await createUser({ fcmToken: deviceToken('dedupe') });
    const tokenDoc = { _id: new mongoose.Types.ObjectId(), userId: user._id, tokenCode: 'QF-DEDUPE' };
    const dedupeKey = `fcmtest_dedupe_${Date.now()}`;

    const sent = [];
    const originalSend = fcmPushProvider.sendPush;
    fcmPushProvider.sendPush = async (args) => {
      sent.push(args);
      return { delivered: true, reason: null, invalidToken: false };
    };
    let first;
    let second;
    try {
      first = await notificationService.sendTokenNotification(tokenDoc, 'TOKEN_APPROACHING', {
        title: '5 Tokens Away',
        body: 'a',
        dedupeKey,
      });
      second = await notificationService.sendTokenNotification(tokenDoc, 'TOKEN_APPROACHING', {
        title: '5 Tokens Away',
        body: 'a',
        dedupeKey,
      });
    } finally {
      fcmPushProvider.sendPush = originalSend;
    }

    assert.strictEqual(String(first._id), String(second._id), 'the same record is returned');
    assert.strictEqual(sent.length, 1, 'a repeated alert must not be pushed twice');
    const stored = await Notification.countDocuments({ dedupeKey });
    assert.strictEqual(stored, 1, 'exactly one notification exists for the dedupe key');
    pass('16. duplicate alerts are deduplicated before any push is sent');
  } catch (err) {
    fail('16. duplicate alerts are deduplicated before any push is sent', err);
  }

  // ── 17. No credential material in records, payloads, or source ─────────
  try {
    assert.ok(
      !SERVICE_SRC.includes('private_key'),
      'notificationService must not touch key material'
    );
    assert.ok(PROVIDER_SRC.includes("require('../utils/logger')"), 'the provider must log through the redacting logger');
    assert.ok(
      !/logger\.[a-z]+\([^)]*deviceToken/.test(PROVIDER_SRC),
      'the device token must never be passed to a logger'
    );
    assert.ok(
      !/logger\.[a-z]+\([^)]*\bparsed\b/.test(PROVIDER_SRC),
      'the parsed service account must never be logged'
    );

    const recent = await Notification.find({ type: { $in: ['TOKEN_CALLED', 'TOKEN_APPROACHING'] } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const serialised = JSON.stringify(recent);
    for (const forbidden of ['private_key', 'BEGIN PRIVATE KEY', 'service_account', 'client_email', 'fcmToken']) {
      assert.ok(!serialised.includes(forbidden), `notification records must not contain "${forbidden}"`);
    }
    pass('17. no credential material appears in records, payloads, or logs');
  } catch (err) {
    fail('17. no credential material appears in records, payloads, or logs', err);
  }

  // ── 18. Single notification system, no bypass of the provider ──────────
  try {
    // notificationService is the sole owner of notification creation; FCM is a
    // delivery step inside it, never a parallel path.
    const fcmDirectSends = (PROVIDER_SRC.match(/messaging\.send\(/g) || []).length;
    assert.strictEqual(fcmDirectSends, 1, 'the Firebase SDK is invoked in exactly one place');
    assert.ok(SERVICE_SRC.includes("require('../channels/fcmPushProvider')"));
    // Deduping happens before any channel is attempted.
    const dedupeIndex = SERVICE_SRC.indexOf('Database-backed deduplication check');
    const fcmIndex = SERVICE_SRC.indexOf('fcmPushProvider.sendPush');
    assert.ok(dedupeIndex > 0 && fcmIndex > dedupeIndex, 'deduplication must precede FCM delivery');
    pass('18. FCM is one delivery step inside the single notification service');
  } catch (err) {
    fail('18. FCM is one delivery step inside the single notification service', err);
  }

  console.log('\n============================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function createUser(overrides = {}) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  return User.create({
    name: `FCM Test User ${suffix}`,
    email: `fcmtest.${suffix}@queueflow.test`,
    phone: `9${String(Date.now()).slice(-9)}`,
    // A pre-hashed placeholder. The FCM suite never authenticates, so no
    // plaintext password or real hash is needed for notification ownership.
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwx',
    role: 'CUSTOMER',
    isActive: true,
    ...overrides,
  });
}

async function setup() {
  db = await connectDB();
}

async function teardown() {
  try {
    if (db) await db.close();
  } catch (_) {
    /* ignore */
  }
  clearFirebaseEnv();
}

setup()
  .then(runTests)
  .then(teardown)
  .then(() => process.exit(process.exitCode || 0))
  .catch(async (err) => {
    console.error('Fatal test error:', err);
    await teardown();
    process.exit(1);
  });

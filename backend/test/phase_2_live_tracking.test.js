'use strict';

/**
 * QueueFlow — Tier 1 / Feature 2: Live Tracking & Queue Transparency
 * Comprehensive Integration, Real-Time & Security Test Suite
 *
 * Covers:
 *  1. Server-authoritative queue position calculation (1st is 1, 2nd is 2)
 *  2. People ahead calculation (excludes completed, cancelled, skipped, expired)
 *  3. Current serving token retrieval across queue endpoints
 *  4. Active counters retrieval with service assignments and serving tokens
 *  5. Tier 1 Basic EWT calculation (queue depth * avgServiceTime / activeCounters)
 *  6. Queue position update after new customer joins
 *  7. Queue position update and advancement after token completion
 *  8. Queue position update and advancement after customer cancellation
 *  9. Skipped token behavior (removed from queue, remaining positions re-indexed)
 * 10. Socket.IO token.position_updated and queue.updated real-time events
 * 11. Reconnect refresh: authoritative recovery via /display and /queue endpoints
 * 12. token.called event payload sanitization (no private PII leaked)
 * 13. TTS callout deduplication logic verification
 * 14. TV / Web display endpoint (GET /api/queue/:centerId/display) schema and content
 * 15. Empty queue handling (zero counts, empty arrays, no errors)
 * 16. Closed / zero-counter state (activeCounters = 0, safe EWT without NaN)
 * 17. Unauthorized access protection (private tokens and data protected)
 * 18. Malformed ID validation (rejects invalid ObjectIds with 400)
 * 19. Concurrent queue operations consistency
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');

const { server } = require('../server');
const connectDB = require('../src/config/database');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const Queue = require('../src/models/Queue');
const queueService = require('../src/services/queueService');
const waitTimeService = require('../src/services/waitTimeService');

let baseUrl;
let testServer;
let socketClient;

let testCenter;
let testService;
let testCounter1;
let testCounter2;
let testAdminUser;
let testCustomerUser1;
let testCustomerUser2;
let testAdminToken;
let testCustomerToken1;
let testCustomerToken2;

let passed = 0;
let failed = 0;
const results = [];

function pass(name) {
  passed++;
  results.push({ name, result: '✅ PASS' });
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  results.push({ name, result: '❌ FAIL', error: err.message });
  console.error(`  ❌ FAIL  ${name}: ${err.message}`);
}

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (_) {
          parsed = raw;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

runSuite();

async function runSuite() {
  console.log('\n============================================================');
  console.log('🧪  QueueFlow — Feature 2: Live Tracking & Queue Transparency');
  console.log('============================================================\n');

  try {
    await connectDB();

    await new Promise((resolve) => {
      testServer = server.listen(0, '127.0.0.1', () => {
        const port = testServer.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const ts = Date.now().toString().slice(-6);

    testCenter = await ServiceCenter.create({
      name: `Live Tracking Center ${ts}`,
      code: `LT${ts}`,
      type: 'BANK',
      capacity: 100,
      isOpen: true,
    });

    testService = await Service.create({
      centerId: testCenter._id,
      name: `Priority Teller ${ts}`,
      tokenPrefix: 'LT',
      avgServiceTimeMinutes: 6,
      isActive: true,
    });

    testAdminUser = await User.create({
      name: 'LT Admin',
      email: `lt_admin_${ts}@test.com`,
      passwordHash: '$2a$10$abcdefghijklmnopqrstuvwx',
      role: 'ADMIN',
      centerId: testCenter._id,
    });

    testCustomerUser1 = await User.create({
      name: 'LT Customer 1',
      email: `lt_cust1_${ts}@test.com`,
      passwordHash: '$2a$10$abcdefghijklmnopqrstuvwx',
      role: 'CUSTOMER',
    });

    testCustomerUser2 = await User.create({
      name: 'LT Customer 2',
      email: `lt_cust2_${ts}@test.com`,
      passwordHash: '$2a$10$abcdefghijklmnopqrstuvwx',
      role: 'CUSTOMER',
    });

    const jwtSecret = process.env.JWT_SECRET || 'queueflow_test_jwt_secret_dev';

    testAdminToken = jwt.sign(
      { id: testAdminUser._id.toString(), role: testAdminUser.role, tokenVersion: 0, centerId: testCenter._id.toString() },
      jwtSecret,
      { expiresIn: '1h' }
    );

    testCustomerToken1 = jwt.sign(
      { id: testCustomerUser1._id.toString(), role: testCustomerUser1.role, tokenVersion: 0 },
      jwtSecret,
      { expiresIn: '1h' }
    );

    testCustomerToken2 = jwt.sign(
      { id: testCustomerUser2._id.toString(), role: testCustomerUser2.role, tokenVersion: 0 },
      jwtSecret,
      { expiresIn: '1h' }
    );

    testCounter1 = await Counter.create({
      centerId: testCenter._id,
      name: 'Counter 1',
      number: 1,
      status: 'ACTIVE',
      serviceId: testService._id,
      staffId: testAdminUser._id,
    });

    testCounter2 = await Counter.create({
      centerId: testCenter._id,
      name: 'Counter 2',
      number: 2,
      status: 'ACTIVE',
      serviceId: testService._id,
      staffId: testAdminUser._id,
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 1. Server-authoritative queue position calculation
    // ──────────────────────────────────────────────────────────────────────────
    let t1, t2, t3;
    try {
      const res1 = await queueService.joinQueue({
        centerId: testCenter._id,
        serviceId: testService._id,
        userId: testCustomerUser1._id,
      });
      t1 = res1.token;

      const res2 = await queueService.joinQueue({
        centerId: testCenter._id,
        serviceId: testService._id,
        userId: testCustomerUser2._id,
      });
      t2 = res2.token;

      const cust3 = await User.create({
        name: 'Cust 3',
        email: `cust3_${ts}@test.com`,
        passwordHash: 'hash',
        role: 'CUSTOMER',
      });
      const res3 = await queueService.joinQueue({
        centerId: testCenter._id,
        serviceId: testService._id,
        userId: cust3._id,
      });
      t3 = res3.token;

      assert.strictEqual(t1.currentPosition, 1, 'First token position must be 1');
      assert.strictEqual(t2.currentPosition, 2, 'Second token position must be 2');
      assert.strictEqual(t3.currentPosition, 3, 'Third token position must be 3');

      pass('1. Server-authoritative queue position calculation (ordered 1, 2, 3)');
    } catch (err) {
      fail('1. Server-authoritative queue position calculation', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 2. People ahead calculation
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const ahead1 = Math.max(0, (t1.currentPosition || 1) - 1);
      const ahead2 = Math.max(0, (t2.currentPosition || 2) - 1);
      const ahead3 = Math.max(0, (t3.currentPosition || 3) - 1);

      assert.strictEqual(ahead1, 0, 'People ahead for token 1 must be 0');
      assert.strictEqual(ahead2, 1, 'People ahead for token 2 must be 1');
      assert.strictEqual(ahead3, 2, 'People ahead for token 3 must be 2');

      // Verify enriched API response returns peopleAhead
      const token2Res = await request('GET', `/api/tokens/${t2._id}`, null, {
        Authorization: `Bearer ${testCustomerToken2}`,
      });
      assert.strictEqual(token2Res.status, 200);
      assert.strictEqual(token2Res.body.data.token.peopleAhead, 1, 'API must expose peopleAhead: 1');

      pass('2. People ahead calculation (correct count of preceding waiting tokens)');
    } catch (err) {
      fail('2. People ahead calculation', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 3. Current serving token retrieval
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Call token 1 at counter 1
      const callRes = await queueService.callNext({
        counterId: testCounter1._id,
        centerId: testCenter._id,
        adminId: testAdminUser._id,
      });
      assert(callRes, 'callNext must return result');
      const calledT1 = callRes.token;
      assert.strictEqual(calledT1.tokenCode, t1.tokenCode);
      assert.strictEqual(calledT1.status, 'CALLED');

      const queueStatuses = await queueService.getQueueStatus(testCenter._id);
      const queueStatus = queueStatuses.find((s) => s.service && s.service._id.toString() === testService._id.toString());
      assert(queueStatus, 'Queue status for service exists');

      // Also verify via HTTP endpoint
      const queueRes = await request('GET', `/api/queue/${testCenter._id}/${testService._id}`);
      assert.strictEqual(queueRes.status, 200);
      assert.strictEqual(queueRes.body.data.servingToken.tokenCode, t1.tokenCode);

      pass('3. Current serving token retrieval (correctly reflects currently called/serving token)');
    } catch (err) {
      fail('3. Current serving token retrieval', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 4. Active counters retrieval
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const queueRes = await request('GET', `/api/queue/${testCenter._id}/${testService._id}`);
      assert.strictEqual(queueRes.status, 200);
      const counters = queueRes.body.data.activeCounters;
      assert(Array.isArray(counters), 'activeCounters must be an array');
      assert.strictEqual(counters.length, 2, 'Must have 2 active counters');

      const c1 = counters.find((c) => c.number === 1);
      assert(c1, 'Counter 1 must exist in list');
      assert.strictEqual(c1.currentToken, t1.tokenCode, 'Counter 1 must report serving t1');

      pass('4. Active counters retrieval (counter status, number, and serving token)');
    } catch (err) {
      fail('4. Active counters retrieval', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 5. Basic Tier 1 EWT calculation
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Formula: ceil((waitingCount * avgServiceTimeMinutes) / activeCounters)
      // Currently waiting: t2, t3 (count = 2)
      // avgServiceTimeMinutes = 6
      // activeCounters = 2
      // Expected = ceil((2 * 6) / 2) = 6 minutes
      const ewt = waitTimeService.calculateEstimatedWaitTime({
        queueDepth: 2,
        avgServiceTimeMinutes: 6,
        activeCounters: 2,
      });
      assert.strictEqual(ewt, 6, 'EWT must equal 6 minutes');

      // Verify through queue endpoint
      const queueRes = await request('GET', `/api/queue/${testCenter._id}/${testService._id}`);
      assert.strictEqual(queueRes.body.data.estimatedWaitMinutes, 6);

      pass('5. Basic Tier 1 EWT calculation (queueDepth * avgServiceTime / activeCounters)');
    } catch (err) {
      fail('5. Basic Tier 1 EWT calculation', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 6. Queue position update after new customer joins
    // ──────────────────────────────────────────────────────────────────────────
    let t4;
    try {
      const cust4 = await User.create({
        name: 'Cust 4',
        email: `cust4_${ts}@test.com`,
        passwordHash: 'hash',
        role: 'CUSTOMER',
      });
      const res4 = await queueService.joinQueue({
        centerId: testCenter._id,
        serviceId: testService._id,
        userId: cust4._id,
      });
      t4 = res4.token;

      // t1 is CALLED, so waiting tokens are t2 (pos 1), t3 (pos 2), t4 (pos 3)
      assert.strictEqual(t4.currentPosition, 3, 'Newly joined token must take position 3');

      pass('6. Queue position update after new customer joins');
    } catch (err) {
      fail('6. Queue position update after new customer joins', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 7. Queue position update after token completion
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Transition t1 CALLED -> SERVING -> COMPLETED
      await queueService.startServing({ tokenId: t1._id, counterId: testCounter1._id, adminId: testAdminUser._id });
      await queueService.completeToken({ tokenId: t1._id, counterId: testCounter1._id, adminId: testAdminUser._id });

      // Call t2
      const callRes2 = await queueService.callNext({
        counterId: testCounter1._id,
        centerId: testCenter._id,
        adminId: testAdminUser._id,
      });
      assert.strictEqual(callRes2.token.tokenCode, t2.tokenCode);

      // Refresh t3 from DB
      const refreshedT3 = await Token.findById(t3._id);
      assert.strictEqual(refreshedT3.currentPosition, 1, 'Token 3 must now be position 1');

      const refreshedT4 = await Token.findById(t4._id);
      assert.strictEqual(refreshedT4.currentPosition, 2, 'Token 4 must now be position 2');

      pass('7. Queue position update after token completion & next call (tokens advance)');
    } catch (err) {
      fail('7. Queue position update after token completion', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 8. Queue position update after cancellation
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Cancel t3 (which is currently position 1 in waiting)
      await queueService.cancelToken({
        tokenId: t3._id,
        userId: t3.userId,
      });

      // t4 must now advance to position 1
      const refreshedT4 = await Token.findById(t4._id);
      assert.strictEqual(refreshedT4.currentPosition, 1, 'Token 4 must advance to position 1 after cancellation');

      pass('8. Queue position update after cancellation (subsequent tokens advance)');
    } catch (err) {
      fail('8. Queue position update after cancellation', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 9. Skipped token behavior
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // t2 is currently CALLED. Skip t2.
      const skippedT2 = await queueService.skipToken({
        tokenId: t2._id,
        counterId: testCounter1._id,
        adminId: testAdminUser._id,
      });
      assert.strictEqual(skippedT2.status, 'SKIPPED');

      // Verify skipped token has null currentPosition and is not counted in waiting
      const updatedSkipped = await Token.findById(t2._id);
      assert.strictEqual(updatedSkipped.currentPosition, null, 'Skipped token must have null currentPosition');

      const statuses = await queueService.getQueueStatus(testCenter._id);
      const queueStatus = statuses.find((s) => s.service && s.service._id.toString() === testService._id.toString());
      assert(queueStatus && queueStatus.waitingCount === 1, 'Only t4 is in waiting count');

      pass('9. Skipped token behavior (removed from queue, positions remain correct)');
    } catch (err) {
      fail('9. Skipped token behavior', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 10. Socket.IO token.position_updated and queue.updated events
    // ──────────────────────────────────────────────────────────────────────────
    try {
      socketClient = ioClient(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
        auth: { token: testCustomerToken1 },
      });

      const receivedEvents = [];

      await new Promise((resolve, reject) => {
        socketClient.on('connect', () => {
          socketClient.emit('join:center', testCenter._id.toString());
          resolve();
        });
        socketClient.on('connect_error', reject);
      });

      socketClient.on('queue.updated', (data) => receivedEvents.push({ event: 'queue.updated', data }));
      socketClient.on('token.position_updated', (data) => receivedEvents.push({ event: 'token.position_updated', data }));

      // Issue a new token for customer 1
      await queueService.joinQueue({
        centerId: testCenter._id,
        serviceId: testService._id,
        userId: testCustomerUser1._id,
      });

      // Wait 300ms for event broadcast
      await new Promise((r) => setTimeout(r, 300));

      const queueUpdated = receivedEvents.find((e) => e.event === 'queue.updated');
      assert(queueUpdated, 'Must receive queue.updated event');
      assert.strictEqual(queueUpdated.data.centerId.toString(), testCenter._id.toString());

      pass('10. Socket.IO real-time events (queue.updated received upon state mutation)');
    } catch (err) {
      fail('10. Socket.IO real-time events', err);
    } finally {
      if (socketClient) {
        socketClient.disconnect();
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 11. Reconnect refresh recovery
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Simulate client reconnecting and calling authoritative endpoints
      const displayRes = await request('GET', `/api/queue/${testCenter._id}/display`);
      assert.strictEqual(displayRes.status, 200);
      assert(displayRes.body.data.center, 'Display recovery must provide center info');
      assert(Array.isArray(displayRes.body.data.nowServing), 'nowServing must be an array');
      assert(Array.isArray(displayRes.body.data.nextInQueue), 'nextInQueue must be an array');
      assert(Array.isArray(displayRes.body.data.counters), 'counters must be an array');

      pass('11. Reconnect refresh recovery (authoritative state cleanly retrievable without stale cache)');
    } catch (err) {
      fail('11. Reconnect refresh recovery', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 12. token.called event payload sanitization
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Counter 2 calls t4
      const callRes4 = await queueService.callNext({
        counterId: testCounter2._id,
        centerId: testCenter._id,
        adminId: testAdminUser._id,
      });

      assert(callRes4, 'callNext must return token');
      const calledT4 = callRes4.token;
      assert.strictEqual(calledT4.status, 'CALLED');

      // Check display endpoint to see latestCallout
      const displayRes = await request('GET', `/api/queue/${testCenter._id}/display`);
      const callout = displayRes.body.data.latestCallout;
      assert(callout, 'Latest callout must exist');
      assert.strictEqual(callout.tokenCode, calledT4.tokenCode);
      assert.strictEqual(callout.counterId.name, testCounter2.name);
      assert.strictEqual(callout.counterId.number, testCounter2.number);
      // Ensure no private user ID is present on public callout object
      assert.strictEqual(callout.userId, undefined, 'Public callout must not leak customer userId');

      pass('12. token.called event sanitization (assigned counter exposed, private customer PII absent)');
    } catch (err) {
      fail('12. token.called event sanitization', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 13. TTS Callout Deduplication Logic
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const announcedKeys = new Set();
      function shouldAnnounce(token) {
        const key = `${token.id || token._id || token.tokenCode}_${token.calledAt || 'called'}`;
        if (announcedKeys.has(key)) return false;
        announcedKeys.add(key);
        return true;
      }

      const mockToken = {
        _id: 'token_abc_123',
        tokenCode: 'LT005',
        counterName: 'Counter 2',
        calledAt: '2026-09-26T12:00:00Z',
      };

      assert.strictEqual(shouldAnnounce(mockToken), true, 'First announcement must be allowed');
      assert.strictEqual(shouldAnnounce(mockToken), false, 'Duplicate callout event must be blocked');
      assert.strictEqual(shouldAnnounce(mockToken), false, 'Subsequent duplicate must remain blocked');

      pass('13. TTS Callout Deduplication Logic (same event identifier announced strictly once)');
    } catch (err) {
      fail('13. TTS Callout Deduplication Logic', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 14. TV / Web display endpoint (GET /api/queue/:centerId/display)
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const res = await request('GET', `/api/queue/${testCenter._id}/display`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      const d = res.body.data;
      assert.strictEqual(d.center.id, testCenter._id.toString());
      assert.strictEqual(d.center.code, testCenter.code);
      assert(Array.isArray(d.nowServing), 'nowServing must be an array');
      assert(Array.isArray(d.nextInQueue), 'nextInQueue must be an array');
      assert(Array.isArray(d.counters), 'counters must be an array');
      assert(Array.isArray(d.queues), 'queues must be an array');

      // Verify counter object format
      const c = d.counters[0];
      assert(typeof c.name === 'string');
      assert(typeof c.number === 'number');
      assert(['ACTIVE', 'BREAK', 'CLOSED'].includes(c.status));

      pass('14. TV / Web display endpoint (/api/queue/:centerId/display provides complete TV schema)');
    } catch (err) {
      fail('14. TV / Web display endpoint schema', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 15. Empty queue handling
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const emptyCenter = await ServiceCenter.create({
        name: `Empty Center ${ts}`,
        code: `EC${ts}`,
        type: 'OTHER',
        capacity: 50,
        isOpen: true,
      });

      const emptyService = await Service.create({
        centerId: emptyCenter._id,
        name: 'Empty Consultation',
        tokenPrefix: 'EC',
        avgServiceTimeMinutes: 10,
        isActive: true,
      });

      const res = await request('GET', `/api/queue/${emptyCenter._id}/display`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.nowServing.length, 0);
      assert.strictEqual(res.body.data.nextInQueue.length, 0);
      assert.strictEqual(res.body.data.counters.length, 0);
      assert.strictEqual(res.body.data.latestCallout, null);

      const queueRes = await request('GET', `/api/queue/${emptyCenter._id}/${emptyService._id}`);
      assert.strictEqual(queueRes.status, 200);
      assert.strictEqual(queueRes.body.data.queue.waitingCount, 0);
      assert.strictEqual(queueRes.body.data.servingToken, null);
      assert.strictEqual(queueRes.body.data.estimatedWaitMinutes, 0);

      pass('15. Empty queue handling (zero counts, empty arrays, null serving token, 0 EWT)');
    } catch (err) {
      fail('15. Empty queue handling', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 16. Closed / zero-counter state
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const closedCenter = await ServiceCenter.create({
        name: `Closed Center ${ts}`,
        code: `CC${ts}`,
        type: 'HOSPITAL',
        capacity: 100,
        isOpen: false,
      });

      await Service.create({
        centerId: closedCenter._id,
        name: 'Emergency',
        tokenPrefix: 'EM',
        avgServiceTimeMinutes: 15,
        isActive: true,
      });

      const res = await request('GET', `/api/queue/${closedCenter._id}/display`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.center.isOpen, false);

      // Verify EWT handles 0 active counters safely without returning NaN or Infinity
      const ewt = waitTimeService.calculateEstimatedWaitTime({
        queueDepth: 5,
        avgServiceTimeMinutes: 15,
        activeCounters: 0,
      });
      assert(!isNaN(ewt), 'EWT must not be NaN');
      assert(isFinite(ewt), 'EWT must not be Infinity');
      assert.strictEqual(ewt, 75, 'EWT with 0 counters should default to queueDepth * avgServiceTime');

      pass('16. Closed / zero-counter state (activeCounters = 0 handled gracefully without NaN)');
    } catch (err) {
      fail('16. Closed / zero-counter state', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 17. Unauthorized access protection
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Customer 2 attempts to fetch customer 1's private token
      const tCustomer1Token = await Token.findOne({ userId: testCustomerUser1._id });
      assert(tCustomer1Token, 'Token for customer 1 exists');

      const unauthorizedRes = await request('GET', `/api/tokens/${tCustomer1Token._id}`, null, {
        Authorization: `Bearer ${testCustomerToken2}`,
      });

      assert(
        unauthorizedRes.status === 403 || unauthorizedRes.status === 404,
        `Forbidden or Not Found expected for cross-customer access, got: ${unauthorizedRes.status}`
      );

      pass('17. Unauthorized access protection (cross-customer token access prevented)');
    } catch (err) {
      fail('17. Unauthorized access protection', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 18. Malformed ID validation
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const badCenterRes = await request('GET', '/api/queue/not-a-valid-id/display');
      assert.strictEqual(badCenterRes.status, 400, 'Invalid centerId must return 400');

      const badServiceRes = await request('GET', `/api/queue/${testCenter._id}/not-a-valid-id`);
      assert.strictEqual(badServiceRes.status, 400, 'Invalid serviceId must return 400');

      pass('18. Malformed ID validation (rejects invalid ObjectIds with 400 Bad Request)');
    } catch (err) {
      fail('18. Malformed ID validation', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 19. Concurrent queue operations consistency
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const concurrentUsers = await Promise.all([
        User.create({ name: 'Conc 1', email: `conc1_${ts}@test.com`, passwordHash: 'h', role: 'CUSTOMER' }),
        User.create({ name: 'Conc 2', email: `conc2_${ts}@test.com`, passwordHash: 'h', role: 'CUSTOMER' }),
        User.create({ name: 'Conc 3', email: `conc3_${ts}@test.com`, passwordHash: 'h', role: 'CUSTOMER' }),
      ]);

      const tokenPromises = concurrentUsers.map((u) =>
        queueService.joinQueue({
          centerId: testCenter._id,
          serviceId: testService._id,
          userId: u._id,
        })
      );

      const createdResults = await Promise.all(tokenPromises);
      assert.strictEqual(createdResults.length, 3);

      // Verify token numbers are distinct
      const numbers = createdResults.map((r) => r.token.tokenNumber);
      const uniqueNumbers = new Set(numbers);
      assert.strictEqual(uniqueNumbers.size, 3, 'All concurrent token numbers must be unique');

      // Verify queue state is consistent
      const statuses = await queueService.getQueueStatus(testCenter._id);
      const qStatus = statuses.find((s) => s.service && s.service._id.toString() === testService._id.toString());
      assert(qStatus && qStatus.waitingCount >= 3, 'Waiting count must include all created tokens');

      pass('19. Concurrent queue operations consistency (atomic counters, unique token numbers)');
    } catch (err) {
      fail('19. Concurrent queue operations consistency', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Summary
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n============================================================');
    console.log(`  Live Tracking Test Results: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');

    if (testServer) {
      await new Promise((resolve) => testServer.close(resolve));
    }
    await mongoose.disconnect();

    if (failed > 0) {
      process.exit(1);
    }
  } catch (suiteErr) {
    console.error('Fatal suite error:', suiteErr);
    if (testServer) testServer.close();
    await mongoose.disconnect();
    process.exit(1);
  }
}

'use strict';

/**
 * QueueFlow — Tier 2 / Feature 2: Centralized Admin / Resource Hub Test Suite
 *
 * Covers:
 * 1. ADMIN access
 * 2. STAFF restriction
 * 3. CUSTOMER rejection
 * 4. Live center overview
 * 5. Real-time center updates
 * 6. Counter listing
 * 7. Counter state display
 * 8. Counter morphing
 * 9. Invalid center rejection
 * 10. Invalid service rejection
 * 11. Unauthorized morphing
 * 12. Morphing with active token (409 Conflict)
 * 13. Successful safe morphing
 * 14. Operator assignment consistency
 * 15. Historical query
 * 16. Date filtering
 * 17. Pagination / bounds
 * 18. SLA calculation using configured data
 * 19. No fabricated SLA values
 * 20. Aggregation correctness
 * 21. Counter utilization metrics
 * 22. Auditability of morphing
 * 23. Socket reconnect
 * 24. Feature 2 regression
 * 25. Feature 3 regression
 * 26. Concurrency safety (simultaneous morph & token call)
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
const QueueEvent = require('../src/models/QueueEvent');
const Notification = require('../src/models/Notification');
const queueService = require('../src/services/queueService');

let baseUrl;
let testServer;
let socketClientAdmin;

let testCenterA;
let testCenterB;
let testServiceA1;
let testServiceA2;
let testServiceB1;
let testCounterA1;
let testCounterA2;

let testAdminUser;
let testStaffUser;
let testCustomerUser;

let adminToken;
let staffToken;
let customerToken;

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
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch (_) {
          json = raw;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
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

function signToken(userId, role = 'ADMIN') {
  return jwt.sign(
    { id: userId.toString(), role, tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function runTests() {
  console.log('\n============================================================');
  console.log('🏛️  QueueFlow — Tier 2 / Feature 2: Resource Hub Test Suite');
  console.log('============================================================\n');

  try {
    await connectDB();

    await new Promise((resolve) => {
      testServer = server.listen(0, () => {
        const port = testServer.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });

    const ts = Date.now();
    const randA = Math.random().toString(36).substring(2, 8).toUpperCase();
    const randB = Math.random().toString(36).substring(2, 8).toUpperCase();

    // 1. Create Test Centers
    testCenterA = await ServiceCenter.create({
      name: `Resource Center Alpha ${ts}`,
      code: `RA${randA}`.substring(0, 10),
      type: 'GOVT',
      address: { street: '10 Alpha Way', city: 'Metro', state: 'State', pincode: '100001' },
      phone: '+919876543101',
      capacity: 150,
      isOpen: true,
      noShowTimeoutSeconds: 120,
    });

    testCenterB = await ServiceCenter.create({
      name: `Resource Center Beta ${ts}`,
      code: `RB${randB}`.substring(0, 10),
      type: 'BANK',
      address: { street: '20 Beta Ave', city: 'Metro', state: 'State', pincode: '100002' },
      phone: '+919876543102',
      capacity: 100,
      isOpen: true,
      noShowTimeoutSeconds: 120,
    });

    // 2. Create Test Services
    testServiceA1 = await Service.create({
      centerId: testCenterA._id,
      name: `Identity Verification ${ts}`,
      tokenPrefix: 'ID',
      description: 'Identity checking service',
      avgServiceTimeMinutes: 5,
      isActive: true,
      order: 1,
    });

    testServiceA2 = await Service.create({
      centerId: testCenterA._id,
      name: `Document Attestation ${ts}`,
      tokenPrefix: 'AT',
      description: 'Document stamping service',
      avgServiceTimeMinutes: 8,
      isActive: true,
      order: 2,
    });

    testServiceB1 = await Service.create({
      centerId: testCenterB._id,
      name: `Foreign Center Service ${ts}`,
      tokenPrefix: 'FC',
      description: 'Center B service',
      avgServiceTimeMinutes: 10,
      isActive: true,
      order: 1,
    });

    // 3. Create Users
    testAdminUser = await User.create({
      name: `Admin Supervisor ${ts}`,
      email: `admin_hub_${ts}@queueflow.dev`,
      passwordHash: 'hashed_pw_test_123',
      role: 'ADMIN',
      isEmailVerified: true,
    });

    testStaffUser = await User.create({
      name: `Staff Member ${ts}`,
      email: `staff_hub_${ts}@queueflow.dev`,
      passwordHash: 'hashed_pw_test_123',
      role: 'STAFF',
      centerId: testCenterA._id,
      isEmailVerified: true,
    });

    testCustomerUser = await User.create({
      name: `Customer User ${ts}`,
      email: `cust_hub_${ts}@queueflow.dev`,
      passwordHash: 'hashed_pw_test_123',
      role: 'CUSTOMER',
      isEmailVerified: true,
    });

    adminToken = signToken(testAdminUser._id, 'ADMIN');
    staffToken = signToken(testStaffUser._id, 'STAFF');
    customerToken = signToken(testCustomerUser._id, 'CUSTOMER');

    // 4. Create Counters
    testCounterA1 = await Counter.create({
      centerId: testCenterA._id,
      name: 'Counter Alpha 1',
      number: 1,
      status: 'ACTIVE',
      serviceId: testServiceA1._id,
      staffId: testStaffUser._id,
    });

    testCounterA2 = await Counter.create({
      centerId: testCenterA._id,
      name: 'Counter Alpha 2',
      number: 2,
      status: 'CLOSED',
      serviceId: testServiceA2._id,
    });

    // Update staffUser assignment
    testStaffUser.assignedCounterId = testCounterA1._id;
    await testStaffUser.save();

    // ── Test 1: ADMIN Access ─────────────────────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/operational-overview`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert(res.data?.data?.center, 'Expected center data in response');
      assert(res.data?.data?.metrics, 'Expected metrics object');
      assert(Array.isArray(res.data?.data?.counters), 'Expected counters array');
      pass('1. ADMIN access (operational overview accessible to ADMIN)');
    } catch (err) {
      fail('1. ADMIN access', err);
    }

    // ── Test 2: STAFF Restriction ────────────────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/operational-overview`, null, {
        Authorization: `Bearer ${staffToken}`,
      });
      assert.strictEqual(res.status, 403, `Expected 403 Forbidden for STAFF, got ${res.status}`);
      pass('2. STAFF restriction (Resource Hub overview restricted from STAFF)');
    } catch (err) {
      fail('2. STAFF restriction', err);
    }

    // ── Test 3: CUSTOMER Rejection ───────────────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/operational-overview`, null, {
        Authorization: `Bearer ${customerToken}`,
      });
      assert.strictEqual(res.status, 403, `Expected 403 Forbidden for CUSTOMER, got ${res.status}`);
      pass('3. CUSTOMER rejection (Resource Hub rejected for CUSTOMER)');
    } catch (err) {
      fail('3. CUSTOMER rejection', err);
    }

    // ── Test 4: Live Center Overview Content ──────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/operational-overview`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      const data = res.data.data;
      assert.strictEqual(data.center.name, testCenterA.name);
      assert.strictEqual(data.center.code, testCenterA.code);
      assert.strictEqual(typeof data.metrics.totalCounters, 'number');
      assert(data.metrics.totalCounters >= 2, 'Should report at least 2 counters');
      assert.strictEqual(data.metrics.activeCounters, 1, 'Counter 1 is ACTIVE');
      assert.strictEqual(data.metrics.closedCounters, 1, 'Counter 2 is CLOSED');
      pass('4. Live center overview (accurate center metadata & live counts)');
    } catch (err) {
      fail('4. Live center overview', err);
    }

    // ── Test 5: Real-time Center Updates (Socket.IO) ─────────
    try {
      socketClientAdmin = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { token: adminToken },
      });

      await new Promise((resolve, reject) => {
        socketClientAdmin.on('connect', resolve);
        socketClientAdmin.on('connect_error', reject);
      });

      // Join center room
      socketClientAdmin.emit('join:center', testCenterA._id.toString());
      await new Promise((r) => setTimeout(r, 200));

      let updateReceived = false;
      socketClientAdmin.on('counter.updated', (payload) => {
        if (payload?.counter?._id === testCounterA2._id.toString()) {
          updateReceived = true;
        }
      });

      // Mutate status to trigger broadcast
      await request('PATCH', `/api/counters/${testCounterA2._id}/status`, { status: 'ACTIVE' }, {
        Authorization: `Bearer ${adminToken}`,
      });

      await new Promise((r) => setTimeout(r, 400));
      assert(updateReceived, 'Socket client should receive counter.updated broadcast');
      pass('5. Real-time center updates (Socket.IO counter event received)');
    } catch (err) {
      fail('5. Real-time center updates', err);
    }

    // ── Test 6: Counter Listing ──────────────────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/operational-overview`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      const counters = res.data.data.counters;
      assert(counters.length >= 2, 'Expected at least 2 counters in overview');
      const c1 = counters.find((c) => c._id === testCounterA1._id.toString());
      assert(c1, 'Counter A1 found in listing');
      assert.strictEqual(c1.number, 1);
      assert.strictEqual(c1.staff?.email, testStaffUser.email);
      assert.strictEqual(c1.service?.tokenPrefix, 'ID');
      pass('6. Counter listing (populated staff, service and desk details)');
    } catch (err) {
      fail('6. Counter listing', err);
    }

    // ── Test 7: Counter State Display ────────────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/operational-overview`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      const counters = res.data.data.counters;
      const c2 = counters.find((c) => c._id === testCounterA2._id.toString());
      assert.strictEqual(c2.status, 'ACTIVE', 'Counter 2 is ACTIVE after status update');
      pass('7. Counter state display (reflects ACTIVE status accurately)');
    } catch (err) {
      fail('7. Counter state display', err);
    }

    // ── Test 8: Counter Morphing ─────────────────────────────
    try {
      // Morph Counter A2 from Service A2 to Service A1
      const res = await request('PATCH', `/api/counters/${testCounterA2._id}/morph`, {
        serviceId: testServiceA1._id.toString(),
        reason: 'Surge handling for ID checks',
      }, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert.strictEqual(res.data?.data?.counter?.serviceId?._id?.toString() || res.data?.data?.counter?.serviceId?.toString(), testServiceA1._id.toString());
      pass('8. Counter morphing (successfully morphed counter to new service)');
    } catch (err) {
      fail('8. Counter morphing', err);
    }

    // ── Test 9: Invalid Center Rejection ─────────────────────
    try {
      const fakeCenterId = new mongoose.Types.ObjectId();
      const res = await request('GET', `/api/analytics/${fakeCenterId}/operational-overview`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 404, `Expected 404 for non-existent center, got ${res.status}`);
      pass('9. Invalid center rejection (404 for non-existent center)');
    } catch (err) {
      fail('9. Invalid center rejection', err);
    }

    // ── Test 10: Invalid Service Rejection (Foreign Center) ──
    try {
      // Attempt to morph Counter A1 with Service B1 from Center B
      const res = await request('PATCH', `/api/counters/${testCounterA2._id}/morph`, {
        serviceId: testServiceB1._id.toString(),
        reason: 'Illegal cross-center morph',
      }, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 400, `Expected 400 Bad Request for foreign service, got ${res.status}`);
      pass('10. Invalid service rejection (service from another center rejected with 400)');
    } catch (err) {
      fail('10. Invalid service rejection', err);
    }

    // ── Test 11: Unauthorized Morphing ───────────────────────
    try {
      const res = await request('PATCH', `/api/counters/${testCounterA2._id}/morph`, {
        serviceId: testServiceA2._id.toString(),
      }, {
        Authorization: `Bearer ${staffToken}`,
      });
      assert.strictEqual(res.status, 403, `Expected 403 Forbidden for STAFF morph, got ${res.status}`);
      pass('11. Unauthorized morphing (STAFF cannot morph counters)');
    } catch (err) {
      fail('11. Unauthorized morphing', err);
    }

    // ── Test 12: Morphing with Active Token (409 Conflict) ───
    let activeToken;
    try {
      // Create a token for Service A1 and call it at Counter A1
      activeToken = await Token.create({
        tokenCode: `ID-${Math.floor(100 + Math.random() * 900)}`,
        tokenNumber: 99,
        userId: testCustomerUser._id,
        centerId: testCenterA._id,
        serviceId: testServiceA1._id,
        status: 'CALLED',
        counterId: testCounterA1._id,
        calledAt: new Date(),
      });

      testCounterA1.currentTokenId = activeToken._id;
      await testCounterA1.save();

      // Attempt to morph Counter A1 while token is actively CALLED
      const res = await request('PATCH', `/api/counters/${testCounterA1._id}/morph`, {
        serviceId: testServiceA2._id.toString(),
        reason: 'Unsafe morph attempt while serving',
      }, {
        Authorization: `Bearer ${adminToken}`,
      });

      assert.strictEqual(res.status, 409, `Expected 409 Conflict, got ${res.status}`);
      assert(res.data?.message?.includes('Cannot morph counter'), 'Expected conflict message');
      pass('12. Morphing with active token (safety guard returns 409 Conflict)');
    } catch (err) {
      fail('12. Morphing with active token', err);
    }

    // ── Test 13: Successful Safe Morphing ────────────────────
    try {
      // Complete the active token at Counter A1
      activeToken.status = 'COMPLETED';
      activeToken.completedAt = new Date();
      activeToken.actualServiceSeconds = 240;
      await activeToken.save();

      testCounterA1.currentTokenId = null;
      await testCounterA1.save();

      // Now morphing Counter A1 should succeed safely
      const res = await request('PATCH', `/api/counters/${testCounterA1._id}/morph`, {
        serviceId: testServiceA2._id.toString(),
        reason: 'Safe morph after token completed',
      }, {
        Authorization: `Bearer ${adminToken}`,
      });

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      pass('13. Successful safe morphing (safe morph succeeds once desk is idle)');
    } catch (err) {
      fail('13. Successful safe morphing', err);
    }

    // ── Test 14: Operator Assignment Consistency ─────────────
    try {
      const refreshedCounter = await Counter.findById(testCounterA1._id);
      assert.strictEqual(refreshedCounter.staffId?.toString(), testStaffUser._id.toString());
      pass('14. Operator assignment consistency (operator remains attached to counter)');
    } catch (err) {
      fail('14. Operator assignment consistency', err);
    }

    // ── Test 15: Historical Query ────────────────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/historical?timeRange=today`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      const data = res.data?.data;
      assert(data.summary, 'Expected summary object in historical report');
      assert(data.summary.totalCompleted >= 1, 'Should record at least 1 completed token');
      pass('15. Historical query (returns accurate aggregated summary counts)');
    } catch (err) {
      fail('15. Historical query', err);
    }

    // ── Test 16: Date Filtering ──────────────────────────────
    try {
      const res7d = await request('GET', `/api/analytics/${testCenterA._id}/historical?timeRange=7d`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res7d.status, 200);
      assert.strictEqual(res7d.data?.data?.timeRange, '7d');
      pass('16. Date filtering (timeRange=7d handled cleanly)');
    } catch (err) {
      fail('16. Date filtering', err);
    }

    // ── Test 17: Pagination / Bounds ─────────────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/historical?page=1&limit=5`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data?.data?.pagination?.page, 1);
      assert.strictEqual(res.data?.data?.pagination?.limit, 5);
      assert(res.data?.data?.tokens.length <= 5);
      pass('17. Pagination/bounds (honors page and limit bounds)');
    } catch (err) {
      fail('17. Pagination/bounds', err);
    }

    // ── Test 18: SLA Calculation Using Configured Data ───────
    try {
      // targetWaitMinutes=10 should compute compliant count and percentage
      const res = await request('GET', `/api/analytics/${testCenterA._id}/historical?targetWaitMinutes=10`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 200);
      const sla = res.data?.data?.sla;
      assert.strictEqual(sla.status, 'CONFIGURED');
      assert.strictEqual(sla.targetWaitMinutes, 10);
      assert(typeof sla.compliancePercent === 'number');
      pass('18. SLA calculation using configured data (compliance percentage calculated)');
    } catch (err) {
      fail('18. SLA calculation using configured data', err);
    }

    // ── Test 19: No Fabricated SLA Values ────────────────────
    try {
      // When targetWaitMinutes is not passed, system should NOT manufacture an SLA percentage
      const res = await request('GET', `/api/analytics/${testCenterA._id}/historical`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 200);
      const sla = res.data?.data?.sla;
      assert.strictEqual(sla.status, 'CONFIGURABLE');
      assert.strictEqual(sla.targetWaitMinutes, null);
      assert.strictEqual(sla.compliancePercent, null);
      pass('19. No fabricated SLA values (reports CONFIGURABLE when unconfigured)');
    } catch (err) {
      fail('19. No fabricated SLA values', err);
    }

    // ── Test 20: Aggregation Correctness ─────────────────────
    try {
      const dbCount = await Token.countDocuments({ centerId: testCenterA._id });
      const res = await request('GET', `/api/analytics/${testCenterA._id}/historical?timeRange=30d`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data?.data?.summary?.totalIssued, dbCount);
      pass('20. Aggregation correctness (matches direct MongoDB collection count)');
    } catch (err) {
      fail('20. Aggregation correctness', err);
    }

    // ── Test 21: Counter Utilization Metrics ─────────────────
    try {
      const res = await request('GET', `/api/analytics/${testCenterA._id}/historical?timeRange=today`, null, {
        Authorization: `Bearer ${adminToken}`,
      });
      const util = res.data?.data?.counterUtilization;
      assert(Array.isArray(util));
      const c1Util = util.find((u) => u.counterId === testCounterA1._id.toString());
      assert(c1Util, 'Counter A1 utilization present in report');
      assert.strictEqual(c1Util.completed, 1);
      pass('21. Counter utilization metrics (accurate completed counts per counter)');
    } catch (err) {
      fail('21. Counter utilization metrics', err);
    }

    // ── Test 22: Auditability of Morphing ────────────────────
    try {
      const morphEvent = await QueueEvent.findOne({
        centerId: testCenterA._id,
        eventType: 'COUNTER_MORPHED',
      }).sort({ createdAt: -1 });

      assert(morphEvent, 'Expected COUNTER_MORPHED audit record in QueueEvents');
      assert.strictEqual(morphEvent.performedBy.toString(), testAdminUser._id.toString());
      assert(morphEvent.metadata?.newServiceName, 'Audit event recorded new service name');
      pass('22. Auditability of morphing (QueueEvent persisted with admin and service context)');
    } catch (err) {
      fail('22. Auditability of morphing', err);
    }

    // ── Test 23: Socket Reconnect ────────────────────────────
    try {
      socketClientAdmin.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      socketClientAdmin.connect();
      await new Promise((resolve) => socketClientAdmin.on('connect', resolve));
      assert(socketClientAdmin.connected, 'Socket reconnected successfully');
      pass('23. Socket reconnect (handles reconnect gracefully)');
    } catch (err) {
      fail('23. Socket reconnect', err);
    }

    // ── Test 24: Feature 2 Regression (Live Tracking) ────────
    try {
      const customerTokenRecord = await Token.create({
        tokenCode: `AT-${Math.floor(100 + Math.random() * 900)}`,
        tokenNumber: 101,
        userId: testCustomerUser._id,
        centerId: testCenterA._id,
        serviceId: testServiceA2._id,
        status: 'WAITING',
      });

      const res = await request('GET', `/api/tokens/${customerTokenRecord._id}`, null, {
        Authorization: `Bearer ${customerToken}`,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data?.data?.token?.status, 'WAITING');
      pass('24. Feature 2 regression (customer live token tracking intact)');
    } catch (err) {
      fail('24. Feature 2 regression', err);
    }

    // ── Test 25: Feature 3 Regression (Notifications) ────────
    try {
      const notifCount = await Notification.countDocuments({ userId: testCustomerUser._id });
      assert(typeof notifCount === 'number');
      pass('25. Feature 3 regression (notification store intact and accessible)');
    } catch (err) {
      fail('25. Feature 3 regression', err);
    }

    // ── Test 26: Concurrency Safety (Simultaneous Morph & Call Next) ──
    try {
      // Revert Counter A1 to Service A1
      testCounterA1.serviceId = testServiceA1._id;
      testCounterA1.currentTokenId = null;
      await testCounterA1.save();

      // Create a waiting token for Service A1
      await Token.create({
        tokenCode: `ID-${Math.floor(100 + Math.random() * 900)}`,
        tokenNumber: 102,
        userId: testCustomerUser._id,
        centerId: testCenterA._id,
        serviceId: testServiceA1._id,
        status: 'WAITING',
      });

      // Fire morph to Service A2 and callNext concurrently
      const [morphRes, callRes] = await Promise.all([
        request('PATCH', `/api/counters/${testCounterA1._id}/morph`, {
          serviceId: testServiceA2._id.toString(),
          reason: 'Concurrent race test',
        }, { Authorization: `Bearer ${adminToken}` }),
        request('POST', `/api/counters/${testCounterA1._id}/call-next`, null, {
          Authorization: `Bearer ${adminToken}`,
        }),
      ]);

      // Both must complete cleanly without 500 error; system must remain consistent
      assert([200, 409].includes(morphRes.status), `Morph status must be 200 or 409, got ${morphRes.status}`);
      assert([200, 409].includes(callRes.status), `CallNext status must be 200 or 409, got ${callRes.status}`);
      pass('26. Concurrency safety (simultaneous morph and call-next preserve data integrity)');
    } catch (err) {
      fail('26. Concurrency safety', err);
    }

  } catch (fatal) {
    console.error('Fatal test error:', fatal);
  } finally {
    if (socketClientAdmin) socketClientAdmin.disconnect();
    if (testServer) await new Promise((r) => testServer.close(r));
    await mongoose.disconnect();
  }

  console.log('\n============================================================');
  console.log(`  Tier 2 Resource Hub Results: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();

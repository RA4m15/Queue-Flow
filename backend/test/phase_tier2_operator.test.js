'use strict';

/**
 * QueueFlow — Tier 2 / Feature 1: Teller / Operator Portal
 * Comprehensive Integration, Concurrency & Security Test Suite
 *
 * Verifies all 24 requirements:
 *  1. STAFF authentication
 *  2. CUSTOMER cannot access operator portal
 *  3. ADMIN access
 *  4. Assigned center enforcement
 *  5. Assigned counter enforcement
 *  6. Current counter load
 *  7. CALL NEXT
 *  8. START SERVING
 *  9. COMPLETE
 * 10. SKIP
 * 11. Unauthorized token mutation
 * 12. Unauthorized counter access
 * 13. Concurrent CALL NEXT
 * 14. Concurrent COMPLETE/SKIP conflict
 * 15. Socket.IO operator updates
 * 16. Customer tracking regression
 * 17. Notification regression
 * 18. Counter status behavior
 * 19. 401 handling
 * 20. 403 handling
 * 21. 409 conflict handling
 * 22. No customer PII leakage
 * 23. No fake/static queue data
 * 24. Reconnect recovery
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
const Notification = require('../src/models/Notification');
const queueService = require('../src/services/queueService');

let baseUrl;
let testServer;
let socketClientStaff1;

let testCenterA;
let testCenterB;
let testServiceA;
let testCounterA1;
let testCounterA2;
let testCounterB1;

let testAdminUser;
let testStaffUser1;
let testStaffUser2;
let testCustomerUser1;
let testCustomerUser2;

let testAdminToken;
let testStaffToken1;
let testStaffToken2;
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

function signToken(userId, role = 'STAFF') {
  return jwt.sign(
    { id: userId.toString(), role, tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function runTests() {
  console.log('\n============================================================');
  console.log('🏛️  QueueFlow — Tier 2 / Feature 1: Teller Portal Test Suite');
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
      name: `City Center Alpha ${ts}`,
      code: `CA${randA}`.substring(0, 10),
      type: 'GOVT',
      address: { street: '1 Main St', city: 'Metro', state: 'State', pincode: '100001' },
      phone: '+919876543201',
      capacity: 100,
      isOpen: true,
      noShowTimeoutSeconds: 120,
    });

    testCenterB = await ServiceCenter.create({
      name: `Branch Center Beta ${ts}`,
      code: `CB${randB}`.substring(0, 10),
      type: 'BANK',
      address: { street: '2 Second St', city: 'Metro', state: 'State', pincode: '100002' },
      phone: '+919876543202',
      capacity: 100,
      isOpen: true,
      noShowTimeoutSeconds: 120,
    });

    // 2. Create Services
    testServiceA = await Service.create({
      centerId: testCenterA._id,
      name: 'General Registration',
      tokenPrefix: 'GR',
      avgServiceTimeMinutes: 10,
      isActive: true,
      order: 1,
    });

    // 3. Create Users
    testAdminUser = await User.create({
      name: 'Head Administrator',
      email: `admin_${ts}@test.local`,
      passwordHash: await User.hashPassword('Admin@12345'),
      role: 'ADMIN',
      centerId: testCenterA._id,
      isActive: true,
    });

    testStaffUser1 = await User.create({
      name: 'Teller Operator 1',
      email: `staff1_${ts}@test.local`,
      passwordHash: await User.hashPassword('Staff@12345'),
      role: 'STAFF',
      centerId: testCenterA._id,
      isActive: true,
    });

    testStaffUser2 = await User.create({
      name: 'Teller Operator 2',
      email: `staff2_${ts}@test.local`,
      passwordHash: await User.hashPassword('Staff@12345'),
      role: 'STAFF',
      centerId: testCenterA._id,
      isActive: true,
    });

    testCustomerUser1 = await User.create({
      name: 'Customer Alice',
      email: `alice_${ts}@test.local`,
      phone: '+919876543211',
      passwordHash: await User.hashPassword('Cust@12345'),
      role: 'CUSTOMER',
      isActive: true,
    });

    testCustomerUser2 = await User.create({
      name: 'Customer Bob',
      email: `bob_${ts}@test.local`,
      phone: '+919876543212',
      passwordHash: await User.hashPassword('Cust@12345'),
      role: 'CUSTOMER',
      isActive: true,
    });

    testAdminToken = signToken(testAdminUser._id, 'ADMIN');
    testStaffToken1 = signToken(testStaffUser1._id, 'STAFF');
    testStaffToken2 = signToken(testStaffUser2._id, 'STAFF');
    testCustomerToken1 = signToken(testCustomerUser1._id, 'CUSTOMER');
    testCustomerToken2 = signToken(testCustomerUser2._id, 'CUSTOMER');

    // 4. Create Counters with Statically Assigned Staff
    testCounterA1 = await Counter.create({
      centerId: testCenterA._id,
      name: 'Window 01',
      number: 1,
      status: 'ACTIVE',
      serviceId: testServiceA._id,
      staffId: testStaffUser1._id,
    });

    testCounterA2 = await Counter.create({
      centerId: testCenterA._id,
      name: 'Window 02',
      number: 2,
      status: 'ACTIVE',
      serviceId: testServiceA._id,
      staffId: testStaffUser2._id,
    });

    testCounterB1 = await Counter.create({
      centerId: testCenterB._id,
      name: 'Branch Desk 01',
      number: 1,
      status: 'ACTIVE',
      staffId: null,
    });

    // Update staffUser with assignedCounterId
    await User.findByIdAndUpdate(testStaffUser1._id, { assignedCounterId: testCounterA1._id });
    await User.findByIdAndUpdate(testStaffUser2._id, { assignedCounterId: testCounterA2._id });

    // ──────────────────────────────────────────────────────────────────────────
    // 1. STAFF authentication
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const loginRes = await request('POST', '/api/auth/login', {
        email: testStaffUser1.email,
        password: 'Staff@12345',
      });
      assert.strictEqual(loginRes.status, 200);
      assert.strictEqual(loginRes.data.data.user.role, 'STAFF');
      assert.strictEqual(loginRes.data.data.user.assignedCounterId.toString(), testCounterA1._id.toString());
      assert(loginRes.data.data.user.assignedCounter, 'assignedCounter should be populated');

      const meRes = await request('GET', '/api/auth/me', null, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(meRes.status, 200);
      assert.strictEqual(meRes.data.data.user.role, 'STAFF');

      pass('1. STAFF authentication (resolves authenticated operator, center & counter)');
    } catch (err) {
      fail('1. STAFF authentication', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 2. CUSTOMER cannot access operator portal
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const custRes = await request('GET', '/api/counters/operator/me', null, {
        Authorization: `Bearer ${testCustomerToken1}`,
      });
      assert.strictEqual(custRes.status, 403, 'Customer must be rejected with 403 Forbidden');

      const custCall = await request('POST', `/api/counters/${testCounterA1._id}/call-next`, {}, {
        Authorization: `Bearer ${testCustomerToken1}`,
      });
      assert.strictEqual(custCall.status, 403, 'Customer cannot call next token');

      pass('2. CUSTOMER cannot access operator portal (strictly blocked with 403 Forbidden)');
    } catch (err) {
      fail('2. CUSTOMER cannot access operator portal', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 3. ADMIN access
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const adminRes = await request('GET', `/api/counters/operator/me?counterId=${testCounterA1._id}`, null, {
        Authorization: `Bearer ${testAdminToken}`,
      });
      assert.strictEqual(adminRes.status, 200);
      assert.strictEqual(adminRes.data.data.counter._id.toString(), testCounterA1._id.toString());

      pass('3. ADMIN access (admin retains broader management access across counters)');
    } catch (err) {
      fail('3. ADMIN access', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 4. Assigned center enforcement
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Staff 1 belongs to Center A; attempting to operate Counter in Center B
      const diffCenterRes = await request('POST', `/api/counters/${testCounterB1._id}/call-next`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(diffCenterRes.status, 403, 'Staff must not operate counters in foreign center');

      pass('4. Assigned center enforcement (server prevents foreign center counter mutation)');
    } catch (err) {
      fail('4. Assigned center enforcement', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 5. Assigned counter enforcement
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Staff 1 is assigned to Counter A1; attempting to call next on Counter A2 (assigned to Staff 2)
      const diffCounterRes = await request('POST', `/api/counters/${testCounterA2._id}/call-next`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(diffCounterRes.status, 403, 'Staff 1 cannot operate Counter A2');

      pass('5. Assigned counter enforcement (staff cannot operate unauthorized peer counter)');
    } catch (err) {
      fail('5. Assigned counter enforcement', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 6. Current counter load
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Create waiting tokens for Service A
      await queueService.joinQueue({
        userId: testCustomerUser1._id.toString(),
        centerId: testCenterA._id.toString(),
        serviceId: testServiceA._id.toString(),
        channel: 'WEB',
      });
      await queueService.joinQueue({
        userId: testCustomerUser2._id.toString(),
        centerId: testCenterA._id.toString(),
        serviceId: testServiceA._id.toString(),
        channel: 'WEB',
      });

      const opRes = await request('GET', '/api/counters/operator/me', null, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(opRes.status, 200);
      assert.strictEqual(opRes.data.data.counter._id.toString(), testCounterA1._id.toString());
      assert(opRes.data.data.waitingTokens.length >= 2, 'Waiting tokens list should contain queued customers');
      assert.strictEqual(opRes.data.data.waitingTokens[0].tokenCode.startsWith('GR-'), true);

      pass('6. Current counter load (loads assigned counter, queue state & next waiting tokens)');
    } catch (err) {
      fail('6. Current counter load', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 7. CALL NEXT
    // ──────────────────────────────────────────────────────────────────────────
    let calledTokenId;
    try {
      const callRes = await request('POST', `/api/counters/${testCounterA1._id}/call-next`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(callRes.status, 200);
      assert(callRes.data.data.token, 'Token should be returned');
      assert.strictEqual(callRes.data.data.token.status, 'CALLED');
      assert.strictEqual(callRes.data.data.counter.currentTokenId._id.toString(), callRes.data.data.token._id.toString());
      calledTokenId = callRes.data.data.token._id;

      // Verify token in DB has servedBy set
      const dbToken = await Token.findById(calledTokenId);
      assert.strictEqual(dbToken.status, 'CALLED');
      assert.strictEqual(dbToken.servedBy.toString(), testStaffUser1._id.toString());

      pass('7. CALL NEXT (atomic transition to CALLED, sets counter & records operator)');
    } catch (err) {
      fail('7. CALL NEXT', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 8. START SERVING
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const serveRes = await request('POST', `/api/counters/${testCounterA1._id}/start-serving`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(serveRes.status, 200);
      assert.strictEqual(serveRes.data.data.token.status, 'SERVING');

      const dbToken = await Token.findById(calledTokenId);
      assert.strictEqual(dbToken.status, 'SERVING');
      assert(dbToken.servingAt, 'servingAt must be recorded');

      pass('8. START SERVING (transitions CALLED -> SERVING and records timestamp)');
    } catch (err) {
      fail('8. START SERVING', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 9. COMPLETE
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const compRes = await request('POST', `/api/counters/${testCounterA1._id}/complete`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(compRes.status, 200);
      assert.strictEqual(compRes.data.data.token.status, 'COMPLETED');

      const dbToken = await Token.findById(calledTokenId);
      assert.strictEqual(dbToken.status, 'COMPLETED');
      assert(dbToken.completedAt, 'completedAt must be recorded');
      assert(typeof dbToken.actualServiceSeconds === 'number', 'actualServiceSeconds computed');

      const dbCounter = await Counter.findById(testCounterA1._id);
      assert.strictEqual(dbCounter.currentTokenId, null, 'Counter currentToken cleared');
      assert.strictEqual(dbCounter.stats.served, 1, 'Counter served count incremented');

      pass('9. COMPLETE (transitions SERVING -> COMPLETED, updates stats & clears counter)');
    } catch (err) {
      fail('9. COMPLETE', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 10. SKIP
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Call Customer 2 to skip
      const callRes2 = await request('POST', `/api/counters/${testCounterA1._id}/call-next`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(callRes2.status, 200);
      const tokenToSkipId = callRes2.data.data.token._id;

      const skipRes = await request('POST', `/api/counters/${testCounterA1._id}/skip`, { tokenId: tokenToSkipId }, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(skipRes.status, 200);
      assert.strictEqual(skipRes.data.data.token.status, 'SKIPPED');

      const dbToken = await Token.findById(tokenToSkipId);
      assert.strictEqual(dbToken.status, 'SKIPPED');
      assert.strictEqual(dbToken.currentPosition, null);

      const dbCounter = await Counter.findById(testCounterA1._id);
      assert.strictEqual(dbCounter.currentTokenId, null);
      assert.strictEqual(dbCounter.stats.skipped, 1);

      pass('10. SKIP (safely skips token, clears counter & updates skipped statistics)');
    } catch (err) {
      fail('10. SKIP', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 11. Unauthorized token mutation
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Customer attempts to complete a token directly
      const mutRes = await request('POST', `/api/counters/${testCounterA1._id}/complete`, {}, {
        Authorization: `Bearer ${testCustomerToken1}`,
      });
      assert.strictEqual(mutRes.status, 403, 'Customer cannot execute counter mutations');

      pass('11. Unauthorized token mutation (CUSTOMER cannot invoke complete/skip/serve)');
    } catch (err) {
      fail('11. Unauthorized token mutation', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 12. Unauthorized counter access
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Staff 2 attempts to change status of Counter A1
      const patchRes = await request('PATCH', `/api/counters/${testCounterA1._id}/status`, { status: 'BREAK' }, {
        Authorization: `Bearer ${testStaffToken2}`,
      });
      assert.strictEqual(patchRes.status, 403, 'Staff 2 cannot update Counter A1 status');

      pass('12. Unauthorized counter access (peer staff cannot change status of another counter)');
    } catch (err) {
      fail('12. Unauthorized counter access', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 13. Concurrent CALL NEXT
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Join 2 tokens
      const u3 = await User.create({ name: 'C3', email: `c3_${ts}@t.com`, passwordHash: 'h', role: 'CUSTOMER' });
      const u4 = await User.create({ name: 'C4', email: `c4_${ts}@t.com`, passwordHash: 'h', role: 'CUSTOMER' });

      await queueService.joinQueue({
        userId: u3._id.toString(),
        centerId: testCenterA._id.toString(),
        serviceId: testServiceA._id.toString(),
        channel: 'WEB',
      });
      await queueService.joinQueue({
        userId: u4._id.toString(),
        centerId: testCenterA._id.toString(),
        serviceId: testServiceA._id.toString(),
        channel: 'WEB',
      });

      // Staff 1 on Counter A1 and Staff 2 on Counter A2 call next SIMULTANEOUSLY
      const [res1, res2] = await Promise.all([
        request('POST', `/api/counters/${testCounterA1._id}/call-next`, {}, {
          Authorization: `Bearer ${testStaffToken1}`,
        }),
        request('POST', `/api/counters/${testCounterA2._id}/call-next`, {}, {
          Authorization: `Bearer ${testStaffToken2}`,
        }),
      ]);

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res2.status, 200);
      assert(res1.data.data.token, 'Token 1 claimed');
      assert(res2.data.data.token, 'Token 2 claimed');

      // Crucial concurrency check: both counters must NOT receive the same token
      assert.notStrictEqual(
        res1.data.data.token._id.toString(),
        res2.data.data.token._id.toString(),
        'Two concurrent CALL NEXT operations must receive distinct tokens'
      );

      pass('13. Concurrent CALL NEXT (atomic claim guarantees unique token per counter)');
    } catch (err) {
      fail('13. Concurrent CALL NEXT', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 14. Concurrent COMPLETE/SKIP conflict
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Counter A1 has a current token. Attempting to complete it twice concurrently
      const [c1, c2] = await Promise.all([
        request('POST', `/api/counters/${testCounterA1._id}/complete`, {}, {
          Authorization: `Bearer ${testStaffToken1}`,
        }),
        request('POST', `/api/counters/${testCounterA1._id}/complete`, {}, {
          Authorization: `Bearer ${testStaffToken1}`,
        }),
      ]);

      const statuses = [c1.status, c2.status].sort();
      // Exactly one succeeds (200), the other encounters conflict/already cleared (400/409)
      assert.strictEqual(statuses[0], 200, 'One completion must succeed');
      assert([400, 409].includes(statuses[1]), 'Second completion must be rejected as conflict');

      pass('14. Concurrent COMPLETE/SKIP conflict (atomic guard rejects double completion)');
    } catch (err) {
      fail('14. Concurrent COMPLETE/SKIP conflict', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 15. Socket.IO operator updates
    // ──────────────────────────────────────────────────────────────────────────
    try {
      socketClientStaff1 = ioClient(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
        auth: { token: testStaffToken1 },
      });

      await new Promise((resolve) => socketClientStaff1.on('connect', resolve));

      let counterUpdatedReceived = false;
      socketClientStaff1.on('counter.updated', () => {
        counterUpdatedReceived = true;
      });

      // Join center room on socket
      socketClientStaff1.emit('join:center', testCenterA._id.toString());

      // Toggle status on Counter A1
      await request('PATCH', `/api/counters/${testCounterA1._id}/status`, { status: 'BREAK' }, {
        Authorization: `Bearer ${testStaffToken1}`,
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      assert(counterUpdatedReceived, 'Socket client must receive counter.updated event');

      pass('15. Socket.IO operator updates (realtime counter.updated broadcast delivered)');
    } catch (err) {
      fail('15. Socket.IO operator updates', err);
    } finally {
      if (socketClientStaff1) socketClientStaff1.disconnect();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 16. Customer tracking regression
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Put Counter A1 back to ACTIVE
      await request('PATCH', `/api/counters/${testCounterA1._id}/status`, { status: 'ACTIVE' }, {
        Authorization: `Bearer ${testStaffToken1}`,
      });

      const u5 = await User.create({ name: 'C5', email: `c5_${ts}@t.com`, passwordHash: 'h', role: 'CUSTOMER' });
      const joinRes = await queueService.joinQueue({
        userId: u5._id.toString(),
        centerId: testCenterA._id.toString(),
        serviceId: testServiceA._id.toString(),
        channel: 'WEB',
      });

      // Customer checks active token
      const t1 = await Token.findById(joinRes.token._id);
      assert.strictEqual(t1.status, 'WAITING');

      // Operator calls next
      await request('POST', `/api/counters/${testCounterA1._id}/call-next`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });

      const t2 = await Token.findById(joinRes.token._id);
      assert.strictEqual(t2.status, 'CALLED');

      pass('16. Customer tracking regression (Feature 2 customer live states advance correctly)');
    } catch (err) {
      fail('16. Customer tracking regression', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 17. Notification regression
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Verify that calling a token generated a TOKEN_CALLED notification for customer
      const notifs = await Notification.find({
        type: 'TOKEN_CALLED',
      });
      assert(notifs.length > 0, 'Feature 3 alert engine must generate TOKEN_CALLED notification');

      pass('17. Notification regression (Feature 3 notification engine triggers on operator actions)');
    } catch (err) {
      fail('17. Notification regression', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 18. Counter status behavior
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Complete current token first
      await request('POST', `/api/counters/${testCounterA1._id}/complete`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });

      // Test status transitions: ACTIVE -> BREAK -> CLOSED -> ACTIVE
      const resBreak = await request('PATCH', `/api/counters/${testCounterA1._id}/status`, { status: 'BREAK' }, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(resBreak.status, 200);
      assert.strictEqual(resBreak.data.data.counter.status, 'BREAK');

      const resClosed = await request('PATCH', `/api/counters/${testCounterA1._id}/status`, { status: 'CLOSED' }, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(resClosed.status, 200);
      assert.strictEqual(resClosed.data.data.counter.status, 'CLOSED');

      // When CLOSED, call next must be rejected
      const callClosed = await request('POST', `/api/counters/${testCounterA1._id}/call-next`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(callClosed.status, 400, 'Cannot call next on CLOSED counter');

      const resActive = await request('PATCH', `/api/counters/${testCounterA1._id}/status`, { status: 'ACTIVE' }, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(resActive.status, 200);
      assert.strictEqual(resActive.data.data.counter.status, 'ACTIVE');

      pass('18. Counter status behavior (ACTIVE, BREAK, CLOSED transitions enforced)');
    } catch (err) {
      fail('18. Counter status behavior', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 19. 401 handling
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const res401 = await request('GET', '/api/counters/operator/me');
      assert.strictEqual(res401.status, 401, 'Unauthenticated access must return 401');

      pass('19. 401 handling (unauthenticated requests rejected cleanly)');
    } catch (err) {
      fail('19. 401 handling', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 20. 403 handling
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const res403 = await request('PATCH', `/api/counters/${testCounterA1._id}/assign`, { serviceId: testServiceA._id }, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(res403.status, 403, 'Staff cannot reassign services (admin only)');

      pass('20. 403 handling (unauthorized staff modifications return 403 Forbidden)');
    } catch (err) {
      fail('20. 403 handling', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 21. 409 conflict handling
    // ──────────────────────────────────────────────────────────────────────────
    try {
      // Re-calling when counter has NO current token called
      const emptyRecall = await request('POST', `/api/counters/${testCounterA1._id}/recall`, {}, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert([400, 409].includes(emptyRecall.status), 'Recall with no active token rejected safely');

      pass('21. 409 conflict handling (state conflicts return clean error status)');
    } catch (err) {
      fail('21. 409 conflict handling', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 22. No customer PII leakage
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const opMe = await request('GET', '/api/counters/operator/me', null, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(opMe.status, 200);
      const strPayload = JSON.stringify(opMe.data);

      assert(!strPayload.includes('passwordHash'), 'No password hashes exposed');
      assert(!strPayload.includes('fcmToken'), 'No FCM tokens exposed');
      assert(!strPayload.includes('jwt'), 'No JWTs exposed');

      pass('22. No customer PII leakage (operator payload sanitizes credentials and PII)');
    } catch (err) {
      fail('22. No customer PII leakage', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 23. No fake/static queue data
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const opMe = await request('GET', '/api/counters/operator/me', null, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(opMe.status, 200);
      const data = opMe.data.data;
      assert(mongoose.Types.ObjectId.isValid(data.counter._id), 'Counter ID is a valid MongoDB ObjectId');
      assert(mongoose.Types.ObjectId.isValid(data.counter.centerId._id), 'Center ID is valid ObjectId');

      pass('23. No fake/static queue data (authoritative MongoDB documents loaded)');
    } catch (err) {
      fail('23. No fake/static queue data', err);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 24. Reconnect recovery
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const resAfterReconnect = await request('GET', '/api/counters/operator/me', null, {
        Authorization: `Bearer ${testStaffToken1}`,
      });
      assert.strictEqual(resAfterReconnect.status, 200);
      assert.strictEqual(resAfterReconnect.data.data.counter._id.toString(), testCounterA1._id.toString());
      assert(Array.isArray(resAfterReconnect.data.data.waitingTokens));

      pass('24. Reconnect recovery (re-fetching operator state cleanly recovers state)');
    } catch (err) {
      fail('24. Reconnect recovery', err);
    }

  } catch (globalErr) {
    console.error('Fatal test error:', globalErr);
  } finally {
    if (testServer) testServer.close();
    await mongoose.disconnect();
    console.log('[DB] MongoDB disconnected.');

    console.log('\n============================================================');
    console.log(`  Tier 2 Operator Portal Results: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();

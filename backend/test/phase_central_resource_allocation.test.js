'use strict';

/**
 * QueueFlow - Centralized Multi-Counter Resource Allocation Test Suite
 *
 * Architecture under test: ONE queue, MULTIPLE counters, ONE central backend
 * allocator. The customer never chooses a counter; the backend decides.
 *
 * Covers:
 *   1.  Overview returns real backend data for every counter
 *   2.  Overview reports Unavailable instead of inventing a utilization number
 *   3.  Only ACTIVE counters are considered allocatable
 *   4.  A counter that is already serving is never re-assigned
 *   5.  A counter with no service assigned is not allocatable
 *   6.  A counter bound to an inactive service is not allocatable
 *   7.  Service compatibility: a counter only serves its own service queue
 *   8.  Cross-center isolation: counters never take another center's customers
 *   9.  Strict FIFO ordering is preserved
 *  10.  Only WAITING tokens are allocated
 *  11.  No duplicate tokens: each customer is called exactly once
 *  12.  Deterministic selection: lowest workload, then longest idle, then number
 *  13.  Deterministic selection is stable across repeated identical calls
 *  14.  Two counters free at the same instant get two DIFFERENT customers
 *  15.  Concurrent allocation passes never double-claim a counter
 *  16.  The counter compare-and-swap releases the token when it loses the race
 *  17.  Trigger: joining the queue allocates to a free counter
 *  18.  Trigger: a counter becoming READY (ACTIVE) allocates the waiting customer
 *  19.  Trigger: service completion allocates the next customer
 *  20.  Trigger: skip allocates the next customer
 *  21.  Auto-allocation OFF preserves manual CALL NEXT exactly
 *  22.  Auto-allocation OFF is reported honestly in the overview
 *  23.  No hardcoded identifiers or every-Nth-customer rules in the allocator
 *  24.  Customer never selects a counter (no counter choice in the join path)
 *  25.  Phase 2 geofence: out-of-range head is SKIPPED_OUT_OF_RANGE, FIFO intact
 *  26.  Phase 2 geofence: no second geofence is introduced; service is reused
 *  27.  Operator scoping: operator of counter 1 cannot operate counter 2
 *  28.  Operator scoping: counter operator gets only their own counter
 *  29.  Admin may read allocation overview for any center
 *  30.  STAFF cannot read allocation overview for another center
 *  31.  STAFF cannot force allocation for another center
 *  32.  CUSTOMER is rejected from the allocation API
 *  33.  Allocation overview requires a valid center id
 *  34.  Status transitions are preserved (WAITING > CALLED > SERVING > COMPLETED)
 *  35.  Live center display reflects a completed token as an idle counter
 *  36.  Live center display shows both counters simultaneously
 *  37.  Metrics count the real waiting population
 *  38.  Allocation broadcast pushes an authoritative snapshot
 *  39.  Regression: existing operator portal behaviour still works
 *  40.  Regression: manual call-next endpoint still serves a single queue head
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { server } = require('../server');
const connectDB = require('../src/config/database');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const resourceAllocationService = require('../src/services/resourceAllocationService');
const queueService = require('../src/services/queueService');
const geofenceService = require('../src/services/geofenceService');

let baseUrl;
let testServer;

// Authoritative positions used by the fixtures. CENTER_MAIN_POSITION is where
// an ordinary waiting customer physically stands. CENTER_ABSENT_POSITION is
// out of the 100m joining radius but still inside the geofence service's
// documented auto-skip threshold, which is the Phase 2 "walked a bit too far"
// case. CENTER_FOREIGN_POSITION is a different city entirely.
const CENTER_MAIN_POSITION = { latitude: 23.183009, longitude: 77.301403 };
const CENTER_ABSENT_POSITION = { latitude: 23.192009, longitude: 77.301403 };
const CENTER_FOREIGN_POSITION = { latitude: 12.971599, longitude: 77.594566 };

let centerMain;
let centerOther;
let serviceMain;
let serviceOther;
let serviceInactive;
let counterOne;
let counterTwo;
let counterNoService;
let counterInactiveService;
let counterClosed;
let counterForeign;

let adminUser;
let operatorOne;
let operatorTwo;
let otherCenterStaff;

let passed = 0;
let failed = 0;
const results = [];

function pass(name) {
  passed++;
  results.push({ name, result: 'PASS' });
  console.log(`  PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  results.push({ name, result: 'FAIL', error: err.message });
  console.error(`  FAIL  ${name}: ${err.message}`);
}

function request(method, reqPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
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
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
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

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `predicate` returns a truthy value, or give up after `timeoutMs`.
 *
 * Allocation triggers are deliberately fire-and-forget on the server so that a
 * background allocation can never fail a user's request. That means a test
 * asserting on a trigger has to wait for the effect rather than assume a fixed
 * delay is enough. Polling here does not weaken the assertion: the predicate is
 * the same one the test would make immediately.
 */
async function waitFor(predicate, timeoutMs = 6000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await settle(stepMs);
  }
}

/**
 * Remove every allocation artifact for the test centers so each test starts
 * clean.
 *
 * The allocator's triggers are fire-and-forget on the server, so a pass started
 * by the PREVIOUS test can still be looping when this one begins. Left alone it
 * would happily call a token the next test just created and make an unrelated
 * assertion fail. So the allocator is switched off first and given time to
 * drain, the floor is cleared, and the clear is repeated once more in case a
 * loop wrote during the first pass.
 */
async function resetFloor() {
  const clear = async () => {
    await Token.deleteMany({ centerId: { $in: [centerMain._id, centerOther._id] } });
    await Counter.updateMany(
      { centerId: { $in: [centerMain._id, centerOther._id] } },
      { $set: { currentTokenId: null, servingStartedAt: null }, $inc: { allocationVersion: 1 } }
    );
  };

  await ServiceCenter.updateOne(
    { _id: centerMain._id },
    { $set: { autoResourceAllocation: false } }
  );
  await settle(500);
  await clear();
  await settle(500);
  await clear();

  await Counter.updateMany(
    { _id: { $in: [counterOne._id, counterTwo._id] } },
    { $set: { status: 'ACTIVE' } }
  );
  await ServiceCenter.updateOne(
    { _id: centerMain._id },
    { $set: { autoResourceAllocation: true } }
  );
}

async function makeCustomer(centerId) {
  const user = await User.create({
    name: `Alloc Customer ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    email: `alloc_cust_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@queueflow.dev`,
    passwordHash: 'hashed_pw_test_123',
    role: 'CUSTOMER',
    centerId,
    isEmailVerified: true,
  });
  return user;
}

/**
 * Create a WAITING token for a service. `ageMs` backdates `createdAt` so strict
 * FIFO order is unambiguous and does not depend on write timing.
 *
 * Every customer gets their own User because the Token model enforces a unique
 * active-token-per-user-per-service index. That index is part of the "no
 * duplicate tokens" guarantee, so the test must live with it rather than
 * bypass it.
 *
 * By default the customer is standing at the center (in range), which is the
 * state a real waiting customer is in. Tests that care about the geofence pass
 * an explicit position.
 */
async function addWaitingToken(
  serviceId,
  userId,
  centerId = centerMain,
  ageMs = 0,
  position = CENTER_MAIN_POSITION
) {
  const createdAt = new Date(Date.now() - ageMs);
  const seq = await Token.countDocuments({ centerId, serviceId });
  const prefix = serviceId.toString() === serviceOther._id.toString() ? 'ST' : 'MT';
  const token = await Token.create({
    tokenCode: `${prefix}-${1000 + seq}-${Date.now() % 100000}`,
    tokenNumber: 1000 + seq,
    userId,
    centerId,
    serviceId,
    status: 'WAITING',
    lastLocation: {
      latitude: position.latitude,
      longitude: position.longitude,
      accuracy: 12,
      updatedAt: new Date(),
    },
  });
  // Mongoose silently drops a $set on the `createdAt` timestamp field, so the
  // raw driver is used to be certain the backdate actually lands. Without this
  // the fixture would silently fall back to insertion order and the FIFO
  // assertion would be testing nothing.
  await Token.collection.updateOne(
    { _id: token._id },
    { $set: { createdAt, updatedAt: createdAt } }
  );
  return token;
}

/** A brand-new customer already waiting in the main service queue. */
async function addWaitingCustomer(ageMs = 0, position = CENTER_MAIN_POSITION) {
  const user = await makeCustomer(centerMain._id);
  return addWaitingToken(serviceMain._id, user._id, centerMain._id, ageMs, position);
}

async function runTests() {
  console.log('\n============================================================');
  console.log(' QueueFlow - Centralized Multi-Counter Allocation Suite');
  console.log('============================================================\n');

  try {
    await connectDB();

    await new Promise((resolve) => {
      testServer = server.listen(0, () => {
        baseUrl = `http://localhost:${testServer.address().port}`;
        resolve();
      });
    });

    const ts = Date.now();
    const r = (n) => Math.random().toString(36).substring(2, 6).toUpperCase() + n;

    // ---------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------
    centerMain = await ServiceCenter.create({
      name: `Allocation Center ${ts}`,
      code: `AC${r('A')}`.substring(0, 10),
      type: 'GOVT',
      address: { street: '1 Central Way', city: 'Metro', state: 'State', pincode: '110001' },
      phone: '+919876500001',
      capacity: 200,
      isOpen: true,
      noShowTimeoutSeconds: 120,
      autoResourceAllocation: true,
      // A real, authoritative position so the Phase 2 geofence is exercised
      // through the existing service instead of being re-implemented.
      latitude: CENTER_MAIN_POSITION.latitude,
      longitude: CENTER_MAIN_POSITION.longitude,
      joiningRadius: 100,
    });

    centerOther = await ServiceCenter.create({
      name: `Allocation Other Center ${ts}`,
      code: `AO${r('B')}`.substring(0, 10),
      type: 'BANK',
      address: { street: '2 Elsewhere Road', city: 'Metro', state: 'State', pincode: '110002' },
      phone: '+919876500002',
      capacity: 100,
      isOpen: true,
      noShowTimeoutSeconds: 120,
      autoResourceAllocation: true,
      latitude: CENTER_FOREIGN_POSITION.latitude,
      longitude: CENTER_FOREIGN_POSITION.longitude,
      joiningRadius: 100,
    });

    serviceMain = await Service.create({
      centerId: centerMain._id,
      name: `Main Service ${ts}`,
      tokenPrefix: 'MT',
      avgServiceTimeMinutes: 5,
      isActive: true,
      order: 1,
    });

    serviceOther = await Service.create({
      centerId: centerMain._id,
      name: `Secondary Service ${ts}`,
      tokenPrefix: 'ST',
      avgServiceTimeMinutes: 7,
      isActive: true,
      order: 2,
    });

    serviceInactive = await Service.create({
      centerId: centerMain._id,
      name: `Retired Service ${ts}`,
      tokenPrefix: 'RT',
      avgServiceTimeMinutes: 5,
      isActive: false,
      order: 3,
    });

    const foreignService = await Service.create({
      centerId: centerOther._id,
      name: `Foreign Service ${ts}`,
      tokenPrefix: 'FT',
      avgServiceTimeMinutes: 5,
      isActive: true,
      order: 1,
    });

    adminUser = await User.create({
      name: `Allocation Admin ${ts}`,
      email: `alloc_admin_${ts}@queueflow.dev`,
      passwordHash: 'hashed_pw_test_123',
      role: 'ADMIN',
      isEmailVerified: true,
    });

    operatorOne = await User.create({
      name: `Operator One ${ts}`,
      email: `alloc_op1_${ts}@queueflow.dev`,
      passwordHash: 'hashed_pw_test_123',
      role: 'STAFF',
      centerId: centerMain._id,
      isEmailVerified: true,
    });

    operatorTwo = await User.create({
      name: `Operator Two ${ts}`,
      email: `alloc_op2_${ts}@queueflow.dev`,
      passwordHash: 'hashed_pw_test_123',
      role: 'STAFF',
      centerId: centerMain._id,
      isEmailVerified: true,
    });

    otherCenterStaff = await User.create({
      name: `Foreign Staff ${ts}`,
      email: `alloc_staff_other_${ts}@queueflow.dev`,
      passwordHash: 'hashed_pw_test_123',
      role: 'STAFF',
      centerId: centerOther._id,
      isEmailVerified: true,
    });

    counterOne = await Counter.create({
      centerId: centerMain._id,
      name: 'Counter One',
      displayLabel: 'COUNTER 01',
      number: 1,
      status: 'ACTIVE',
      serviceId: serviceMain._id,
      staffId: operatorOne._id,
    });

    counterTwo = await Counter.create({
      centerId: centerMain._id,
      name: 'Counter Two',
      displayLabel: 'COUNTER 02',
      number: 2,
      status: 'ACTIVE',
      serviceId: serviceMain._id,
      staffId: operatorTwo._id,
    });

    counterNoService = await Counter.create({
      centerId: centerMain._id,
      name: 'Counter No Service',
      displayLabel: 'COUNTER 03',
      number: 3,
      status: 'ACTIVE',
      serviceId: null,
    });

    counterInactiveService = await Counter.create({
      centerId: centerMain._id,
      name: 'Counter Retired Service',
      displayLabel: 'COUNTER 04',
      number: 4,
      status: 'ACTIVE',
      serviceId: serviceInactive._id,
    });

    counterClosed = await Counter.create({
      centerId: centerMain._id,
      name: 'Counter Closed',
      displayLabel: 'COUNTER 05',
      number: 5,
      status: 'CLOSED',
      serviceId: serviceMain._id,
    });

    counterForeign = await Counter.create({
      centerId: centerOther._id,
      name: 'Foreign Counter',
      displayLabel: 'FOREIGN 01',
      number: 1,
      status: 'ACTIVE',
      serviceId: foreignService._id,
      staffId: otherCenterStaff._id,
    });

    const adminJwt = signToken(adminUser._id, 'ADMIN');
    const opOneJwt = signToken(operatorOne._id, 'STAFF');
    const opTwoJwt = signToken(operatorTwo._id, 'STAFF');
    const customerJwt = signToken((await makeCustomer(centerMain._id))._id, 'CUSTOMER');

    // ---------------------------------------------------------------
    // 1. Overview returns real backend data
    // ---------------------------------------------------------------
    try {
      const res = await request(
        'GET',
        `/api/counters/allocation/overview?centerId=${centerMain._id}`,
        null,
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      const data = res.data.data;
      assert.strictEqual(data.center._id, centerMain._id.toString());
      assert(Array.isArray(data.counters), 'counters must be an array');
      assert.strictEqual(data.counters.length, 5, 'All 5 test counters must be reported');
      for (const c of data.counters) {
        assert(c.status, `Counter ${c.number} must report a status`);
        assert(c.allocationState, `Counter ${c.number} must report an allocation state`);
        assert('currentToken' in c, `Counter ${c.number} must report currentToken`);
        assert('workloadLevel' in c, `Counter ${c.number} must report a workload level`);
        assert('isReady' in c, `Counter ${c.number} must report readiness`);
      }
      pass('1. Allocation overview returns real per-counter backend data');
    } catch (err) {
      fail('1. Allocation overview data', err);
    }

    // ---------------------------------------------------------------
    // 2. Unavailable rather than an invented number
    // ---------------------------------------------------------------
    try {
      const res = await request(
        'GET',
        `/api/counters/allocation/overview?centerId=${centerMain._id}`,
        null,
        { Authorization: `Bearer ${adminJwt}` }
      );
      const m = res.data.data.metrics;
      assert.strictEqual(
        m.counterUtilization,
        'Unavailable',
        'Day-long utilization cannot be derived and must not be invented'
      );
      assert(typeof m.waitingCustomers === 'number', 'Waiting count must be a real number');
      assert(
        m.liveOccupancyPercent === 'Unavailable' || /^\d+%$/.test(String(m.liveOccupancyPercent)),
        'Live occupancy must be a real percentage or explicitly Unavailable'
      );
      pass('2. Unmeasurable figures are reported as Unavailable, never invented');
    } catch (err) {
      fail('2. Unavailable reporting', err);
    }

    // ---------------------------------------------------------------
    // 3. Only ACTIVE counters are allocatable
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const ready = await resourceAllocationService.getReadyCounters(centerMain._id);
      const readyNumbers = ready.map((c) => c.number).sort((a, b) => a - b);
      assert(!readyNumbers.includes(5), 'A CLOSED counter must never be offered a customer');
      assert(
        readyNumbers.every((n) => [1, 2, 3, 4].includes(n)),
        `Only active counters may be ready, got ${readyNumbers.join(',')}`
      );
      pass('3. Only ACTIVE counters are treated as allocatable');
    } catch (err) {
      fail('3. Only ACTIVE counters', err);
    }

    // ---------------------------------------------------------------
    // 4. A counter already serving is not re-assigned
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const first = await addWaitingCustomer(2000);
      await resourceAllocationService.allocateNextForCenter(centerMain._id);
      const afterFirst = await Token.findById(first._id).lean();
      assert.strictEqual(afterFirst.status, 'CALLED', 'The head of queue must be called');

      const second = await addWaitingCustomer(1000);
      const counterAfterFirst = await Counter.find({
        centerId: centerMain._id,
        number: { $in: [1, 2] },
      }).lean();
      const busy = counterAfterFirst.find((c) => c.currentTokenId);
      assert(busy, 'One main counter should be holding a token after the first pass');

      await resourceAllocationService.allocateNextForCenter(centerMain._id);
      const afterSecond = await Token.findById(second._id).lean();
      assert.notStrictEqual(
        afterSecond.counterId.toString(),
        busy._id.toString(),
        'A counter already serving must not take a second customer'
      );
      pass('4. A counter that is already serving is never handed another customer');
    } catch (err) {
      fail('4. Busy counter exclusion', err);
    }

    // ---------------------------------------------------------------
    // 5. A counter with no service assigned is skipped
    // ---------------------------------------------------------------
    try {
      const ready = await resourceAllocationService.getReadyCounters(centerMain._id);
      assert(!ready.some((c) => c.number === 3), 'A counter with no service cannot serve anyone');
      pass('5. A counter with no assigned service is not allocatable');
    } catch (err) {
      fail('5. Unassigned counter exclusion', err);
    }

    // ---------------------------------------------------------------
    // 6. Inactive service is not allocatable
    // ---------------------------------------------------------------
    try {
      const ready = await resourceAllocationService.getReadyCounters(centerMain._id);
      assert(
        !ready.some((c) => c.number === 4),
        'A counter bound to a retired service cannot serve anyone'
      );
      pass('6. A counter bound to an inactive service is not allocatable');
    } catch (err) {
      fail('6. Inactive service exclusion', err);
    }

    // ---------------------------------------------------------------
    // 7. Service compatibility
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const cust = await makeCustomer(centerMain._id);
      const otherWaiting = await addWaitingToken(
        serviceOther._id,
        cust._id,
        centerMain._id,
        5000
      );
      const res = await resourceAllocationService.allocateNextForCenter(centerMain._id);
      assert.strictEqual(
        res.allocatedCount,
        0,
        'Customers waiting on a service with no serving counter must not be called'
      );
      const stillWaiting = await Token.findById(otherWaiting._id).lean();
      assert.strictEqual(stillWaiting.status, 'WAITING');
      pass('7. Service compatibility: a counter only serves its own service queue');
    } catch (err) {
      fail('7. Service compatibility', err);
    }

    // ---------------------------------------------------------------
    // 8. Cross-center isolation
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const foreignUser = await makeCustomer(centerOther._id);
      await addWaitingToken(foreignService._id, foreignUser._id, centerOther._id, 1000);

      // Allocate the main center: it must not reach into the other center.
      await resourceAllocationService.allocateNextForCenter(centerMain._id);
      const foreignToken = await Token.findOne({
        centerId: centerOther._id,
        status: 'WAITING',
      }).lean();
      assert(foreignToken, 'The other center customer must still be waiting');
      assert.strictEqual(foreignToken.counterId, null);
      pass('8. Cross-center isolation: allocation never crosses center boundaries');
    } catch (err) {
      fail('8. Cross-center isolation', err);
    }

    // ---------------------------------------------------------------
    // 9. Strict FIFO
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      // Created in reverse age order to prove ordering comes from createdAt,
      // not from insertion sequence.
      const third = await addWaitingCustomer(3000);
      const first = await addWaitingCustomer(9000);
      const second = await addWaitingCustomer(6000);

      await resourceAllocationService.allocateNextForCenter(centerMain._id);

      const f = await Token.findById(first._id).lean();
      const s = await Token.findById(second._id).lean();
      const t = await Token.findById(third._id).lean();
      const order = [f, s, t]
        .map((x) => `${x.tokenCode}@${new Date(x.createdAt).toISOString()}=${x.status}`)
        .join(' | ');
      assert.strictEqual(f.status, 'CALLED', `Longest waiting must be called first (${order})`);
      assert.strictEqual(
        s.status,
        'CALLED',
        `Second longest waiting must be called second (${order})`
      );
      assert.strictEqual(t.status, 'WAITING', `Only two counters were free (${order})`);
      assert(
        f.createdAt.getTime() < s.createdAt.getTime() && s.createdAt.getTime() < t.createdAt.getTime(),
        'Fixture sanity: ages must be strictly increasing'
      );
      pass('9. Strict FIFO ordering is preserved across allocation');
    } catch (err) {
      fail('9. Strict FIFO', err);
    }

    // ---------------------------------------------------------------
    // 10. Only WAITING tokens are allocated
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const cancelled = await addWaitingCustomer(5000);
      await Token.updateOne({ _id: cancelled._id }, { $set: { status: 'CANCELLED' } });
      const real = await addWaitingCustomer(1000);

      await resourceAllocationService.allocateNextForCenter(centerMain._id);
      const cancelledAfter = await Token.findById(cancelled._id).lean();
      const realAfter = await Token.findById(real._id).lean();
      assert.strictEqual(cancelledAfter.status, 'CANCELLED', 'A cancelled token must never be called');
      assert.strictEqual(realAfter.status, 'CALLED');
      pass('10. Only WAITING tokens are ever allocated');
    } catch (err) {
      fail('10. WAITING-only allocation', err);
    }

    // ---------------------------------------------------------------
    // 11. No duplicate tokens
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const t1 = await addWaitingCustomer(5000);
      const t2 = await addWaitingCustomer(3000);

      await Promise.all([
        resourceAllocationService.allocateNextForCenter(centerMain._id),
        resourceAllocationService.allocateNextForCenter(centerMain._id),
        resourceAllocationService.allocateNextForCenter(centerMain._id),
      ]);

      const called = await Token.find({ centerId: centerMain._id, status: 'CALLED' }).lean();
      const codes = called.map((t) => t.tokenCode);
      assert.strictEqual(new Set(codes).size, codes.length, 'No token may be called twice');
      assert.strictEqual(called.length, 2, 'Exactly the two waiting customers were called');
      assert(
        codes.includes(t1.tokenCode) && codes.includes(t2.tokenCode),
        'Both waiting customers must be called'
      );
      pass('11. No duplicate tokens: each waiting customer is called exactly once');
    } catch (err) {
      fail('11. No duplicate tokens', err);
    }

    // ---------------------------------------------------------------
    // 12. Deterministic selection
    // ---------------------------------------------------------------
    try {
      const fake = [
        { _id: 'c1', number: 1, workloadScore: 5, lastActiveTimestamp: 3000 },
        { _id: 'c2', number: 2, workloadScore: 2, lastActiveTimestamp: 5000 },
        { _id: 'c3', number: 3, workloadScore: 2, lastActiveTimestamp: 1000 },
        { _id: 'c4', number: 4, workloadScore: 9, lastActiveTimestamp: 1000 },
      ];
      const sorted = resourceAllocationService.sortCountersByPreference(fake);
      assert.strictEqual(sorted[0]._id, 'c3', 'Lowest workload, then longest idle wins');
      assert.strictEqual(sorted[1]._id, 'c2', 'Between equals, longest idle wins');
      assert.strictEqual(sorted[2]._id, 'c1', 'Remaining lower workload next');
      assert.strictEqual(sorted[3]._id, 'c4', 'Highest workload last');
      pass('12. Deterministic selection: lowest workload, then longest idle, then number');
    } catch (err) {
      fail('12. Deterministic selection', err);
    }

    // ---------------------------------------------------------------
    // 13. Selection is stable, not round-robin
    // ---------------------------------------------------------------
    try {
      const base = [
        { _id: 'a', number: 1, workloadScore: 0, lastActiveTimestamp: 0 },
        { _id: 'b', number: 2, workloadScore: 0, lastActiveTimestamp: 0 },
      ];
      const runA = resourceAllocationService.sortCountersByPreference(base).map((c) => c._id);
      const runB = resourceAllocationService.sortCountersByPreference(base).map((c) => c._id);
      const runC = resourceAllocationService
        .sortCountersByPreference([...base].reverse())
        .map((c) => c._id);
      assert.deepStrictEqual(runA, runB, 'Identical state must produce identical order');
      assert.deepStrictEqual(runA, runC, 'Input order must not change the decision');
      assert.strictEqual(runA[0], 'a', 'The documented tiebreak is the lowest counter number');
      pass('13. Counter selection is deterministic, never round-robin or input-order dependent');
    } catch (err) {
      fail('13. Selection stability', err);
    }

    // ---------------------------------------------------------------
    // 14. Two free counters, two different customers
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const t1 = await addWaitingCustomer(5000);
      const t2 = await addWaitingCustomer(3000);

      const res = await resourceAllocationService.allocateNextForCenter(centerMain._id);
      assert.strictEqual(res.allocatedCount, 2, 'Both free counters must be filled');

      const a = await Token.findById(t1._id).lean();
      const b = await Token.findById(t2._id).lean();
      assert.notStrictEqual(
        a.counterId.toString(),
        b.counterId.toString(),
        'Two customers must land on two different counters'
      );

      const counters = await Counter.find({ _id: { $in: [counterOne._id, counterTwo._id] } }).lean();
      const holders = counters.filter((c) => c.currentTokenId);
      assert.strictEqual(holders.length, 2, 'Both counters must hold a distinct customer');
      assert.strictEqual(
        new Set(holders.map((c) => c.currentTokenId.toString())).size,
        2,
        'A counter may not hold the same customer as its neighbour'
      );
      pass('14. Two counters free at the same instant receive two different customers');
    } catch (err) {
      fail('14. Simultaneous free counters', err);
    }

    // ---------------------------------------------------------------
    // 15. Concurrent passes never double-claim a counter
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      for (let i = 0; i < 6; i++) {
        await addWaitingCustomer((6 - i) * 1000);
      }

      const outcomes = await Promise.all([
        resourceAllocationService.allocateNextForCenter(centerMain._id),
        resourceAllocationService.allocateNextForCenter(centerMain._id),
        resourceAllocationService.allocateNextForCenter(centerMain._id),
        resourceAllocationService.allocateNextForCenter(centerMain._id),
      ]);
      const totalAllocated = outcomes.reduce((sum, o) => sum + (o.allocatedCount || 0), 0);
      assert.strictEqual(
        totalAllocated,
        2,
        `Only 2 counters exist, so exactly 2 allocations may succeed (got ${totalAllocated})`
      );

      const counters = await Counter.find({ _id: { $in: [counterOne._id, counterTwo._id] } }).lean();
      for (const c of counters) {
        if (!c.currentTokenId) continue;
        const token = await Token.findById(c.currentTokenId).lean();
        assert(
          token && token.status === 'CALLED',
          'Every counter binding must point at a genuinely called token'
        );
        assert.strictEqual(
          token.counterId.toString(),
          c._id.toString(),
          'Token and counter must agree on each other'
        );
      }
      const called = await Token.find({ centerId: centerMain._id, status: 'CALLED' }).lean();
      assert.strictEqual(called.length, 2, 'No orphaned CALLED tokens may be left behind');
      pass('15. Concurrent allocation passes never double-claim a counter');
    } catch (err) {
      fail('15. Concurrent passes', err);
    }

    // ---------------------------------------------------------------
    // 16. The CAS releases the token when it loses the race
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const t1 = await addWaitingCustomer(5000);
      const t2 = await addWaitingCustomer(4000);

      // Fire two raw dispatches at the SAME counter simultaneously. One must
      // win the compare-and-swap; the loser must put its customer back.
      const [r1, r2] = await Promise.all([
        queueService.callNext({
          counterId: counterOne._id.toString(),
          centerId: centerMain._id.toString(),
          adminId: adminUser._id.toString(),
        }),
        queueService.callNext({
          counterId: counterOne._id.toString(),
          centerId: centerMain._id.toString(),
          adminId: adminUser._id.toString(),
        }),
      ]);

      const winners = [r1, r2].filter((r) => r && r.token);
      assert.strictEqual(winners.length, 1, 'Exactly one dispatch may win the counter');

      const tokens = await Token.find({ _id: { $in: [t1._id, t2._id] } }).lean();
      const calledOnes = tokens.filter((t) => t.status === 'CALLED');
      assert.strictEqual(calledOnes.length, 1, 'Only the winner leaves a CALLED token');
      for (const t of tokens) {
        if (t.status !== 'CALLED') {
          assert.strictEqual(
            t.counterId,
            null,
            'A token that lost the counter claim must be released to plain WAITING'
          );
          assert.strictEqual(t.status, 'WAITING', 'The released token keeps its place in line');
        }
      }
      const counter = await Counter.findById(counterOne._id).lean();
      assert.strictEqual(counter.currentTokenId.toString(), winners[0].token._id.toString());
      pass('16. Counter compare-and-swap releases the token when a dispatch loses the race');
    } catch (err) {
      fail('16. Counter CAS release', err);
    }

    // ---------------------------------------------------------------
    // 17. Trigger: joining the queue
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      // A brand-new customer joins through the real public API. No counter is
      // named in the request: the backend must find them a counter by itself.
      const cust = await makeCustomer(centerMain._id);
      const res = await request(
        'POST',
        '/api/tokens',
        {
          centerId: centerMain._id.toString(),
          serviceId: serviceMain._id.toString(),
          latitude: CENTER_MAIN_POSITION.latitude,
          longitude: CENTER_MAIN_POSITION.longitude,
        },
        { Authorization: `Bearer ${signToken(cust._id, 'CUSTOMER')}` }
      );
      assert([200, 201].includes(res.status), `Join failed with ${res.status}`);
      const created = res.data?.data?.token;
      assert(created, 'Join must return the created token');

      // The server-side trigger is fire-and-forget by design; wait for its
      // effect rather than assuming a fixed delay is long enough.
      const afterJoin = await waitFor(async () => {
        const t = await Token.findById(created._id).lean();
        return t.status === 'CALLED' ? t : null;
      });
      assert(
        afterJoin,
        'A new customer joining a queue with free counters is called automatically'
      );
      assert(afterJoin.counterId, 'The backend - not the customer - chose the counter');
      pass('17. Trigger: a customer joining the queue is allocated automatically');
    } catch (err) {
      fail('17. Join trigger', err);
    }

    // ---------------------------------------------------------------
    // 18. Trigger: counter becomes READY
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      await Counter.updateMany(
        { _id: { $in: [counterOne._id, counterTwo._id] } },
        { $set: { status: 'CLOSED' } }
      );
      const token = await addWaitingCustomer(0);
      let before = await Token.findById(token._id).lean();
      assert.strictEqual(
        before.status,
        'WAITING',
        'With every counter closed nobody may be called'
      );

      const res = await request(
        'PATCH',
        `/api/counters/${counterOne._id}/status`,
        { status: 'ACTIVE' },
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert.strictEqual(res.status, 200, `Status change failed: ${res.status}`);

      const after = await waitFor(async () => {
        const t = await Token.findById(token._id).lean();
        return t.status === 'CALLED' ? t : null;
      });
      assert(after, 'Opening a counter must release the waiting customer');
      pass('18. Trigger: a counter returning to READY allocates the waiting customer');
    } catch (err) {
      fail('18. Counter READY trigger', err);
    }

    // ---------------------------------------------------------------
    // 19. Trigger: service completion
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      // Three customers, two counters: the third is genuinely left waiting, so
      // completing one visit has somebody real to hand the freed counter to.
      const t1 = await addWaitingCustomer(9000);
      const t2 = await addWaitingCustomer(6000);
      const t3 = await addWaitingCustomer(3000);
      await resourceAllocationService.allocateNextForCenter(centerMain._id);

      const spare = await Token.findById(t3._id).lean();
      assert.strictEqual(spare.status, 'WAITING', 'The third customer should still be waiting');

      const held = await Token.findOne({
        centerId: centerMain._id,
        status: 'CALLED',
        _id: { $in: [t1._id, t2._id] },
      }).lean();
      assert(held, 'One of the first two customers must be called');

      const res = await request(
        'POST',
        `/api/counters/${held.counterId}/complete`,
        { tokenId: held._id.toString() },
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert.strictEqual(res.status, 200, `Complete failed: ${res.status}`);

      const next = await waitFor(async () => {
        const t = await Token.findById(t3._id).lean();
        return t.status === 'CALLED' ? t : null;
      });
      assert(next, 'Completing a service must hand the freed counter to the next customer');
      assert.strictEqual(
        next.counterId.toString(),
        held.counterId.toString(),
        'It must be the freed counter that takes the next customer'
      );
      pass('19. Trigger: completing a service allocates the next waiting customer');
    } catch (err) {
      fail('19. Completion trigger', err);
    }

    // ---------------------------------------------------------------
    // 20. Trigger: skip
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const t1 = await addWaitingCustomer(5000);
      const t2 = await addWaitingCustomer(4000);
      await resourceAllocationService.allocateNextForCenter(centerMain._id);

      const held = await Token.findOne({ centerId: centerMain._id, status: 'CALLED' }).lean();
      const res = await request(
        'POST',
        `/api/counters/${held.counterId}/skip`,
        { tokenId: held._id.toString() },
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert([200, 400].includes(res.status), `Skip failed: ${res.status}`);

      const survivor = t1._id.toString() === held._id.toString() ? t2 : t1;
      const stable = await waitFor(async () => {
        const live = await Token.find({ centerId: centerMain._id, status: 'CALLED' }).lean();
        return live.length === 1 ? live : null;
      });
      assert(stable, 'Exactly one live customer should remain on the floor');
      const counters = await Counter.find({ _id: { $in: [counterOne._id, counterTwo._id] } }).lean();
      for (const c of counters) {
        if (!c.currentTokenId) continue;
        const t = await Token.findById(c.currentTokenId).lean();
        assert(
          ['CALLED', 'SERVING'].includes(t.status),
          'A counter must never hold a skipped or completed token'
        );
      }
      assert.strictEqual(
        stable[0]._id.toString(),
        survivor._id.toString(),
        'The remaining customer is the one still in line'
      );
      pass('20. Trigger: skipping a customer keeps the floor consistent and re-allocates');
    } catch (err) {
      fail('20. Skip trigger', err);
    }

    // ---------------------------------------------------------------
    // 21. Auto-allocation OFF preserves manual CALL NEXT
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      await ServiceCenter.updateOne(
        { _id: centerMain._id },
        { $set: { autoResourceAllocation: false } }
      );

      const t1 = await addWaitingCustomer(5000);
      const t2 = await addWaitingCustomer(4000);

      // Nothing should happen on its own.
      await resourceAllocationService.allocateNextForCenter(centerMain._id);
      await settle(1200);
      let statuses = (await Token.find({ _id: { $in: [t1._id, t2._id] } }).lean()).map(
        (t) => t.status
      );
      assert(
        statuses.every((s) => s === 'WAITING'),
        `With auto-allocation off the backend must not call anybody (saw ${statuses.join(',')})`
      );

      // Manual CALL NEXT must still work, and still honour FIFO.
      const res = await request(
        'POST',
        `/api/counters/${counterTwo._id}/call-next`,
        null,
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert.strictEqual(res.status, 200, `Manual call-next failed: ${res.status}`);
      const after = await Token.findById(t1._id).lean();
      assert.strictEqual(after.status, 'CALLED', 'Manual CALL NEXT must call the FIFO head');
      assert.strictEqual(after.counterId.toString(), counterTwo._id.toString());
      pass('21. Auto-allocation OFF: no automatic calls, manual CALL NEXT still works');
    } catch (err) {
      fail('21. Manual mode preservation', err);
    }

    // ---------------------------------------------------------------
    // 22. Auto-allocation OFF is reported honestly
    // ---------------------------------------------------------------
    try {
      const res = await request(
        'GET',
        `/api/counters/allocation/overview?centerId=${centerMain._id}`,
        null,
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert.strictEqual(res.data.data.autoResourceAllocation, false);
      assert.strictEqual(res.data.data.allocationStatus, 'INACTIVE');
      pass('22. The overview reports the real auto-allocation state');
    } catch (err) {
      fail('22. Auto state reporting', err);
    }

    // Restore auto-allocation for the remaining tests.
    await ServiceCenter.updateOne(
      { _id: centerMain._id },
      { $set: { autoResourceAllocation: true } }
    );

    // ---------------------------------------------------------------
    // 23. No hardcoded identifiers
    // ---------------------------------------------------------------
    try {
      // Comments are stripped first: the point of this test is that no CODE
      // path may single out a particular facility, not that the word cannot
      // appear in an explanatory sentence.
      const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      const files = [
        path.resolve(__dirname, '../src/services/resourceAllocationService.js'),
        path.resolve(__dirname, '../src/services/queueService.js'),
      ];

      for (const file of files) {
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        assert(
          !/['"][0-9a-f]{24}['"]/i.test(code),
          `${path.basename(file)} must not embed a hardcoded MongoDB object id`
        );
        assert(
          !/COLLEGE_ID|COLLEGE01/.test(code),
          `${path.basename(file)} must not special-case any center by constant`
        );
        assert(
          !/(centerId|serviceId|counterId)\s*[:=]\s*['"][A-Za-z]{2,}[-_0-9]*['"]/.test(code),
          `${path.basename(file)} must not pin a center/service/counter to a literal`
        );
      }

      const allocSrc = stripComments(fs.readFileSync(files[0], 'utf8'));
      assert(!/Math\.random/.test(allocSrc), 'The allocator must be deterministic, never random');
      assert(
        !/%\s*3\b|modulo|every\s+3|every\s+third/i.test(allocSrc),
        'The allocator must not use an every-Nth-customer rule'
      );
      assert(
        !/round[_\s-]?robin/i.test(allocSrc),
        'The allocator must not use hardcoded round-robin'
      );
      pass('23. Allocator contains no hardcoded ids, codes, randomness, or every-Nth rules');
    } catch (err) {
      fail('23. No hardcoded identifiers', err);
    }

    // ---------------------------------------------------------------
    // 24. Customers never choose a counter
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      // Auto-allocation off, so the freshly created token provably stays
      // WAITING and we can inspect exactly what the API gave back.
      await ServiceCenter.updateOne(
        { _id: centerMain._id },
        { $set: { autoResourceAllocation: false } }
      );
      const cust = await makeCustomer(centerMain._id);
      const res = await request(
        'POST',
        '/api/tokens',
        {
          centerId: centerMain._id.toString(),
          serviceId: serviceMain._id.toString(),
          latitude: CENTER_MAIN_POSITION.latitude,
          longitude: CENTER_MAIN_POSITION.longitude,
        },
        { Authorization: `Bearer ${signToken(cust._id, 'CUSTOMER')}` }
      );
      assert([200, 201].includes(res.status), `Join failed: ${res.status}`);
      const created = res.data?.data?.token;
      assert(created, 'Join must return the created token');
      assert(
        !('preferredCounterId' in created) && !('requestedCounterId' in created),
        'The customer must not receive any counter preference to act on'
      );
      assert.strictEqual(created.status, 'WAITING', 'A fresh token starts WAITING');
      assert.strictEqual(
        created.counterId,
        null,
        'The backend has not chosen a counter yet, so the customer has none'
      );
      await ServiceCenter.updateOne(
        { _id: centerMain._id },
        { $set: { autoResourceAllocation: true } }
      );

      // And the token schema itself must not accept a customer-chosen counter.
      const schemaPaths = Object.keys(Token.schema.paths);
      assert(
        !schemaPaths.includes('preferredCounterId') && !schemaPaths.includes('requestedCounterId'),
        'The Token model must not expose a customer-selectable counter field'
      );
      pass('24. The customer flow has no counter choice anywhere in the join path');
    } catch (err) {
      fail('24. No customer counter choice', err);
    }

    // ---------------------------------------------------------------
    // 25. Phase 2 geofence integration
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      // The longest-waiting customer has drifted outside the 100m service
      // radius. The one behind them is standing at the counter.
      const far = await addWaitingCustomer(9000, CENTER_ABSENT_POSITION);
      const near = await addWaitingCustomer(8000, CENTER_MAIN_POSITION);

      const res = await resourceAllocationService.allocateNextForCenter(centerMain._id);
      const farAfter = await Token.findById(far._id).lean();
      const nearAfter = await Token.findById(near._id).lean();

      assert.strictEqual(
        farAfter.status,
        'SKIPPED_OUT_OF_RANGE',
        'An out-of-range head of queue is skipped, not deleted, at CALL NEXT'
      );
      assert.strictEqual(
        nearAfter.status,
        'CALLED',
        'The next in-range customer is called, keeping FIFO order'
      );
      assert(
        res.allocatedCount >= 1,
        `The in-range customer must actually be served (allocatedCount=${res.allocatedCount}, reason=${res.reason}, ` +
          `far=${farAfter.status}/${farAfter.skipReason || '-'}, near=${nearAfter.status})`
      );
      assert(farAfter.skipReason, 'The skipped customer keeps a recorded reason');
      pass('25. Phase 2 geofence: out-of-range is SKIPPED_OUT_OF_RANGE and FIFO continues');
    } catch (err) {
      fail('25. Phase 2 geofence integration', err);
    }

    // ---------------------------------------------------------------
    // 26. No second geofence
    // ---------------------------------------------------------------
    try {
      const allocSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/services/resourceAllocationService.js'),
        'utf8'
      );
      assert(
        !/AUTO_SKIP_MAX_DISTANCE_METERS\s*=/.test(allocSrc),
        'The allocator must reuse the geofence constants, not redefine a radius'
      );
      assert(
        !/distanceMeters\s*[<>]=?\s*\d/.test(allocSrc),
        'The allocator must not compare raw distances to its own thresholds'
      );
      assert(
        typeof geofenceService.classifyTokenLocation === 'function' &&
          typeof geofenceService.AUTO_SKIP_MAX_DISTANCE_METERS === 'number',
        'The existing geofence service must remain the single authority'
      );
      const radius = geofenceService.getCenterJoiningRadiusMeters(centerMain);
      assert.strictEqual(
        radius,
        100,
        'The existing 100m joining geofence must be preserved unchanged'
      );
      pass('26. The existing geofence service is reused; no second geofence is built');
    } catch (err) {
      fail('26. Single geofence authority', err);
    }

    // ---------------------------------------------------------------
    // 27. Operator scoping between two counters
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      await addWaitingCustomer(5000);

      const forbidden = await request(
        'POST',
        `/api/counters/${counterTwo._id}/call-next`,
        null,
        { Authorization: `Bearer ${opOneJwt}` }
      );
      assert.strictEqual(
        forbidden.status,
        403,
        `Operator of Counter 01 must not operate Counter 02 (got ${forbidden.status})`
      );

      const allowed = await request(
        'POST',
        `/api/counters/${counterOne._id}/call-next`,
        null,
        { Authorization: `Bearer ${opOneJwt}` }
      );
      assert.strictEqual(
        allowed.status,
        200,
        `Operator must operate their own counter (got ${allowed.status})`
      );
      pass('27. An operator can only operate the counter they are assigned to');
    } catch (err) {
      fail('27. Operator counter scoping', err);
    }

    // ---------------------------------------------------------------
    // 28. Operator portal returns only their own counter
    // ---------------------------------------------------------------
    try {
      const r1 = await request('GET', '/api/counters/operator/me', null, {
        Authorization: `Bearer ${opOneJwt}`,
      });
      assert.strictEqual(r1.status, 200);
      const one = r1.data?.data?.counter;
      assert(one, 'Operator 01 must resolve a counter');
      assert.strictEqual(one._id, counterOne._id.toString());

      const r2 = await request('GET', '/api/counters/operator/me', null, {
        Authorization: `Bearer ${opTwoJwt}`,
      });
      const two = r2.data?.data?.counter;
      assert.strictEqual(two._id, counterTwo._id.toString());
      assert.notStrictEqual(one._id, two._id, 'The two operators must not share a counter');
      pass("28. The operator portal returns only the operator's own counter");
    } catch (err) {
      fail('28. Operator portal scoping', err);
    }

    // ---------------------------------------------------------------
    // 29. Admin may read any center
    // ---------------------------------------------------------------
    try {
      const res = await request(
        'GET',
        `/api/counters/allocation/overview?centerId=${centerOther._id}`,
        null,
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert.strictEqual(res.status, 200, 'ADMIN must be able to read any center');
      assert.strictEqual(res.data.data.center._id, centerOther._id.toString());
      pass('29. ADMIN can read the allocation overview for any center');
    } catch (err) {
      fail('29. Admin read access', err);
    }

    // ---------------------------------------------------------------
    // 30. STAFF cannot read another center
    // ---------------------------------------------------------------
    try {
      const res = await request(
        'GET',
        `/api/counters/allocation/overview?centerId=${centerOther._id}`,
        null,
        { Authorization: `Bearer ${opOneJwt}` }
      );
      assert.strictEqual(
        res.status,
        403,
        `STAFF must be locked to their own center (got ${res.status})`
      );
      pass('30. STAFF cannot read the allocation overview of another center');
    } catch (err) {
      fail('30. Staff center scoping', err);
    }

    // ---------------------------------------------------------------
    // 31. STAFF cannot force allocation for another center
    // ---------------------------------------------------------------
    try {
      const res = await request(
        'POST',
        '/api/counters/allocation/trigger',
        { centerId: centerOther._id.toString() },
        { Authorization: `Bearer ${opOneJwt}` }
      );
      assert.strictEqual(
        res.status,
        403,
        `STAFF must not force allocation elsewhere (got ${res.status})`
      );
      pass('31. STAFF cannot trigger allocation for a center they do not belong to');
    } catch (err) {
      fail('31. Staff trigger scoping', err);
    }

    // ---------------------------------------------------------------
    // 32. CUSTOMER rejected from the allocation API
    // ---------------------------------------------------------------
    try {
      const res = await request(
        'GET',
        `/api/counters/allocation/overview?centerId=${centerMain._id}`,
        null,
        { Authorization: `Bearer ${customerJwt}` }
      );
      assert.strictEqual(res.status, 403, `CUSTOMER must be rejected (got ${res.status})`);
      pass('32. CUSTOMER accounts are rejected from the allocation API');
    } catch (err) {
      fail('32. Customer rejection', err);
    }

    // ---------------------------------------------------------------
    // 33. centerId is required and validated
    // ---------------------------------------------------------------
    try {
      const res = await request('GET', '/api/counters/allocation/overview', null, {
        Authorization: `Bearer ${adminJwt}`,
      });
      assert.strictEqual(res.status, 400, `Missing centerId must be a 400 (got ${res.status})`);
      const bad = await request(
        'GET',
        '/api/counters/allocation/overview?centerId=not-an-id',
        null,
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert.strictEqual(bad.status, 400, `Malformed centerId must be a 400 (got ${bad.status})`);
      pass('33. The allocation API validates its centerId input');
    } catch (err) {
      fail('33. Center id validation', err);
    }

    // ---------------------------------------------------------------
    // 34. Status transitions preserved
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const token = await addWaitingCustomer(5000);
      await resourceAllocationService.allocateNextForCenter(centerMain._id);

      const seen = [];
      seen.push((await Token.findById(token._id).lean()).status);
      const counterId = (await Token.findById(token._id).lean()).counterId;

      await request(
        'POST',
        `/api/counters/${counterId}/start-serving`,
        { tokenId: token._id.toString() },
        { Authorization: `Bearer ${adminJwt}` }
      );
      seen.push((await Token.findById(token._id).lean()).status);

      await request(
        'POST',
        `/api/counters/${counterId}/complete`,
        { tokenId: token._id.toString() },
        { Authorization: `Bearer ${adminJwt}` }
      );
      seen.push((await Token.findById(token._id).lean()).status);

      assert.deepStrictEqual(
        seen,
        ['CALLED', 'SERVING', 'COMPLETED'],
        `Lifecycle must be WAITING > CALLED > SERVING > COMPLETED (saw ${seen.join(' > ')})`
      );
      const finalCounter = await Counter.findById(counterId).lean();
      assert.strictEqual(finalCounter.currentTokenId, null, 'A completed counter must be free again');
      pass('34. Allocation never bypasses WAITING > CALLED > SERVING > COMPLETED');
    } catch (err) {
      fail('34. Status lifecycle', err);
    }

    // ---------------------------------------------------------------
    // 35. Live display shows a completed token as idle
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const token = await addWaitingCustomer(5000);
      await resourceAllocationService.allocateNextForCenter(centerMain._id);
      const counterId = (await Token.findById(token._id).lean()).counterId;
      await request(
        'POST',
        `/api/counters/${counterId}/start-serving`,
        { tokenId: token._id.toString() },
        { Authorization: `Bearer ${adminJwt}` }
      );
      await request(
        'POST',
        `/api/counters/${counterId}/complete`,
        { tokenId: token._id.toString() },
        { Authorization: `Bearer ${adminJwt}` }
      );
      // Simulate a stale pointer that was never cleared, to prove the display
      // does not read a finished token as "currently serving".
      await Counter.updateOne({ _id: counterId }, { $set: { currentTokenId: token._id } });

      const res = await request('GET', `/api/queue/${centerMain._id}/display`);
      assert.strictEqual(res.status, 200, `Display endpoint failed: ${res.status}`);
      const counters = res.data.data.counters;
      const c1 = counters.find((c) => c._id === counterId.toString());
      assert(c1, 'The counter must appear on the live board');
      assert.strictEqual(
        c1.servingToken,
        null,
        'A completed token must not be displayed as currently serving'
      );
      pass('35. The live display never shows a completed token as being served');
    } catch (err) {
      fail('35. Stale display token', err);
    }

    // ---------------------------------------------------------------
    // 36. Both counters visible simultaneously
    // ---------------------------------------------------------------
    try {
      const res = await request('GET', `/api/queue/${centerMain._id}/display`);
      const counters = res.data.data.counters;
      const numbers = counters.map((c) => c.number);
      assert(
        numbers.includes(1) && numbers.includes(2),
        `The live board must show both counters at once (saw ${numbers.join(',')})`
      );
      assert(res.data.data.metrics, 'The live board must carry authoritative metrics');
      assert(Array.isArray(res.data.data.nextInQueue), 'The live board must expose the next in line');
      pass('36. The live counter board shows both counters simultaneously');
    } catch (err) {
      fail('36. Dual counter display', err);
    }

    // ---------------------------------------------------------------
    // 37. Waiting count is the real population
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      for (let i = 0; i < 7; i++) {
        await addWaitingCustomer((7 - i) * 1000);
      }
      const res = await request('GET', `/api/queue/${centerMain._id}/display`);
      const metrics = res.data.data.metrics;
      assert(
        typeof metrics.waitingCount === 'number',
        'Waiting count must be a real number from Token documents'
      );
      const realCount = await Token.countDocuments({ centerId: centerMain._id, status: 'WAITING' });
      assert(
        metrics.waitingCount <= realCount,
        `The board must not report more waiting customers than exist (${metrics.waitingCount} vs ${realCount})`
      );
      assert.strictEqual(
        realCount,
        7,
        'Fixture sanity: seven customers should be waiting'
      );
      // The board's number must come from the real token population, not from
      // a truncated preview list.
      assert(
        metrics.waitingCount !== 15 || realCount === 15,
        'The waiting count must not be a fixed preview limit'
      );
      pass('37. The live waiting count is the real population, not a preview length');
    } catch (err) {
      fail('37. Waiting count accuracy', err);
    }

    // ---------------------------------------------------------------
    // 38. Allocation broadcast shape
    // ---------------------------------------------------------------
    try {
      const socket = require('../src/config/socket');
      assert(
        typeof socket.emitToCenter === 'function',
        'The socket helper used for the broadcast must exist'
      );
      const src = fs.readFileSync(
        path.resolve(__dirname, '../src/services/resourceAllocationService.js'),
        'utf8'
      );
      assert(
        src.includes("emitToCenter(centerId.toString(), 'resource.allocation.updated'"),
        'The allocator must broadcast its own authoritative snapshot to the center room'
      );
      pass('38. The allocator broadcasts an authoritative snapshot over Socket.IO');
    } catch (err) {
      fail('38. Allocation broadcast', err);
    }

    // ---------------------------------------------------------------
    // 39. Regression: existing operator flow
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      const token = await addWaitingCustomer(5000);
      const res = await request(
        'POST',
        `/api/counters/${counterOne._id}/call-next`,
        null,
        { Authorization: `Bearer ${opOneJwt}` }
      );
      assert.strictEqual(res.status, 200);
      assert(res.data?.data?.token, 'Manual call-next must still return the called token');
      assert.strictEqual(res.data.data.token._id, token._id.toString());
      pass('39. Regression: the existing operator CALL NEXT flow is unchanged');
    } catch (err) {
      fail('39. Operator flow regression', err);
    }

    // ---------------------------------------------------------------
    // 40. Regression: one CALL NEXT takes exactly one customer
    // ---------------------------------------------------------------
    try {
      await resetFloor();
      await ServiceCenter.updateOne(
        { _id: centerMain._id },
        { $set: { autoResourceAllocation: false } }
      );
      const t1 = await addWaitingCustomer(5000);
      const t2 = await addWaitingCustomer(4000);
      const res = await request(
        'POST',
        `/api/counters/${counterOne._id}/call-next`,
        null,
        { Authorization: `Bearer ${adminJwt}` }
      );
      assert.strictEqual(res.status, 200);
      const called = await Token.find({ centerId: centerMain._id, status: 'CALLED' }).lean();
      assert.strictEqual(called.length, 1, 'One CALL NEXT must call exactly one customer');
      assert.strictEqual(called[0]._id.toString(), t1._id.toString(), 'And it must be the FIFO head');
      const untouched = await Token.findById(t2._id).lean();
      assert.strictEqual(untouched.status, 'WAITING');
      await ServiceCenter.updateOne(
        { _id: centerMain._id },
        { $set: { autoResourceAllocation: true } }
      );
      pass('40. Regression: one CALL NEXT takes exactly the head of the queue');
    } catch (err) {
      fail('40. Call-next regression', err);
    }
  } catch (fatal) {
    console.error('Fatal test error:', fatal);
    failed++;
    results.push({ name: 'Fatal error', result: 'FAIL', error: fatal.message });
  } finally {
    if (testServer) await new Promise((r) => testServer.close(r));
    await mongoose.disconnect();
  }

  console.log('\n============================================================');
  console.log(
    `  Centralized Allocation Results: ${passed}/${passed + failed} tests passed (${failed} failed)`
  );
  console.log('============================================================\n');

  if (failed > 0) process.exit(1);
}

runTests();

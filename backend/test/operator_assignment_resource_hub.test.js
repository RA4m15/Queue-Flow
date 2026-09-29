'use strict';

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

let baseUrl;
let testServer;
let adminToken;
let staffToken;
let customerToken;
let testCenter;
let testOtherCenter;
let testService;
let testCounter1;
let testCounter2;
let testOp1;
let testOp2;
let testInactiveOp;
let testOtherCenterOp;
let testCustomer;

async function request(path, options = {}) {
  const url = new URL(path, baseUrl);
  const method = options.method || 'GET';
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const body = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, centerId: user.centerId, tokenVersion: user.tokenVersion !== undefined ? user.tokenVersion : 0 },
    process.env.JWT_SECRET || 'test_secret',
    { expiresIn: '2h' }
  );
}

async function setup() {
  await connectDB();
  testServer = server.listen(0);
  await new Promise((resolve) => testServer.once('listening', resolve));
  const port = testServer.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Create isolated test center
  testCenter = await ServiceCenter.create({
    name: 'Op Test Center',
    code: 'OPT' + Math.floor(Math.random() * 8999 + 1000),
    type: 'SUPPORT',
    address: { street: 'Test St', city: 'Test City', state: 'TS' },
    isOpen: true,
    capacity: 100,
  });

  testOtherCenter = await ServiceCenter.create({
    name: 'Other Center',
    code: 'OTH' + Math.floor(Math.random() * 8999 + 1000),
    type: 'SUPPORT',
    address: { street: 'Other St', city: 'Other City', state: 'TS' },
    isOpen: true,
    capacity: 100,
  });

  testService = await Service.create({
    centerId: testCenter._id,
    name: 'Op Test Service',
    tokenPrefix: 'OP',
    avgServiceTimeMinutes: 5,
    isActive: true,
    order: 1,
  });

  // Admin user
  const admin = await User.create({
    name: 'Op Admin',
    email: `op.admin.${Date.now()}@test.local`,
    role: 'ADMIN',
    passwordHash: 'hash',
  });
  adminToken = makeToken(admin);

  // Staff operator 1
  testOp1 = await User.create({
    name: 'Op One',
    email: `op.one.${Date.now()}@test.local`,
    role: 'STAFF',
    centerId: testCenter._id,
    passwordHash: 'hash',
    isActive: true,
  });
  staffToken = makeToken(testOp1);

  // Staff operator 2
  testOp2 = await User.create({
    name: 'Op Two',
    email: `op.two.${Date.now()}@test.local`,
    role: 'STAFF',
    centerId: testCenter._id,
    passwordHash: 'hash',
    isActive: true,
  });

  // Inactive operator
  testInactiveOp = await User.create({
    name: 'Inactive Op',
    email: `op.inactive.${Date.now()}@test.local`,
    role: 'STAFF',
    centerId: testCenter._id,
    passwordHash: 'hash',
    isActive: false,
  });

  // Operator belonging to other center
  testOtherCenterOp = await User.create({
    name: 'Other Center Op',
    email: `op.other.${Date.now()}@test.local`,
    role: 'STAFF',
    centerId: testOtherCenter._id,
    passwordHash: 'hash',
    isActive: true,
  });

  // Customer user
  testCustomer = await User.create({
    name: 'Op Customer',
    email: `op.cust.${Date.now()}@test.local`,
    role: 'CUSTOMER',
    passwordHash: 'hash',
  });
  customerToken = makeToken(testCustomer);

  // Counters
  testCounter1 = await Counter.create({
    centerId: testCenter._id,
    number: 1,
    name: 'Counter 01',
    status: 'ACTIVE',
    serviceId: testService._id,
  });

  testCounter2 = await Counter.create({
    centerId: testCenter._id,
    number: 2,
    name: 'Counter 02',
    status: 'ACTIVE',
    serviceId: testService._id,
  });
}

async function teardown() {
  if (testCenter) {
    await Counter.deleteMany({ centerId: { $in: [testCenter._id, testOtherCenter._id] } });
    await Service.deleteMany({ centerId: testCenter._id });
    await ServiceCenter.deleteMany({ _id: { $in: [testCenter._id, testOtherCenter._id] } });
  }
  if (testOp1) {
    await User.deleteMany({
      _id: {
        $in: [
          testOp1._id,
          testOp2._id,
          testInactiveOp._id,
          testOtherCenterOp._id,
          testCustomer._id,
        ],
      },
    });
  }
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
  await mongoose.disconnect();
}

async function run() {
  console.log('\n============================================================');
  console.log('🏛️  QueueFlow — Operator Assignment & Roster Suite');
  console.log('============================================================\n');

  try {
    await setup();

    // 1. Rejects unauthenticated caller
    {
      const res = await request(`/api/counters/operators?centerId=${testCenter._id}`);
      assert.strictEqual(res.status, 401, 'Should reject unauthenticated');
      console.log('  ✅ PASS  1. Rejects unauthenticated caller from /api/counters/operators');
    }

    // 2. Rejects STAFF caller
    {
      const res = await request(`/api/counters/operators?centerId=${testCenter._id}`, {
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      assert.strictEqual(res.status, 403, 'Should reject STAFF caller');
      console.log('  ✅ PASS  2. Rejects STAFF role from accessing operator roster');
    }

    // 3. Rejects CUSTOMER caller
    {
      const res = await request(`/api/counters/operators?centerId=${testCenter._id}`, {
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      assert.strictEqual(res.status, 403, 'Should reject CUSTOMER caller');
      console.log('  ✅ PASS  3. Rejects CUSTOMER role from accessing operator roster');
    }

    // 4. Requires valid centerId
    {
      const res = await request('/api/counters/operators?centerId=invalid-id', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 400, 'Should reject invalid centerId');
      console.log('  ✅ PASS  4. Requires valid centerId query parameter');
    }

    // 5. Returns operators for center
    {
      const res = await request(`/api/counters/operators?centerId=${testCenter._id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.status !== 200) {
        console.error('TEST 5 FAILED STATUS:', res.status, 'BODY:', res.body);
      }
      assert.strictEqual(res.status, 200);
      assert(res.body.data && Array.isArray(res.body.data.operators));
      const opNames = res.body.data.operators.map((o) => o.name);
      assert(opNames.includes('Op One'), 'Should include Op One');
      assert(opNames.includes('Op Two'), 'Should include Op Two');
      assert(opNames.includes('Inactive Op'), 'Should include Inactive Op');
      assert(!opNames.includes('Other Center Op'), 'Must NOT include operator of other center');
      console.log('  ✅ PASS  5. Lists real operators adhering strictly to center isolation');
    }

    // 6. Assign operator to Counter 1
    {
      const res = await request(`/api/counters/${testCounter1._id}/assign-staff`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { staffId: testOp1._id },
      });
      assert.strictEqual(res.status, 200);
      assert(res.body.data?.counter?.staffId, 'Counter should have staffId');
      assert.strictEqual(res.body.data.counter.staffId._id.toString(), testOp1._id.toString());

      // Verify MongoDB persistence
      const freshCounter = await Counter.findById(testCounter1._id);
      assert.strictEqual(freshCounter.staffId.toString(), testOp1._id.toString());
      const freshUser = await User.findById(testOp1._id);
      assert.strictEqual(freshUser.assignedCounterId.toString(), testCounter1._id.toString());
      console.log('  ✅ PASS  6. Successfully assigns operator to counter and persists two-way in MongoDB');
    }

    // 7. Verify /api/counters/operators reflects assignment
    {
      const res = await request(`/api/counters/operators?centerId=${testCenter._id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const op1Record = res.body.data.operators.find((o) => o._id.toString() === testOp1._id.toString());
      assert(op1Record, 'Op 1 should be present');
      assert.strictEqual(op1Record.isAssigned, true);
      assert(op1Record.assignedCounter, 'Should have assignedCounter');
      assert.strictEqual(op1Record.assignedCounter.number, 1);
      console.log('  ✅ PASS  7. Operator roster reflects active desk assignment');
    }

    // 8. Rejects assigning inactive operator
    {
      const res = await request(`/api/counters/${testCounter2._id}/assign-staff`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { staffId: testInactiveOp._id },
      });
      assert.strictEqual(res.status, 400);
      assert(res.body.message.includes('inactive'), 'Error should mention inactive operator');
      console.log('  ✅ PASS  8. Rejects assigning inactive operator');
    }

    // 9. Rejects cross-center operator assignment
    {
      const res = await request(`/api/counters/${testCounter2._id}/assign-staff`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { staffId: testOtherCenterOp._id },
      });
      assert.strictEqual(res.status, 400);
      assert(res.body.message.includes('center'), 'Error should mention different service center');
      console.log('  ✅ PASS  9. Rejects cross-center operator assignment (center isolation)');
    }

    // 10. Reassign Op 1 from Counter 1 to Counter 2
    {
      const res = await request(`/api/counters/${testCounter2._id}/assign-staff`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { staffId: testOp1._id },
      });
      assert.strictEqual(res.status, 200);

      // Verify Counter 1's staffId was unassigned
      const freshCounter1 = await Counter.findById(testCounter1._id);
      assert.strictEqual(freshCounter1.staffId, null, 'Counter 1 should now have null staffId');

      // Verify Counter 2 now has Op 1
      const freshCounter2 = await Counter.findById(testCounter2._id);
      assert.strictEqual(freshCounter2.staffId.toString(), testOp1._id.toString());

      // Verify user's assignedCounterId updated to Counter 2
      const freshUser = await User.findById(testOp1._id);
      assert.strictEqual(freshUser.assignedCounterId.toString(), testCounter2._id.toString());
      console.log('  ✅ PASS  10. Reassigning operator safely releases previous counter and updates new counter');
    }

    // 11. Unassign Op 1 from Counter 2
    {
      const res = await request(`/api/counters/${testCounter2._id}/assign-staff`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { staffId: null },
      });
      assert.strictEqual(res.status, 200);

      const freshCounter2 = await Counter.findById(testCounter2._id);
      assert.strictEqual(freshCounter2.staffId, null, 'Counter 2 staffId should be null');

      const freshUser = await User.findById(testOp1._id);
      assert.strictEqual(freshUser.assignedCounterId, null, 'User assignedCounterId should be null');
      console.log('  ✅ PASS  11. Unassigning operator clears counter and user assignments');
    }

    console.log('\n============================================================');
    console.log('  Operator Assignment Results: 11 passed, 0 failed');
    console.log('============================================================\n');
  } finally {
    await teardown();
  }
}

run().catch((err) => {
  console.error('\n❌ TEST FAILURE:', err);
  process.exit(1);
});

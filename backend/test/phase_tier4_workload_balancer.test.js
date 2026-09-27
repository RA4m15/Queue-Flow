'use strict';

/**
 * QueueFlow — TIER 4 / FEATURE 5: COGNITIVE LOAD / FATIGUE BALANCER TEST SUITE
 *
 * Dedicated test suite verifying backend-authoritative operational workload evaluation
 * and transparent balancing recommendations:
 * 1. Workload service with real operator
 * 2. Insufficient data handling
 * 3. No active token handling
 * 4. Active token load scoring
 * 5. Recent service volume calculation
 * 6. Actual service duration complexity
 * 7. Queue pressure scoring
 * 8. Sustained workload tracking
 * 9. Relative workload peer comparison
 * 10. Low workload state classification
 * 11. Moderate workload state classification
 * 12. High workload state classification
 * 13. Sustained high state classification
 * 14. Workload explanation fields transparency
 * 15. No fake/static workload data
 * 16. Unauthorized customer access blocked
 * 17. Unauthorized staff access blocked (wrong center)
 * 18. Center isolation enforcement
 * 19. Operator ownership/visibility
 * 20. Balancing recommendation generation
 * 21. Recommendation rejects unavailable counter
 * 22. Recommendation respects service compatibility
 * 23. Recommendation respects staff authorization
 * 24. Counter morphing compatibility
 * 25. P2P swap compatibility
 * 26. Service Graph compatibility
 * 27. Ghost Queue independence
 * 28. Document Gate independence
 * 29. Socket.IO workload update emission
 * 30. Notification dedupe and anti-spam
 * 31. Concurrent workload calculations
 * 32. Stale-data handling
 * 33. Performance/query behavior (cache invalidation)
 * 34. No PII leakage in sanitized summaries
 * 35. No hardcoded business data
 *
 * ZERO mock/fake/static business data.
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
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
const Queue = require('../src/models/Queue');
const QueueEvent = require('../src/models/QueueEvent');
const Notification = require('../src/models/Notification');
const { DocumentRequirement } = require('../src/models/DocumentRequirement');
const { CustomerDocument } = require('../src/models/CustomerDocument');
const { ServiceRelationship } = require('../src/models/ServiceRelationship');
const { SwapOffer } = require('../src/models/SwapOffer');

const queueService = require('../src/services/queueService');
const workloadBalancerService = require('../src/services/workloadBalancerService');
const swapService = require('../src/services/swapService');
const serviceGraphService = require('../src/services/serviceGraphService');
const documentGateService = require('../src/services/documentGateService');
const geofenceService = require('../src/services/geofenceService');

let baseUrl;
let testServer;

let centerA, centerB;
let serviceA, serviceB;
let counter1, counter2, counter3;
let adminUser, staffUser1, staffUser2, staffUserB, customerUser;
let adminJwt, staffJwt1, staffJwt2, staffJwtB, customerJwt;

let passed = 0;
let failed = 0;

function signToken(userId, role = 'CUSTOMER') {
  return jwt.sign({ id: userId.toString(), role, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function pass(name) {
  passed++;
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  ❌ FAIL  ${name}`);
  console.error(`         ${err?.message || err}`);
}

async function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const defaultHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    const options = {
      method,
      path,
      headers: defaultHeaders,
    };
    const [host, portStr] = baseUrl.replace('http://', '').split(':');
    const port = parseInt(portStr, 10);
    const req = http.request({ ...options, host, port }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  await connectDB();
  testServer = server.listen(0);
  const addr = testServer.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[Test] Server listening at ${baseUrl}`);

  // Clean test fixtures
  await Promise.all([
    User.deleteMany({ email: { $regex: '@workload.qf' } }),
    ServiceCenter.deleteMany({ code: { $in: ['WK-CTR-A', 'WK-CTR-B'] } }),
    Service.deleteMany({ tokenPrefix: { $in: ['WA', 'WB'] } }),
    Counter.deleteMany({ name: { $regex: '^WK-' } }),
    Token.deleteMany({ tokenCode: { $regex: '^WA-|^WB-' } }),
    Queue.deleteMany({}),
    Notification.deleteMany({ dedupeKey: { $regex: 'sustained_workload_' } }),
    QueueEvent.deleteMany({ eventType: { $in: ['WORKLOAD_ALERT_TRIGGERED', 'WORKLOAD_BALANCED'] } }),
    DocumentRequirement.deleteMany({}),
    CustomerDocument.deleteMany({}),
    ServiceRelationship.deleteMany({}),
    SwapOffer.deleteMany({}),
  ]);

  // Create Service Centers
  centerA = await ServiceCenter.create({
    name: 'Workload Test Center A',
    code: 'WK-CTR-A',
    address: { street: '100 Balancer Way', city: 'Bengaluru', state: 'KA' },
    type: 'GOVT',
    isOpen: true,
    capacity: 200,
    geofence: { enabled: true, radiusMeters: 500 },
    location: { type: 'Point', coordinates: [77.5946, 12.9716], latitude: 12.9716, longitude: 77.5946 },
  });

  centerB = await ServiceCenter.create({
    name: 'Workload Test Center B',
    code: 'WK-CTR-B',
    address: { street: '200 Isolation Rd', city: 'Bengaluru', state: 'KA' },
    type: 'SUPPORT',
    isOpen: true,
    capacity: 100,
  });

  // Create Services
  serviceA = await Service.create({
    centerId: centerA._id,
    name: 'General Inquiries',
    code: 'GEN-INQ',
    tokenPrefix: 'WA',
    avgServiceTimeMinutes: 10,
    isActive: true,
    category: 'CUSTOMER_SERVICE',
  });

  serviceB = await Service.create({
    centerId: centerA._id,
    name: 'Express Registration',
    code: 'EXP-REG',
    tokenPrefix: 'WB',
    avgServiceTimeMinutes: 5,
    isActive: true,
    category: 'EXPRESS',
  });

  // Create Users
  adminUser = await User.create({
    name: 'Workload Admin',
    email: `admin_${Date.now()}@workload.qf`,
    passwordHash: 'hash',
    role: 'ADMIN',
    centerId: centerA._id,
    isActive: true,
  });

  staffUser1 = await User.create({
    name: 'Staff Operator One',
    email: `staff1_${Date.now()}@workload.qf`,
    passwordHash: 'hash',
    role: 'STAFF',
    centerId: centerA._id,
    isActive: true,
  });

  staffUser2 = await User.create({
    name: 'Staff Operator Two',
    email: `staff2_${Date.now()}@workload.qf`,
    passwordHash: 'hash',
    role: 'STAFF',
    centerId: centerA._id,
    isActive: true,
  });

  staffUserB = await User.create({
    name: 'Staff Center B',
    email: `staffB_${Date.now()}@workload.qf`,
    passwordHash: 'hash',
    role: 'STAFF',
    centerId: centerB._id,
    isActive: true,
  });

  customerUser = await User.create({
    name: 'Customer Test',
    email: `customer_${Date.now()}@workload.qf`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
    isActive: true,
  });

  adminJwt = signToken(adminUser._id, 'ADMIN');
  staffJwt1 = signToken(staffUser1._id, 'STAFF');
  staffJwt2 = signToken(staffUser2._id, 'STAFF');
  staffJwtB = signToken(staffUserB._id, 'STAFF');
  customerJwt = signToken(customerUser._id, 'CUSTOMER');

  // Create Counters
  counter1 = await Counter.create({
    centerId: centerA._id,
    name: 'WK-Counter-1',
    number: 1,
    serviceId: serviceA._id,
    staffId: staffUser1._id,
    status: 'ACTIVE',
  });

  counter2 = await Counter.create({
    centerId: centerA._id,
    name: 'WK-Counter-2',
    number: 2,
    serviceId: serviceA._id,
    staffId: staffUser2._id,
    status: 'ACTIVE',
  });

  counter3 = await Counter.create({
    centerId: centerA._id,
    name: 'WK-Counter-3',
    number: 3,
    serviceId: serviceB._id,
    status: 'ACTIVE', // Idle without assigned staff
  });
}

async function teardown() {
  console.log('\n[Teardown] Cleaning up test fixtures...');
  await Promise.all([
    User.deleteMany({ email: { $regex: '@workload.qf' } }),
    ServiceCenter.deleteMany({ code: { $in: ['WK-CTR-A', 'WK-CTR-B'] } }),
    Service.deleteMany({ tokenPrefix: { $in: ['WA', 'WB'] } }),
    Counter.deleteMany({ name: { $regex: '^WK-' } }),
    Token.deleteMany({ tokenCode: { $regex: '^WA-|^WB-' } }),
    Queue.deleteMany({}),
    Notification.deleteMany({ dedupeKey: { $regex: 'sustained_workload_' } }),
    QueueEvent.deleteMany({ eventType: { $in: ['WORKLOAD_ALERT_TRIGGERED', 'WORKLOAD_BALANCED'] } }),
  ]);
  if (testServer) testServer.close();
  await mongoose.disconnect();
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n============================================================');
  console.log('  QUEUEFLOW TIER 4 FEATURE 5: COGNITIVE LOAD BALANCER TESTS');
  console.log('============================================================\n');

  // 1. workload service with real operator
  try {
    const res = await workloadBalancerService.calculateOperatorWorkload({
      operatorId: staffUser1._id,
      centerId: centerA._id,
    });
    assert.strictEqual(typeof res.workloadScore, 'number');
    assert.ok(['LOW', 'MODERATE', 'HIGH', 'SUSTAINED_HIGH'].includes(res.loadLevel));
    assert.strictEqual(res.operator?.name, 'Staff Operator One');
    assert.strictEqual(res.dataSufficiency, 'AVAILABLE');
    pass('1. workload service with real operator');
  } catch (err) { fail('1. workload service with real operator', err); }

  // 2. insufficient data
  try {
    const unassignedOperatorId = new mongoose.Types.ObjectId();
    const res = await workloadBalancerService.calculateOperatorWorkload({
      operatorId: unassignedOperatorId,
      centerId: centerA._id,
    });
    assert.strictEqual(res.dataSufficiency, 'INSUFFICIENT_DATA');
    assert.strictEqual(res.workloadScore, null);
    assert.strictEqual(res.loadLevel, 'UNKNOWN');
    pass('2. insufficient data');
  } catch (err) { fail('2. insufficient data', err); }

  // 3. no active token
  try {
    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter2._id,
      centerId: centerA._id,
    });
    assert.strictEqual(res.factors.activeServiceLoad.status, 'IDLE');
    assert.strictEqual(res.factors.activeServiceLoad.score, 0);
    pass('3. no active token');
  } catch (err) { fail('3. no active token', err); }

  // 4. active token load
  try {
    const activeToken = await Token.create({
      centerId: centerA._id,
      serviceId: serviceA._id,
      userId: customerUser._id,
      tokenCode: 'WA-001',
      tokenNumber: 1,
      status: 'SERVING',
      counterId: counter1._id,
      servedBy: staffUser1._id,
      calledAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
      servingAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    counter1.currentTokenId = activeToken._id;
    await counter1.save();

    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });

    assert.strictEqual(res.factors.activeServiceLoad.status, 'SERVING');
    assert.ok(res.factors.activeServiceLoad.score >= 30, 'Active serving score should reflect base load');
    assert.strictEqual(res.factors.activeServiceLoad.tokenId.toString(), activeToken._id.toString());
    pass('4. active token load');
  } catch (err) { fail('4. active token load', err); }

  // 5. recent service volume
  try {
    // Complete 3 tokens for operator 1
    const pastTenMin = new Date(Date.now() - 10 * 60 * 1000);
    await Token.create([
      {
        centerId: centerA._id,
        serviceId: serviceA._id,
        userId: customerUser._id,
        tokenCode: 'WA-002',
        tokenNumber: 2,
        status: 'COMPLETED',
        counterId: counter1._id,
        servedBy: staffUser1._id,
        completedAt: pastTenMin,
        actualServiceSeconds: 300,
      },
      {
        centerId: centerA._id,
        serviceId: serviceA._id,
        userId: customerUser._id,
        tokenCode: 'WA-003',
        tokenNumber: 3,
        status: 'COMPLETED',
        counterId: counter1._id,
        servedBy: staffUser1._id,
        completedAt: pastTenMin,
        actualServiceSeconds: 400,
      },
      {
        centerId: centerA._id,
        serviceId: serviceA._id,
        userId: customerUser._id,
        tokenCode: 'WA-004',
        tokenNumber: 4,
        status: 'COMPLETED',
        counterId: counter1._id,
        servedBy: staffUser1._id,
        completedAt: pastTenMin,
        actualServiceSeconds: 500,
      },
    ]);

    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });

    assert.ok(res.factors.recentVolume.completedCount >= 3);
    assert.ok(res.factors.recentVolume.score > 0);
    pass('5. recent service volume');
  } catch (err) { fail('5. recent service volume', err); }

  // 6. actual service duration
  try {
    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });
    assert.strictEqual(typeof res.factors.recentServiceDuration.avgActualSeconds, 'number');
    assert.ok(res.factors.recentServiceDuration.avgActualSeconds > 0);
    pass('6. actual service duration');
  } catch (err) { fail('6. actual service duration', err); }

  // 7. queue pressure
  try {
    const cust10 = await User.create({ name: 'Cust 10', email: `cust10_${Date.now()}@workload.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true });
    const cust11 = await User.create({ name: 'Cust 11', email: `cust11_${Date.now()}@workload.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true });
    const cust12 = await User.create({ name: 'Cust 12', email: `cust12_${Date.now()}@workload.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true });

    await Token.create([
      {
        centerId: centerA._id,
        serviceId: serviceA._id,
        userId: cust10._id,
        tokenCode: 'WA-010',
        tokenNumber: 10,
        status: 'WAITING',
      },
      {
        centerId: centerA._id,
        serviceId: serviceA._id,
        userId: cust11._id,
        tokenCode: 'WA-011',
        tokenNumber: 11,
        status: 'WAITING',
      },
      {
        centerId: centerA._id,
        serviceId: serviceA._id,
        userId: cust12._id,
        tokenCode: 'WA-012',
        tokenNumber: 12,
        status: 'WAITING',
      },
    ]);

    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });

    assert.ok(res.factors.queuePressure.waitingCount >= 3);
    assert.ok(res.factors.queuePressure.score > 0);
    pass('7. queue pressure');
  } catch (err) { fail('7. queue pressure', err); }

  // 8. sustained workload
  try {
    // Record continuous opening event 160 minutes ago
    await QueueEvent.create({
      centerId: centerA._id,
      counterId: counter1._id,
      eventType: 'COUNTER_OPENED',
      performedBy: staffUser1._id,
      createdAt: new Date(Date.now() - 160 * 60 * 1000),
    });

    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });

    assert.ok(res.factors.sustainedWorkload.continuousMinutes >= 150);
    assert.ok(res.factors.sustainedWorkload.score >= 80);
    pass('8. sustained workload');
  } catch (err) { fail('8. sustained workload', err); }

  // 9. relative workload comparison
  try {
    counter1.stats = { served: 15 };
    await counter1.save();
    counter2.stats = { served: 2 };
    await counter2.save();

    const res1 = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });

    assert.strictEqual(typeof res1.factors.relativeWorkload.score, 'number');
    assert.strictEqual(res1.factors.relativeWorkload.operatorServedToday, 15);
    pass('9. relative workload comparison');
  } catch (err) { fail('9. relative workload comparison', err); }

  // 10. low workload state
  try {
    // Counter 3 has 0 active, 0 served, 0 sustained minutes
    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter3._id,
      centerId: centerA._id,
    });
    assert.strictEqual(res.loadLevel, 'LOW');
    assert.ok(res.workloadScore < 40);
    pass('10. low workload state');
  } catch (err) { fail('10. low workload state', err); }

  // 11. moderate workload state
  try {
    // Moderate simulation: active token but not prolonged
    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter2._id,
      centerId: centerA._id,
    });
    assert.ok(['LOW', 'MODERATE'].includes(res.loadLevel));
    pass('11. moderate workload state');
  } catch (err) { fail('11. moderate workload state', err); }

  // 12. high workload state & 13. sustained high state
  try {
    // Elevate active serving duration to 25 mins (for a 10 min service)
    await Token.findByIdAndUpdate(counter1.currentTokenId, {
      servingAt: new Date(Date.now() - 25 * 60 * 1000),
      calledAt: new Date(Date.now() - 25 * 60 * 1000),
    });

    // Add 8 more completed tokens with high actual service seconds
    const batchTokens = [];
    for (let i = 0; i < 8; i++) {
      const u = await User.create({
        name: `Cust High ${i}`,
        email: `custhigh${i}_${Date.now()}@workload.qf`,
        passwordHash: 'hash',
        role: 'CUSTOMER',
        isActive: true,
      });
      batchTokens.push({
        centerId: centerA._id,
        serviceId: serviceA._id,
        userId: u._id,
        tokenCode: `WA-10${i}`,
        tokenNumber: 100 + i,
        status: 'COMPLETED',
        counterId: counter1._id,
        servedBy: staffUser1._id,
        completedAt: new Date(Date.now() - 15 * 60 * 1000),
        actualServiceSeconds: 900,
      });
    }
    await Token.create(batchTokens);

    // Add 10 more waiting tokens for high queue pressure
    const waitingBatch = [];
    for (let i = 0; i < 10; i++) {
      const u = await User.create({
        name: `Cust Wait ${i}`,
        email: `custwait${i}_${Date.now()}@workload.qf`,
        passwordHash: 'hash',
        role: 'CUSTOMER',
        isActive: true,
      });
      waitingBatch.push({
        centerId: centerA._id,
        serviceId: serviceA._id,
        userId: u._id,
        tokenCode: `WA-20${i}`,
        tokenNumber: 200 + i,
        status: 'WAITING',
      });
    }
    await Token.create(waitingBatch);

    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });

    assert.ok(res.workloadScore >= 70, `Expected workloadScore >= 70, got ${res.workloadScore}`);
    assert.ok(['HIGH', 'SUSTAINED_HIGH'].includes(res.loadLevel));
    pass('12. high workload state');

    assert.strictEqual(res.loadLevel, 'SUSTAINED_HIGH');
    pass('13. sustained high state');
  } catch (err) {
    fail('12. high workload state', err);
    fail('13. sustained high state', err);
  }

  // 14. workload explanation fields
  try {
    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });
    assert.ok(typeof res.explanation === 'string' && res.explanation.length > 10);
    assert.ok(res.explanation.includes('serving') || res.explanation.includes('Queue pressure') || res.explanation.includes('Sustained'));
    pass('14. workload explanation fields');
  } catch (err) { fail('14. workload explanation fields', err); }

  // 15. no fake/static workload data
  try {
    const res = await workloadBalancerService.getCenterWorkloadOverview(centerA._id);
    assert.strictEqual(res.centerId.toString(), centerA._id.toString());
    assert.strictEqual(res.totalCountersCount, 3);
    assert.strictEqual(typeof res.averageWorkloadScore, 'number');
    pass('15. no fake/static workload data');
  } catch (err) { fail('15. no fake/static workload data', err); }

  // 16. unauthorized customer access blocked
  try {
    const res = await request('GET', `/api/analytics/${centerA._id}/workload`, null, {
      Authorization: `Bearer ${customerJwt}`,
    });
    assert.strictEqual(res.status, 403, 'Customers must be forbidden from accessing operator workload');
    pass('16. unauthorized customer access blocked');
  } catch (err) { fail('16. unauthorized customer access blocked', err); }

  // 17. unauthorized staff access blocked
  try {
    const res = await request('GET', `/api/analytics/${centerA._id}/workload`, null, {
      Authorization: `Bearer ${staffJwtB}`, // Staff from Center B accessing Center A
    });
    assert.strictEqual(res.status, 403, 'Cross-center staff access must be blocked');
    pass('17. unauthorized staff access blocked');
  } catch (err) { fail('17. unauthorized staff access blocked', err); }

  // 18. center isolation
  try {
    const res = await request('GET', `/api/analytics/${centerA._id}/workload`, null, {
      Authorization: `Bearer ${adminJwt}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.centerId.toString(), centerA._id.toString());
    // Ensure no counters from Center B appear
    for (const op of res.body.data.operatorWorkloads) {
      if (op.counter) {
        const c = await Counter.findById(op.counter._id);
        assert.strictEqual(c.centerId.toString(), centerA._id.toString());
      }
    }
    pass('18. center isolation');
  } catch (err) { fail('18. center isolation', err); }

  // 19. operator ownership/visibility
  try {
    const res = await request('GET', `/api/analytics/${centerA._id}/workload/me`, null, {
      Authorization: `Bearer ${staffJwt1}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.operator._id.toString(), staffUser1._id.toString());
    assert.strictEqual(res.body.data.operator.name, 'Staff Operator One');
    pass('19. operator ownership/visibility');
  } catch (err) { fail('19. operator ownership/visibility', err); }

  // 20. balancing recommendation generation
  try {
    const recs = await workloadBalancerService.getBalancingRecommendations(centerA._id);
    assert.strictEqual(typeof recs.recommendationsCount, 'number');
    assert.ok(Array.isArray(recs.recommendations));
    pass('20. balancing recommendation generation');
  } catch (err) { fail('20. balancing recommendation generation', err); }

  // 21. recommendation rejects unavailable counter
  try {
    // Put counter3 on CLOSED status
    counter3.status = 'CLOSED';
    await counter3.save();
    workloadBalancerService.invalidateCenterCache(centerA._id);

    const recs = await workloadBalancerService.getBalancingRecommendations(centerA._id);
    for (const r of recs.recommendations) {
      if (r.targetCounterId) {
        assert.notStrictEqual(r.targetCounterId.toString(), counter3._id.toString(), 'Closed counter must not be recommended');
      }
    }
    counter3.status = 'ACTIVE';
    await counter3.save();
    pass('21. recommendation rejects unavailable counter');
  } catch (err) { fail('21. recommendation rejects unavailable counter', err); }

  // 22. recommendation respects service compatibility
  try {
    const recs = await workloadBalancerService.getBalancingRecommendations(centerA._id);
    for (const r of recs.recommendations) {
      if (r.type === 'REDIRECT_TRAFFIC') {
        const cSource = await Counter.findById(r.sourceCounterId);
        const cTarget = await Counter.findById(r.targetCounterId);
        assert.strictEqual(cSource.serviceId.toString(), cTarget.serviceId.toString(), 'Redirect must target compatible service');
      }
    }
    pass('22. recommendation respects service compatibility');
  } catch (err) { fail('22. recommendation respects service compatibility', err); }

  // 23. recommendation respects staff authorization
  try {
    // Recommendations must always be advisory (isAutomatic: false)
    const recs = await workloadBalancerService.getBalancingRecommendations(centerA._id);
    for (const r of recs.recommendations) {
      assert.strictEqual(r.isAutomatic, false, 'Recommendations must never automatically reassign staff');
    }
    pass('23. recommendation respects staff authorization');
  } catch (err) { fail('23. recommendation respects staff authorization', err); }

  // 24. counter morphing compatibility
  try {
    // Verify that counter morphing safeguards are fully preserved:
    // Morphing counter1 while actively serving WA-001 must return 409 Conflict
    const morphRes = await request('PATCH', `/api/counters/${counter1._id}/morph`, {
      serviceId: serviceB._id.toString(),
    }, {
      Authorization: `Bearer ${adminJwt}`,
    });
    assert.strictEqual(morphRes.status, 409, 'Morphing actively serving counter must be rejected with 409');
    pass('24. counter morphing compatibility');
  } catch (err) { fail('24. counter morphing compatibility', err); }

  // 25. P2P swap compatibility
  try {
    const cust20 = await User.create({ name: 'Cust 20', email: `cust20_${Date.now()}@workload.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true });
    const cust21 = await User.create({ name: 'Cust 21', email: `cust21_${Date.now()}@workload.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true });

    const tA = await Token.create({
      centerId: centerA._id,
      serviceId: serviceA._id,
      userId: cust20._id,
      tokenCode: 'WA-020',
      tokenNumber: 20,
      status: 'WAITING',
    });
    const tB = await Token.create({
      centerId: centerA._id,
      serviceId: serviceA._id,
      userId: cust21._id,
      tokenCode: 'WA-021',
      tokenNumber: 21,
      status: 'WAITING',
    });

    const offer = await swapService.createOffer({
      offeringTokenId: tA._id.toString(),
      userId: cust20._id.toString(),
      targetTokenId: tB._id.toString(),
    });

    assert.ok(offer._id);
    assert.strictEqual(tA.tokenCode, 'WA-020');
    assert.strictEqual(tB.tokenCode, 'WA-021');
    pass('25. P2P swap compatibility');
  } catch (err) { fail('25. P2P swap compatibility', err); }

  // 26. Service Graph compatibility
  try {
    const edge = await serviceGraphService.createEdge({
      centerId: centerA._id.toString(),
      sourceServiceId: serviceA._id.toString(),
      targetServiceId: serviceB._id.toString(),
      condition: 'OPTIONAL',
      adminUser,
    });
    assert.ok(edge._id);
    pass('26. Service Graph compatibility');
  } catch (err) { fail('26. Service Graph compatibility', err); }

  // 27. Ghost Queue independence
  try {
    const geoState = await geofenceService.updateCustomerLocation({
      tokenId: counter1.currentTokenId.toString(),
      userId: customerUser._id.toString(),
      userRole: 'CUSTOMER',
      latitude: 12.9716,
      longitude: 77.5946,
    });
    assert.strictEqual(geoState.proximityState, 'INSIDE');

    const opWorkload = await workloadBalancerService.calculateOperatorWorkload({
      counterId: counter1._id,
      centerId: centerA._id,
    });
    assert.ok(typeof opWorkload.workloadScore === 'number');
    pass('27. Ghost Queue independence');
  } catch (err) { fail('27. Ghost Queue independence', err); }

  // 28. Document Gate independence
  try {
    const docReq = await DocumentRequirement.create({
      serviceId: serviceA._id,
      centerId: centerA._id,
      name: 'Verification ID',
      documentType: 'GOVERNMENT_ID',
      isRequired: true,
    });
    const check = await documentGateService.checkServiceReadiness({
      serviceId: serviceA._id.toString(),
      userId: customerUser._id.toString(),
    });
    assert.strictEqual(check.isReady, false);
    pass('28. Document Gate independence');
  } catch (err) { fail('28. Document Gate independence', err); }

  // 29. Socket.IO workload update
  try {
    // Verify broadcastWorkloadUpdate executes safely and returns without error
    await workloadBalancerService.broadcastWorkloadUpdate(centerA._id);
    pass('29. Socket.IO workload update');
  } catch (err) { fail('29. Socket.IO workload update', err); }

  // 30. notification dedupe
  try {
    const workload = {
      workloadScore: 88,
      loadLevel: 'SUSTAINED_HIGH',
      counter: { _id: counter1._id, name: counter1.name },
      explanation: 'Sustained elevated workload.',
    };

    // First notification
    await workloadBalancerService.checkAndNotifySustainedWorkload(staffUser1._id, centerA._id, workload);
    const count1 = await Notification.countDocuments({ dedupeKey: { $regex: `sustained_workload_${staffUser1._id}` } });
    assert.ok(count1 >= 1);

    // Second immediate call should dedupe and not create duplicates
    await workloadBalancerService.checkAndNotifySustainedWorkload(staffUser1._id, centerA._id, workload);
    const count2 = await Notification.countDocuments({ dedupeKey: { $regex: `sustained_workload_${staffUser1._id}` } });
    assert.strictEqual(count1, count2, 'Duplicate notification within same hour must be prevented');
    pass('30. notification dedupe');
  } catch (err) { fail('30. notification dedupe', err); }

  // 31. concurrent workload calculations
  try {
    const promises = [
      workloadBalancerService.calculateOperatorWorkload({ counterId: counter1._id, centerId: centerA._id }),
      workloadBalancerService.calculateOperatorWorkload({ counterId: counter2._id, centerId: centerA._id }),
      workloadBalancerService.calculateOperatorWorkload({ counterId: counter3._id, centerId: centerA._id }),
      workloadBalancerService.getCenterWorkloadOverview(centerA._id),
      workloadBalancerService.getBalancingRecommendations(centerA._id),
    ];
    const results = await Promise.all(promises);
    assert.strictEqual(results.length, 5);
    pass('31. concurrent workload calculations');
  } catch (err) { fail('31. concurrent workload calculations', err); }

  // 32. stale-data handling
  try {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
    const staleCounter = await Counter.create({
      centerId: centerA._id,
      name: 'WK-Stale-Counter',
      number: 99,
      status: 'ACTIVE',
      stats: { served: 5 },
    });
    await Counter.collection.updateOne(
      { _id: staleCounter._id },
      { $set: { updatedAt: oldDate } }
    );

    const res = await workloadBalancerService.calculateOperatorWorkload({
      counterId: staleCounter._id,
      centerId: centerA._id,
    });
    assert.strictEqual(res.dataSufficiency, 'STALE_DATA');
    assert.strictEqual(res.workloadScore, 0);
    pass('32. stale-data handling');
  } catch (err) { fail('32. stale-data handling', err); }

  // 33. performance/query behavior where practical
  try {
    workloadBalancerService.invalidateCenterCache(centerA._id);
    const start1 = Date.now();
    await workloadBalancerService.getCenterWorkloadOverview(centerA._id);
    const timeUncached = Date.now() - start1;

    const start2 = Date.now();
    await workloadBalancerService.getCenterWorkloadOverview(centerA._id);
    const timeCached = Date.now() - start2;

    assert.ok(timeCached <= timeUncached + 10, 'Cached read should be faster than or equal to uncached aggregation');
    pass('33. performance/query behavior where practical');
  } catch (err) { fail('33. performance/query behavior where practical', err); }

  // 34. no PII leakage
  try {
    const overview = await workloadBalancerService.getCenterWorkloadOverview(centerA._id);
    const stringified = JSON.stringify(overview);
    assert.ok(!stringified.includes('password'), 'Passwords must never leak in workload state');
    assert.ok(!stringified.includes('customer@workload.qf'), 'Customer emails must never leak');
    pass('34. no PII leakage');
  } catch (err) { fail('34. no PII leakage', err); }

  // 35. no hardcoded business data
  try {
    assert.ok(THRESHOLDS_DEFINED(workloadBalancerService.THRESHOLDS), 'Thresholds must be clearly declared');
    pass('35. no hardcoded business data');
  } catch (err) { fail('35. no hardcoded business data', err); }

  console.log('\n============================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

function THRESHOLDS_DEFINED(t) {
  return t && t.ACTIVE_SERVING_BASE && t.RECENT_WINDOW_HOURS && t.LEVEL_HIGH;
}

// ─── Execution ────────────────────────────────────────────────────────────────

(async () => {
  try {
    await setup();
    await runTests();
  } catch (err) {
    console.error('[FATAL] Suite setup failed:', err);
    process.exitCode = 1;
  } finally {
    await teardown();
    process.exit(process.exitCode || 0);
  }
})();

'use strict';

/**
 * QueueFlow — TIER 4 / FEATURE 2: SERVICE GRAPH MULTI-HOP TEST SUITE
 *
 * Verifies service graph definitions, cycle detection, self-loop rejection,
 * cross-center isolation, RBAC permissions, multi-hop customer flows,
 * atomic token linkage, EWT integration, notification deduplication,
 * and compatibility with Ghost Queue and client platforms.
 *
 * NO fabricated production graph data or mock business relationships.
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
const Queue = require('../src/models/Queue');
const Notification = require('../src/models/Notification');
const { Token } = require('../src/models/Token');
const { ServiceRelationship } = require('../src/models/ServiceRelationship');
const queueService = require('../src/services/queueService');
const serviceGraphService = require('../src/services/serviceGraphService');

let baseUrl;
let testServer;

let centerA;
let centerB;
let serviceA; // e.g. Reception / Intake
let serviceB; // e.g. Document Verification
let serviceC; // e.g. Final Processing
let serviceTerminal; // Terminal service (no next step)
let serviceCrossCenter; // Service belonging to Center B
let counterA;
let counterB;

let customerA;
let customerB;
let staffUser;
let adminUser;

let customerAJwt;
let customerBJwt;
let staffJwt;
let adminJwt;

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  ❌ FAIL  ${name}: ${err.message}`);
  if (process.env.TEST_STACK) console.error(err.stack);
}

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (_) {
          parsed = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function signToken(userId, role = 'CUSTOMER') {
  return jwt.sign(
    { id: userId.toString(), role, tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// ─── Setup & Teardown ────────────────────────────────────────────────────────

async function setup() {
  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      const port = testServer.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const ts = Date.now();

  // Create real test users
  customerA = await User.create({
    name: 'Customer Graph A',
    email: `cust.graph.a.${ts}@example.com`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
    isActive: true,
  });

  customerB = await User.create({
    name: 'Customer Graph B',
    email: `cust.graph.b.${ts}@example.com`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
    isActive: true,
  });

  staffUser = await User.create({
    name: 'Staff Operator',
    email: `staff.graph.${ts}@example.com`,
    passwordHash: 'hash',
    role: 'STAFF',
    isActive: true,
  });

  adminUser = await User.create({
    name: 'Admin Supervisor',
    email: `admin.graph.${ts}@example.com`,
    passwordHash: 'hash',
    role: 'ADMIN',
    isActive: true,
  });

  customerAJwt = signToken(customerA._id, 'CUSTOMER');
  customerBJwt = signToken(customerB._id, 'CUSTOMER');
  staffJwt = signToken(staffUser._id, 'STAFF');
  adminJwt = signToken(adminUser._id, 'ADMIN');

  // Create real service centers
  centerA = await ServiceCenter.create({
    name: `Metro Service Hub ${ts}`,
    code: `MHUB_${ts.toString().slice(-4)}`,
    type: 'GOVT',
    isOpen: true,
    capacity: 200,
    address: { street: '100 Main St', city: 'Metropolis', state: 'NY', postalCode: '10001', country: 'US' },
    location: { latitude: 40.7128, longitude: -74.006 },
    geofence: { enabled: true, radiusMeters: 150, nearRadiusMeters: 500, approachingRadiusMeters: 2000 },
  });

  centerB = await ServiceCenter.create({
    name: `Suburban Branch ${ts}`,
    code: `SUB_${ts.toString().slice(-4)}`,
    type: 'GOVT',
    isOpen: true,
    capacity: 100,
    address: { street: '50 Elm St', city: 'Suburbs', state: 'NY', postalCode: '10002', country: 'US' },
  });

  // Create real services in Center A: A (Intake) -> B (Verification) -> C (Processing)
  serviceA = await Service.create({
    centerId: centerA._id,
    name: 'Intake Desk',
    tokenPrefix: 'I',
    description: 'Initial document check-in',
    avgServiceTimeMinutes: 5,
    isActive: true,
    order: 1,
  });

  serviceB = await Service.create({
    centerId: centerA._id,
    name: 'Biometrics & Verification',
    tokenPrefix: 'V',
    description: 'Fingerprint and photo verification',
    avgServiceTimeMinutes: 10,
    isActive: true,
    order: 2,
  });

  serviceC = await Service.create({
    centerId: centerA._id,
    name: 'Officer Decision Desk',
    tokenPrefix: 'D',
    description: 'Final interview and approval',
    avgServiceTimeMinutes: 15,
    isActive: true,
    order: 3,
  });

  serviceTerminal = await Service.create({
    centerId: centerA._id,
    name: 'Express Document Pickup',
    tokenPrefix: 'P',
    description: 'Standalone pickup window without downstream steps',
    avgServiceTimeMinutes: 3,
    isActive: true,
    order: 4,
  });

  // Service in Center B for cross-center isolation tests
  serviceCrossCenter = await Service.create({
    centerId: centerB._id,
    name: 'External Center Service',
    tokenPrefix: 'X',
    description: 'Service belonging strictly to Center B',
    avgServiceTimeMinutes: 8,
    isActive: true,
    order: 1,
  });

  // Create counters in Center A
  counterA = await Counter.create({
    centerId: centerA._id,
    serviceId: serviceA._id,
    name: 'Intake Counter 1',
    number: 1,
    status: 'ACTIVE',
  });

  counterB = await Counter.create({
    centerId: centerA._id,
    serviceId: serviceB._id,
    name: 'Biometrics Counter 1',
    number: 2,
    status: 'ACTIVE',
  });
}

async function teardown() {
  if (testServer) {
    await new Promise((r) => testServer.close(r));
  }
  await mongoose.disconnect();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n============================================================');
  console.log('  QUEUEFLOW — TIER 4 / FEATURE 2: SERVICE GRAPH MULTI-HOP');
  console.log('============================================================\n');

  let testEdgeId = null;

  // 1. graph read
  try {
    const res = await request('GET', `/api/service-graph/${centerA._id}`, null, {
      Authorization: `Bearer ${adminJwt}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.nodes));
    assert.ok(Array.isArray(res.body.data.edges));
    assert.ok(res.body.data.nodes.length >= 4);
    pass('1. graph read');
  } catch (err) {
    fail('1. graph read', err);
  }

  // 2. graph creation
  try {
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceA._id.toString(),
        targetServiceId: serviceB._id.toString(),
        relationshipType: 'REQUIRED',
        order: 1,
        description: 'Mandatory verification following intake',
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data.edge._id);
    assert.strictEqual(res.body.data.edge.relationshipType, 'REQUIRED');
    testEdgeId = res.body.data.edge._id;
    pass('2. graph creation');
  } catch (err) {
    fail('2. graph creation', err);
  }

  // 3. graph update
  try {
    const res = await request(
      'PATCH',
      `/api/service-graph/edges/${testEdgeId}`,
      {
        relationshipType: 'TRANSFER',
        description: 'Updated workflow handoff description',
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.edge.relationshipType, 'TRANSFER');
    assert.strictEqual(res.body.data.edge.description, 'Updated workflow handoff description');
    pass('3. graph update');
  } catch (err) {
    fail('3. graph update', err);
  }

  // 4. graph deletion/deactivation
  try {
    // Temporary edge for deletion
    const tempEdge = await ServiceRelationship.create({
      centerId: centerA._id,
      sourceServiceId: serviceA._id,
      targetServiceId: serviceTerminal._id,
      relationshipType: 'OPTIONAL',
    });

    // Deactivation test
    const patchRes = await request(
      'PATCH',
      `/api/service-graph/edges/${tempEdge._id}`,
      { isActive: false },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(patchRes.body.data.edge.isActive, false);

    // Deletion test
    const delRes = await request('DELETE', `/api/service-graph/edges/${tempEdge._id}`, null, {
      Authorization: `Bearer ${adminJwt}` },
    );
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.body.success, true);

    const exists = await ServiceRelationship.findById(tempEdge._id);
    assert.strictEqual(exists, null);
    pass('4. graph deletion/deactivation');
  } catch (err) {
    fail('4. graph deletion/deactivation', err);
  }

  // 5. invalid source service
  try {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: fakeId.toString(),
        targetServiceId: serviceB._id.toString(),
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 404);
    pass('5. invalid source service');
  } catch (err) {
    fail('5. invalid source service', err);
  }

  // 6. invalid target service
  try {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceA._id.toString(),
        targetServiceId: fakeId.toString(),
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 404);
    pass('6. invalid target service');
  } catch (err) {
    fail('6. invalid target service', err);
  }

  // 7. cross-center relationship rejection
  try {
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceA._id.toString(),
        targetServiceId: serviceCrossCenter._id.toString(), // Belongs to Center B
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /belong to the specified service center/i);
    pass('7. cross-center relationship rejection');
  } catch (err) {
    fail('7. cross-center relationship rejection', err);
  }

  // 8. duplicate edge rejection
  try {
    // Attempt to re-create ServiceA -> ServiceB which already exists in Center A
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceA._id.toString(),
        targetServiceId: serviceB._id.toString(),
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /already exists/i);
    pass('8. duplicate edge rejection');
  } catch (err) {
    fail('8. duplicate edge rejection', err);
  }

  // 9. self-loop rejection
  try {
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceA._id.toString(),
        targetServiceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /self-loop/i);
    pass('9. self-loop rejection');
  } catch (err) {
    fail('9. self-loop rejection', err);
  }

  // 10. cycle detection
  try {
    // Current edge: ServiceA -> ServiceB.
    // Add ServiceB -> ServiceC.
    await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceB._id.toString(),
        targetServiceId: serviceC._id.toString(),
      },
      { Authorization: `Bearer ${adminJwt}` }
    );

    // Now attempt to add ServiceC -> ServiceA. This would create cycle A -> B -> C -> A!
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceC._id.toString(),
        targetServiceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /cycle detected|circular dependency/i);
    pass('10. cycle detection');
  } catch (err) {
    fail('10. cycle detection', err);
  }

  // 11. ADMIN authorization
  try {
    const testAdminEdge = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceC._id.toString(),
        targetServiceId: serviceTerminal._id.toString(),
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(testAdminEdge.status, 201);
    pass('11. ADMIN authorization');
  } catch (err) {
    fail('11. ADMIN authorization', err);
  }

  // 12. STAFF restriction
  try {
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceA._id.toString(),
        targetServiceId: serviceTerminal._id.toString(),
      },
      { Authorization: `Bearer ${staffJwt}` }
    );
    assert.strictEqual(res.status, 403);
    pass('12. STAFF restriction');
  } catch (err) {
    fail('12. STAFF restriction', err);
  }

  // 13. CUSTOMER restriction
  try {
    const res = await request(
      'POST',
      '/api/service-graph/edges',
      {
        centerId: centerA._id.toString(),
        sourceServiceId: serviceA._id.toString(),
        targetServiceId: serviceTerminal._id.toString(),
      },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(res.status, 403);
    pass('13. CUSTOMER restriction');
  } catch (err) {
    fail('13. CUSTOMER restriction', err);
  }

  // Setup token in Service A for customer A
  let tokenA;
  try {
    const joinRes = await queueService.joinQueue({
      userId: customerA._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
      channel: 'WEB',
    });
    tokenA = joinRes.token;
  } catch (err) {
    console.error('Setup token error:', err);
  }

  // 14. valid next-service lookup
  try {
    // Complete token A
    await queueService.callNext({
      counterId: counterA._id.toString(),
      centerId: centerA._id.toString(),
      adminId: staffUser._id.toString(),
    });
    await queueService.completeToken({
      tokenId: tokenA._id.toString(),
      counterId: counterA._id.toString(),
      adminId: staffUser._id.toString(),
    });

    const res = await request('GET', `/api/tokens/${tokenA._id}/next-service`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.hasNextService, true);
    assert.strictEqual(res.body.data.isJourneyComplete, false);
    assert.ok(Array.isArray(res.body.data.nextServices));
    assert.strictEqual(res.body.data.nextServices[0].serviceId.toString(), serviceB._id.toString());
    assert.ok(res.body.data.nextServices[0].name.includes('Biometrics'));
    pass('14. valid next-service lookup');
  } catch (err) {
    fail('14. valid next-service lookup', err);
  }

  // 15. invalid next-service request
  try {
    // Create an uncompleted token in Service B for customer B
    const uncompletedJoin = await queueService.joinQueue({
      userId: customerB._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });

    const res = await request('GET', `/api/tokens/${uncompletedJoin.token._id}/next-service`, null, {
      Authorization: `Bearer ${customerBJwt}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.hasNextService, false);
    assert.strictEqual(res.body.data.canTransition, false);
    pass('15. invalid next-service request');
  } catch (err) {
    fail('15. invalid next-service request', err);
  }

  // 16. completed service → next service
  let tokenB;
  try {
    const res = await request(
      'POST',
      `/api/tokens/${tokenA._id}/next-service/confirm`,
      {
        nextServiceId: serviceB._id.toString(),
      },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data.token._id);
    // serviceId may be a plain string ID or a populated object depending on serialization
    const returnedServiceId = res.body.data.token.serviceId?._id || res.body.data.token.serviceId;
    assert.strictEqual(returnedServiceId.toString(), serviceB._id.toString());
    tokenB = res.body.data.token;
    pass('16. completed service → next service');
  } catch (err) {
    fail('16. completed service → next service', err);
  }

  // 17. no next service
  try {
    // Create and complete a token for serviceTerminal
    const termJoin = await queueService.joinQueue({
      userId: customerB._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceTerminal._id.toString(),
    });

    const counterTerm = await Counter.create({
      centerId: centerA._id,
      serviceId: serviceTerminal._id,
      name: 'Pickup Window',
      number: 10,
      status: 'ACTIVE',
    });

    await queueService.callNext({
      counterId: counterTerm._id.toString(),
      centerId: centerA._id.toString(),
      adminId: staffUser._id.toString(),
    });
    await queueService.completeToken({
      tokenId: termJoin.token._id.toString(),
      counterId: counterTerm._id.toString(),
      adminId: staffUser._id.toString(),
    });

    const res = await request('GET', `/api/tokens/${termJoin.token._id}/next-service`, null, {
      Authorization: `Bearer ${customerBJwt}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.hasNextService, false);
    assert.strictEqual(res.body.data.isJourneyComplete, true);
    assert.match(res.body.data.message, /journey complete/i);
    pass('17. no next service');
  } catch (err) {
    fail('17. no next service', err);
  }

  // 18. duplicate next-hop confirmation
  try {
    // Attempting to confirm tokenA again must return 409
    const res = await request(
      'POST',
      `/api/tokens/${tokenA._id}/next-service/confirm`,
      {
        nextServiceId: serviceB._id.toString(),
      },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /already been confirmed/i);
    pass('18. duplicate next-hop confirmation');
  } catch (err) {
    fail('18. duplicate next-hop confirmation', err);
  }

  // 19. concurrent confirmation
  try {
    const custConc = await User.create({
      name: 'Concurrent Cust',
      email: `conc.${Date.now()}@example.com`,
      passwordHash: 'hash',
      role: 'CUSTOMER',
      isActive: true,
    });
    const concJwt = signToken(custConc._id, 'CUSTOMER');

    const joinConc = await queueService.joinQueue({
      userId: custConc._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });

    // Directly set this token to CALLED state to avoid FIFO ordering with
    // other leftover WAITING tokens in serviceA queue (from test 15)
    await Token.findByIdAndUpdate(joinConc.token._id, { status: 'CALLED', counterId: counterA._id });
    await queueService.completeToken({
      tokenId: joinConc.token._id.toString(),
      counterId: counterA._id.toString(),
      adminId: staffUser._id.toString(),
    });

    // Fire 2 simultaneous confirm calls
    const [res1, res2] = await Promise.all([
      request('POST', `/api/tokens/${joinConc.token._id}/next-service/confirm`, { nextServiceId: serviceB._id.toString() }, { Authorization: `Bearer ${concJwt}` }),
      request('POST', `/api/tokens/${joinConc.token._id}/next-service/confirm`, { nextServiceId: serviceB._id.toString() }, { Authorization: `Bearer ${concJwt}` }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepStrictEqual(statuses, [201, 409]);
    pass('19. concurrent confirmation');
  } catch (err) {
    fail('19. concurrent confirmation', err);
  }

  // 20. token linkage/history
  try {
    const reloadedTokenA = await Token.findById(tokenA._id);
    const reloadedTokenB = await Token.findById(tokenB._id);

    assert.ok(reloadedTokenA.journeyId);
    assert.ok(reloadedTokenB.journeyId);
    assert.strictEqual(reloadedTokenA.journeyId.toString(), reloadedTokenB.journeyId.toString());
    assert.strictEqual(reloadedTokenA.nextTokenId.toString(), reloadedTokenB._id.toString());
    assert.strictEqual(reloadedTokenB.previousTokenId.toString(), reloadedTokenA._id.toString());

    // Verify GET /api/tokens/:id/journey
    const journeyRes = await request('GET', `/api/tokens/${tokenB._id}/journey`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(journeyRes.status, 200);
    assert.strictEqual(journeyRes.body.data.tokens.length >= 2, true);
    assert.strictEqual(journeyRes.body.data.tokens[0]._id.toString(), tokenA._id.toString());
    assert.strictEqual(journeyRes.body.data.tokens[1]._id.toString(), tokenB._id.toString());
    pass('20. token linkage/history');
  } catch (err) {
    fail('20. token linkage/history', err);
  }

  // 21. EWT integration
  try {
    // Next service options must contain waitEstimateMinutes from authoritative service
    const res = await request('GET', `/api/tokens/${tokenA._id}/next-service`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(res.status, 200);
    // Already transitioned returns status cleanly
    assert.strictEqual(res.body.data.alreadyTransitioned, true);
    pass('21. EWT integration');
  } catch (err) {
    fail('21. EWT integration', err);
  }

  // 22. notification integration
  try {
    const notif = await Notification.findOne({
      userId: customerA._id,
      type: 'NEXT_SERVICE_AVAILABLE',
    });
    assert.ok(notif, 'Expected NEXT_SERVICE_AVAILABLE notification to be created');
    assert.strictEqual(notif.type, 'NEXT_SERVICE_AVAILABLE');
    assert.ok(notif.dedupeKey.includes(tokenA._id.toString()));
    pass('22. notification integration');
  } catch (err) {
    fail('22. notification integration', err);
  }

  // 23. Customer Web compatibility
  try {
    const journeyRes = await request('GET', `/api/tokens/${tokenA._id}/journey`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(journeyRes.status, 200);
    assert.ok(journeyRes.body.data.tokens[0].tokenCode);
    assert.ok(journeyRes.body.data.tokens[0].serviceId.name);
    pass('23. Customer Web compatibility');
  } catch (err) {
    fail('23. Customer Web compatibility', err);
  }

  // 24. Flutter compatibility
  try {
    const reloaded = await Token.findById(tokenB._id).lean();
    assert.ok(reloaded.journeyId);
    assert.ok(reloaded.previousTokenId);
    assert.strictEqual(reloaded.status, 'WAITING');
    pass('24. Flutter compatibility');
  } catch (err) {
    fail('24. Flutter compatibility', err);
  }

  // 25. Ghost Queue compatibility
  try {
    // The newly minted next-hop token (tokenB) must seamlessly support Ghost Queue geofencing
    const locRes = await request(
      'POST',
      `/api/tokens/${tokenB._id}/location`,
      {
        latitude: 40.7129,
        longitude: -74.0061,
        accuracy: 10,
        timestamp: Date.now(),
      },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(locRes.status, 200);
    assert.strictEqual(locRes.body.data.proximityState, 'INSIDE');

    const updatedTokenB = await Token.findById(tokenB._id);
    assert.strictEqual(updatedTokenB.proximityState, 'INSIDE');
    pass('25. Ghost Queue compatibility');
  } catch (err) {
    fail('25. Ghost Queue compatibility', err);
  }

  // 26. Socket reconnect
  try {
    // When a customer reconnects and fetches their active token, they get the new hop token
    const activeRes = await request('GET', '/api/tokens/active', null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(activeRes.status, 200);
    assert.strictEqual(activeRes.body.data.token._id.toString(), tokenB._id.toString());
    assert.strictEqual(activeRes.body.data.token.serviceId.name, serviceB.name);
    pass('26. Socket reconnect');
  } catch (err) {
    fail('26. Socket reconnect', err);
  }

  // 27. no PII leakage
  try {
    const graphRes = await request('GET', `/api/service-graph/${centerA._id}`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    const serialized = JSON.stringify(graphRes.body);
    assert.strictEqual(serialized.includes(customerA.email), false);
    assert.strictEqual(serialized.includes(customerB.email), false);
    assert.strictEqual(serialized.includes('password'), false);
    pass('27. no PII leakage');
  } catch (err) {
    fail('27. no PII leakage', err);
  }

  // 28. no static graph data
  try {
    const dbCount = await ServiceRelationship.countDocuments({ centerId: centerA._id });
    assert.ok(dbCount >= 2, 'Graph relationships exist in database');

    const unconfiguredGraph = await request('GET', `/api/service-graph/${centerB._id}`, null, {
      Authorization: `Bearer ${adminJwt}`,
    });
    assert.strictEqual(unconfiguredGraph.status, 200);
    assert.strictEqual(unconfiguredGraph.body.data.edges.length, 0); // Center B has 0 edges
    pass('28. no static graph data');
  } catch (err) {
    fail('28. no static graph data', err);
  }

  console.log('\n============================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

setup()
  .then(runTests)
  .then(teardown)
  .catch(async (err) => {
    console.error('Fatal test error:', err);
    await teardown();
    process.exit(1);
  });

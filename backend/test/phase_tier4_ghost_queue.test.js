'use strict';

/**
 * QueueFlow — TIER 4 / FEATURE 1: GHOST QUEUE GEOFENCING TEST SUITE
 *
 * Verifies server-authoritative geofencing, distance calculation, state evaluation,
 * privacy guarantees, anti-spoofing validations, notification deduplication,
 * rate limiting, and lifecycle compatibility against the real MongoDB Atlas database.
 *
 * NO fabricated production coordinates or mock business data.
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
const queueService = require('../src/services/queueService');
const geofenceService = require('../src/services/geofenceService');
const { calculateHaversineDistance } = geofenceService;
const { createLimiter, QueueFlowDistributedStore } = require('../src/middleware/rateLimiter');

let baseUrl;
let testServer;

let centerConfigured;
let centerUnconfigured;
let serviceConfigured;
let serviceUnconfigured;
let counterConfigured;

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

  // Create Center A with REAL configured coordinates & geofence:
  // Bangalore City Center: 12.9716, 77.5946
  centerConfigured = await ServiceCenter.create({
    name: `Bengaluru Center ${ts}`,
    code: `BLR_${ts}`.slice(0, 18),
    type: 'BANK',
    capacity: 100,
    isOpen: true,
    location: {
      latitude: 12.9716,
      longitude: 77.5946,
    },
    geofence: {
      enabled: true,
      radiusMeters: 500,           // INSIDE <= 500m
      nearRadiusMeters: 1000,       // NEAR <= 1000m
      approachingRadiusMeters: 2000,// APPROACHING <= 2000m
    },
  });

  // Create Center B WITHOUT coordinates (truthful unconfigured state)
  centerUnconfigured = await ServiceCenter.create({
    name: `Rural Unconfigured Center ${ts}`,
    code: `RUR_${ts}`.slice(0, 18),
    type: 'BANK',
    capacity: 100,
    isOpen: true,
    location: {
      latitude: null,
      longitude: null,
    },
    geofence: {
      enabled: false,
      radiusMeters: 500,
    },
  });

  serviceConfigured = await Service.create({
    centerId: centerConfigured._id,
    name: `Cash Deposit ${ts}`,
    tokenPrefix: 'D',
    avgServiceTimeMinutes: 10,
    isActive: true,
  });

  serviceUnconfigured = await Service.create({
    centerId: centerUnconfigured._id,
    name: `Rural Service ${ts}`,
    tokenPrefix: 'R',
    avgServiceTimeMinutes: 10,
    isActive: true,
  });

  counterConfigured = await Counter.create({
    centerId: centerConfigured._id,
    name: 'Counter 1',
    number: 1,
    serviceId: serviceConfigured._id,
    status: 'ACTIVE',
  });

  customerA = await User.create({
    name: `Customer A ${ts}`,
    email: `custA_${ts}@test.com`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
  });

  customerB = await User.create({
    name: `Customer B ${ts}`,
    email: `custB_${ts}@test.com`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
  });

  staffUser = await User.create({
    name: `Staff ${ts}`,
    email: `staff_${ts}@test.com`,
    passwordHash: 'hash',
    role: 'STAFF',
    centerId: centerConfigured._id,
  });

  adminUser = await User.create({
    name: `Admin ${ts}`,
    email: `admin_${ts}@test.com`,
    passwordHash: 'hash',
    role: 'ADMIN',
  });

  customerAJwt = signToken(customerA._id, 'CUSTOMER');
  customerBJwt = signToken(customerB._id, 'CUSTOMER');
  staffJwt = signToken(staffUser._id, 'STAFF');
  adminJwt = signToken(adminUser._id, 'ADMIN');
}

async function teardown() {
  try {
    if (centerConfigured) {
      await Token.deleteMany({ centerId: centerConfigured._id });
      await Queue.deleteMany({ centerId: centerConfigured._id });
      await Service.deleteMany({ centerId: centerConfigured._id });
      await Counter.deleteMany({ centerId: centerConfigured._id });
      await ServiceCenter.deleteOne({ _id: centerConfigured._id });
    }
    if (centerUnconfigured) {
      await Token.deleteMany({ centerId: centerUnconfigured._id });
      await Queue.deleteMany({ centerId: centerUnconfigured._id });
      await Service.deleteMany({ centerId: centerUnconfigured._id });
      await ServiceCenter.deleteOne({ _id: centerUnconfigured._id });
    }
    if (customerA) await User.deleteOne({ _id: customerA._id });
    if (customerB) await User.deleteOne({ _id: customerB._id });
    if (staffUser) await User.deleteOne({ _id: staffUser._id });
    if (adminUser) await User.deleteOne({ _id: adminUser._id });
  } catch (_) {}

  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
  await mongoose.disconnect();
}

// ─── Test Suite Execution ────────────────────────────────────────────────────

async function runTests() {
  console.log('\n============================================================');
  console.log('  QUEUEFLOW — TIER 4 / FEATURE 1: GHOST QUEUE GEOFENCING');
  console.log('============================================================\n');

  let activeTokenA;

  // Setup initial token for Customer A
  // Location is supplied because the Phase 1 join geofence requires it for a
  // center that has a position configured. The point is the center's own
  // coordinate, so the join is unambiguously inside the 100 m radius and the
  // test goes on to exercise proximity transitions as before.
  const joinRes = await queueService.joinQueue({
    userId: customerA._id.toString(),
    centerId: centerConfigured._id.toString(),
    serviceId: serviceConfigured._id.toString(),
    latitude: 12.9716,
    longitude: 77.5946,
    accuracy: 15,
  });
  activeTokenA = joinRes.token;

  // 1. Valid coordinates
  try {
    // Coordinate ~50m from center: (12.9718, 77.5948)
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9718,
      longitude: 77.5948,
      accuracy: 15,
      timestamp: Date.now(),
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.proximityState, 'INSIDE');
    assert.ok(typeof res.body.data.distanceMeters === 'number', 'distanceMeters should be a number');
    assert.ok(res.body.data.distanceMeters <= 500, 'Customer should be within 500m');
    pass('1. valid coordinates');
  } catch (err) {
    fail('1. valid coordinates', err);
  }

  // 2. Invalid latitude
  try {
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 105.0, // Impossible latitude > 90
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 400, `Expected 400 Bad Request, got ${res.status}`);
    pass('2. invalid latitude');
  } catch (err) {
    fail('2. invalid latitude', err);
  }

  // 3. Invalid longitude
  try {
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 200.0, // Impossible longitude > 180
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 400, `Expected 400 Bad Request, got ${res.status}`);
    pass('3. invalid longitude');
  } catch (err) {
    fail('3. invalid longitude', err);
  }

  // 4. Missing coordinates
  try {
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      accuracy: 20,
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 400, `Expected 400 Bad Request, got ${res.status}`);
    pass('4. missing coordinates');
  } catch (err) {
    fail('4. missing coordinates', err);
  }

  // 5. Distance calculation (Haversine formula verification)
  try {
    // Known points:
    // P1: (0, 0), P2: (0, 1) on equator -> ~111,195 meters
    const dist1 = calculateHaversineDistance(0, 0, 0, 1);
    assert.ok(dist1 > 111000 && dist1 < 112000, `Expected ~111.19 km, got ${dist1}`);

    // Same point -> 0 meters
    const distZero = calculateHaversineDistance(12.9716, 77.5946, 12.9716, 77.5946);
    assert.strictEqual(distZero, 0, 'Same point distance must be 0');

    // 0.001 deg latitude difference (~111 meters)
    const distSmall = calculateHaversineDistance(12.9716, 77.5946, 12.9726, 77.5946);
    assert.ok(distSmall >= 110 && distSmall <= 112, `Expected ~111m, got ${distSmall}`);
    pass('5. distance calculation');
  } catch (err) {
    fail('5. distance calculation', err);
  }

  // 6. Inside geofence
  try {
    // ~100m from center: (12.9720, 77.5950)
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9720,
      longitude: 77.5950,
      accuracy: 10,
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.proximityState, 'INSIDE');
    assert.ok(res.body.data.distanceMeters <= 500, 'Must be within radiusMeters (500)');
    pass('6. inside geofence');
  } catch (err) {
    fail('6. inside geofence', err);
  }

  // 7. Outside geofence
  try {
    // Mysore Palace (~130 km away from Bangalore): 12.3051, 76.6551
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.3051,
      longitude: 76.6551,
      accuracy: 15,
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.proximityState, 'OUTSIDE');
    assert.ok(res.body.data.distanceMeters > 2000, 'Distance must exceed approaching radius (2000m)');
    pass('7. outside geofence');
  } catch (err) {
    fail('7. outside geofence', err);
  }

  // 8. Approaching state
  try {
    // Point ~1.5 km away from Bangalore Center: (12.9850, 77.5946)
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9850,
      longitude: 77.5946,
      accuracy: 15,
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.proximityState, 'APPROACHING');
    assert.ok(res.body.data.distanceMeters > 1000 && res.body.data.distanceMeters <= 2000,
      `Expected between 1000m and 2000m, got ${res.body.data.distanceMeters}`);
    pass('8. approaching state');
  } catch (err) {
    fail('8. approaching state', err);
  }

  // 9. Stale location
  try {
    // 10 minutes in the past (> 5 min threshold)
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
      timestamp: tenMinutesAgo,
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 400, 'Expected 400 for stale incoming timestamp');

    // Also test read-staleness via getTokenProximity
    const tokenDoc = await Token.findById(activeTokenA._id);
    tokenDoc.proximityUpdatedAt = new Date(Date.now() - 15 * 60 * 1000); // 15 mins ago
    tokenDoc.proximityState = 'INSIDE';
    await tokenDoc.save();

    const proxRes = await request('GET', `/api/tokens/${activeTokenA._id}/proximity`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(proxRes.status, 200);
    assert.strictEqual(proxRes.body.data.proximityState, 'STALE', 'Read-stale token proximity must be STALE');
    pass('9. stale location');
  } catch (err) {
    fail('9. stale location', err);
  }

  // 10. Low-accuracy location
  try {
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
      accuracy: 2500, // 2.5km accuracy uncertainty is too low for geofencing
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 400, 'Expected 400 for low accuracy > 1000m');
    pass('10. low-accuracy location');
  } catch (err) {
    fail('10. low-accuracy location', err);
  }

  // 11. Unauthenticated location update
  try {
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }); // No Auth header

    assert.strictEqual(res.status, 401, 'Unauthenticated request must return 401');
    pass('11. unauthenticated location update');
  } catch (err) {
    fail('11. unauthenticated location update', err);
  }

  // 12. Customer ownership (IDOR check)
  try {
    // Customer B attempts to update location for Customer A's token
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerBJwt}` });

    assert.strictEqual(res.status, 403, `Non-owner must be rejected with 403, got ${res.status}`);
    pass('12. customer ownership');
  } catch (err) {
    fail('12. customer ownership', err);
  }

  // 13. Cross-center rejection
  try {
    // Client attempts to pass a centerId that does not match token.centerId
    const res = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
      centerId: centerUnconfigured._id.toString(), // Wrong center
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(res.status, 400, 'Cross-center spoofing must return 400');
    pass('13. cross-center rejection');
  } catch (err) {
    fail('13. cross-center rejection', err);
  }

  // 14. Rate limiting
  try {
    // Create dedicated rate limiter with small limit (3 requests) to test 429
    const testLimiter = createLimiter({
      prefix: 'rl:test_loc:',
      windowMs: 60 * 1000,
      max: 3,
      storeOptions: { isTest: true },
      keyGenerator: (req) => req.ip,
      message: { success: false, message: 'Too many location updates' },
    });

    const mockReq = { ip: '192.168.1.99', headers: {} };
    let rateLimited = false;

    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => {
        const mockRes = {
          status: (code) => {
            if (code === 429) rateLimited = true;
            return { json: () => resolve() };
          },
          setHeader: () => {},
        };
        testLimiter(mockReq, mockRes, () => resolve());
      });
    }

    assert.strictEqual(rateLimited, true, 'Rate limiter must trigger 429 when max requests exceeded');
    pass('14. rate limiting');
  } catch (err) {
    fail('14. rate limiting', err);
  }

  // 15. State transition (OUTSIDE -> APPROACHING -> INSIDE)
  try {
    // Step 1: Outside (10km away: 13.0600, 77.5946)
    const res1 = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 13.0600,
      longitude: 77.5946,
      accuracy: 10,
    }, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(res1.body.data.proximityState, 'OUTSIDE');

    // Step 2: Approaching (1.5km away: 12.9850, 77.5946)
    const res2 = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9850,
      longitude: 77.5946,
      accuracy: 10,
    }, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(res2.body.data.proximityState, 'APPROACHING');

    // Step 3: Inside (50m away: 12.9718, 77.5948)
    const res3 = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9718,
      longitude: 77.5948,
      accuracy: 10,
    }, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(res3.body.data.proximityState, 'INSIDE');

    const updatedToken = await Token.findById(activeTokenA._id);
    assert.strictEqual(updatedToken.proximityState, 'INSIDE');
    pass('15. state transition');
  } catch (err) {
    fail('15. state transition', err);
  }

  // 16. Notification deduplication
  try {
    // Send repeated updates while already INSIDE
    const res1 = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9717,
      longitude: 77.5947,
    }, { Authorization: `Bearer ${customerAJwt}` });

    const res2 = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerAJwt}` });

    // Dedupe key ensures exactly 1 GEOFENCE_INSIDE notification exists for activeTokenA
    const notifications = await Notification.find({
      tokenId: activeTokenA._id,
      type: 'GEOFENCE_INSIDE',
    });

    assert.strictEqual(notifications.length, 1, `Expected exactly 1 notification, found ${notifications.length}`);
    pass('16. notification deduplication');
  } catch (err) {
    fail('16. notification deduplication', err);
  }

  // 17. No duplicate token creation
  try {
    const tokenCountBefore = await Token.countDocuments({ userId: customerA._id });

    // Send 3 location updates
    for (let i = 0; i < 3; i++) {
      await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
        latitude: 12.9716,
        longitude: 77.5946,
      }, { Authorization: `Bearer ${customerAJwt}` });
    }

    const tokenCountAfter = await Token.countDocuments({ userId: customerA._id });
    assert.strictEqual(tokenCountAfter, tokenCountBefore, 'Token count must not increase after location updates');
    pass('17. no duplicate token creation');
  } catch (err) {
    fail('17. no duplicate token creation', err);
  }

  // 18. Queue position unchanged
  try {
    const tokenBefore = await Token.findById(activeTokenA._id);
    const originalTokenNumber = tokenBefore.tokenNumber;
    const originalPosition = tokenBefore.currentPosition;

    // Send location update
    await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerAJwt}` });

    const tokenAfter = await Token.findById(activeTokenA._id);
    assert.strictEqual(tokenAfter.tokenNumber, originalTokenNumber, 'Token number must not change');
    assert.strictEqual(tokenAfter.currentPosition, originalPosition, 'Queue position must not change');
    pass('18. queue position unchanged');
  } catch (err) {
    fail('18. queue position unchanged', err);
  }

  // 19. Location unavailable behavior (Center without coordinates)
  try {
    // Create token for unconfigured center
    const joinResUnconf = await queueService.joinQueue({
      userId: customerB._id.toString(),
      centerId: centerUnconfigured._id.toString(),
      serviceId: serviceUnconfigured._id.toString(),
    });
    const tokenB = joinResUnconf.token;

    // Submit location for token at unconfigured center
    const res = await request('POST', `/api/tokens/${tokenB._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerBJwt}` });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.proximityState, 'LOCATION_UNAVAILABLE',
      'Should report truthful LOCATION_UNAVAILABLE state');
    assert.strictEqual(res.body.data.distanceMeters, null);

    const tokenDoc = await Token.findById(tokenB._id);
    assert.strictEqual(tokenDoc.proximityState, 'LOCATION_UNAVAILABLE');
    pass('19. location unavailable behavior');
  } catch (err) {
    fail('19. location unavailable behavior', err);
  }

  // 20. No precise location leakage
  try {
    // Check update response
    const updateRes = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerAJwt}` });

    assert.strictEqual(updateRes.body.data.latitude, undefined, 'Response must not leak latitude');
    assert.strictEqual(updateRes.body.data.longitude, undefined, 'Response must not leak longitude');

    // Check GET token response
    const getRes = await request('GET', `/api/tokens/${activeTokenA._id}`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(getRes.body.data.token.latitude, undefined, 'GET token must not leak latitude');
    assert.strictEqual(getRes.body.data.token.longitude, undefined, 'GET token must not leak longitude');

    // Check GET proximity response
    const proxRes = await request('GET', `/api/tokens/${activeTokenA._id}/proximity`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(proxRes.body.data.latitude, undefined, 'GET proximity must not leak latitude');
    assert.strictEqual(proxRes.body.data.longitude, undefined, 'GET proximity must not leak longitude');

    // Check Admin Resource Hub overview response
    const hubRes = await request('GET', `/api/analytics/${centerConfigured._id}/operational-overview`, null, {
      Authorization: `Bearer ${adminJwt}`,
    });
    assert.strictEqual(hubRes.status, 200);
    assert.ok(hubRes.body.data.ghostQueue, 'Resource Hub should contain aggregate ghostQueue data');
    assert.ok(typeof hubRes.body.data.ghostQueue.atCenter === 'number', 'Should have aggregate atCenter count');
    assert.strictEqual(hubRes.body.data.ghostQueue.customers, undefined, 'No customer coordinate list in Resource Hub');
    pass('20. no precise location leakage');
  } catch (err) {
    fail('20. no precise location leakage', err);
  }

  // 21. Concurrent location updates
  try {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        request('POST', `/api/tokens/${activeTokenA._id}/location`, {
          latitude: 12.9716 + (i * 0.0001),
          longitude: 77.5946 + (i * 0.0001),
          accuracy: 10,
        }, { Authorization: `Bearer ${customerAJwt}` })
      );
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      assert.strictEqual(r.status, 200, 'Concurrent requests must resolve with 200');
    }

    const tokenAfter = await Token.findById(activeTokenA._id);
    assert.ok(['INSIDE', 'NEAR', 'APPROACHING'].includes(tokenAfter.proximityState));
    pass('21. concurrent location updates');
  } catch (err) {
    fail('21. concurrent location updates', err);
  }

  // 22. Token lifecycle compatibility
  try {
    // A) WAITING: Location update works (already verified above)

    // B) CALLED: Call token
    await queueService.callNext({
      counterId: counterConfigured._id.toString(),
      centerId: centerConfigured._id.toString(),
      adminId: staffUser._id.toString(),
    });
    const calledToken = await Token.findById(activeTokenA._id);
    assert.strictEqual(calledToken.status, 'CALLED');

    const resCalled = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(resCalled.status, 200, 'CALLED token must accept location update');

    // C) SERVING: Start serving token
    await queueService.startServing({
      tokenId: activeTokenA._id.toString(),
      counterId: counterConfigured._id.toString(),
      adminId: staffUser._id.toString(),
    });
    const servingToken = await Token.findById(activeTokenA._id);
    assert.strictEqual(servingToken.status, 'SERVING');

    const resServing = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(resServing.status, 200, 'SERVING token must accept location update');

    // D) COMPLETED: Complete token
    await queueService.completeToken({
      tokenId: activeTokenA._id.toString(),
      counterId: counterConfigured._id.toString(),
      adminId: staffUser._id.toString(),
    });
    const completedToken = await Token.findById(activeTokenA._id);
    assert.strictEqual(completedToken.status, 'COMPLETED');

    const resCompleted = await request('POST', `/api/tokens/${activeTokenA._id}/location`, {
      latitude: 12.9716,
      longitude: 77.5946,
    }, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(resCompleted.status, 400, 'COMPLETED token must reject location updates');
    pass('22. Token lifecycle compatibility');
  } catch (err) {
    fail('22. Token lifecycle compatibility', err);
  }

  console.log('\n============================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

setup()
  .then(runTests)
  .then(teardown)
  .catch((err) => {
    console.error('Test runner fatal error:', err);
    teardown().finally(() => process.exit(1));
  });

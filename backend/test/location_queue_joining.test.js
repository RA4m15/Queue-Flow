'use strict';

/**
 * QueueFlow — Location-Based Queue Joining Authoritative Test Suite
 *
 * Verifies all 14 required hackathon / demo location enforcement rules:
 * 1. 50 m → allowed
 * 2. exactly 100 m → allowed
 * 3. 101 m → rejected
 * 4. 500 m → rejected
 * 5. missing location → rejected safely
 * 6. inaccurate location → rejected safely
 * 7. QR outside radius → rejected
 * 8. direct API outside radius → rejected
 * 9. direct API inside radius → real token created
 * 10. existing token remains valid when user later leaves radius
 * 11. Admin "Use Current Location" persists real coordinates
 * 12. College Account remains unchanged except its location configuration
 * 13. No coordinates are hardcoded in Flutter
 * 14. No fake location is used in production
 */

process.env.NODE_ENV = 'test';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { server } = require('../server');
const connectDB = require('../src/config/database');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const { Token } = require('../src/models/Token');
const geofenceService = require('../src/services/geofenceService');
const { calculateHaversineDistance } = geofenceService;

const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';
const METRO_ID = '6ab96defe738d0ba61cadae2';

let baseUrl;
let testServer;
let customerUser;
let customerJwt;
let adminUser;
let adminJwt;
let collegeService;
let metroService;

// Snapshot of the shared College Account's auto-allocation flag so the suite can
// restore it exactly. See setup()/cleanup().
let originalAutoAllocation = null;

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  ❌ FAIL  ${name}: ${err.message}`);
}

function request(method, pathUrl, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, baseUrl);
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

function signToken(user, role = null) {
  const uid = user._id ? user._id.toString() : user.toString();
  const userRole = role || (user.role || 'CUSTOMER');
  const tokenVersion = user.tokenVersion !== undefined ? user.tokenVersion : 0;
  return jwt.sign(
    { id: uid, role: userRole, tokenVersion },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '1h' }
  );
}

function getPointAtDistanceMeters(lat0, lng0, meters) {
  const R = 6371000;
  const dLat = (meters / R) * (180 / Math.PI);
  return {
    latitude: lat0 + dLat,
    longitude: lng0,
  };
}

async function setup() {
  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, '127.0.0.1', () => {
      const port = testServer.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  customerUser = await User.findOne({ email: 'customer.geo@queueflow.test' });
  if (!customerUser) {
    customerUser = await User.create({
      name: 'Geo Customer',
      email: 'customer.geo@queueflow.test',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345',
      role: 'CUSTOMER',
      isActive: true,
      isVerified: true,
    });
  }
  customerJwt = signToken(customerUser, 'CUSTOMER');

  adminUser = await User.findOne({ role: 'ADMIN' });
  if (!adminUser) {
    adminUser = await User.create({
      name: 'Geo Admin',
      email: 'admin.geo@queueflow.test',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345',
      role: 'ADMIN',
      isActive: true,
      isVerified: true,
    });
  }
  adminJwt = signToken(adminUser, 'ADMIN');

  collegeService = await Service.findOne({ centerId: COLLEGE_ID, isActive: true });
  if (!collegeService) {
    collegeService = await Service.create({
      name: 'General Inquiries',
      code: 'GEN',
      centerId: COLLEGE_ID,
      isActive: true,
      tokenPrefix: 'C',
      avgServiceTimeMinutes: 10,
    });
  }

  metroService = await Service.findOne({ centerId: METRO_ID, isActive: true });
  if (!metroService) {
    metroService = await Service.create({
      name: 'Metro Desk',
      code: 'MET',
      centerId: METRO_ID,
      isActive: true,
      tokenPrefix: 'M',
      avgServiceTimeMinutes: 15,
    });
  }

  // Ensure any existing active tokens for this test customer are cleared
  await Token.deleteMany({ userId: customerUser._id, status: { $in: ['WAITING', 'CALLED', 'SERVING'] } });

  // ------------------------------------------------------------------
  // Hermetic isolation: turn OFF centralized auto-allocation for the
  // duration of this suite.
  //
  // This suite asserts *geofence* semantics, and Tests 9/10 assert that a
  // token created inside the radius is WAITING and survives the customer
  // walking away. The shared College Account is a live center that an
  // administrator may have auto-allocation enabled on, and it has free
  // ACTIVE counters. When that is the case the centralized allocator is
  // *correctly* dispatching the brand-new token to a counter the instant
  // it is created, so the token legitimately becomes CALLED and the
  // WAITING assertions race against a fire-and-forget background trigger.
  //
  // Pinning the flag off makes the suite deterministic and independent of
  // unrelated center configuration. The assertions themselves are NOT
  // weakened, and the real flag value is restored by cleanup().
  // ------------------------------------------------------------------
  originalAutoAllocation = await ServiceCenter.findById(COLLEGE_ID).then(
    (c) => (c ? c.autoResourceAllocation === true : null)
  );
  await ServiceCenter.updateOne({ _id: COLLEGE_ID }, { $set: { autoResourceAllocation: false } });
}

/**
 * Restore the shared College Account's auto-allocation flag to the value it
 * had before this suite ran. Safe to call more than once.
 */
async function restoreCenterAllocationFlag() {
  if (originalAutoAllocation === null) return;
  await ServiceCenter.updateOne(
    { _id: COLLEGE_ID },
    { $set: { autoResourceAllocation: originalAutoAllocation } }
  );
}

async function cleanup() {
  // Always put the shared College Account back the way we found it, even if a
  // test failed, so this suite leaves no side effects on real center data.
  try {
    await restoreCenterAllocationFlag();
  } catch (err) {
    console.error('Failed to restore center auto-allocation flag:', err.message);
  }
  if (customerUser) {
    await Token.deleteMany({ userId: customerUser._id });
  }
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
  await mongoose.disconnect();
}

async function runTests() {
  console.log('\n=== QueueFlow Authoritative Geofence & Location Joining Tests ===\n');

  const collegeCenter = await ServiceCenter.findById(COLLEGE_ID);
  assert(collegeCenter, 'College center must exist in database');

  const collegeLat = collegeCenter.latitude !== undefined && collegeCenter.latitude !== null
    ? collegeCenter.latitude
    : (collegeCenter.location ? collegeCenter.location.latitude : 12.9716);
  const collegeLng = collegeCenter.longitude !== undefined && collegeCenter.longitude !== null
    ? collegeCenter.longitude
    : (collegeCenter.location ? collegeCenter.location.longitude : 77.5946);

  // Test 1: 50 m → allowed
  try {
    await Token.deleteMany({ userId: customerUser._id });
    const pt50 = getPointAtDistanceMeters(collegeLat, collegeLng, 50);
    const dist = calculateHaversineDistance(collegeLat, collegeLng, pt50.latitude, pt50.longitude);
    assert(Math.abs(dist - 50) <= 1, `Expected ~50m distance but was ${dist}`);

    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: pt50.latitude,
      longitude: pt50.longitude,
      accuracy: 10,
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 201, `Expected 201 Created but got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert(res.body.data.token, 'Must return token');
    assert.strictEqual(res.body.data.token.proximityState, 'INSIDE');

    await Token.findByIdAndDelete(res.body.data.token._id);
    pass('1. 50 m → allowed');
  } catch (err) {
    fail('1. 50 m → allowed', err);
  }

  // Test 2: exactly 100 m → allowed
  try {
    await Token.deleteMany({ userId: customerUser._id });
    const pt100 = getPointAtDistanceMeters(collegeLat, collegeLng, 100);
    const dist = calculateHaversineDistance(collegeLat, collegeLng, pt100.latitude, pt100.longitude);
    assert.strictEqual(dist, 100, 'Distance must be 100 meters');

    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: pt100.latitude,
      longitude: pt100.longitude,
      accuracy: 15,
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 201, `Expected 201 Created but got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert(res.body.data.token, 'Must return token at 100m');

    await Token.findByIdAndDelete(res.body.data.token._id);
    pass('2. exactly 100 m → allowed');
  } catch (err) {
    fail('2. exactly 100 m → allowed', err);
  }

  // Test 3: 101 m → rejected
  try {
    const pt101 = getPointAtDistanceMeters(collegeLat, collegeLng, 101);
    const dist = calculateHaversineDistance(collegeLat, collegeLng, pt101.latitude, pt101.longitude);
    assert.strictEqual(dist, 101, 'Distance must be 101 meters');

    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: pt101.latitude,
      longitude: pt101.longitude,
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 400, `Expected 400 Bad Request but got ${res.status}`);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'OUT_OF_RANGE');

    pass('3. 101 m → rejected');
  } catch (err) {
    fail('3. 101 m → rejected', err);
  }

  // Test 4: 500 m → rejected
  try {
    const pt500 = getPointAtDistanceMeters(collegeLat, collegeLng, 500);
    const dist = calculateHaversineDistance(collegeLat, collegeLng, pt500.latitude, pt500.longitude);
    assert.strictEqual(dist, 500, 'Distance must be 500 meters');

    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: pt500.latitude,
      longitude: pt500.longitude,
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'OUT_OF_RANGE');

    pass('4. 500 m → rejected');
  } catch (err) {
    fail('4. 500 m → rejected', err);
  }

  // Test 5: missing location → rejected safely
  try {
    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'LOCATION_REQUIRED');

    pass('5. missing location → rejected safely');
  } catch (err) {
    fail('5. missing location → rejected safely', err);
  }

  // Test 6: inaccurate location → rejected safely
  try {
    const pt30 = getPointAtDistanceMeters(collegeLat, collegeLng, 30);
    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: pt30.latitude,
      longitude: pt30.longitude,
      accuracy: 250, // Accuracy of 250m is far too coarse for a 100m geofence
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'LOCATION_UNCERTAIN');

    pass('6. inaccurate location → rejected safely');
  } catch (err) {
    fail('6. inaccurate location → rejected safely', err);
  }

  // Test 7: QR outside radius → rejected
  try {
    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      isWithinRange: true, // Spoofed client boolean
      channel: 'QR',
      latitude: collegeLat + 0.05, // ~5.5 km away
      longitude: collegeLng,
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'OUT_OF_RANGE');

    pass('7. QR outside radius → rejected');
  } catch (err) {
    fail('7. QR outside radius → rejected', err);
  }

  // Test 8: direct API outside radius → rejected
  try {
    const ptFar = getPointAtDistanceMeters(collegeLat, collegeLng, 10000);
    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: ptFar.latitude,
      longitude: ptFar.longitude,
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'OUT_OF_RANGE');

    pass('8. direct API outside radius → rejected');
  } catch (err) {
    fail('8. direct API outside radius → rejected', err);
  }

  // Test 9: direct API inside radius → real token created
  let createdTokenId = null;
  try {
    await Token.deleteMany({ userId: customerUser._id });
    const pt20 = getPointAtDistanceMeters(collegeLat, collegeLng, 20);
    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: pt20.latitude,
      longitude: pt20.longitude,
      accuracy: 5,
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert(res.body.data.token, 'Must return token');
    assert.strictEqual(res.body.data.token.proximityState, 'INSIDE');

    createdTokenId = res.body.data.token._id;
    const dbToken = await Token.findById(createdTokenId);
    assert(dbToken, 'Token must exist in database');
    assert.strictEqual(dbToken.status, 'WAITING');

    pass('9. direct API inside radius → real token created');
  } catch (err) {
    fail('9. direct API inside radius → real token created', err);
  }

  // Test 10: existing token remains valid when user later leaves radius
  try {
    assert(createdTokenId, 'Token must exist from Test 9');
    // User moves 5 km away and reports location (or queries token status)
    const farPt = getPointAtDistanceMeters(collegeLat, collegeLng, 5000);
    const res = await request('POST', '/api/tokens/me/location', {
      latitude: farPt.latitude,
      longitude: farPt.longitude,
      accuracy: 10,
    }, { Authorization: `Bearer ${customerJwt}` });

    // The user's active token must remain WAITING, NOT cancelled or deleted
    const dbToken = await Token.findById(createdTokenId);
    assert(dbToken, 'Token must not be deleted when user walks away');
    assert.strictEqual(dbToken.status, 'WAITING', 'Token must remain WAITING when user moves away');

    // Clean up
    await Token.findByIdAndDelete(createdTokenId);

    pass('10. existing token remains valid when user later leaves radius');
  } catch (err) {
    fail('10. existing token remains valid when user later leaves radius', err);
  }

  // Test 11: Admin "Use Current Location" persists real coordinates
  try {
    const originalCenter = await ServiceCenter.findById(COLLEGE_ID).lean();
    const updatedLat = originalCenter.latitude !== null && originalCenter.latitude !== undefined ? originalCenter.latitude : 23.183009;
    const updatedLng = originalCenter.longitude !== null && originalCenter.longitude !== undefined ? originalCenter.longitude : 77.301403;
    const updatedRadius = 100;

    const res = await request('PATCH', `/api/service-centers/${COLLEGE_ID}`, {
      latitude: updatedLat,
      longitude: updatedLng,
      joiningRadiusMeters: updatedRadius,
    }, { Authorization: `Bearer ${adminJwt}` });

    assert.strictEqual(res.status, 200, `Expected 200 OK from admin center update: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    const centerData = res.body.data.center;
    assert.strictEqual(centerData.latitude, updatedLat);
    assert.strictEqual(centerData.longitude, updatedLng);
    assert.strictEqual(centerData.joiningRadiusMeters, updatedRadius);

    // Verify in database
    const dbCenter = await ServiceCenter.findById(COLLEGE_ID);
    assert.strictEqual(dbCenter.latitude, updatedLat);
    assert.strictEqual(dbCenter.longitude, updatedLng);
    assert.strictEqual(dbCenter.joiningRadiusMeters, updatedRadius);
    assert.strictEqual(dbCenter.location.latitude, updatedLat);
    assert.strictEqual(dbCenter.location.longitude, updatedLng);

    pass('11. Admin "Use Current Location" persists real coordinates');
  } catch (err) {
    fail('11. Admin "Use Current Location" persists real coordinates', err);
  }

  // Test 12: College Account remains unchanged except its location configuration
  try {
    const dbCenter = await ServiceCenter.findById(COLLEGE_ID);
    assert(dbCenter, 'College center must exist');
    assert.strictEqual(dbCenter.name, 'College Account');
    assert.strictEqual(dbCenter.code, 'COLLEGE01');
    assert.strictEqual(dbCenter.isOpen, true);
    assert(dbCenter.capacity > 0);

    const services = await Service.find({ centerId: COLLEGE_ID });
    assert(services.length > 0, 'College Account services must remain intact');

    pass('12. College Account remains unchanged except its location configuration');
  } catch (err) {
    fail('12. College Account remains unchanged except its location configuration', err);
  }

  // Test 13: No coordinates are hardcoded in Flutter
  try {
    const libDir = path.resolve(__dirname, '../../user_app/lib');
    function searchFlutterSource(dir) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          searchFlutterSource(fullPath);
        } else if (file.endsWith('.dart')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          // Check for hardcoded GPS coordinates of College Account (12.9716 or 77.5946)
          if (content.includes('12.9716') || content.includes('77.5946')) {
            throw new Error(`Hardcoded coordinate found in Flutter file: ${file}`);
          }
        }
      }
    }
    searchFlutterSource(libDir);

    pass('13. No coordinates are hardcoded in Flutter');
  } catch (err) {
    fail('13. No coordinates are hardcoded in Flutter', err);
  }

  // Test 14: No fake location is used in production
  try {
    const flutterLocFile = path.resolve(__dirname, '../../user_app/lib/services/location_service.dart');
    const content = fs.readFileSync(flutterLocFile, 'utf8');
    assert(!content.includes('fake'), 'location_service.dart must not contain fake location data');
    assert(!content.includes('mock'), 'location_service.dart must not contain mock location data');

    pass('14. No fake location is used in production');
  } catch (err) {
    fail('14. No fake location is used in production', err);
  }

  // Test 15: Fresh timestamp (<90s) within 100m → allowed
  try {
    await Token.deleteMany({ userId: customerUser._id });
    const pt50 = getPointAtDistanceMeters(collegeLat, collegeLng, 50);

    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: pt50.latitude,
      longitude: pt50.longitude,
      accuracy: 10,
      timestamp: new Date().toISOString(),
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 201, `Expected 201 Created with fresh timestamp but got ${res.status}`);
    assert.strictEqual(res.body.success, true);
    await Token.findByIdAndDelete(res.body.data.token._id);

    pass('15. Fresh timestamp (<90s) within 100m → allowed');
  } catch (err) {
    fail('15. Fresh timestamp (<90s) within 100m → allowed', err);
  }

  // Test 16: Stale timestamp (>90s) → rejected with LOCATION_STALE
  try {
    await Token.deleteMany({ userId: customerUser._id });
    const pt50 = getPointAtDistanceMeters(collegeLat, collegeLng, 50);
    const staleDate = new Date(Date.now() - 120 * 1000).toISOString();

    const res = await request('POST', '/api/tokens', {
      centerId: COLLEGE_ID,
      serviceId: collegeService._id.toString(),
      latitude: pt50.latitude,
      longitude: pt50.longitude,
      accuracy: 10,
      timestamp: staleDate,
    }, { Authorization: `Bearer ${customerJwt}` });

    assert.strictEqual(res.status, 400, `Expected 400 for stale timestamp but got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'LOCATION_STALE');

    pass('16. Stale timestamp (>90s) → rejected with LOCATION_STALE');
  } catch (err) {
    fail('16. Stale timestamp (>90s) → rejected with LOCATION_STALE', err);
  }

  console.log(`\n================================`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`================================\n`);

  if (failed > 0) {
    // Set the code instead of exiting immediately: process.exit() would
    // terminate the process before the finally-block in main() runs, which
    // would skip cleanup() and leave the shared College Account modified.
    process.exitCode = 1;
  }
}

async function main() {
  try {
    await setup();
    await runTests();
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
  // Exit only once cleanup() has fully restored shared state.
  process.exit(process.exitCode || 0);
}

main();

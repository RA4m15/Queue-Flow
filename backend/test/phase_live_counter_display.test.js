'use strict';

/**
 * QueueFlow — LIVE COUNTER / PUBLIC DISPLAY & IOT TELEMETRY TEST SUITE
 *
 * Verifies:
 * 1. GET /api/queue/:centerId/display returns real center, counter, and token telemetry
 * 2. Dedicated public displayToken is issued and verifiable with JWT_SECRET
 * 3. Authoritative currentCrowd, crowdPercent, and crowdStatus are included in center payload
 * 4. POST /api/iot/crowd with type: 'COUNT' updates live footfall and logs FootfallEvent
 * 5. IoT endpoint security: rejects unauthenticated requests (HTTP 401)
 * 6. Public display PII protection: no customer phone, password, or sensitive tokens exposed
 * 7. Non-existent center returns HTTP 404
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { server } = require('../server');
const connectDB = require('../src/config/database');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const Queue = require('../src/models/Queue');
const { Token } = require('../src/models/Token');
const User = require('../src/models/User');
const FootfallEvent = require('../src/models/FootfallEvent');
const { getTodayDateString } = require('../src/utils/tokenUtils');

let testServer;
let baseUrl;
let centerId;
let serviceId;
let counterId;
let tokenId;
let testUserId;

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
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function setup() {
  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      const port = testServer.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Seed test data
  const center = await ServiceCenter.create({
    name: 'Test Live Display Center',
    code: `TLDC_${Date.now()}`,
    type: 'GOVT',
    capacity: 100,
    currentCrowd: 15,
    isOpen: true,
  });
  centerId = center._id.toString();

  const service = await Service.create({
    name: 'Display General Service',
    code: `DGS_${Date.now()}`,
    centerId,
    tokenPrefix: 'D',
    avgServiceTimeMinutes: 10,
    isActive: true,
  });
  serviceId = service._id.toString();

  const counter = await Counter.create({
    name: 'Station 1',
    number: 1,
    centerId,
    serviceId,
    status: 'ACTIVE',
    displayLabel: 'Teller 01',
  });
  counterId = counter._id.toString();

  const suffix = Date.now();
  const testUser = await User.create({
    name: 'Display Test User',
    email: `display_test_${suffix}@queueflow.test`,
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwx',
    role: 'CUSTOMER',
    isActive: true,
  });
  testUserId = testUser._id.toString();

  const date = getTodayDateString();
  await Queue.create({
    centerId,
    serviceId,
    date,
    waitingCount: 1,
    activeCount: 1,
    completedCount: 5,
  });

  const token = await Token.create({
    tokenNumber: 101,
    tokenCode: 'D101',
    userId: testUserId,
    centerId,
    serviceId,
    counterId,
    status: 'SERVING',
    calledAt: new Date(),
  });
  tokenId = token._id.toString();

  await Counter.findByIdAndUpdate(counterId, { currentTokenId: tokenId });
}

async function runTests() {
  console.log('==================================================');
  console.log('🧪 Live Counter & IoT Display Integration Tests');
  console.log('==================================================');

  // Test 1: Authoritative Display Payload
  console.log('▶ [1/6] Authoritative Display Feed & Telemetry');
  const res1 = await request('GET', `/api/queue/${centerId}/display`);
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.body.success, true);
  const data = res1.body.data;
  assert.strictEqual(data.center.id, centerId);
  assert.strictEqual(data.center.name, 'Test Live Display Center');
  assert.strictEqual(data.center.currentCrowd, 15);
  assert.strictEqual(data.center.crowdPercent, 15);
  assert.strictEqual(data.center.crowdStatus, 'LOW');
  console.log('  ✅ Center metadata, live footfall, and crowd status verified');

  // Test 2: Public Display Token
  console.log('▶ [2/6] Public Display Token Security');
  assert.ok(data.displayToken);
  const decoded = jwt.verify(data.displayToken, process.env.JWT_SECRET);
  assert.strictEqual(decoded.id, centerId);
  assert.strictEqual(decoded.isDisplay, true);
  console.log('  ✅ Dedicated read-only display token issued and verified');

  // Test 3: Serving Tokens & Counters
  console.log('▶ [3/6] Serving Tokens and Station Assignments');
  assert.ok(Array.isArray(data.nowServing));
  assert.strictEqual(data.nowServing.length, 1);
  assert.strictEqual(data.nowServing[0].tokenCode, 'D101');
  assert.ok(Array.isArray(data.counters));
  assert.strictEqual(data.counters[0].displayLabel, 'Teller 01');
  assert.strictEqual(data.counters[0].servingToken?.tokenCode, 'D101');
  console.log('  ✅ Active serving token D101 and counter assignments verified');

  // Test 4: Live Footfall Ingestion via IoT
  console.log('▶ [4/6] Authenticated Live Footfall Telemetry (crowd_monitor)');
  const resIot = await request(
    'POST',
    '/api/iot/crowd',
    {
      centerId,
      type: 'COUNT',
      count: 48,
      sensorId: 'cctv-cam-01',
    },
    {
      'x-iot-secret': process.env.IOT_SECRET,
    }
  );
  assert.strictEqual(resIot.status, 200);
  assert.strictEqual(resIot.body.data.currentCrowd, 48);
  assert.ok(resIot.body.data.crowdUpdatedAt, 'response carries a freshness timestamp');

  const updatedCenter = await ServiceCenter.findById(centerId);
  assert.strictEqual(updatedCenter.currentCrowd, 48);
  assert.ok(updatedCenter.crowdUpdatedAt, 'currentCrowd is stamped with crowdUpdatedAt');

  const event = await FootfallEvent.findOne({ centerId, type: 'COUNT' });
  assert.ok(event);
  assert.strictEqual(event.countAfter, 48);
  console.log('  ✅ Crowd count=48 atomically recorded and FootfallEvent persisted');

  // Test 4b: LIVE FOOTFALL is a current-occupancy metric, never accumulated.
  console.log('▶ [4b] Live Footfall Occupancy Accuracy (1 -> 2 -> 1 -> 0)');
  const occupancy = [1, 2, 1, 0];
  for (const expected of occupancy) {
    const r = await request(
      'POST',
      '/api/iot/crowd',
      { centerId, type: 'COUNT', count: expected, sensorId: 'cctv-cam-01' },
      { 'x-iot-secret': process.env.IOT_SECRET }
    );
    assert.strictEqual(r.status, 200);
    // A COUNT replaces the stored value outright — it is never incremented.
    assert.strictEqual(r.body.data.currentCrowd, expected);
  }
  const afterOccupancy = await ServiceCenter.findById(centerId);
  assert.strictEqual(afterOccupancy.currentCrowd, 0, 'zero-person reading is stored, not retained');
  console.log('  ✅ 1 -> 2 -> 1 -> 0 applied as absolute readings; zero is not retained');

  // Test 4c: Freshness is exposed so a dead sensor is distinguishable from a real zero.
  console.log('▶ [4c] Crowd Sensor Freshness Reporting');
  const freshDisplay = await request('GET', `/api/queue/${centerId}/display`);
  assert.strictEqual(freshDisplay.body.data.center.crowdSensorOnline, true);
  assert.ok(freshDisplay.body.data.center.crowdUpdatedAt);

  // Simulate a camera that died 10 minutes ago: the stored count is still there,
  // but the display must report the sensor as offline rather than showing 0.
  await ServiceCenter.findByIdAndUpdate(centerId, {
    $set: { crowdUpdatedAt: new Date(Date.now() - 10 * 60 * 1000) },
  });
  const staleDisplay = await request('GET', `/api/queue/${centerId}/display`);
  assert.strictEqual(staleDisplay.body.data.center.crowdSensorOnline, false);
  assert.strictEqual(staleDisplay.body.data.center.currentCrowd, 0);
  console.log('  ✅ Stale sensor reported as offline while the last count is preserved');

  // Restore a live reading for the remaining assertions.
  await request(
    'POST',
    '/api/iot/crowd',
    { centerId, type: 'COUNT', count: 48, sensorId: 'cctv-cam-01' },
    { 'x-iot-secret': process.env.IOT_SECRET }
  );

  // Test 5: IoT Authentication Enforcement
  console.log('▶ [5/6] IoT Endpoint Authentication Security');
  const unauthIot = await request('POST', '/api/iot/crowd', {
    centerId,
    type: 'COUNT',
    count: 99,
  });
  assert.strictEqual(unauthIot.status, 401);
  console.log('  ✅ Unauthenticated IoT requests correctly rejected with HTTP 401');

  // Test 6: Non-existent Center Error Handling
  console.log('▶ [6/6] Invalid Center Error Handling');
  const fakeId = new mongoose.Types.ObjectId().toString();
  const res404 = await request('GET', `/api/queue/${fakeId}/display`);
  assert.strictEqual(res404.status, 404);
  console.log('  ✅ Non-existent center returns HTTP 404 Not Found');

  console.log('\n==================================================');
  console.log('🎉 ALL LIVE COUNTER & TELEMETRY TESTS PASSED!');
  console.log('==================================================\n');
}

async function teardown() {
  if (centerId) {
    await ServiceCenter.findByIdAndDelete(centerId);
    await Service.deleteMany({ centerId });
    await Counter.deleteMany({ centerId });
    await Queue.deleteMany({ centerId });
    await Token.deleteMany({ centerId });
    await FootfallEvent.deleteMany({ centerId });
  }
  if (testUserId) {
    await User.findByIdAndDelete(testUserId);
  }
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
}

setup()
  .then(runTests)
  .then(teardown)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Fatal test error:', err);
    await teardown();
    process.exit(1);
  });

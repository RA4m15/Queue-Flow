'use strict';

/**
 * QueueFlow Backend Smoke & Verification Test Suite
 *
 * Covers:
 * 1. MongoDB Atlas connectivity & ping
 * 2. GET /health endpoint (HTTP 200)
 * 3. Authentication & Security (Register, Login, JWT, Bcrypt hash, Role-based access)
 * 4. Service center & Queue status retrieval
 * 5. Complete token creation flow & persistence in Atlas
 * 6. Queue state transitions:
 *    - WAITING -> CALLED -> SERVING -> COMPLETED
 *    - WAITING -> CALLED -> SKIPPED
 *    - WAITING -> CANCELLED
 *    - CALLED -> EXPIRED
 * 7. Socket.IO live real-time event verification (test client receiving events)
 * 8. IoT Endpoints (Crowd entry/exit, RFID lookup, auth & dev protection)
 */

process.env.NODE_ENV = 'test';
process.env.DEV_SIMULATOR_ENABLED = 'true';
require('dotenv').config();

const http = require('http');
const assert = require('assert');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');
const { app, server } = require('../server');
const connectDB = require('../src/config/database');
const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const Queue = require('../src/models/Queue');
const FootfallEvent = require('../src/models/FootfallEvent');
const queueService = require('../src/services/queueService');

let testServer;
let baseUrl;
let socketClient;
let testAdminToken;
let testCustomerToken;
let testCustomerId;
let testCenterId;
let testServiceId;
let testCounterId;

// Helper for making HTTP requests
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

async function runTests() {
  console.log('\n========================================');
  console.log('🧪 Starting QueueFlow Backend Smoke Tests');
  console.log('========================================\n');

  // ─── 1. MongoDB Atlas Connectivity & Ping ────────────────────────
  console.log('▶ [1/8] MongoDB Atlas Connection & Ping');
  await connectDB();
  assert(mongoose.connection.readyState === 1, 'Mongoose must be connected');
  const pingResult = await mongoose.connection.db.admin().ping();
  assert(pingResult.ok === 1, 'MongoDB Atlas ping must succeed');
  console.log('  ✅ MongoDB Atlas connected & ping passed');

  // Verify collections exist from seed
  const centerCount = await ServiceCenter.countDocuments();
  const serviceCount = await Service.countDocuments();
  const counterCount = await Counter.countDocuments();
  assert(centerCount > 0, 'ServiceCenter collection must have seeded data');
  assert(serviceCount > 0, 'Service collection must have seeded data');
  assert(counterCount > 0, 'Counter collection must have seeded data');
  console.log(`  ✅ Database collections verified (Centers: ${centerCount}, Services: ${serviceCount}, Counters: ${counterCount})`);

  // Start HTTP server on an available port
  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      const port = testServer.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`  ✅ Test HTTP server listening on ${baseUrl}`);
      resolve();
    });
  });

  // ─── 2. Health Endpoint ──────────────────────────────────────────
  console.log('\n▶ [2/8] Health Endpoint Verification');
  const healthRes = await request('GET', '/health');
  assert.strictEqual(healthRes.status, 200, 'GET /health must return 200');
  assert.strictEqual(healthRes.body.success, true, 'GET /health success must be true');
  console.log('  ✅ GET /health returns HTTP 200 OK');

  // ─── 3. Authentication & Security ────────────────────────────────
  console.log('\n▶ [3/8] Authentication & Role Security');

  // Login as admin
  const adminLogin = await request('POST', '/api/auth/login', {
    email: 'admin@queueflow.dev',
    password: 'Admin@1234',
  });
  assert.strictEqual(adminLogin.status, 200, 'Admin login must return 200');
  assert(adminLogin.body.data.token, 'Admin login must return JWT');
  testAdminToken = adminLogin.body.data.token;
  console.log('  ✅ Admin login successful, JWT received');

  // Register a unique customer
  const randomSuffix = Date.now().toString().slice(-6);
  const testEmail = `test.customer.${randomSuffix}@example.com`;
  const regRes = await request('POST', '/api/auth/register', {
    name: 'Smoke Test Customer',
    email: testEmail,
    password: 'Password@123',
    phone: '+919999988888',
  });
  assert.strictEqual(regRes.status, 201, 'Customer register must return 201');
  assert(regRes.body.data.token, 'Customer register must return JWT');
  assert.strictEqual(regRes.body.data.user.email, testEmail);
  assert.strictEqual(regRes.body.data.user.passwordHash, undefined, 'Password hash must NOT be in API response');
  testCustomerToken = regRes.body.data.token;
  testCustomerId = regRes.body.data.user._id;

  // Verify password in DB is bcrypt hashed
  const dbUser = await User.findById(testCustomerId).select('+passwordHash');
  assert(dbUser.passwordHash.startsWith('$2a$') || dbUser.passwordHash.startsWith('$2b$'), 'Password must be hashed with bcrypt');
  console.log('  ✅ Customer registered; password is confirmed bcrypt hashed in MongoDB');

  // Verify login with bad password fails
  const badLogin = await request('POST', '/api/auth/login', {
    email: testEmail,
    password: 'WrongPassword@123',
  });
  assert.strictEqual(badLogin.status, 401, 'Invalid password must return 401');
  console.log('  ✅ Bad password rejected with HTTP 401');

  // Verify GET /api/auth/me with JWT
  const meRes = await request('GET', '/api/auth/me', null, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(meRes.status, 200, 'GET /api/auth/me must return 200');
  assert.strictEqual(meRes.body.data.user._id, testCustomerId);
  console.log('  ✅ GET /api/auth/me with JWT authenticated successfully');

  // Verify role restriction: CUSTOMER cannot call ADMIN endpoint (POST /api/counters)
  const forbiddenRes = await request('POST', '/api/counters', {
    centerId: new mongoose.Types.ObjectId().toString(),
    name: 'Hacked Counter',
    number: 99,
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(forbiddenRes.status, 403, 'Customer calling admin endpoint must return 403 Forbidden');
  console.log('  ✅ Role security verified: Customer correctly rejected with HTTP 403 on admin route');

  // ─── 4. Queue Retrieval ──────────────────────────────────────────
  console.log('\n▶ [4/8] Queue Retrieval');
  const centersRes = await request('GET', '/api/service-centers');
  assert.strictEqual(centersRes.status, 200, 'GET /api/service-centers must return 200');
  assert(centersRes.body.data.centers.length > 0, 'Centers list must not be empty');
  const center = centersRes.body.data.centers[0];
  testCenterId = center._id.toString();

  const servicesRes = await request('GET', `/api/services?centerId=${testCenterId}`);
  assert.strictEqual(servicesRes.status, 200, 'GET /api/services must return 200');
  assert(servicesRes.body.data.services.length > 0, 'Services list must not be empty');
  testServiceId = servicesRes.body.data.services[0]._id.toString();

  const queueRes = await request('GET', `/api/queue/${testCenterId}`);
  assert.strictEqual(queueRes.status, 200, 'GET /api/queue/:centerId must return 200');
  console.log(`  ✅ Retrieved center (${center.name}) and queue status successfully`);

  // Find or assign a counter for this center and service
  let counter = await Counter.findOne({ centerId: testCenterId, serviceId: testServiceId });
  if (!counter) {
    counter = await Counter.findOne({ centerId: testCenterId });
    counter.serviceId = testServiceId;
    await counter.save();
  }
  testCounterId = counter._id.toString();

  // ─── 5. Socket.IO Event Client Setup ─────────────────────────────
  console.log('\n▶ [5/8] Socket.IO Real-Time Event Setup');
  const receivedEvents = [];

  // Pass the customer JWT in the handshake auth object, matching the Flutter
  // SocketService and the new server-side io.use() authentication middleware.
  socketClient = ioClient(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    auth: { token: testCustomerToken },
  });

  await new Promise((resolve, reject) => {
    socketClient.on('connect', () => {
      console.log(`  ✅ Test Socket.IO client authenticated & connected (id: ${socketClient.id})`);
      // join:center — subscribe to center-level broadcasts
      socketClient.emit('join:center', testCenterId);
      // join:user — now a server-authoritative no-op; private room already joined
      socketClient.emit('join:user', testCustomerId);
      socketClient.emit('join:counter', { centerId: testCenterId, counterId: testCounterId });
      resolve();
    });
    socketClient.on('connect_error', reject);
  });

  const eventNames = [
    'queue.updated',
    'token.created',
    'token.called',
    'token.serving',
    'token.completed',
    'token.skipped',
    'token.cancelled',
    'token.expired',
    'counter.updated',
    'crowd.updated',
    'notification.created',
  ];

  for (const ev of eventNames) {
    socketClient.on(ev, (data) => {
      receivedEvents.push({ event: ev, data });
    });
  }

  // ─── 6. Complete Token Flow & Queue State Transitions ────────────
  console.log('\n▶ [6/8] Token Flow & Queue State Transitions');

  // Ensure clean queue state for the test service
  await Token.deleteMany({ serviceId: testServiceId, status: { $in: ['WAITING', 'CALLED', 'SERVING'] } });

  // Step A: Customer creates token
  const tokenCreateRes = await request('POST', '/api/tokens', {
    centerId: testCenterId,
    serviceId: testServiceId,
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(tokenCreateRes.status, 201, 'Token creation must return 201');
  const createdToken = tokenCreateRes.body.data.token;
  assert(createdToken._id, 'Token must have an _id');
  assert(createdToken.tokenCode, 'Token must have a tokenCode');
  assert.strictEqual(createdToken.status, 'WAITING', 'New token status must be WAITING');
  assert(createdToken.waitEstimateMinutes >= 0, 'waitEstimateMinutes must be calculated');
  console.log(`  ✅ Token created: ${createdToken.tokenCode} (status: WAITING, wait: ${createdToken.waitEstimateMinutes} min)`);

  // Verify in MongoDB Atlas
  const dbToken = await Token.findById(createdToken._id);
  assert(dbToken, 'Created token must exist in MongoDB Atlas');
  assert.strictEqual(dbToken.status, 'WAITING');
  console.log('  ✅ Verified token is persisted in MongoDB Atlas with status WAITING');

  // Verify duplicate active token is rejected
  const dupRes = await request('POST', '/api/tokens', {
    centerId: testCenterId,
    serviceId: testServiceId,
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(dupRes.status, 409, 'Duplicate active token must return 409 Conflict');
  console.log('  ✅ Duplicate active token correctly prevented with HTTP 409');

  // Business Rule Validations:
  // 1. Non-existent center -> 404
  const fakeCenterId = new mongoose.Types.ObjectId().toString();
  const notFoundCenterRes = await request('POST', '/api/tokens', {
    centerId: fakeCenterId,
    serviceId: testServiceId,
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(notFoundCenterRes.status, 404, 'Non-existent center must return 404');
  console.log('  ✅ Non-existent service center rejected with HTTP 404');

  // 2. Non-existent service -> 404
  const fakeServiceId = new mongoose.Types.ObjectId().toString();
  const notFoundServiceRes = await request('POST', '/api/tokens', {
    centerId: testCenterId,
    serviceId: fakeServiceId,
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(notFoundServiceRes.status, 404, 'Non-existent service must return 404');
  console.log('  ✅ Non-existent service rejected with HTTP 404');

  // 3. Service belonging to a different center (mismatch) -> 400
  const otherService = await Service.findOne({ centerId: { $ne: testCenterId } });
  if (otherService) {
    const mismatchRes = await request('POST', '/api/tokens', {
      centerId: testCenterId,
      serviceId: otherService._id.toString(),
    }, {
      Authorization: `Bearer ${testCustomerToken}`,
    });
    assert.strictEqual(mismatchRes.status, 400, 'Service center mismatch must return 400');
    console.log('  ✅ Center/Service mismatch correctly rejected with HTTP 400');
  }

  // 4. Closed center rejection -> 400
  const closedCenter = await ServiceCenter.create({
    name: 'Temporary Closed Center',
    code: 'TEMPCLOSED01',
    type: 'OTHER',
    capacity: 50,
    isOpen: false,
  });
  const tempService = await Service.create({
    centerId: closedCenter._id,
    name: 'Temp Service',
    tokenPrefix: 'Z',
  });
  const closedCenterRes = await request('POST', '/api/tokens', {
    centerId: closedCenter._id.toString(),
    serviceId: tempService._id.toString(),
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(closedCenterRes.status, 400, 'Closed center must return 400');
  console.log('  ✅ Closed service center correctly rejected with HTTP 400');
  await Service.deleteOne({ _id: tempService._id });
  await ServiceCenter.deleteOne({ _id: closedCenter._id });

  // Step B: Admin opens counter
  const openCounterRes = await request('PATCH', `/api/counters/${testCounterId}/status`, {
    status: 'ACTIVE',
  }, {
    Authorization: `Bearer ${testAdminToken}`,
  });
  assert.strictEqual(openCounterRes.status, 200, 'Counter open must return 200');
  console.log('  ✅ Counter opened (status: ACTIVE)');

  // Step C: Counter calls next token (WAITING -> CALLED)
  const callNextRes = await request('POST', `/api/counters/${testCounterId}/call-next`, {}, {
    Authorization: `Bearer ${testAdminToken}`,
  });
  assert.strictEqual(callNextRes.status, 200, 'Call next token must return 200');
  assert.strictEqual(callNextRes.body.data.token.status, 'CALLED', 'Called token status must be CALLED');
  assert.strictEqual(callNextRes.body.data.token._id, createdToken._id, 'Called token must be our created token');
  console.log(`  ✅ Transition WAITING → CALLED verified for token ${createdToken.tokenCode}`);

  // Step D: Staff starts serving (CALLED -> SERVING)
  const startServingRes = await request('POST', `/api/counters/${testCounterId}/start-serving`, {}, {
    Authorization: `Bearer ${testAdminToken}`,
  });
  assert.strictEqual(startServingRes.status, 200, 'Start serving must return 200');
  assert.strictEqual(startServingRes.body.data.token.status, 'SERVING', 'Token status must be SERVING');
  console.log(`  ✅ Transition CALLED → SERVING verified for token ${createdToken.tokenCode}`);

  // Step E: Staff completes token (SERVING -> COMPLETED)
  const completeRes = await request('POST', `/api/counters/${testCounterId}/complete`, {}, {
    Authorization: `Bearer ${testAdminToken}`,
  });
  assert.strictEqual(completeRes.status, 200, 'Complete token must return 200');
  assert.strictEqual(completeRes.body.data.token.status, 'COMPLETED', 'Token status must be COMPLETED');

  // Verify in MongoDB Atlas
  const completedDbToken = await Token.findById(createdToken._id);
  assert.strictEqual(completedDbToken.status, 'COMPLETED');
  assert(completedDbToken.completedAt !== null, 'completedAt must be set');
  console.log(`  ✅ Transition SERVING → COMPLETED verified and persisted in MongoDB Atlas`);

  // Step F: Test SKIP transition (WAITING -> CALLED -> SKIPPED)
  const token2Res = await request('POST', '/api/tokens', {
    centerId: testCenterId,
    serviceId: testServiceId,
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(token2Res.status, 201);
  const token2Id = token2Res.body.data.token._id;

  await request('POST', `/api/counters/${testCounterId}/call-next`, {}, {
    Authorization: `Bearer ${testAdminToken}`,
  });

  const skipRes = await request('POST', `/api/counters/${testCounterId}/skip`, {
    tokenId: token2Id,
  }, {
    Authorization: `Bearer ${testAdminToken}`,
  });
  assert.strictEqual(skipRes.status, 200, 'Skip token must return 200');
  assert.strictEqual(skipRes.body.data.token.status, 'SKIPPED', 'Token status must be SKIPPED');
  console.log('  ✅ Transition WAITING → CALLED → SKIPPED verified');

  // Step G: Test CANCEL transition (WAITING -> CANCELLED)
  const token3Res = await request('POST', '/api/tokens', {
    centerId: testCenterId,
    serviceId: testServiceId,
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(token3Res.status, 201);
  const token3Id = token3Res.body.data.token._id;

  const cancelRes = await request('POST', `/api/tokens/${token3Id}/cancel`, {}, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(cancelRes.status, 200, 'Cancel token must return 200');
  assert.strictEqual(cancelRes.body.data.token.status, 'CANCELLED', 'Token status must be CANCELLED');
  console.log('  ✅ Transition WAITING → CANCELLED verified');

  // Step H: Test EXPIRED transition (WAITING -> CALLED -> EXPIRED)
  const token4Res = await request('POST', '/api/tokens', {
    centerId: testCenterId,
    serviceId: testServiceId,
  }, {
    Authorization: `Bearer ${testCustomerToken}`,
  });
  assert.strictEqual(token4Res.status, 201);
  const token4Id = token4Res.body.data.token._id;

  await request('POST', `/api/counters/${testCounterId}/call-next`, {}, {
    Authorization: `Bearer ${testAdminToken}`,
  });

  const expiredToken = await queueService.expireToken({
    tokenId: token4Id,
    counterId: testCounterId,
  });
  assert.strictEqual(expiredToken.status, 'EXPIRED', 'Token status must be EXPIRED');
  console.log('  ✅ Transition CALLED → EXPIRED verified');

  // ─── 7. IoT & Dev Simulator Endpoints ────────────────────────────
  console.log('\n▶ [7/8] IoT & Crowd Endpoints');
  const iotSecret = process.env.IOT_SECRET || 'queueflow_iot_device_secret_dev';

  // Test unauthorized IoT request without secret
  const unauthIot = await request('POST', '/api/iot/crowd', {
    centerId: testCenterId,
    type: 'ENTRY',
  });
  assert.strictEqual(unauthIot.status, 401, 'IoT request without secret must return 401');
  console.log('  ✅ IoT endpoint correctly rejects requests without x-iot-secret header (401)');

  // Test IoT Crowd ENTRY
  const centerBefore = await ServiceCenter.findById(testCenterId);
  const initialCrowd = centerBefore.currentCrowd;

  const crowdEntryRes = await request('POST', '/api/iot/crowd', {
    centerId: testCenterId,
    type: 'ENTRY',
    sensorId: 'ESP32_GATE_01',
  }, {
    'x-iot-secret': iotSecret,
  });
  assert.strictEqual(crowdEntryRes.status, 200, 'IoT crowd ENTRY must return 200');
  assert.strictEqual(crowdEntryRes.body.data.currentCrowd, initialCrowd + 1, 'Crowd count must increase by 1 on ENTRY');

  // Test IoT Crowd EXIT
  const crowdExitRes = await request('POST', '/api/iot/crowd', {
    centerId: testCenterId,
    type: 'EXIT',
    sensorId: 'ESP32_GATE_01',
  }, {
    'x-iot-secret': iotSecret,
  });
  assert.strictEqual(crowdExitRes.status, 200, 'IoT crowd EXIT must return 200');
  assert.strictEqual(crowdExitRes.body.data.currentCrowd, initialCrowd, 'Crowd count must decrease by 1 on EXIT');

  // Verify FootfallEvent in DB
  const footfall = await FootfallEvent.findOne({ centerId: testCenterId, sensorId: 'ESP32_GATE_01' });
  assert(footfall, 'FootfallEvent must be recorded in MongoDB Atlas');
  console.log('  ✅ IoT crowd ENTRY/EXIT verified and FootfallEvent persisted');

  // Test IoT RFID lookup (Customer 1 from seed has rfidUid: 'RFID001A2B3C')
  const rfidRes = await request('POST', '/api/iot/rfid', {
    uid: 'RFID001A2B3C',
    centerId: testCenterId,
  }, {
    'x-iot-secret': iotSecret,
  });
  assert.strictEqual(rfidRes.status, 200, 'Valid RFID lookup must return 200');
  assert.strictEqual(rfidRes.body.data.user.rfidUid, 'RFID001A2B3C');
  assert.strictEqual(rfidRes.body.data.user.passwordHash, undefined, 'No sensitive data exposed via RFID');
  console.log('  ✅ IoT RFID lookup verified (registered user matched, no sensitive info exposed)');

  // Test IoT RFID not found
  const unknownRfidRes = await request('POST', '/api/iot/rfid', {
    uid: 'NONEXISTENT_RFID_12345',
    centerId: testCenterId,
  }, {
    'x-iot-secret': iotSecret,
  });
  assert.strictEqual(unknownRfidRes.status, 404, 'Unknown RFID lookup must return 404');
  console.log('  ✅ Unknown RFID card returns 404 not found');

  // Test Dev Simulator endpoint
  const devSimRes = await request('POST', '/api/dev/simulate/crowd', {
    centerId: testCenterId,
    type: 'ENTRY',
    count: 2,
  });
  assert.strictEqual(devSimRes.status, 200, 'Dev simulator crowd must return 200 in development');
  console.log('  ✅ Dev simulator endpoint verified');

  // ─── 8. Socket.IO Events Delivery Verification ───────────────────
  console.log('\n▶ [8/8] Socket.IO Events Received Verification');
  // Allow brief moment for any pending network events
  await new Promise((resolve) => setTimeout(resolve, 500));

  const receivedEventTypes = [...new Set(receivedEvents.map((e) => e.event))];
  console.log(`  Events received by client: ${receivedEventTypes.join(', ')}`);

  assert(receivedEventTypes.includes('queue.updated'), 'Must receive queue.updated');
  assert(receivedEventTypes.includes('token.created'), 'Must receive token.created');
  assert(receivedEventTypes.includes('token.called'), 'Must receive token.called');
  assert(receivedEventTypes.includes('token.serving'), 'Must receive token.serving');
  assert(receivedEventTypes.includes('token.completed'), 'Must receive token.completed');
  assert(receivedEventTypes.includes('token.skipped'), 'Must receive token.skipped');
  assert(receivedEventTypes.includes('counter.updated'), 'Must receive counter.updated');
  assert(receivedEventTypes.includes('crowd.updated'), 'Must receive crowd.updated');
  assert(receivedEventTypes.includes('notification.created'), 'Must receive notification.created');
  console.log('  ✅ All required Socket.IO events successfully captured by test client!');

  // ─── Clean up ────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('🎉 ALL BACKEND SMOKE TESTS PASSED!');
  console.log('========================================\n');

  socketClient.disconnect();
  await new Promise((resolve) => testServer.close(resolve));
  await mongoose.disconnect();
  process.exit(0);
}

runTests().catch(async (err) => {
  console.error('\n❌ Smoke Test Failed:', err);
  if (socketClient) socketClient.disconnect();
  if (testServer) testServer.close();
  await mongoose.disconnect();
  process.exit(1);
});

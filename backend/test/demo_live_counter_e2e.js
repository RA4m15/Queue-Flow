'use strict';

/**
 * QueueFlow — LIVE COUNTER END-TO-END DEMO SCRIPT
 *
 * Demonstrates the full sequence:
 * 1. Open Live Counter & connect to Socket.IO with authoritative displayToken
 * 2. Show real QR content generated for the center
 * 3. Customer joins queue -> Live Counter joined count changes via Socket.IO
 * 4. Token appears in queue
 * 5. Operator calls token -> Live Counter NOW SERVING updates with counter name
 * 6. NEXT TOKEN updates
 * 7. Crowd monitor publishes real-time footfall -> Live Counter footfall updates
 * 8. All updates happen via Socket.IO without manual refresh
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const http = require('http');
const ioClient = require('socket.io-client');
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
let socketClient;
let centerId;
let serviceId;
let counterId;
let customerId;
let customerToken;
let operatorId;
let operatorToken;

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
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runDemo() {
  console.log('\n================================================================');
  console.log('🚀 DEMO: QUEUEFLOW LIVE COUNTER REAL-TIME INTEGRATION');
  console.log('================================================================\n');

  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      const port = testServer.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`[Step 0] Backend HTTP & Socket.IO server running at ${baseUrl}`);
      resolve();
    });
  });

  const suffix = Date.now();

  // Create demo service center
  const center = await ServiceCenter.create({
    name: 'Metropolis Civic Service Center',
    code: `MCSC_${suffix}`,
    type: 'GOVT',
    capacity: 250,
    currentCrowd: 12,
    isOpen: true,
  });
  centerId = center._id.toString();

  // Create service
  const service = await Service.create({
    name: 'Passport & Identity Verification',
    code: `PIV_${suffix}`,
    centerId,
    tokenPrefix: 'P',
    avgServiceTimeMinutes: 8,
    isActive: true,
  });
  serviceId = service._id.toString();

  // Create operator
  const operator = await User.create({
    name: 'Bob Operator',
    email: `bob_${suffix}@example.com`,
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwx',
    role: 'ADMIN',
    isActive: true,
  });
  operatorId = operator._id.toString();

  // Create counter
  const counter = await Counter.create({
    name: 'Counter 01',
    number: 1,
    centerId,
    serviceId,
    status: 'ACTIVE',
    displayLabel: 'Desk 1 - Express',
    staffId: operatorId,
  });
  counterId = counter._id.toString();

  // Create customer
  const customer = await User.create({
    name: 'Alice Customer',
    email: `alice_${suffix}@example.com`,
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwx',
    role: 'CUSTOMER',
    isActive: true,
  });
  customerId = customer._id.toString();

  const jwt = require('jsonwebtoken');
  customerToken = jwt.sign({ id: customerId, role: 'CUSTOMER', tokenVersion: customer.tokenVersion || 0 }, process.env.JWT_SECRET);
  operatorToken = jwt.sign({ id: operatorId, role: 'ADMIN', tokenVersion: operator.tokenVersion || 0 }, process.env.JWT_SECRET);

  // 1. Open Live Counter: fetches initial display data
  console.log('[Step 1] Live Counter loads authoritative display feed...');
  const displayRes = await request('GET', `/api/queue/${centerId}/display`);
  assert.strictEqual(displayRes.status, 200);
  const displayData = displayRes.body.data;

  console.log(`  -> Center: ${displayData.center.name} (${displayData.center.code})`);
  console.log(`  -> Initial Live Footfall: ${displayData.center.currentCrowd}`);
  console.log(`  -> Now Serving: ${displayData.nowServing.length === 0 ? 'NO ACTIVE TOKEN' : displayData.nowServing[0].tokenCode}`);
  console.log(`  -> Next in Queue: ${displayData.nextInQueue.length === 0 ? '— (Queue Empty)' : displayData.nextInQueue[0].tokenCode}`);

  // 2. Real QR Generation
  console.log('\n[Step 2] Live Counter displays dynamic QR code:');
  const deepLink = `queueflow://join?centerId=${centerId}`;
  const webFallback = `http://localhost:5173/join?centerId=${centerId}`;
  console.log(`  -> App Deep Link: ${deepLink}`);
  console.log(`  -> Web Fallback:  ${webFallback}`);

  // 3. Connect Live Counter to Socket.IO using displayToken
  console.log('\n[Step 3] Live Counter connects to Socket.IO using safe displayToken...');
  const liveEventsReceived = [];

  await new Promise((resolve, reject) => {
    socketClient = ioClient(baseUrl, {
      auth: { token: `Bearer ${displayData.displayToken}` },
      transports: ['websocket'],
    });

    socketClient.on('connect', () => {
      console.log(`  -> Live Counter Socket.IO connected (socket ID: ${socketClient.id})`);
      socketClient.emit('join:center', centerId);
      console.log(`  -> Live Counter joined room: center:${centerId}`);
      resolve();
    });

    socketClient.on('connect_error', reject);

    socketClient.on('queue.updated', (d) => {
      liveEventsReceived.push({ event: 'queue.updated', data: d });
      console.log('  [Socket Event] queue.updated received on Live Counter');
    });

    socketClient.on('token.called', (d) => {
      liveEventsReceived.push({ event: 'token.called', data: d });
      console.log(`  [Socket Event] token.called received on Live Counter: Token ${d?.token?.tokenCode} -> Counter ${d?.counter?.displayLabel || d?.counter?.name}`);
    });

    socketClient.on('crowd.updated', (d) => {
      liveEventsReceived.push({ event: 'crowd.updated', data: d });
      console.log(`  [Socket Event] crowd.updated received on Live Counter: Footfall=${d?.currentCrowd} (Status=${d?.crowdStatus})`);
    });
  });

  // 4. Customer scans QR & joins queue
  console.log('\n[Step 4] Customer scans QR code and joins queue (POST /api/tokens)...');
  const joinRes = await request(
    'POST',
    '/api/tokens',
    { centerId, serviceId },
    { Authorization: `Bearer ${customerToken}` }
  );
  assert.strictEqual(joinRes.status, 201);
  const createdToken = joinRes.body.data.token;
  console.log(`  -> Customer received token: ${createdToken.tokenCode} (status: ${createdToken.status})`);

  // Wait briefly for Socket.IO event propagation
  await new Promise((r) => setTimeout(r, 600));

  // Verify display feed after join
  const displayAfterJoin = await request('GET', `/api/queue/${centerId}/display`);
  console.log(`  -> Live Counter joined queue count: ${displayAfterJoin.body.data.queues[0]?.waitingCount}`);
  console.log(`  -> Live Counter NEXT IN LINE: ${displayAfterJoin.body.data.nextInQueue[0]?.tokenCode}`);
  assert.strictEqual(displayAfterJoin.body.data.nextInQueue[0]?.tokenCode, createdToken.tokenCode);

  // 5. Operator calls token
  console.log('\n[Step 5] Operator calls next ticket at Counter 01 (POST /api/counters/:id/call-next)...');
  const callRes = await request(
    'POST',
    `/api/counters/${counterId}/call-next`,
    {},
    { Authorization: `Bearer ${operatorToken}` }
  );
  assert.strictEqual(callRes.status, 200);

  // Wait briefly for Socket.IO event propagation
  await new Promise((r) => setTimeout(r, 600));

  // Verify display feed after callout
  const displayAfterCall = await request('GET', `/api/queue/${centerId}/display`);
  console.log(`  -> Live Counter NOW SERVING: ${displayAfterCall.body.data.nowServing[0]?.tokenCode} at ${displayAfterCall.body.data.nowServing[0]?.counterId?.displayLabel}`);
  assert.strictEqual(displayAfterCall.body.data.nowServing[0]?.tokenCode, createdToken.tokenCode);

  // 6. CCTV crowd_monitor detects people & publishes authenticated telemetry
  console.log('\n[Step 6] CCTV crowd_monitor tracks persons and publishes telemetry (POST /api/iot/crowd)...');
  const simulatedCctvCount = 37;
  const iotRes = await request(
    'POST',
    '/api/iot/crowd',
    {
      centerId,
      type: 'COUNT',
      count: simulatedCctvCount,
      sensorId: 'cctv-cam-01',
    },
    { 'x-iot-secret': process.env.IOT_SECRET }
  );
  assert.strictEqual(iotRes.status, 200);

  // Wait briefly for Socket.IO event propagation
  await new Promise((r) => setTimeout(r, 600));

  // Verify display feed after crowd update
  const displayAfterCrowd = await request('GET', `/api/queue/${centerId}/display`);
  console.log(`  -> Live Counter LIVE FOOTFALL: ${displayAfterCrowd.body.data.center.currentCrowd}`);
  assert.strictEqual(displayAfterCrowd.body.data.center.currentCrowd, simulatedCctvCount);

  // 7. Verify all Socket.IO events captured in real-time
  console.log('\n[Step 7] Validating that all real-time events reached the Live Counter:');
  const hasQueueUpdate = liveEventsReceived.some((e) => e.event === 'queue.updated');
  const hasTokenCalled = liveEventsReceived.some((e) => e.event === 'token.called');
  const hasCrowdUpdate = liveEventsReceived.some((e) => e.event === 'crowd.updated');

  console.log(`  -> Received queue.updated: ${hasQueueUpdate ? 'YES' : 'NO'}`);
  console.log(`  -> Received token.called:  ${hasTokenCalled ? 'YES' : 'NO'}`);
  console.log(`  -> Received crowd.updated: ${hasCrowdUpdate ? 'YES' : 'NO'}`);

  assert.ok(hasQueueUpdate, 'Live counter must receive queue.updated on ticket join');
  assert.ok(hasTokenCalled, 'Live counter must receive token.called on teller callout');
  assert.ok(hasCrowdUpdate, 'Live counter must receive crowd.updated on CCTV telemetry publish');

  console.log('\n================================================================');
  console.log('🎉 DEMO COMPLETED SUCCESSFULLY: ZERO REFRESH REQUIRED!');
  console.log('================================================================\n');
}

async function cleanup() {
  if (socketClient) {
    socketClient.disconnect();
  }
  if (centerId) {
    await ServiceCenter.findByIdAndDelete(centerId);
    await Service.deleteMany({ centerId });
    await Counter.deleteMany({ centerId });
    await Queue.deleteMany({ centerId });
    await Token.deleteMany({ centerId });
    await FootfallEvent.deleteMany({ centerId });
  }
  if (customerId) await User.findByIdAndDelete(customerId);
  if (operatorId) await User.findByIdAndDelete(operatorId);
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
}

runDemo()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Demo error:', err);
    await cleanup();
    process.exit(1);
  });

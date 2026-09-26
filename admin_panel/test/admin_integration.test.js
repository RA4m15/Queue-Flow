'use strict';

/**
 * QueueFlow Phase 2 Admin Panel Integration Test — PRODUCTION ONLY
 *
 * Backend: https://queue-flow-4308.onrender.com  (Render, MongoDB Atlas)
 *
 * Verifies end-to-end against the LIVE deployed backend:
 *  - Production connectivity pre-check (/health)
 *  - Admin & Staff authentication
 *  - Dashboard API (Service Center, Queue, Counter, Crowd, Analytics)
 *  - Real-time Socket.IO (join center + counter rooms)
 *  - Token lifecycle: WAITING → CALLED → SERVING → COMPLETED
 *  - Skip workflow: WAITING → CALLED → SKIPPED
 *  - Real IoT crowd: ENTRY (+1) and EXIT (-1)
 *  - Socket.IO event delivery for all lifecycle steps
 *  - Counter Display real-time update without browser refresh
 *
 * Environment (loaded via node --env-file=.env.test):
 *   TEST_API_URL   = https://queue-flow-4308.onrender.com/api
 *   TEST_SOCKET_URL= https://queue-flow-4308.onrender.com
 *   IOT_SECRET     = <production IoT secret — see Render env config>
 *
 * CRITICAL RULES:
 *   - No localhost or 127.0.0.1 anywhere in this file.
 *   - No local backend is started or expected.
 *   - If env vars are missing, the test fails with a clear message.
 *   - If the Render backend is unreachable, the test fails with a clear message.
 *   - The dev simulator route (/api/dev/simulate/crowd) is NOT tested here
 *     because it is disabled in production (NODE_ENV=production).
 */

import assert from 'assert';
import axios from 'axios';
import { io } from 'socket.io-client';

// ─── Production Environment Validation ───────────────────────────────────────

const API_BASE = process.env.TEST_API_URL;
const SOCKET_URL = process.env.TEST_SOCKET_URL;
const IOT_SECRET = process.env.IOT_SECRET;

if (!API_BASE) {
  console.error('\n❌ Production API URL is not configured.');
  console.error('   Set TEST_API_URL in .env.test and run: npm test');
  console.error('   Expected: TEST_API_URL=https://queue-flow-4308.onrender.com/api\n');
  process.exit(1);
}

if (!SOCKET_URL) {
  console.error('\n❌ Production Socket URL is not configured.');
  console.error('   Set TEST_SOCKET_URL in .env.test and run: npm test');
  console.error('   Expected: TEST_SOCKET_URL=https://queue-flow-4308.onrender.com\n');
  process.exit(1);
}

if (!IOT_SECRET) {
  console.error('\n❌ IOT_SECRET is not configured.');
  console.error('   Set IOT_SECRET in .env.test (get value from Render environment settings).\n');
  process.exit(1);
}

const TEST_ADMIN_EMAIL    = process.env.TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;
const TEST_STAFF_EMAIL    = process.env.TEST_STAFF_EMAIL;
const TEST_STAFF_PASSWORD = process.env.TEST_STAFF_PASSWORD;
const TEST_CUSTOMER_PASSWORD = process.env.TEST_CUSTOMER_PASSWORD;

const missingCreds = [
  !TEST_ADMIN_EMAIL    && 'TEST_ADMIN_EMAIL',
  !TEST_ADMIN_PASSWORD && 'TEST_ADMIN_PASSWORD',
  !TEST_STAFF_EMAIL    && 'TEST_STAFF_EMAIL',
  !TEST_STAFF_PASSWORD && 'TEST_STAFF_PASSWORD',
  !TEST_CUSTOMER_PASSWORD && 'TEST_CUSTOMER_PASSWORD',
].filter(Boolean);

if (missingCreds.length > 0) {
  console.error('\n❌ Test credentials are not configured.');
  console.error(`   Missing in .env.test: ${missingCreds.join(', ')}`);
  console.error('   Add these values to .env.test. Do not hardcode them in source files.\n');
  process.exit(1);
}

// Derive health check URL from API_BASE (strip /api suffix)
const BACKEND_ROOT = API_BASE.replace(/\/api$/, '');

// ─── Main Test Suite ──────────────────────────────────────────────────────────

async function testAdminFlow() {
  console.log('\n======================================================');
  console.log('🚀 QueueFlow Phase 2 Admin Panel — PRODUCTION Integration Test');
  console.log(`   Backend : ${BACKEND_ROOT}`);
  console.log(`   API     : ${API_BASE}`);
  console.log(`   Sockets : ${SOCKET_URL}`);
  console.log('======================================================\n');

  // ── [0/7] Production Connectivity Pre-check ─────────────────────────────────
  console.log('▶ [0/7] Production Connectivity Pre-check (GET /health)');
  let healthRes;
  try {
    healthRes = await axios.get(`${BACKEND_ROOT}/health`, { timeout: 15000 });
  } catch (err) {
    console.error(`\n❌ Production backend is unreachable at: ${BACKEND_ROOT}`);
    console.error('   This test requires an active internet connection to Render.');
    console.error(`   Error: ${err.message}\n`);
    process.exit(1);
  }
  assert.strictEqual(healthRes.status, 200, 'Health check must return HTTP 200');
  assert.strictEqual(healthRes.data.success, true, 'Health check must return success:true');
  console.log(`  ✅ Production backend is healthy: ${JSON.stringify(healthRes.data.message)}`);
  console.log(`     Environment: ${healthRes.data.environment}, Timestamp: ${healthRes.data.timestamp}`);

  // ── [1/7] Admin & Staff Authentication ──────────────────────────────────────
  console.log('\n▶ [1/7] Admin & Staff Authentication (POST /auth/login)');

  const adminLogin = await axios.post(`${API_BASE}/auth/login`, {
    email: TEST_ADMIN_EMAIL,
    password: TEST_ADMIN_PASSWORD,
  });
  assert.strictEqual(adminLogin.data.success, true, 'Admin login must succeed');
  const adminToken = adminLogin.data.data.token;
  const adminUser = adminLogin.data.data.user;
  assert(adminToken, 'Admin JWT token must be returned');
  assert.strictEqual(adminUser.role, 'ADMIN', 'User role must be ADMIN');
  console.log(`  ✅ Admin authenticated: ${adminUser.name} (${adminUser.role})`);

  const staffLogin = await axios.post(`${API_BASE}/auth/login`, {
    email: TEST_STAFF_EMAIL,
    password: TEST_STAFF_PASSWORD,
  });
  assert.strictEqual(staffLogin.data.success, true, 'Staff login must succeed');
  const staffUser = staffLogin.data.data.user;
  assert.strictEqual(staffUser.role, 'STAFF', 'Staff role must be STAFF');
  console.log(`  ✅ Staff authenticated: ${staffUser.name} (${staffUser.role})`);

  const authHeaders = { Authorization: `Bearer ${adminToken}` };

  // ── [2/7] Dashboard API — Service Center, Queue, Counters, Crowd, Analytics ─
  console.log('\n▶ [2/7] Dashboard API (Centers, Queue, Counters, Crowd, Analytics)');

  const centersRes = await axios.get(`${API_BASE}/service-centers`);
  assert(centersRes.data.data.centers.length > 0, 'At least one service center must exist');
  const center = centersRes.data.data.centers[0];
  const centerId = center._id;
  assert(typeof center.capacity === 'number' && center.capacity > 0, 'Center must have numeric capacity > 0');
  console.log(`  ✅ Service Center: ${center.name} (Code: ${center.code}, Capacity: ${center.capacity})`);

  const [queueRes, countersRes, crowdRes, analyticsRes] = await Promise.all([
    axios.get(`${API_BASE}/queue/${centerId}`),
    axios.get(`${API_BASE}/counters?centerId=${centerId}`),
    axios.get(`${API_BASE}/crowd/${centerId}`),
    axios.get(`${API_BASE}/analytics/${centerId}`, { headers: authHeaders }),
  ]);

  assert.strictEqual(queueRes.data.success, true, 'Queue API must return success');
  assert.strictEqual(countersRes.data.success, true, 'Counters API must return success');
  assert.strictEqual(crowdRes.data.success, true, 'Crowd API must return success');
  assert.strictEqual(analyticsRes.data.success, true, 'Analytics API must return success');

  const counters = countersRes.data.data.counters;
  assert(counters.length > 0, 'At least one counter must exist');
  const targetCounter = counters[0];
  const targetCounterId = targetCounter._id;
  const targetServiceId = targetCounter.serviceId?._id || targetCounter.serviceId;

  console.log(`  ✅ Queue API: ${queueRes.data.data.queues.length} queue(s) loaded`);
  console.log(`  ✅ Counters API: ${counters.length} counter(s) — target: ${targetCounter.name}`);
  console.log(`  ✅ Crowd API: currentCrowd=${crowdRes.data.data.currentCrowd}, capacity=${crowdRes.data.data.capacity}`);

  // Verify analytics returns real backend-computed fields
  const analyticsData = analyticsRes.data.data;
  assert(analyticsData.counters !== undefined, 'Analytics must provide counters array');
  assert(
    analyticsData.counters.every((c) => typeof c.utilizationPercent === 'number'),
    'Analytics counters must have utilizationPercent as number'
  );
  console.log(
    `  ✅ Analytics API: ${analyticsData.counters.map((c) => `${c.name}: ${c.utilizationPercent}%`).join(', ')}`
  );

  // ── [3/7] Socket.IO — Connect, Join Rooms ────────────────────────────────────
  console.log('\n▶ [3/7] Socket.IO Connection & Room Subscriptions');

  const adminSocket = io(SOCKET_URL, {
    transports: ['websocket', 'polling'],
    timeout: 20000,
  });
  const displaySocket = io(SOCKET_URL, {
    transports: ['websocket', 'polling'],
    timeout: 20000,
  });

  const adminEvents = [];
  const displayEvents = [];

  // Connect both sockets and join rooms
  await new Promise((resolve, reject) => {
    const connectTimeout = setTimeout(() => {
      reject(new Error('Socket.IO connection to production backend timed out after 20s'));
    }, 20000);

    let connected = 0;
    const check = () => {
      connected++;
      if (connected === 2) {
        clearTimeout(connectTimeout);
        resolve();
      }
    };

    adminSocket.on('connect', () => {
      adminSocket.emit('join:center', centerId);
      // Admin joins the counter room to receive counter.updated events
      // (counter.updated is emitted to the counter room, not the center room)
      adminSocket.emit('join:counter', { centerId, counterId: targetCounterId });
      check();
    });
    adminSocket.on('connect_error', (err) => {
      clearTimeout(connectTimeout);
      reject(new Error(`Admin Socket.IO connect_error: ${err.message}`));
    });

    displaySocket.on('connect', () => {
      displaySocket.emit('join:center', centerId);
      displaySocket.emit('join:counter', { centerId, counterId: targetCounterId });
      check();
    });
    displaySocket.on('connect_error', (err) => {
      clearTimeout(connectTimeout);
      reject(new Error(`Display Socket.IO connect_error: ${err.message}`));
    });
  });

  console.log(`  ✅ Admin Socket connected (id: ${adminSocket.id}), joined center + counter rooms`);
  console.log(`  ✅ Counter Display Socket connected (id: ${displaySocket.id}), joined center + counter rooms`);

  // Register event listeners — events are NOT cleared; counter.updated from
  // the ACTIVE status change below will be captured by both sockets.
  adminSocket.on('queue.updated',   (d) => adminEvents.push({ e: 'queue.updated', d }));
  adminSocket.on('token.called',    (d) => adminEvents.push({ e: 'token.called', d }));
  adminSocket.on('token.serving',   (d) => adminEvents.push({ e: 'token.serving', d }));
  adminSocket.on('token.completed', (d) => adminEvents.push({ e: 'token.completed', d }));
  adminSocket.on('token.skipped',   (d) => adminEvents.push({ e: 'token.skipped', d }));
  adminSocket.on('crowd.updated',   (d) => adminEvents.push({ e: 'crowd.updated', d }));
  adminSocket.on('counter.updated', (d) => adminEvents.push({ e: 'counter.updated', d }));

  displaySocket.on('counter.updated', (d) => displayEvents.push({ e: 'counter.updated', d }));
  displaySocket.on('token.called',    (d) => displayEvents.push({ e: 'token.called', d }));
  displaySocket.on('token.serving',   (d) => displayEvents.push({ e: 'token.serving', d }));
  displaySocket.on('token.completed', (d) => displayEvents.push({ e: 'token.completed', d }));
  displaySocket.on('token.skipped',   (d) => displayEvents.push({ e: 'token.skipped', d }));

  // Activate counter — emits counter.updated to the counter room.
  // Both admin and display sockets are subscribed to the counter room, so both will receive it.
  await axios.patch(
    `${API_BASE}/counters/${targetCounterId}/status`,
    { status: 'ACTIVE' },
    { headers: authHeaders }
  );
  console.log(`  ✅ Counter "${targetCounter.name}" set to ACTIVE`);

  // Allow time for the counter.updated event to arrive before the lifecycle tests
  await new Promise((r) => setTimeout(r, 600));

  // ── [4/7] Token Lifecycle: WAITING → CALLED → SERVING → COMPLETED ───────────
  console.log('\n▶ [4/7] Token Lifecycle: WAITING → CALLED → SERVING → COMPLETED');

  // Register two unique test customers (timestamped to avoid conflicts)
  const ts = Date.now();

  const cust1Reg = await axios.post(`${API_BASE}/auth/register`, {
    name: 'Test Customer 1',
    email: `testcust_${ts}_1@queueflow.dev`,
    password: TEST_CUSTOMER_PASSWORD,
  });
  assert.strictEqual(cust1Reg.status, 201, 'Customer 1 registration must return 201');
  const cust1Token = cust1Reg.data.data.token;

  const cust2Reg = await axios.post(`${API_BASE}/auth/register`, {
    name: 'Test Customer 2',
    email: `testcust_${ts}_2@queueflow.dev`,
    password: TEST_CUSTOMER_PASSWORD,
  });
  assert.strictEqual(cust2Reg.status, 201, 'Customer 2 registration must return 201');
  const cust2Token = cust2Reg.data.data.token;

  // Create Token 1 (WAITING)
  const t1Res = await axios.post(
    `${API_BASE}/tokens`,
    { centerId, serviceId: targetServiceId },
    { headers: { Authorization: `Bearer ${cust1Token}` } }
  );
  assert.strictEqual(t1Res.status, 201, 'Token 1 creation must return 201');
  assert.strictEqual(t1Res.data.success, true);
  const token1 = t1Res.data.data.token;
  assert(token1 && token1.tokenCode, 'Token 1 must have tokenCode');
  assert.strictEqual(token1.status, 'WAITING', 'Token 1 initial status must be WAITING');

  // Verify Token 1 persisted in MongoDB
  const t1Check = await axios.get(`${API_BASE}/tokens/${token1._id}`, {
    headers: { Authorization: `Bearer ${cust1Token}` },
  });
  assert.strictEqual(t1Check.data.data.token.status, 'WAITING');
  console.log(`  ✅ Token 1 created & verified in MongoDB Atlas: ${token1.tokenCode} (WAITING)`);

  // Create Token 2 (WAITING)
  const t2Res = await axios.post(
    `${API_BASE}/tokens`,
    { centerId, serviceId: targetServiceId },
    { headers: { Authorization: `Bearer ${cust2Token}` } }
  );
  assert.strictEqual(t2Res.status, 201, 'Token 2 creation must return 201');
  const token2 = t2Res.data.data.token;
  assert(token2 && token2.tokenCode, 'Token 2 must have tokenCode');
  assert.strictEqual(token2.status, 'WAITING', 'Token 2 initial status must be WAITING');

  const t2Check = await axios.get(`${API_BASE}/tokens/${token2._id}`, {
    headers: { Authorization: `Bearer ${cust2Token}` },
  });
  assert.strictEqual(t2Check.data.data.token.status, 'WAITING');
  console.log(`  ✅ Token 2 created & verified in MongoDB Atlas: ${token2.tokenCode} (WAITING)`);

  // Admin: CALL NEXT → Token 1 becomes CALLED
  const callRes = await axios.post(
    `${API_BASE}/counters/${targetCounterId}/call-next`,
    {},
    { headers: authHeaders }
  );
  assert.strictEqual(callRes.data.success, true, 'Call Next must succeed');
  const calledToken = callRes.data.data.token;
  assert.strictEqual(calledToken._id.toString(), token1._id.toString(), 'Called token must be Token 1');
  assert.strictEqual(calledToken.status, 'CALLED', 'Token 1 must be CALLED');
  console.log(`  ✅ CALL NEXT → ${calledToken.tokenCode} is CALLED at ${targetCounter.name}`);

  // Admin: START SERVING → Token 1 becomes SERVING
  const servingRes = await axios.post(
    `${API_BASE}/counters/${targetCounterId}/start-serving`,
    {},
    { headers: authHeaders }
  );
  assert.strictEqual(servingRes.data.success, true, 'Start Serving must succeed');
  assert.strictEqual(servingRes.data.data.token.status, 'SERVING', 'Token 1 must be SERVING');
  console.log(`  ✅ START SERVING → ${servingRes.data.data.token.tokenCode} is SERVING`);

  // Admin: COMPLETE → Token 1 becomes COMPLETED
  const completeRes = await axios.post(
    `${API_BASE}/counters/${targetCounterId}/complete`,
    {},
    { headers: authHeaders }
  );
  assert.strictEqual(completeRes.data.success, true, 'Complete must succeed');
  assert.strictEqual(completeRes.data.data.token.status, 'COMPLETED', 'Token 1 must be COMPLETED');
  console.log(`  ✅ COMPLETE → ${completeRes.data.data.token.tokenCode} is COMPLETED`);

  // ── [5/7] Skip Workflow: Token 2: WAITING → CALLED → SKIPPED ────────────────
  console.log('\n▶ [5/7] Skip Workflow (WAITING → CALLED → SKIPPED)');

  const callNext2Res = await axios.post(
    `${API_BASE}/counters/${targetCounterId}/call-next`,
    {},
    { headers: authHeaders }
  );
  assert.strictEqual(callNext2Res.data.success, true, 'Call Next (Token 2) must succeed');
  const nextToken = callNext2Res.data.data.token;
  assert.strictEqual(nextToken._id.toString(), token2._id.toString(), 'Next called token must be Token 2');
  assert.strictEqual(nextToken.status, 'CALLED', 'Token 2 must be CALLED');
  console.log(`  ✅ CALL NEXT → ${nextToken.tokenCode} is CALLED`);

  const skipRes = await axios.post(
    `${API_BASE}/counters/${targetCounterId}/skip`,
    {},
    { headers: authHeaders }
  );
  assert.strictEqual(skipRes.data.success, true, 'Skip must succeed');
  assert.strictEqual(skipRes.data.data.token.status, 'SKIPPED', 'Token 2 must be SKIPPED');
  console.log(`  ✅ SKIP → ${nextToken.tokenCode} is SKIPPED`);

  // ── [6/7] Real IoT Crowd: ENTRY (+1) and EXIT (-1) ──────────────────────────
  console.log('\n▶ [6/7] Real IoT Crowd Events (POST /iot/crowd with x-iot-secret)');

  const crowdBefore = (await axios.get(`${API_BASE}/crowd/${centerId}`)).data.data.currentCrowd;

  const iotEntryRes = await axios.post(
    `${API_BASE}/iot/crowd`,
    { centerId, type: 'ENTRY', sensorId: 'TOF_GATE_01' },
    { headers: { 'x-iot-secret': IOT_SECRET } }
  );
  assert.strictEqual(iotEntryRes.status, 200, 'IoT ENTRY must return HTTP 200');
  assert.strictEqual(iotEntryRes.data.success, true, 'IoT ENTRY must return success:true');
  const crowdAfterEntry = iotEntryRes.data.data.currentCrowd;
  assert.strictEqual(crowdAfterEntry, crowdBefore + 1, 'IoT ENTRY must increment crowd by 1');
  console.log(`  ✅ IoT ENTRY: crowd ${crowdBefore} → ${crowdAfterEntry}`);

  const iotExitRes = await axios.post(
    `${API_BASE}/iot/crowd`,
    { centerId, type: 'EXIT', sensorId: 'TOF_GATE_01' },
    { headers: { 'x-iot-secret': IOT_SECRET } }
  );
  assert.strictEqual(iotExitRes.status, 200, 'IoT EXIT must return HTTP 200');
  assert.strictEqual(iotExitRes.data.success, true, 'IoT EXIT must return success:true');
  const crowdAfterExit = iotExitRes.data.data.currentCrowd;
  assert.strictEqual(crowdAfterExit, crowdBefore, 'IoT EXIT must restore crowd to original value');
  console.log(`  ✅ IoT EXIT: crowd ${crowdAfterEntry} → ${crowdAfterExit} (restored)`);

  // ── [7/7] Socket.IO Event Delivery Verification ──────────────────────────────
  console.log('\n▶ [7/7] Socket.IO Real-time Event Delivery (no browser refresh required)');

  // Give Render + Socket.IO a moment to fan events to our clients
  await new Promise((r) => setTimeout(r, 800));

  const adminEventNames  = adminEvents.map((a) => a.e);
  const displayEventNames = displayEvents.map((d) => d.e);

  console.log(`  Admin socket received (${adminEvents.length}): ${[...new Set(adminEventNames)].join(', ')}`);
  console.log(`  Display socket received (${displayEvents.length}): ${[...new Set(displayEventNames)].join(', ')}`);

  // Admin center room must receive all lifecycle events
  assert(adminEventNames.includes('token.called'),    'Admin must receive token.called');
  assert(adminEventNames.includes('token.serving'),   'Admin must receive token.serving');
  assert(adminEventNames.includes('token.completed'), 'Admin must receive token.completed');
  assert(adminEventNames.includes('token.skipped'),   'Admin must receive token.skipped');
  assert(adminEventNames.includes('crowd.updated'),   'Admin must receive crowd.updated (IoT events)');
  assert(adminEventNames.includes('counter.updated'), 'Admin must receive counter.updated');

  // Counter display room must receive real-time updates
  assert(
    displayEventNames.includes('counter.updated') ||
    displayEventNames.includes('token.called') ||
    displayEventNames.includes('token.serving'),
    'Counter Display must receive at least one real-time event'
  );

  console.log('  ✅ All Socket.IO events confirmed — no browser refresh required');

  // Room cleanup
  displaySocket.emit('leave:counter', { centerId, counterId: targetCounterId });
  displaySocket.emit('leave:center', centerId);
  adminSocket.emit('leave:center', centerId);

  adminSocket.disconnect();
  displaySocket.disconnect();

  console.log('\n======================================================');
  console.log('🎉 ALL PHASE 2 ACCEPTANCE CRITERIA VERIFIED & PASSED!');
  console.log('======================================================');
  console.log('');
  console.log('  ✅ Admin authentication');
  console.log('  ✅ Staff authentication');
  console.log('  ✅ Dashboard API (Queue, Counters, Crowd, Analytics)');
  console.log('  ✅ Token creation WAITING');
  console.log('  ✅ WAITING → CALLED');
  console.log('  ✅ CALLED → SERVING');
  console.log('  ✅ SERVING → COMPLETED');
  console.log('  ✅ SKIP (CALLED → SKIPPED)');
  console.log('  ✅ Real IoT ENTRY/EXIT');
  console.log('  ✅ Socket.IO connection (production WebSocket)');
  console.log('  ✅ Socket.IO events (token.called / serving / completed / skipped / crowd.updated / counter.updated)');
  console.log('  ✅ Counter Display real-time update');
  console.log('  ✅ No local backend used');
  console.log(`\n  Backend tested : ${BACKEND_ROOT}`);
  console.log('  Database       : MongoDB Atlas (via Render environment)');
  console.log('');
  console.log('  ── PHASE 2 COMPLETE — DO NOT START PHASE 3 ──');
  console.log('');

  process.exit(0);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

testAdminFlow().catch((err) => {
  console.error('\n❌ Integration Test Failed:', err.message);
  if (err.response) {
    console.error('   HTTP Status :', err.response.status);
    console.error('   Response    :', JSON.stringify(err.response.data));
  }
  if (err.stack) {
    console.error('\nStack:', err.stack);
  }
  process.exit(1);
});

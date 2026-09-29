/**
 * Verification Script for College Account Live Counter
 * Tests the real two-counter flow directly against the running backend server.
 */

const http = require('http');
const { io } = require('socket.io-client');
const assert = require('assert');

const BASE_URL = 'http://localhost:5000';
const COLLEGE_CENTER_ID = '6ab93df8da6b1eefeb19caa2';
const COUNTER_ONE_ID = '6ab93df9da6b1eefeb19caaa';
const COUNTER_TWO_ID = '6ab93dfbda6b1eefeb19cae0';
const SERVICE_ID = '6ab93df8da6b1eefeb19caa6';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (_) {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

// Pure counter state replication from frontend
function buildCountersState(backendCounters = [], nowServing = []) {
  if (!Array.isArray(backendCounters) || backendCounters.length === 0) return [];

  const isNowServingExplicitEmpty = Array.isArray(nowServing) && nowServing.length === 0;

  return backendCounters.map((c, idx) => {
    const matchedToken = Array.isArray(nowServing)
      ? nowServing.find((t) => {
          if (!t) return false;
          if (t.counterId) {
            if (t.counterId === c._id || t.counterId?._id === c._id) return true;
            if (c.number && t.counterId?.number === c.number) return true;
            if (c.name && t.counterId?.name === c.name) return true;
            if (c.displayLabel && t.counterId?.displayLabel === c.displayLabel) return true;
          }
          return false;
        })
      : null;

    const counterLabel =
      matchedToken?.counterId?.displayLabel ||
      c.displayLabel ||
      c.name ||
      (c.number ? `COUNTER ${String(c.number).padStart(2, '0')}` : `COUNTER ${String(idx + 1).padStart(2, '0')}`);

    if (isNowServingExplicitEmpty) {
      return { ...c, displayLabel: counterLabel, servingToken: null };
    }

    let servingToken = null;
    if (matchedToken) {
      servingToken = {
        _id: matchedToken._id,
        tokenCode: matchedToken.tokenCode,
        status: matchedToken.status,
        calledAt: matchedToken.calledAt,
      };
    } else if (c.servingToken && ['CALLED', 'SERVING'].includes(c.servingToken.status)) {
      servingToken = { ...c.servingToken };
    }

    return {
      ...c,
      displayLabel: counterLabel,
      servingToken,
    };
  });
}

function updateOnTokenCalled(counters, token, counter) {
  return counters.map((c) => {
    const match =
      (counter?._id && String(c._id) === String(counter._id)) ||
      (token?.counterId?._id && String(c._id) === String(token.counterId._id)) ||
      (counter?.number !== undefined && Number(c.number) === Number(counter.number));

    if (match) {
      return {
        ...c,
        servingToken: {
          _id: token?._id || token?.id,
          tokenCode: token?.tokenCode,
          status: token?.status || 'CALLED',
        },
      };
    }
    return c;
  });
}

function clearOnTokenCompleted(counters, token, counter) {
  return counters.map((c) => {
    const match =
      (counter?._id && String(c._id) === String(counter._id)) ||
      (token?.counterId?._id && String(c._id) === String(token.counterId._id)) ||
      (c.servingToken && c.servingToken.tokenCode === token?.tokenCode);

    if (match) {
      return {
        ...c,
        servingToken: null,
      };
    }
    return c;
  });
}

async function runVerification() {
  console.log('🚀 Starting College Account Real Two-Counter Verification...\n');

  // 1. Login as Admin
  const loginRes = await request('POST', '/api/auth/login', {
    email: 'admin@queueflow.dev',
    password: 'Admin@1234',
  });
  assert.strictEqual(loginRes.status, 200, 'Admin login failed');
  const adminToken = loginRes.body.data.token;
  console.log('  ✓ Admin logged in');

  // 2. Fetch Display State to get displayToken & initial counters
  const displayRes = await request('GET', `/api/queue/${COLLEGE_CENTER_ID}/display`);
  assert.strictEqual(displayRes.status, 200, 'Failed to fetch display data');
  const displayData = displayRes.body.data;
  const displayToken = displayData.displayToken;
  assert(displayToken, 'displayToken is missing');
  console.log('  ✓ Fetched initial display data and displayToken');

  // Disable autoResourceAllocation temporarily so manual call-next can be tested deterministically
  const initialAuto = displayData.center?.autoResourceAllocation ?? true;
  await request('PATCH', `/api/service-centers/${COLLEGE_CENTER_ID}`, { autoResourceAllocation: false }, auth(adminToken));
  console.log('  ✓ Disabled autoResourceAllocation for deterministic manual testing');

  let localCounters = buildCountersState(displayData.counters, displayData.nowServing);
  console.log('  Initial Counters:', localCounters.map((c) => `${c.displayLabel}: ${c.servingToken?.tokenCode || 'IDLE'}`));

  // 3. Clear any active tokens on Counter 01 and 02 first
  for (const c of localCounters) {
    if (c.servingToken) {
      await request('POST', `/api/counters/${c._id}/complete`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));
    }
  }

  // Connect socket client as Live Counter display board
  const socket = io(BASE_URL, {
    transports: ['websocket'],
    auth: { token: displayToken },
    query: { centerId: COLLEGE_CENTER_ID, role: 'display' },
  });

  const receivedEvents = [];
  socket.on('token.called', (d) => {
    receivedEvents.push({ event: 'token.called', data: d });
    localCounters = updateOnTokenCalled(localCounters, d.token, d.counter);
  });
  socket.on('token.completed', (d) => {
    receivedEvents.push({ event: 'token.completed', data: d });
    localCounters = clearOnTokenCompleted(localCounters, d.token, d.counter);
  });

  await new Promise((resolve) => socket.once('connect', resolve));
  console.log('  ✓ Socket.IO connected to display room');

  const centerLat = displayData.center?.latitude || displayData.center?.location?.latitude || 23.183009;
  const centerLng = displayData.center?.longitude || displayData.center?.location?.longitude || 77.301403;

  // Register 3 customers to join College Queue
  async function makeCustomerAndJoin(idx) {
    const email = `college.test.${Date.now()}.${idx}@example.com`;
    const reg = await request('POST', '/api/auth/register', {
      name: `College Customer ${idx}`,
      email,
      password: 'Password@1234',
    });
    const custToken = reg.body?.data?.token || reg.body?.token;
    const joinRes = await request(
      'POST',
      '/api/tokens',
      {
        centerId: COLLEGE_CENTER_ID,
        serviceId: SERVICE_ID,
        notifyApp: false,
        notifySms: false,
        latitude: centerLat,
        longitude: centerLng,
      },
      auth(custToken)
    );
    if (joinRes.status !== 201) {
      throw new Error(`Failed to join queue: ${joinRes.status} ${JSON.stringify(joinRes.body)}`);
    }
    return joinRes.body?.data?.token;
  }

  console.log('\n  Issuing test tokens for College Queue...');
  const t1 = await makeCustomerAndJoin(1);
  const t2 = await makeCustomerAndJoin(2);
  const t3 = await makeCustomerAndJoin(3);
  console.log(`  ✓ Tokens issued: ${t1?.tokenCode}, ${t2?.tokenCode}, ${t3?.tokenCode}`);

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Call next at Counter 01
  // Expected: Counter 01 -> real token, Counter 02 -> IDLE
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST 1: Call next at Counter 01 ---');
  const call1Res = await request('POST', `/api/counters/${COUNTER_ONE_ID}/call-next`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));
  assert.strictEqual(call1Res.status, 200, 'Call next at Counter 01 failed');
  const c1Token = call1Res.body.data.token.tokenCode;
  console.log(`  Counter 01 called token: ${c1Token}`);

  await new Promise((r) => setTimeout(r, 600));

  const c1 = localCounters.find((c) => c._id === COUNTER_ONE_ID);
  const c2 = localCounters.find((c) => c._id === COUNTER_TWO_ID);
  assert.strictEqual(c1?.servingToken?.tokenCode, c1Token, `Counter 01 must be serving ${c1Token}`);
  assert.strictEqual(c2?.servingToken, null, 'Counter 02 must be IDLE');
  console.log('  ✅ TEST 1 PASSED: Counter 01 is serving real token, Counter 02 is IDLE');

  // ─────────────────────────────────────────────────────────────
  // TEST 2: Call next at Counter 02
  // Expected: Counter 01 -> current state, Counter 02 -> new real token
  // Both must be shown at the same time!
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST 2: Call next at Counter 02 ---');
  const call2Res = await request('POST', `/api/counters/${COUNTER_TWO_ID}/call-next`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));
  assert.strictEqual(call2Res.status, 200, 'Call next at Counter 02 failed');
  const c2Token = call2Res.body.data.token.tokenCode;
  console.log(`  Counter 02 called token: ${c2Token}`);

  await new Promise((r) => setTimeout(r, 600));

  const c1After = localCounters.find((c) => c._id === COUNTER_ONE_ID);
  const c2After = localCounters.find((c) => c._id === COUNTER_TWO_ID);
  assert.strictEqual(c1After?.servingToken?.tokenCode, c1Token, 'Counter 01 must still be serving its token');
  assert.strictEqual(c2After?.servingToken?.tokenCode, c2Token, 'Counter 02 must be serving new real token');
  console.log(`  State: Counter 01 -> ${c1After?.servingToken?.tokenCode}, Counter 02 -> ${c2After?.servingToken?.tokenCode}`);
  console.log('  ✅ TEST 2 PASSED: Both counters are shown simultaneously without overwriting!');

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Complete Counter 01 token
  // Expected: Counter 01 -> IDLE, Counter 02 -> still shows real token
  // Counter 02 must NOT disappear!
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST 3: Complete Counter 01 token ---');
  const comp1Res = await request('POST', `/api/counters/${COUNTER_ONE_ID}/complete`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));
  assert.strictEqual(comp1Res.status, 200, 'Complete Counter 01 failed');

  await new Promise((r) => setTimeout(r, 600));

  const c1PostComp = localCounters.find((c) => c._id === COUNTER_ONE_ID);
  const c2PostComp = localCounters.find((c) => c._id === COUNTER_TWO_ID);
  assert.strictEqual(c1PostComp?.servingToken, null, 'Counter 01 must be IDLE');
  assert.strictEqual(c2PostComp?.servingToken?.tokenCode, c2Token, `Counter 02 must STILL show its token ${c2Token}`);
  console.log(`  State: Counter 01 -> IDLE, Counter 02 -> ${c2PostComp?.servingToken?.tokenCode}`);
  console.log('  ✅ TEST 3 PASSED: Counter 01 is IDLE, Counter 02 did NOT disappear!');

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Call another token on Counter 01
  // Expected: Counter 01 updates, Counter 02 remains unchanged
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST 4: Call another token on Counter 01 ---');
  const call1NextRes = await request('POST', `/api/counters/${COUNTER_ONE_ID}/call-next`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));
  assert.strictEqual(call1NextRes.status, 200, 'Second call next at Counter 01 failed');
  const c1Token2 = call1NextRes.body.data.token.tokenCode;
  console.log(`  Counter 01 called token: ${c1Token2}`);

  await new Promise((r) => setTimeout(r, 600));

  const c1Test4 = localCounters.find((c) => c._id === COUNTER_ONE_ID);
  const c2Test4 = localCounters.find((c) => c._id === COUNTER_TWO_ID);
  assert.strictEqual(c1Test4?.servingToken?.tokenCode, c1Token2, `Counter 01 updated to ${c1Token2}`);
  assert.strictEqual(c2Test4?.servingToken?.tokenCode, c2Token, `Counter 02 remained ${c2Token}`);
  console.log('  ✅ TEST 4 PASSED: Counter 01 updated, Counter 02 remained unchanged');

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Socket reconnect / Authoritative sync
  // Expected: Both counters return authoritative state
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST 5: Authoritative Reconnect Sync ---');
  const freshDisplay = await request('GET', `/api/queue/${COLLEGE_CENTER_ID}/display`);
  assert.strictEqual(freshDisplay.status, 200);
  const rebuiltCounters = buildCountersState(freshDisplay.body.data.counters, freshDisplay.body.data.nowServing);

  const c1Rebuilt = rebuiltCounters.find((c) => c._id === COUNTER_ONE_ID);
  const c2Rebuilt = rebuiltCounters.find((c) => c._id === COUNTER_TWO_ID);
  assert.strictEqual(c1Rebuilt?.servingToken?.tokenCode, c1Token2, 'Counter 01 authoritative state verified');
  assert.strictEqual(c2Rebuilt?.servingToken?.tokenCode, c2Token, 'Counter 02 authoritative state verified');
  console.log('  ✅ TEST 5 PASSED: Both counters authoritative on reconnect!');

  // Cleanup: Complete remaining tokens and restore auto allocation
  await request('POST', `/api/counters/${COUNTER_ONE_ID}/complete`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));
  await request('POST', `/api/counters/${COUNTER_TWO_ID}/complete`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));
  await request('PATCH', `/api/service-centers/${COLLEGE_CENTER_ID}`, { autoResourceAllocation: initialAuto }, auth(adminToken));
  console.log('  ✓ Cleaned up active tokens and restored autoResourceAllocation');

  socket.disconnect();
  console.log('\n🎉 ALL REAL COLLEGE ACCOUNT TESTS PASSED WITH 100% SUCCESS!\n');
}

runVerification().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});

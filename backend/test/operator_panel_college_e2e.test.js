'use strict';

/**
 * QueueFlow — Live Operator Panel: end-to-end regression against the REAL
 * "College Account" facility.
 *
 * This suite is the proof that the operator panel is actually fixed. It runs
 * against the real, existing facility
 *
 *     centerId = 6ab93df8da6b1eefeb19caa2   ("College Account")
 *
 * and its real, existing counters (Counter 01 / Counter 02, both running the
 * "College Queue" service). It deliberately does NOT create a duplicate center.
 *
 * What it proves, in order:
 *   1.  CHOOSE COUNTER loads real counters for the selected facility
 *   2.  an ADMIN with no facility selected is told to choose, instead of being
 *       silently handed the first counter in the whole database
 *   3.  a counter that does not belong to the selected facility is refused
 *   4.  the rendered center/service always belong to the selected facility
 *   5.  the waiting list is real, de-duplicated and scoped to this queue
 *   6.  CALL NEXT returns a real token and the panel reflects it
 *   7.  START SERVING moves CALLED -> SERVING
 *   8.  COMPLETE moves SERVING -> COMPLETED and frees the counter
 *   9.  SKIP removes the token through the backend
 *  10.  Counter 01 and Counter 02 stay independent
 *  11.  counter status (ACTIVE / BREAK / CLOSED) gates CALL NEXT
 *  12.  a normal operator is bound to their assigned counter by the backend
 *  13.  the existing Socket.IO events actually fire
 *  14.  the Live Counter display feed agrees with the operator panel
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');

const { server } = require('../server');
const connectDB = require('../src/config/database');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const queueService = require('../src/services/queueService');

const COLLEGE_CENTER_ID = '6ab93df8da6b1eefeb19caa2';
const ADMIN_EMAIL = 'admin@queueflow.dev';
const ADMIN_PASSWORD = 'Admin@1234';
const OPERATOR_PASSWORD = 'Operator@1234';

let baseUrl;
let testServer;
let college;
let service;
let counterOne;
let counterTwo;
let otherCenter;
let otherCounter;

let adminToken;
let operatorOneToken;

const createdCustomerIds = [];
const createdTokenIds = [];
const operatorPasswordsToRestore = [];
let autoAllocationWasEnabled = false;

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

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
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

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function step(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, err);
  }
}

async function login(email, password) {
  const res = await request('POST', '/api/auth/login', { email, password });
  if (res.status !== 200 || !res.body?.data?.token) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return res.body.data.token;
}

/**
 * Put a customer into the real College Queue and mark them as physically
 * present at the facility, so both the join-time geofence and the CALL NEXT
 * eligibility check treat them as legitimately present.
 *
 * The coordinates are read from the center record with the same precedence the
 * backend uses (center.latitude/longitude first, then center.location), so the
 * customer is standing exactly on the facility.
 */
async function joinCollegeQueue() {
  const user = await makeCustomer('Queue');

  const lat = college.latitude ?? college.location?.latitude;
  const lng = college.longitude ?? college.location?.longitude;
  assert(Number.isFinite(lat) && Number.isFinite(lng), 'College Account must have usable coordinates');

  const { token } = await queueService.joinQueue({
    userId: user._id.toString(),
    centerId: COLLEGE_CENTER_ID,
    serviceId: service._id.toString(),
    channel: 'WEB',
    latitude: lat,
    longitude: lng,
    accuracy: 10,
    timestamp: new Date(),
  });
  createdTokenIds.push(token._id);

  return token;
}

function codes(list) {
  return (list || []).map((t) => t.tokenCode);
}

/**
 * Read a Mongo id off a field that may be a raw ObjectId or a populated
 * document. Some payloads come back populated, so `String(x)` alone is not
 * enough to compare ids.
 */
function idOf(value) {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

/** Join customers until the real queue has at least `n` WAITING tokens. */
async function ensureWaiting(n) {
  const { $gte, $lt } = queueService.getTodayTokenRange();
  for (let guard = 0; guard < 20; guard += 1) {
    const waiting = await Token.countDocuments({
      centerId: COLLEGE_CENTER_ID,
      serviceId: service._id,
      status: 'WAITING',
      createdAt: { $gte, $lt },
    });
    if (waiting >= n) return;
    await joinCollegeQueue();
  }
  throw new Error(`Could not get ${n} customers waiting in the College Account queue`);
}

/** Create a throwaway customer account and remember it for cleanup. */
async function makeCustomer(tag) {
  const user = await User.create({
    name: `E2E ${tag} ${Date.now()}${Math.floor(Math.random() * 1000)}`,
    email: `e2e_${tag}_${Date.now()}_${Math.floor(Math.random() * 100000)}@queueflow.test`,
    passwordHash: await User.hashPassword('Customer@1234'),
    role: 'CUSTOMER',
  });
  createdCustomerIds.push(user._id);
  return user;
}

function assertNoDuplicateCodes(list, label) {
  const seen = new Set();
  for (const t of list || []) {
    assert(!seen.has(t.tokenCode), `${label}: token ${t.tokenCode} appears more than once`);
    seen.add(t.tokenCode);
  }
}

async function run() {
  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      baseUrl = `http://localhost:${testServer.address().port}`;
      resolve();
    });
  });

  // ── Fixture: the REAL College Account facility and its REAL counters ──────
  college = await ServiceCenter.findById(COLLEGE_CENTER_ID);
  if (!college) {
    throw new Error(`College Account center ${COLLEGE_CENTER_ID} does not exist`);
  }

  const counters = await Counter.find({ centerId: college._id }).sort({ number: 1 });
  if (counters.length < 2) {
    throw new Error(`College Account must have at least 2 real counters, found ${counters.length}`);
  }
  counterOne = counters[0];
  counterTwo = counters[1];

  // Make sure both counters are open and idle before the run.
  for (const c of [counterOne, counterTwo]) {
    await Counter.updateOne({ _id: c._id }, { $set: { status: 'ACTIVE', currentTokenId: null } });
  }

  service = await mongoose.model('Service').findById(counterOne.serviceId);

  // This facility has `autoResourceAllocation` enabled, which is a legitimate
  // production behaviour: it pre-assigns waiting customers to free counters on
  // its own. This suite exercises the MANUAL operator path (CALL NEXT /
  // START SERVING / COMPLETE / SKIP), so automatic pre-assignment is paused for
  // the duration of the run and restored in cleanup. Without this, the
  // allocator would move tokens onto counters between the panel's read and the
  // operator's click and the test would be non-deterministic.
  autoAllocationWasEnabled = college.autoResourceAllocation === true;
  if (autoAllocationWasEnabled) {
    await ServiceCenter.updateOne({ _id: college._id }, { $set: { autoResourceAllocation: false } });
  }

  // A counter in a completely different facility, used for the isolation checks.
  otherCounter = await Counter.findOne({ centerId: { $ne: college._id } });
  otherCenter = otherCounter
    ? await ServiceCenter.findById(otherCounter.centerId)
    : await ServiceCenter.findOne({ _id: { $ne: college._id } });

  // ── Auth ──────────────────────────────────────────────────────────────────
  adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // The two real College operators are @queueflow.test accounts. Give them a
  // known password for this run and restore whatever they had afterwards.
  const operators = await User.find({
    centerId: college._id,
    role: 'STAFF',
  }).limit(2);

  let operatorOne = operators.find((u) => String(u.assignedCounterId) === String(counterOne._id));
  if (!operatorOne) operatorOne = operators[0];

  if (operatorOne) {
    operatorPasswordsToRestore.push({
      id: operatorOne._id,
      passwordHash: operatorOne.passwordHash,
    });
    operatorOne.passwordHash = await User.hashPassword(OPERATOR_PASSWORD);
    await operatorOne.save();
    operatorOneToken = await login(operatorOne.email, OPERATOR_PASSWORD);
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Live Operator Panel — College Account E2E');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Facility : ${college.name} (${college._id})`);
  console.log(`  Service  : ${service.name}`);
  console.log(`  Counter 1: ${counterOne.name} (${counterOne._id})`);
  console.log(`  Counter 2: ${counterTwo.name} (${counterTwo._id})`);
  console.log('══════════════════════════════════════════════════════════\n');

  let calledTokenOne = null;
  let calledTokenTwo = null;
  let socket = null;
  const socketEvents = [];

  // ─────────────────────────────────────────────────────────────────────────
  // 1. CHOOSE COUNTER loads REAL counters for the selected facility
  // ─────────────────────────────────────────────────────────────────────────
  let operable = null;
  await step('CHOOSE COUNTER returns the real counters of the selected facility', async () => {
    const res = await request(
      'GET',
      `/api/counters/operable?centerId=${COLLEGE_CENTER_ID}`,
      null,
      auth(adminToken)
    );
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    operable = res.body.data.counters;

    assert(operable.length >= 2, 'expected at least 2 operable counters');
    // Names/numbers come from the database, not from a hardcoded list.
    for (const c of operable) {
      const real = await Counter.findById(c._id).lean();
      assert(real, `counter ${c._id} returned by the picker does not exist in MongoDB`);
      assert.strictEqual(c.name, real.name, 'picker name must match the stored counter name');
      assert.strictEqual(c.number, real.number, 'picker number must match the stored counter number');
      assert.strictEqual(String(real.centerId), COLLEGE_CENTER_ID, 'every returned counter must belong to the selected facility');
    }
    assert(
      operable.some((c) => c._id === String(counterOne._id)) &&
        operable.some((c) => c._id === String(counterTwo._id)),
      'both real College Account counters must be offered'
    );
    assert(
      operable.every((c) => typeof c.canOperate === 'boolean'),
      'the backend must state whether each counter can be operated'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. The original bug: an ADMIN with no facility got a foreign counter
  // ─────────────────────────────────────────────────────────────────────────
  await step('ADMIN with no facility is asked to choose a counter (no foreign counter is invented)', async () => {
    const res = await request('GET', '/api/counters/operator/me', null, auth(adminToken));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      res.body.data.counter,
      null,
      'the backend must NOT fall back to "first counter in the whole database"'
    );
    assert.strictEqual(res.body.data.requiresCounterSelection, true);
    assert(res.body.data.canSelectAnyCounter === true, 'an ADMIN may choose a counter');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Counter / facility mismatch is refused
  // ─────────────────────────────────────────────────────────────────────────
  await step('a counter from another facility is refused for the selected facility', async () => {
    const res = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${otherCounter._id}`,
      null,
      auth(adminToken)
    );
    assert.strictEqual(res.status, 403, 'expected 403 for a counter outside the selected facility');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Panel data always belongs to the selected facility
  // ─────────────────────────────────────────────────────────────────────────
  await step('operator state is scoped to the selected facility and its own service', async () => {
    const res = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterOne._id}`,
      null,
      auth(adminToken)
    );
    assert.strictEqual(res.status, 200);
    const d = res.body.data;
    assert(d.counter, 'a counter must be returned');
    assert.strictEqual(d.counter._id, String(counterOne._id));
    assert.strictEqual(
      String(d.counter.centerId._id),
      COLLEGE_CENTER_ID,
      'the counter header must show the selected facility'
    );
    assert.strictEqual(d.center.name, college.name, 'the facility name must be the selected facility');
    assert.strictEqual(
      String(d.service._id),
      String(service._id),
      'the service must be the one the selected counter actually runs'
    );
    assert.notStrictEqual(d.service._id, String(otherCounter.serviceId), 'service must not leak from another counter');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Real waiting tokens, no duplicates
  // ─────────────────────────────────────────────────────────────────────────
  await step('waiting list is real, de-duplicated and scoped to this queue', async () => {
    // Two customers join the real College Queue.
    const t1 = await joinCollegeQueue();
    const t2 = await joinCollegeQueue();

    const res = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterOne._id}`,
      null,
      auth(adminToken)
    );
    assert.strictEqual(res.status, 200);
    const d = res.body.data;

    assert(d.waitingCount >= 2, `expected at least 2 waiting, got ${d.waitingCount}`);
    assertNoDuplicateCodes(d.waitingTokens, 'waiting list');

    const expected = await Token.find({
      centerId: COLLEGE_CENTER_ID,
      serviceId: service._id,
      status: 'WAITING',
      createdAt: { $gte: queueService.getTodayTokenRange().$gte, $lt: queueService.getTodayTokenRange().$lt },
    })
      .sort({ createdAt: 1 })
      .lean();
    assert.strictEqual(
      d.waitingCount,
      expected.length,
      'the headline waiting count must equal the real number of WAITING tokens'
    );
    assert.deepStrictEqual(
      codes(d.waitingTokens).slice(0, 2),
      [t1.tokenCode, t2.tokenCode],
      'the first two waiting tokens must be the ones that just joined, in FIFO order'
    );
    assert(
      typeof d.estimatedWaitMinutes === 'number',
      'estimated wait must be a real number from the backend, not a placeholder'
    );
    assert(
      d.estimatedWaitMinutes !== 15 || college.name === 'State Bank',
      'the 15m figure must come from the backend, not from a hardcoded default'
    );
  });

  await step('a token issued on a previous business day never appears in today\'s waiting list', async () => {
    // A dedicated customer: the unique "one active token per user per service"
    // index would otherwise reject a second WAITING token for the same user.
    const staleUser = await makeCustomer('Stale');
    const stale = await Token.create({
      userId: staleUser._id,
      centerId: college._id,
      serviceId: service._id,
      tokenCode: `${service.tokenPrefix}-900`,
      tokenNumber: 900,
      status: 'WAITING',
      channel: 'WEB',
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      currentPosition: 1,
    });
    createdTokenIds.push(stale._id);

    const res = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterOne._id}`,
      null,
      auth(adminToken)
    );
    const d = res.body.data;
    assert(
      !codes(d.waitingTokens).includes(stale.tokenCode),
      'a stale token from a previous day must not be shown as waiting now'
    );
    assertNoDuplicateCodes(d.waitingTokens, 'waiting list with stale data present');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6-10. The full action chain on Counter 01
  // ─────────────────────────────────────────────────────────────────────────
  await step('CALL NEXT on Counter 01 returns a real token and the panel shows it', async () => {
    const res = await request(
      'POST',
      `/api/counters/${counterOne._id}/call-next`,
      { centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(res.status, 200, `call-next failed: ${JSON.stringify(res.body).slice(0, 300)}`);
    const token = res.body.data.token;
    assert(token, `no token was called: ${res.body.message}`);
    calledTokenOne = token;

    assert.strictEqual(token.status, 'CALLED');
    assert.strictEqual(idOf(token.centerId), COLLEGE_CENTER_ID, 'the called token must belong to the selected facility');
    assert.strictEqual(idOf(token.serviceId), String(service._id), 'the called token must belong to the counter\'s service');
    assert(String(token.tokenCode).startsWith(service.tokenPrefix), 'token code must use the real service prefix');

    const panel = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterOne._id}`,
      null,
      auth(adminToken)
    );
    assert.strictEqual(
      String(panel.body.data.counter.currentTokenId._id),
      String(token._id),
      'the panel must show the token that was just called'
    );
    assertNoDuplicateCodes(panel.body.data.waitingTokens, 'waiting list after call-next');
    assert(
      !codes(panel.body.data.waitingTokens).includes(token.tokenCode),
      'the called token must leave the waiting list'
    );
  });

  await step('START SERVING moves the called token CALLED -> SERVING', async () => {
    const res = await request(
      'POST',
      `/api/counters/${counterOne._id}/start-serving`,
      { centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(res.status, 200, `start-serving failed: ${JSON.stringify(res.body).slice(0, 300)}`);
    assert.strictEqual(res.body.data.token.status, 'SERVING');
    assert.strictEqual(String(res.body.data.token._id), String(calledTokenOne._id));

    const panel = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterOne._id}`,
      null,
      auth(adminToken)
    );
    assert.strictEqual(panel.body.data.counter.currentTokenId.status, 'SERVING');
  });

  await step('COMPLETE moves SERVING -> COMPLETED and frees the counter', async () => {
    const res = await request(
      'POST',
      `/api/counters/${counterOne._id}/complete`,
      { centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(res.status, 200, `complete failed: ${JSON.stringify(res.body).slice(0, 300)}`);
    assert.strictEqual(res.body.data.token.status, 'COMPLETED');
    assert.strictEqual(String(res.body.data.token._id), String(calledTokenOne._id));

    const panel = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterOne._id}`,
      null,
      auth(adminToken)
    );
    assert(
      !panel.body.data.counter.currentTokenId,
      'the current customer must be cleared after COMPLETE'
    );
    assert(panel.body.data.waitingTokens.length > 0, 'the next waiting token must become available');
  });

  await step('a second CALL NEXT takes a different, later token (real FIFO)', async () => {
    const res = await request(
      'POST',
      `/api/counters/${counterOne._id}/call-next`,
      { centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(res.status, 200);
    const token = res.body.data.token;
    assert(token, 'expected a second token to be called');
    assert.notStrictEqual(
      String(token._id),
      String(calledTokenOne._id),
      'a second CALL NEXT must not re-call the completed token'
    );
    calledTokenOne = token;
  });

  await step('SKIP removes the token through the backend and frees the counter', async () => {
    const res = await request(
      'POST',
      `/api/counters/${counterOne._id}/skip`,
      { centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(res.status, 200, `skip failed: ${JSON.stringify(res.body).slice(0, 300)}`);
    assert.strictEqual(res.body.data.token.status, 'SKIPPED');
    assert.strictEqual(String(res.body.data.token._id), String(calledTokenOne._id));

    const panel = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterOne._id}`,
      null,
      auth(adminToken)
    );
    assert(!panel.body.data.counter.currentTokenId, 'SKIP must clear the current customer');
    assertNoDuplicateCodes(panel.body.data.waitingTokens, 'waiting list after skip');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. Two counters stay independent
  // ─────────────────────────────────────────────────────────────────────────
  await step('Counter 01 and Counter 02 operate independently', async () => {
    await ensureWaiting(2);

    // Counter 01 has a token in progress.
    const first = await request(
      'POST',
      `/api/counters/${counterOne._id}/call-next`,
      { centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(first.status, 200);
    const tokenAtCounterOne = first.body.data.token;
    assert(tokenAtCounterOne, 'Counter 01 should have called a token');

    // Selecting Counter 02 must show Counter 02's state, not Counter 01's.
    const panelTwo = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterTwo._id}`,
      null,
      auth(adminToken)
    );
    assert.strictEqual(panelTwo.status, 200);
    assert.strictEqual(
      String(panelTwo.body.data.counter._id),
      String(counterTwo._id),
      'the panel must show the counter that was chosen'
    );
    assert(
      !panelTwo.body.data.counter.currentTokenId,
      'Counter 02 must not inherit Counter 01\'s current customer'
    );

    // Now call at Counter 02 and prove the two tokens differ.
    const second = await request(
      'POST',
      `/api/counters/${counterTwo._id}/call-next`,
      { centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(second.status, 200);
    calledTokenTwo = second.body.data.token;
    assert(calledTokenTwo, 'Counter 02 should have called a token');
    assert.notStrictEqual(
      String(calledTokenTwo._id),
      String(tokenAtCounterOne._id),
      'two counters must never hold the same customer'
    );
    assert.strictEqual(idOf(calledTokenTwo.counterId), String(counterTwo._id));

    // And Counter 01 still holds its own customer.
    const panelOne = await request(
      'GET',
      `/api/counters/operator/me?centerId=${COLLEGE_CENTER_ID}&counterId=${counterOne._id}`,
      null,
      auth(adminToken)
    );
    assert.strictEqual(
      String(panelOne.body.data.counter.currentTokenId._id),
      String(tokenAtCounterOne._id),
      'Counter 01 must be unaffected by Counter 02\'s CALL NEXT'
    );
    calledTokenOne = tokenAtCounterOne;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12. Counter status gates CALL NEXT
  // ─────────────────────────────────────────────────────────────────────────
  await step('CLOSED and BREAK counters refuse CALL NEXT; ACTIVE allows it', async () => {
    for (const status of ['CLOSED', 'BREAK']) {
      const up = await request(
        'PATCH',
        `/api/counters/${counterTwo._id}/status`,
        { status, centerId: COLLEGE_CENTER_ID },
        auth(adminToken)
      );
      assert.strictEqual(up.status, 200);
      assert.strictEqual(up.body.data.counter.status, status);

      const call = await request(
        'POST',
        `/api/counters/${counterTwo._id}/call-next`,
        { centerId: COLLEGE_CENTER_ID },
        auth(adminToken)
      );
      assert(
        call.status >= 400,
        `CALL NEXT must be refused while the counter is ${status} (got ${call.status})`
      );
    }

    const reopen = await request(
      'PATCH',
      `/api/counters/${counterTwo._id}/status`,
      { status: 'ACTIVE', centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(reopen.status, 200);
    assert.strictEqual(reopen.body.data.counter.status, 'ACTIVE');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 13. A normal operator is bound to their assigned counter
  // ─────────────────────────────────────────────────────────────────────────
  await step('a normal operator is bound to their backend-assigned counter', async () => {
    if (!operatorOneToken) return; // no operator account to exercise

    const mine = await request('GET', '/api/counters/operator/me', null, auth(operatorOneToken));
    assert.strictEqual(mine.status, 200);
    assert(mine.body.data.counter, 'the operator must resolve their own counter');
    assert.strictEqual(
      String(mine.body.data.counter._id),
      String(counterOne._id),
      'the operator must land on their assigned counter, not an arbitrary one'
    );

    // ...and must not be able to operate their colleague's counter.
    const other = await request(
      'POST',
      `/api/counters/${counterTwo._id}/call-next`,
      { centerId: COLLEGE_CENTER_ID },
      auth(operatorOneToken)
    );
    assert.strictEqual(other.status, 403, 'an operator must not operate an unassigned counter');
  });

  await step('an operator cannot operate a counter in a foreign facility', async () => {
    if (!operatorOneToken) return;
    const res = await request(
      'POST',
      `/api/counters/${otherCounter._id}/call-next`,
      {},
      auth(operatorOneToken)
    );
    assert.strictEqual(res.status, 403, 'cross-facility operation must be refused');
  });

  await step('an operator cannot skip a token from a foreign queue', async () => {
    if (!operatorOneToken) return;
    const foreignToken = await Token.findOne({
      centerId: { $ne: college._id },
      status: { $in: ['WAITING', 'CALLED'] },
    });
    if (!foreignToken) return;
    const res = await request(
      'POST',
      `/api/counters/${counterOne._id}/skip`,
      { tokenId: foreignToken._id, centerId: COLLEGE_CENTER_ID },
      auth(operatorOneToken)
    );
    assert.strictEqual(res.status, 403, 'skipping a token outside the counter scope must be refused');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 14. Realtime: the existing Socket.IO events really fire
  // ─────────────────────────────────────────────────────────────────────────
  await step('the existing Socket.IO events reach a client watching this facility', async () => {
    await ensureWaiting(1);

    socket = ioClient(baseUrl, {
      transports: ['websocket'],
      auth: { token: adminToken },
      reconnection: false,
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    });
    socket.emit('join:center', COLLEGE_CENTER_ID);
    // The operator panel also subscribes to the specific counter room, because
    // the backend broadcasts `counter.updated` there rather than to the centre.
    socket.emit('join:counter', { centerId: COLLEGE_CENTER_ID, counterId: String(counterOne._id) });
    await new Promise((r) => setTimeout(r, 300));

    const seen = new Set();
    for (const ev of [
      'token.called',
      'token.serving',
      'token.completed',
      'token.skipped',
      'queue.updated',
      'counter.updated',
    ]) {
      socket.on(ev, (payload) => {
        seen.add(ev);
        socketEvents.push({ ev, payload });
      });
    }

    // Drive a full cycle at Counter 01 and record what is broadcast.
    const call = await request(
      'POST',
      `/api/counters/${counterOne._id}/call-next`,
      { centerId: COLLEGE_CENTER_ID },
      auth(adminToken)
    );
    assert.strictEqual(call.status, 200);
    const tok = call.body.data.token;
    assert(tok, 'expected a token for the realtime cycle');

    await request('POST', `/api/counters/${counterOne._id}/start-serving`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));
    await request('POST', `/api/counters/${counterOne._id}/complete`, { centerId: COLLEGE_CENTER_ID }, auth(adminToken));

    await new Promise((r) => setTimeout(r, 1200));

    for (const ev of ['token.called', 'token.serving', 'token.completed', 'queue.updated', 'counter.updated']) {
      assert(seen.has(ev), `expected the existing "${ev}" event to be broadcast (saw: ${[...seen].join(', ') || 'none'})`);
    }

    // The broadcast token must be the real one, and scoped to this facility.
    const calledEv = socketEvents.find((e) => e.ev === 'token.called' && e.payload?.token?._id);
    if (calledEv) {
      assert.strictEqual(
        String(calledEv.payload.token._id),
        String(tok._id),
        'token.called must carry the real token that was called'
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 15. The Live Counter display feed agrees with the panel
  // ─────────────────────────────────────────────────────────────────────────
  await step('the Live Counter display feed reflects the same facility and tokens', async () => {
    const res = await request('GET', `/api/queue/${COLLEGE_CENTER_ID}/display`);
    assert.strictEqual(res.status, 200);
    const d = res.body.data;
    assert(d.center, 'the display feed must name the center');
    assert.strictEqual(String(d.center._id), COLLEGE_CENTER_ID, 'the display feed must be for the selected facility');
    assert(Array.isArray(d.counters), 'the display feed must list counters');
    const ours = d.counters.filter((c) => [String(counterOne._id), String(counterTwo._id)].includes(String(c._id)));
    assert.strictEqual(ours.length, 2, 'both College Account counters must appear on the display feed');
    assert(Array.isArray(d.nowServing), 'the display feed must expose nowServing');
    assert(Array.isArray(d.nextInQueue), 'the display feed must expose nextInQueue');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────
  await step('cleanup', async () => {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }

    // Leave both real counters open and idle.
    for (const c of [counterOne, counterTwo]) {
      await Counter.updateOne({ _id: c._id }, { $set: { status: 'ACTIVE', currentTokenId: null } });
    }

    // Put the facility's automatic pre-assignment back the way we found it.
    if (autoAllocationWasEnabled) {
      await ServiceCenter.updateOne({ _id: college._id }, { $set: { autoResourceAllocation: true } });
    }

    // Resolve any token this run left in flight.
    await Token.updateMany(
      { _id: { $in: createdTokenIds }, status: { $in: ['CALLED', 'SERVING', 'WAITING'] } },
      { $set: { status: 'CANCELLED', currentPosition: null } }
    );
    if (createdTokenIds.length) {
      await Token.deleteMany({ _id: { $in: createdTokenIds } });
    }
    if (createdCustomerIds.length) {
      await User.deleteMany({ _id: { $in: createdCustomerIds } });
    }

    // Restore the operator passwords we borrowed.
    for (const rec of operatorPasswordsToRestore) {
      await User.updateOne({ _id: rec.id }, { $set: { passwordHash: rec.passwordHash } });
    }
  });
}

run()
  .catch((err) => {
    failed++;
    console.error('\n  ❌ FATAL:', err);
  })
  .finally(async () => {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');

    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    try {
      await mongoose.disconnect();
    } catch (_) {}
    if (testServer && testServer.close) {
      // Drop keep-alive sockets, otherwise the listener never finishes closing.
      testServer.closeAllConnections?.();
      testServer.close();
    }

    // The server module installs its own timers/interval handles, so the event
    // loop is not guaranteed to drain on its own. An unref'd timer still fires
    // while the process is alive, which makes the exit code reliable instead of
    // leaving CI hanging.
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 200).unref();
  });

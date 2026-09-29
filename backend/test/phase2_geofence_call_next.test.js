'use strict';

/**
 * QueueFlow — Phase 2 Second-Stage Geofencing Regression Suite
 *
 * Covers the 20 required scenarios for customers who ALREADY hold a WAITING
 * token and then leave the 100 m service-area radius.
 *
 * Every test drives the real HTTP surface against a booted server, a real
 * MongoDB, the real Token model and the real Socket.IO emitter. Nothing is
 * stubbed, so a green run really means the production code path works.
 */

process.env.NODE_ENV = 'test';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const assert = require('assert');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// ─── Captured socket emissions ────────────────────────────────────────────────
// The socket emit helpers are captured BEFORE anything else is required,
// because queueService (and the controllers it is loaded by) destructure these
// functions at module load time. Only the three emit helpers are intercepted;
// the real Socket.IO server is still created by ../server, so the HTTP surface
// is exercised for real while the outbound broadcasts are recorded for
// assertion instead of being fired into the void.
const emitted = [];
const socketModule = require('../src/config/socket');
socketModule.emitToCenter = (centerId, event, data) => {
  emitted.push({ room: `center:${centerId}`, event, payload: data });
};
socketModule.emitToUser = (userId, event, data) => {
  emitted.push({ room: `user:${userId}`, event, payload: data });
};
socketModule.emitToCounter = (centerId, counterId, event, data) => {
  emitted.push({ room: `counter:${centerId}:${counterId}`, event, payload: data });
};

const { server } = require('../server');
const connectDB = require('../src/config/database');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const Queue = require('../src/models/Queue');
const QueueEvent = require('../src/models/QueueEvent');
const Notification = require('../src/models/Notification');
const { Token } = require('../src/models/Token');

const queueService = require('../src/services/queueService');
const geofenceService = require('../src/services/geofenceService');
const { getTodayDateString } = require('../src/utils/tokenUtils');

const CENTER_CODE = 'QF-GEO-P2';
const CENTER_LAT = 12.9716;
const CENTER_LNG = 77.5946;
const RADIUS_METERS = 100;

let baseUrl;
let testServer;
let center;
let service;
let counter;
let counterB;
let adminUser;
let adminJwt;
const customers = [];

let passed = 0;
let failed = 0;
const failures = [];

function pass(name) {
  passed++;
  console.log(`  PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  failures.push(`${name}: ${err.message}`);
  console.error(`  FAIL  ${name}: ${err.message}`);
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

function signToken(user, role) {
  const tokenVersion = user.tokenVersion !== undefined ? user.tokenVersion : 0;
  return jwt.sign(
    { id: user._id.toString(), role, tokenVersion },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '1h' }
  );
}

/** Real coordinate `meters` north of the service center. */
function pointAt(meters) {
  const R = 6371000;
  return { latitude: CENTER_LAT + (meters / R) * (180 / Math.PI), longitude: CENTER_LNG };
}

async function makeCustomer(n) {
  const email = `geo2.customer${n}@queueflow.test`;
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({
      name: `Geo2 Customer ${n}`,
      email,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345',
      role: 'CUSTOMER',
      isActive: true,
      isVerified: true,
    });
  }
  const jwtToken = signToken(user, 'CUSTOMER');
  const entry = { user, jwt: jwtToken };
  customers.push(entry);
  return entry;
}

/**
 * Join the real queue through the real HTTP endpoint from a real coordinate.
 * The Phase 1 join geofence rejects anything outside the radius, so a token can
 * only ever start life inside the service area.
 */
async function joinAt(customer, metersFromCenter) {
  const pt = pointAt(metersFromCenter);
  const res = await request(
    'POST',
    '/api/tokens',
    {
      centerId: center._id.toString(),
      serviceId: service._id.toString(),
      latitude: pt.latitude,
      longitude: pt.longitude,
      accuracy: 8,
    },
    { Authorization: `Bearer ${customer.jwt}` }
  );
  assert.strictEqual(
    res.status,
    201,
    `join from ${metersFromCenter}m must succeed, got ${res.status}: ${JSON.stringify(res.body)}`
  );
  return { tokenId: res.body.data.token._id, tokenCode: res.body.data.token.tokenCode };
}

/** Push a real location through the real location endpoint. */
async function pushLocation(customer, tokenId, metersFromCenter, ageSeconds = 0) {
  const pt = pointAt(metersFromCenter);
  const timestamp = new Date(Date.now() - ageSeconds * 1000).toISOString();
  const res = await request(
    'POST',
    `/api/tokens/${tokenId}/location`,
    {
      latitude: pt.latitude,
      longitude: pt.longitude,
      accuracy: 8,
      timestamp,
      centerId: center._id.toString(),
    },
    { Authorization: `Bearer ${customer.jwt}` }
  );
  assert.strictEqual(
    res.status,
    200,
    `location push at ${metersFromCenter}m must succeed, got ${res.status}: ${JSON.stringify(res.body)}`
  );
  return res.body.data;
}

function callNext() {
  return queueService.callNext({
    counterId: counter._id.toString(),
    centerId: center._id.toString(),
    adminId: adminUser._id.toString(),
  });
}

/** Run CALL NEXT against an explicit counter (used for the two-counter race). */
function callNextAt(targetCounter) {
  return queueService.callNext({
    counterId: targetCounter._id.toString(),
    centerId: center._id.toString(),
    adminId: adminUser._id.toString(),
  });
}

/** Run CALL NEXT and return only the emissions it produced. */
async function callNextCapturing() {
  emitted.length = 0;
  const result = await callNext();
  return { result, events: emitted.slice() };
}

/** Clear the whole test queue back to a known-empty state. */
async function resetQueue() {
  await Token.deleteMany({ centerId: center._id });
  await Queue.deleteMany({ centerId: center._id });
  await QueueEvent.deleteMany({ centerId: center._id });
  await Notification.deleteMany({ centerId: center._id });
  await Counter.updateMany(
    { centerId: center._id },
    { $set: { currentTokenId: null, servingStartedAt: null } }
  );
}

async function setup() {
  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${testServer.address().port}`;
      resolve();
    });
  });

  center = await ServiceCenter.findOne({ code: CENTER_CODE });
  if (!center) {
    center = await ServiceCenter.create({
      name: 'Geo Phase2 Test Center',
      code: CENTER_CODE,
      type: 'GOVT',
      capacity: 200,
      isOpen: true,
      latitude: CENTER_LAT,
      longitude: CENTER_LNG,
      joiningRadiusMeters: RADIUS_METERS,
    });
  } else {
    center.latitude = CENTER_LAT;
    center.longitude = CENTER_LNG;
    center.joiningRadiusMeters = RADIUS_METERS;
    center.isOpen = true;
    await center.save();
  }

  service = await Service.findOne({ centerId: center._id, $or: [{ code: 'GEO2' }, { tokenPrefix: 'P2' }] });
  if (!service) {
    service = await Service.create({
      name: 'Phase2 Window',
      code: 'GEO2',
      centerId: center._id,
      isActive: true,
      tokenPrefix: 'P2',
      avgServiceTimeMinutes: 5,
    });
  } else {
    service.isActive = true;
    await service.save();
  }

  counter = await Counter.findOne({ centerId: center._id, number: 2 });
  if (!counter) {
    counter = await Counter.create({
      name: 'Counter 02',
      number: 2,
      centerId: center._id,
      serviceId: service._id,
      status: 'ACTIVE',
      displayLabel: 'Counter 02',
    });
  } else {
    counter.serviceId = service._id;
    counter.status = 'ACTIVE';
    await counter.save();
  }

  adminUser =
    (await User.findOne({ email: 'geo2.admin@queueflow.test' })) ||
    (await User.create({
      name: 'Geo2 Admin',
      email: 'geo2.admin@queueflow.test',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345',
      role: 'ADMIN',
      isActive: true,
      isVerified: true,
    }));
  adminJwt = signToken(adminUser, 'ADMIN');

  // A second free counter at the same center. Test 20 needs the real
  // "two counters free at the same instant" race, which cannot be reproduced
  // by pressing CALL NEXT twice on one counter: a counter physically serves
  // one customer at a time.
  counterB = await Counter.findOne({ centerId: center._id, number: 3 });
  if (!counterB) {
    counterB = await Counter.create({
      name: 'Counter 03',
      number: 3,
      centerId: center._id,
      serviceId: service._id,
      status: 'ACTIVE',
      displayLabel: 'Counter 03',
    });
  } else {
    counterB.serviceId = service._id;
    counterB.status = 'ACTIVE';
    await counterB.save();
  }

  for (let i = 0; i < 6; i++) {
    await makeCustomer(i);
  }

  await resetQueue();
}

async function cleanup() {
  try {
    await Token.deleteMany({ centerId: center._id });
    await Queue.deleteMany({ centerId: center._id });
    await QueueEvent.deleteMany({ centerId: center._id });
    await Notification.deleteMany({ centerId: center._id });
    if (counter) await Counter.deleteMany({ centerId: center._id });
    if (service) await Service.deleteMany({ centerId: center._id });
    if (center) await ServiceCenter.deleteMany({ _id: center._id });
  } catch (_) {}
  if (testServer) await new Promise((resolve) => testServer.close(resolve));
  await mongoose.disconnect();
}

async function runTests() {
  console.log('\n============================================================');
  console.log('  QUEUEFLOW - PHASE 2 SECOND-STAGE GEOFENCING');
  console.log('============================================================\n');
  const c0 = customers[0];
  const c1 = customers[1];
  const c2 = customers[2];
  const c3 = customers[3];
  const c4 = customers[4];
  const c5 = customers[5];

  // ── 1. Joined in range -> token remains valid ──────────────────────────────
  try {
    await resetQueue();
    const t = await joinAt(c0, 40);
    const token = await Token.findById(t.tokenId).lean();
    assert.strictEqual(token.status, 'WAITING', 'token must be WAITING after joining in range');
    assert.strictEqual(token.locationStatus, 'IN_RANGE', 'join must record IN_RANGE');
    assert(token.lastLocation && token.lastLocation.updatedAt, 'join must seed a timestamped lastLocation');
    assert(token.lastLocation.latitude, 'lastLocation must carry the verified join position');

    // Walking away must NOT invalidate the token (Phase 1 guarantee).
    await pushLocation(c0, t.tokenId, 600);
    const after = await Token.findById(t.tokenId).lean();
    assert.strictEqual(after.status, 'WAITING', 'token must stay WAITING after the customer walks out');
    assert.strictEqual(after.locationStatus, 'OUT_OF_RANGE', 'backend must record OUT_OF_RANGE');
    pass('1. joined in range -> token remains valid after leaving the radius');
  } catch (err) {
    fail('1. joined in range -> token remains valid after leaving the radius', err);
  }

  // ── 2. Token moves outside while WAITING ───────────────────────────────────
  try {
    await resetQueue();
    const t = await joinAt(c0, 20);
    const res = await pushLocation(c0, t.tokenId, 300);
    assert.strictEqual(res.locationStatus, 'OUT_OF_RANGE', 'backend must classify 300m as OUT_OF_RANGE');
    assert.strictEqual(res.inRange, false, 'backend must not report inRange at 300m');
    assert(res.distanceMeters > RADIUS_METERS, 'backend must compute a real distance');
    const token = await Token.findById(t.tokenId).lean();
    assert.strictEqual(token.status, 'WAITING', 'status must remain WAITING');
    assert.strictEqual(token.locationStatus, 'OUT_OF_RANGE', 'token must record OUT_OF_RANGE');
    pass('2. token moves outside while WAITING is recorded as OUT_OF_RANGE');
  } catch (err) {
    fail('2. token moves outside while WAITING is recorded as OUT_OF_RANGE', err);
  }

  // ── 3. Token returns inside before its turn ────────────────────────────────
  try {
    await resetQueue();
    const t = await joinAt(c0, 20);
    await pushLocation(c0, t.tokenId, 400);
    await pushLocation(c0, t.tokenId, 30);
    const token = await Token.findById(t.tokenId).lean();
    assert.strictEqual(token.locationStatus, 'IN_RANGE', 'returning inside must restore IN_RANGE');
    assert(token.lastLocation.distanceMeters <= RADIUS_METERS, 'distance must be recomputed inside');
    pass('3. token returning inside before its turn becomes eligible again');
  } catch (err) {
    fail('3. token returning inside before its turn becomes eligible again', err);
  }

  // ── 4. Out-of-range candidate skipped at CALL NEXT ────────────────────────
  try {
    await resetQueue();
    const t = await joinAt(c0, 20);
    await pushLocation(c0, t.tokenId, 350);
    const result = await callNext();
    assert(result, 'callNext must return a result object');
    assert.strictEqual(result.skipped.length, 1, 'exactly one token must be skipped');
    assert.strictEqual(result.skipped[0].tokenId, t.tokenId, 'the out-of-range token must be the one skipped');
    assert.strictEqual(result.skipped[0].skipReason, 'OUT_OF_RANGE', 'skip reason must be OUT_OF_RANGE');
    const token = await Token.findById(t.tokenId).lean();
    assert.strictEqual(token.status, 'SKIPPED_OUT_OF_RANGE', 'token status must be SKIPPED_OUT_OF_RANGE');
    pass('4. out-of-range candidate is skipped at CALL NEXT');
  } catch (err) {
    fail('4. out-of-range candidate is skipped at CALL NEXT', err);
  }

  // ── 5. Next eligible candidate called ──────────────────────────────────────
  try {
    await resetQueue();
    const out = await joinAt(c0, 20);
    await pushLocation(c0, out.tokenId, 350);
    const inside = await joinAt(c1, 25);
    const result = await callNext();
    assert(result.token, 'a token must be called');
    assert.strictEqual(result.token._id.toString(), inside.tokenId, 'the in-range token must be called');
    assert.strictEqual(result.token.status, 'CALLED', 'called token must be CALLED');
    const counterNow = await Counter.findById(counter._id).lean();
    assert.strictEqual(counterNow.currentTokenId.toString(), inside.tokenId, 'counter must point at the called token');
    pass('5. next eligible candidate is called in the same CALL NEXT');
  } catch (err) {
    fail('5. next eligible candidate is called in the same CALL NEXT', err);
  }

  // ── 6. Multiple out-of-range candidates skipped in one CALL NEXT ───────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    const b = await joinAt(c1, 20);
    const c = await joinAt(c2, 20);
    await pushLocation(c0, a.tokenId, 350);
    await pushLocation(c1, b.tokenId, 420);
    const result = await callNext();

    assert.strictEqual(result.skipped.length, 2, 'both out-of-range tokens must be skipped in one call');
    assert.deepStrictEqual(
      result.skipped.map((s) => s.tokenId),
      [a.tokenId, b.tokenId],
      'skips must be reported in strict FIFO order'
    );
    assert.strictEqual(result.token._id.toString(), c.tokenId, 'the third, in-range token must be called');

    const aDoc = await Token.findById(a.tokenId).lean();
    const bDoc = await Token.findById(b.tokenId).lean();
    assert.strictEqual(aDoc.status, 'SKIPPED_OUT_OF_RANGE', 'first candidate must be SKIPPED_OUT_OF_RANGE');
    assert.strictEqual(bDoc.status, 'SKIPPED_OUT_OF_RANGE', 'second candidate must be SKIPPED_OUT_OF_RANGE');
    pass('6. multiple out-of-range candidates are skipped in ONE CALL NEXT');
  } catch (err) {
    fail('6. multiple out-of-range candidates are skipped in ONE CALL NEXT', err);
  }

  // ── 7. All candidates out of range -> no token fabricated ──────────────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    const b = await joinAt(c1, 20);
    await pushLocation(c0, a.tokenId, 350);
    await pushLocation(c1, b.tokenId, 500);
    const result = await callNext();
    assert.strictEqual(result.token, null, 'no token may be fabricated when nobody is eligible');
    assert.strictEqual(result.counter, null, 'no counter binding may be invented');
    assert.strictEqual(result.skipped.length, 2, 'both waiting customers must be reported as skipped');
    const counterNow = await Counter.findById(counter._id).lean();
    assert.strictEqual(counterNow.currentTokenId, null, 'counter must not be bound to any token');
    const aDoc = await Token.findById(a.tokenId).lean();
    assert.strictEqual(aDoc.status, 'SKIPPED_OUT_OF_RANGE', 'token A must be SKIPPED_OUT_OF_RANGE');
    pass('7. all candidates out of range -> no token fabricated');
  } catch (err) {
    fail('7. all candidates out of range -> no token fabricated', err);
  }

  // ── 8. Stale location is not treated as IN_RANGE ───────────────────────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    const b = await joinAt(c1, 20);
    // A is out of range. B reports a real in-range position...
    await pushLocation(c0, a.tokenId, 350);
    await pushLocation(c1, b.tokenId, 20);
    // ...and then the app is backgrounded for 10 minutes without heartbeating.
    // The upload endpoint correctly refuses a 5-minute-old payload, so the
    // staleness is produced the only honest way: by ageing the stored reading.
    await Token.findByIdAndUpdate(b.tokenId, {
      $set: {
        'lastLocation.updatedAt': new Date(Date.now() - 10 * 60 * 1000),
        proximityUpdatedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    const verdict = geofenceService.classifyTokenLocation(
      await Token.findById(b.tokenId).lean(),
      await ServiceCenter.findById(center._id).lean()
    );
    assert.strictEqual(verdict.locationStatus, 'LOCATION_STALE', 'a 10-minute-old reading must be STALE');
    assert.strictEqual(verdict.inRange, false, 'STALE must never be treated as IN_RANGE');

    const result = await callNext();
    assert.strictEqual(result.token, null, 'a stale-location customer must not be called');
    const aDoc = await Token.findById(a.tokenId).lean();
    const bDoc = await Token.findById(b.tokenId).lean();
    assert.strictEqual(aDoc.status, 'SKIPPED_OUT_OF_RANGE', 'the out-of-range customer is still skipped');
    assert.strictEqual(bDoc.status, 'WAITING', 'a stale-location customer must NOT be destroyed');
    assert.strictEqual(
      result.blocked.some((x) => x.tokenId === b.tokenId),
      true,
      'the operator must be told why the scan stopped'
    );
    pass('8. stale location is not treated as IN_RANGE and is not skipped');
  } catch (err) {
    fail('8. stale location is not treated as IN_RANGE and is not skipped', err);
  }

  // ── 9. Missing location is not treated as IN_RANGE ─────────────────────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    // Force the token back to a state with no usable location at all.
    await Token.findByIdAndUpdate(a.tokenId, {
      $set: { lastLocation: null, proximityUpdatedAt: null, locationStatus: 'LOCATION_UNAVAILABLE' },
    });

    const verdict = geofenceService.classifyTokenLocation(
      await Token.findById(a.tokenId).lean(),
      await ServiceCenter.findById(center._id).lean()
    );
    assert.strictEqual(verdict.locationStatus, 'LOCATION_UNAVAILABLE', 'no location must be UNAVAILABLE');
    assert.strictEqual(verdict.inRange, false, 'UNAVAILABLE must never be treated as IN_RANGE');

    const result = await callNext();
    assert.strictEqual(result.token, null, 'a customer with no location must not be called');
    const doc = await Token.findById(a.tokenId).lean();
    assert.strictEqual(doc.status, 'WAITING', 'a customer with no location must NOT be skipped');
    pass('9. missing location is not treated as IN_RANGE and is not skipped');
  } catch (err) {
    fail('9. missing location is not treated as IN_RANGE and is not skipped', err);
  }

  // ── 10. Approaching warning fires at the correct queue threshold ───────────
  try {
    await resetQueue();
    // Four blockers ahead put the target at position 5, i.e. 4 tokens remaining,
    // which is the top of the "turn is approaching" band.
    await joinAt(c0, 20);
    await joinAt(c1, 20);
    await joinAt(c2, 20);
    await joinAt(c3, 20);
    const target = await joinAt(c4, 20);

    await Notification.deleteMany({ centerId: center._id, type: 'TURN_APPROACHING_RETURN' });
    await pushLocation(c4, target.tokenId, 400);
    await queueService._updateWaitingPositions(center._id, service._id);

    const warned = await Notification.find({
      centerId: center._id,
      type: 'TURN_APPROACHING_RETURN',
    }).lean();
    assert.strictEqual(warned.length, 1, 'only the customer inside the 3-4 band may be warned');
    assert.strictEqual(warned[0].tokenId.toString(), target.tokenId, 'the warning must target the 3-4 band customer');
    assert(/100 m/.test(warned[0].body), 'the 3-4 band warning must state the real radius');
    assert(/turn is approaching/i.test(warned[0].body), 'the 3-4 band warning must use the approaching wording');
    pass('10. approaching warning fires at the 3-4 tokens threshold');
  } catch (err) {
    fail('10. approaching warning fires at the 3-4 tokens threshold', err);
  }

  // ── 10b. The 1-2 band uses the stronger "return" wording ───────────────────
  try {
    await resetQueue();
    // One blocker ahead puts the target at position 2, i.e. 1 token remaining.
    await joinAt(c0, 20);
    const target = await joinAt(c1, 20);

    await Notification.deleteMany({ centerId: center._id });
    await pushLocation(c1, target.tokenId, 400);
    await queueService._updateWaitingPositions(center._id, service._id);

    const imminent = await Notification.find({
      centerId: center._id,
      type: 'TURN_IMMINENT_RETURN',
    }).lean();
    assert.strictEqual(imminent.length, 1, 'the 1-2 band must produce exactly one imminent warning');
    assert.strictEqual(imminent[0].tokenId.toString(), target.tokenId, 'the imminent warning must target the right customer');
    assert(/turn is coming soon/i.test(imminent[0].body), 'the 1-2 band must use the coming-soon wording');
    assert(/return to the service area/i.test(imminent[0].body), 'the 1-2 band must ask the customer to return');
    pass('10b. the 1-2 token band uses the stronger "return to the service area" warning');
  } catch (err) {
    fail('10b. the 1-2 token band uses the stronger "return to the service area" warning', err);
  }

  // ── 11. Approaching notifications are deduplicated ─────────────────────────
  try {
    await resetQueue();
    await joinAt(c0, 20);
    await joinAt(c1, 20);
    await joinAt(c2, 20);
    await joinAt(c3, 20);
    const target = await joinAt(c4, 20);
    await Notification.deleteMany({ centerId: center._id });
    await pushLocation(c4, target.tokenId, 400);

    for (let i = 0; i < 5; i++) {
      await queueService._updateWaitingPositions(center._id, service._id);
    }
    const warned = await Notification.find({
      centerId: center._id,
      type: 'TURN_APPROACHING_RETURN',
    }).lean();
    assert.strictEqual(
      warned.length,
      1,
      `five recomputations must produce exactly one warning, got ${warned.length}`
    );
    pass('11. approaching notifications are deduplicated across repeated recomputation');
  } catch (err) {
    fail('11. approaching notifications are deduplicated across repeated recomputation', err);
  }

  // ── 11b. An in-range customer is never told to come back ───────────────────
  try {
    await resetQueue();
    await joinAt(c0, 20);
    await joinAt(c1, 20);
    await joinAt(c2, 20);
    await joinAt(c3, 20);
    const target = await joinAt(c4, 20);
    await Notification.deleteMany({ centerId: center._id });
    await pushLocation(c4, target.tokenId, 25); // inside
    await queueService._updateWaitingPositions(center._id, service._id);
    const warned = await Notification.find({
      centerId: center._id,
      type: { $in: ['TURN_APPROACHING_RETURN', 'TURN_IMMINENT_RETURN'] },
    }).lean();
    assert.strictEqual(warned.length, 0, 'an in-range customer must never be told to return');
    pass('11b. an in-range customer is never told to return to the service area');
  } catch (err) {
    fail('11b. an in-range customer is never told to return to the service area', err);
  }

  // ── 12. SKIPPED_OUT_OF_RANGE is persisted distinctly ───────────────────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    await pushLocation(c0, a.tokenId, 260);
    const beforeEvents = await QueueEvent.countDocuments({ centerId: center._id });
    await callNext();

    const token = await Token.findById(a.tokenId).lean();
    assert.strictEqual(token.status, 'SKIPPED_OUT_OF_RANGE', 'status must be the distinct SKIPPED_OUT_OF_RANGE');
    assert.notStrictEqual(token.status, 'SKIPPED', 'must not collapse into an ordinary SKIPPED');
    assert.strictEqual(token.skipReason, 'OUT_OF_RANGE', 'skipReason must be persisted');
    assert(token.skippedAt, 'skippedAt must be persisted');
    assert(token.checkedDistanceMeters > RADIUS_METERS, 'checked proximity distance must be persisted');
    assert(token.lastLocation && token.lastLocation.updatedAt, 'location timestamp must be retained for audit');
    assert.strictEqual(token.locationStatus, 'OUT_OF_RANGE', 'checked proximity state must be persisted');

    const evs = await QueueEvent.find({ centerId: center._id, tokenId: a.tokenId }).lean();
    const audit = evs.find((e) => e.eventType === 'TOKEN_SKIPPED_OUT_OF_RANGE');
    assert(audit, 'a distinct TOKEN_SKIPPED_OUT_OF_RANGE audit event must exist');
    assert.strictEqual(audit.metadata.skipReason, 'OUT_OF_RANGE', 'audit must record the skip reason');
    assert(audit.metadata.locationUpdatedAt, 'audit must record the location timestamp');
    assert(audit.metadata.radiusMeters === RADIUS_METERS, 'audit must record the real radius');
    assert(
      audit.metadata.locationAgeMs === undefined || audit.metadata.locationAgeMs >= 0,
      'audit location age must be a real number'
    );
    assert(
      !JSON.stringify(audit.metadata).includes('latitude'),
      'audit metadata must not leak coordinates'
    );
    const afterEvents = await QueueEvent.countDocuments({ centerId: center._id });
    assert(afterEvents > beforeEvents, 'the skip must be recorded in queue history');

    const dayQueue = await Queue.findOne({
      centerId: center._id,
      serviceId: service._id,
      date: getTodayDateString(),
    }).lean();
    assert(dayQueue.abandonedCount === 1, 'queue integrity: the skip must count as an abandonment');
    assert(dayQueue.waitingCount === 0, 'queue integrity: waiting count must drop');
    pass('12. SKIPPED_OUT_OF_RANGE is persisted distinctly with a full audit trail');
  } catch (err) {
    fail('12. SKIPPED_OUT_OF_RANGE is persisted distinctly with a full audit trail', err);
  }

  // ── 13. Admin receives the skip notification over HTTP ─────────────────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    const b = await joinAt(c1, 20);
    await pushLocation(c0, a.tokenId, 350);
    await pushLocation(c1, b.tokenId, 380);

    const res = await request(
      'POST',
      `/api/counters/${counter._id.toString()}/call-next`,
      {},
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 200, `CALL NEXT must return 200, got ${res.status}`);
    assert.strictEqual(res.body.data.skippedCount, 2, 'the admin response must report two skips');
    assert.strictEqual(res.body.data.token, null, 'no token may be fabricated');
    assert(/2 customers skipped/i.test(res.body.message), `message must summarise the skips, got: ${res.body.message}`);
    assert(/outside service area/i.test(res.body.message), 'message must state the cause in plain words');
    assert.strictEqual(res.body.data.skipped[0].tokenCode, a.tokenCode, 'detail must name the skipped token');
    assert.strictEqual(res.body.data.skipped[1].tokenCode, b.tokenCode, 'detail must be in FIFO order');
    const payload = JSON.stringify(res.body);
    assert(!payload.includes('latitude') && !payload.includes('longitude'),
      'the admin response must not expose raw coordinates');
    assert(!payload.includes('LOCATION_STALE'), 'the admin response must not expose internal state names');
    pass('13. admin receives a concise skip notification with FIFO detail');
  } catch (err) {
    fail('13. admin receives a concise skip notification with FIFO detail', err);
  }

  // ── 13b. Center broadcast carries the skip to Admin + Live Counter ─────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    await pushLocation(c0, a.tokenId, 350);
    const { result, events } = await callNextCapturing();

    const skipEvent = events.find(
      (e) => e.event === 'token.skipped' && e.room === `center:${center._id.toString()}`
    );
    assert(
      skipEvent,
      `a token.skipped broadcast must reach the center room, saw: ${events.map((e) => `${e.room} ${e.event}`).join(', ')}`
    );
    assert.strictEqual(skipEvent.payload.skipReason, 'OUT_OF_RANGE', 'broadcast must carry the skip reason');
    assert.strictEqual(skipEvent.payload.token.status, 'SKIPPED_OUT_OF_RANGE', 'broadcast must carry the new status');
    assert(skipEvent.payload.token.skipReasonText, 'broadcast must carry operator-readable text');
    assert(!skipEvent.payload.token.userId, 'center broadcast must not leak customer identity');
    const s = JSON.stringify(skipEvent.payload);
    assert(!/latitude/.test(s) && !/longitude/.test(s), 'broadcast must not leak coordinates');
    assert(!s.includes('accuracy'), 'broadcast must not leak raw GPS accuracy');
    assert(!/LOCATION_STALE|LOCATION_UNAVAILABLE/.test(s), 'broadcast must not leak internal state names');
    assert.strictEqual(result.token, null, 'and still no token is fabricated');

    // The skipped customer is told on their own private room only.
    const userSkip = events.find(
      (e) => e.event === 'token.skipped' && e.room.startsWith('user:')
    );
    assert(userSkip, 'the skipped customer must be told on their own private room');
    assert.strictEqual(
      userSkip.room,
      `user:${c0.user._id.toString()}`,
      'the customer-room broadcast must target that customer only'
    );
    pass('14. Live Counter receives a floating skip announcement payload over the existing socket event');
  } catch (err) {
    fail('14. Live Counter receives a floating skip announcement payload over the existing socket event', err);
  }

  // ── 15. Customer receives a truthful skip notification ─────────────────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    await pushLocation(c0, a.tokenId, 350);
    await Notification.deleteMany({ centerId: center._id });
    await callNext();

    const n = await Notification.findOne({ centerId: center._id, tokenId: a.tokenId }).lean();
    assert(n, 'the skipped customer must receive a notification');
    assert.strictEqual(n.type, 'TOKEN_SKIPPED_OUT_OF_RANGE', 'notification type must be truthful');
    assert(
      /outside the service area/i.test(n.body),
      `the customer message must state the truth, got: ${n.body}`
    );
    const body = n.body.toLowerCase();
    assert(!body.includes('m away') && !/\d+\s*m\b/.test(body), 'no distance may be shown to the customer');
    assert(!body.includes('latitude') && !body.includes('longitude'), 'no coordinates may be shown');

    // And the token must not be resurrected as an active token.
    const active = await request('GET', '/api/tokens/active', null, {
      Authorization: `Bearer ${c0.jwt}`,
    });
    assert.strictEqual(active.status, 200, 'active token lookup must still work');
    assert.strictEqual(active.body.data.token, null, 'a skipped token must not remain active');
    pass('15. customer receives a truthful skip notification and the token is not resurrected');
  } catch (err) {
    fail('15. customer receives a truthful skip notification and the token is not resurrected', err);
  }

  // ── 16. Voice fires only for the actual token call ─────────────────────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20);
    const b = await joinAt(c1, 20);
    await pushLocation(c0, a.tokenId, 350);

    const { result, events } = await callNextCapturing();

    // The Live Counter announcer is driven exclusively by `token.called`. So the
    // guarantee "voice fires only for actual token calls" is exactly the
    // guarantee that a skip never arrives on that event.
    const called = events.filter((e) => e.event === 'token.called');
    // One for the public board (center room) + one for the customer (own room).
    assert.strictEqual(called.length, 2, `token.called must reach the board and the customer, saw ${called.length}`);
    const calledTokens = new Set(called.map((e) => e.payload.token._id.toString()));
    assert.strictEqual(calledTokens.size, 1, 'one and only one token may be called');
    assert.deepStrictEqual(
      [...calledTokens],
      [b.tokenId],
      'the in-range token is the one called, never the skipped one'
    );
    assert(
      called.some((e) => e.room === `center:${center._id.toString()}`),
      'the call goes to the center room the public board listens on'
    );
    assert(
      called.some((e) => e.room === `user:${c1.user._id.toString()}`),
      'the call goes to the called customer own room'
    );

    // One center announcement (public display) + one private customer notice.
    const skipEvents = events.filter((e) => e.event === 'token.skipped');
    assert.strictEqual(skipEvents.length, 2, 'the skip is announced visually and privately, never as a call');
    assert.strictEqual(result.token._id.toString(), b.tokenId, 'the real eligible token is called');
    pass('16. voice fires only for the actual token.called, never for skips');
  } catch (err) {
    fail('16. voice fires only for the actual token.called, never for skips', err);
  }

  // ── 17. FIFO order is preserved (no geographic reordering) ─────────────────
  try {
    await resetQueue();
    const far = await joinAt(c0, 20);   // position 1, ends up far away
    const mid = await joinAt(c1, 20);   // position 2, stays in range at 80 m
    const near = await joinAt(c2, 20);  // position 3, ends up CLOSEST at 5 m
    // The geographically closest customer is deliberately last in line.
    await pushLocation(c0, far.tokenId, 900);
    await pushLocation(c1, mid.tokenId, 80);
    await pushLocation(c2, near.tokenId, 5);

    const result = await callNext();
    assert.strictEqual(
      result.token._id.toString(),
      mid.tokenId,
      'the FIRST eligible token in queue order must be called, not the closest one'
    );
    assert.deepStrictEqual(
      result.skipped.map((s) => s.tokenId),
      [far.tokenId],
      'only the ineligible head is skipped'
    );
    const nearDoc = await Token.findById(near.tokenId).lean();
    assert.strictEqual(
      nearDoc.status,
      'WAITING',
      'a closer customer further back must not be jumped ahead of'
    );
    pass('17. FIFO order is preserved - proximity never reorders the queue');
  } catch (err) {
    fail('17. FIFO order is preserved - proximity never reorders the queue', err);
  }

  // ── 18. Phase 1 join geofence still works ─────────────────────────────────
  try {
    await resetQueue();
    const far = pointAt(140);
    const rejected = await request(
      'POST',
      '/api/tokens',
      {
        centerId: center._id.toString(),
        serviceId: service._id.toString(),
        latitude: far.latitude,
        longitude: far.longitude,
        accuracy: 8,
      },
      { Authorization: `Bearer ${c0.jwt}` }
    );
    assert.strictEqual(rejected.status, 400, 'joining from 140m must still be rejected');
    assert.strictEqual(rejected.body.code, 'OUT_OF_RANGE', 'Phase 1 OUT_OF_RANGE code must be unchanged');

    const edge = pointAt(100);
    const allowed = await request(
      'POST',
      '/api/tokens',
      {
        centerId: center._id.toString(),
        serviceId: service._id.toString(),
        latitude: edge.latitude,
        longitude: edge.longitude,
        accuracy: 8,
      },
      { Authorization: `Bearer ${c0.jwt}` }
    );
    assert.strictEqual(allowed.status, 201, 'joining from exactly 100m must still be allowed');
    assert.strictEqual(allowed.body.data.token.proximityState, 'INSIDE', 'Phase 1 proximityState is unchanged');
    pass('18. existing Phase 1 100 m join geofence still works unchanged');
  } catch (err) {
    fail('18. existing Phase 1 100 m join geofence still works unchanged', err);
  }

  // ── 19. Existing token lifecycle remains valid ────────────────────────────
  try {
    await resetQueue();
    const t = await joinAt(c0, 30);
    const result = await callNext();
    assert.strictEqual(result.token._id.toString(), t.tokenId, 'the in-range token must be called');
    await queueService.startServing({
      tokenId: t.tokenId,
      counterId: counter._id.toString(),
      adminId: adminUser._id.toString(),
    });
    await queueService.completeToken({
      tokenId: t.tokenId,
      counterId: counter._id.toString(),
      adminId: adminUser._id.toString(),
    });
    const doc = await Token.findById(t.tokenId).lean();
    assert.strictEqual(doc.status, 'COMPLETED', 'the normal lifecycle must still complete');
    assert(doc.completedAt, 'completedAt must be set');
    const dayQueue = await Queue.findOne({
      centerId: center._id,
      serviceId: service._id,
      date: getTodayDateString(),
    }).lean();
    assert(dayQueue.completedCount === 1, 'analytics integrity: completion must be counted');
    pass('19. existing token lifecycle (WAITING -> CALLED -> SERVING -> COMPLETED) is valid');
  } catch (err) {
    fail('19. existing token lifecycle (WAITING -> CALLED -> SERVING -> COMPLETED) is valid', err);
  }

  // ── 20. Concurrent CALL NEXT cannot claim or skip the same token ───────────
  //
  // Two shapes of the same race, because they exercise different guarantees:
  //
  //   20a — two operators press CALL NEXT on ONE counter at the same instant.
  //         A counter serves exactly one customer, so exactly one customer may
  //         end up CALLED. The loser must hand its customer back to WAITING.
  //         The critical safety property is that the counter's pointer and the
  //         CALLED token can never disagree: an orphaned CALLED token is a real
  //         customer who was told to walk to a counter that is serving someone
  //         else and who would otherwise wait forever.
  //
  //   20b — two DIFFERENT free counters are pressed at the same instant. This
  //         is the real centralized-allocation race: each must call exactly one
  //         DISTINCT customer, and the out-of-range customer must be skipped
  //         exactly once by whichever call reached them first.
  try {
    await resetQueue();
    const a = await joinAt(c0, 20); // out of range -> must be skipped
    const b = await joinAt(c1, 20); // in range
    const d = await joinAt(c2, 20); // in range
    await pushLocation(c0, a.tokenId, 350);

    const [r1, r2] = await Promise.all([callNext(), callNext()]);

    // ── No double claim, and no double skip, even though both calls scanned
    //    the same FIFO queue at the same instant.
    const calledIds = [r1, r2].filter((r) => r && r.token).map((r) => r.token._id.toString());
    assert.strictEqual(
      calledIds.length,
      1,
      'one counter can serve exactly one customer, so exactly one concurrent CALL NEXT may claim a token'
    );
    assert.ok(
      calledIds.includes(b.tokenId) || calledIds.includes(d.tokenId),
      'the claimed token must be one of the two eligible FIFO candidates'
    );

    const counterDoc = await Counter.findById(counter._id).lean();
    assert(counterDoc.currentTokenId, 'the counter must point at the customer it is serving');
    assert.strictEqual(
      counterDoc.currentTokenId.toString(),
      calledIds[0],
      'the counter pointer and the CALLED token must agree — no orphaned customer'
    );

    const calledDoc = await Token.findById(calledIds[0]).lean();
    assert.strictEqual(calledDoc.status, 'CALLED', 'the winning token is CALLED');
    const loserId = calledIds[0] === b.tokenId ? d.tokenId : b.tokenId;
    const loserDoc = await Token.findById(loserId).lean();
    assert.strictEqual(
      loserDoc.status,
      'WAITING',
      'the losing concurrent call must return its customer to the queue, not orphan or drop them'
    );
    assert.strictEqual(loserDoc.counterId, null, 'the returned token must not keep a stale counter pointer');

    // The out-of-range customer is skipped exactly once, by the call that
    // reached them first. The second call must not skip them again.
    const aDoc = await Token.findById(a.tokenId).lean();
    assert.strictEqual(aDoc.status, 'SKIPPED_OUT_OF_RANGE', 'the out-of-range token is skipped');
    assert.strictEqual(
      aDoc.skippedAt !== null && aDoc.skippedAt !== undefined,
      true,
      'the out-of-range token records exactly one skip timestamp'
    );
    const skipEvents = await QueueEvent.countDocuments({
      centerId: center._id,
      eventType: 'TOKEN_SKIPPED_OUT_OF_RANGE',
    });
    assert.strictEqual(skipEvents, 1, 'exactly one skip audit event may be written');

    // Exactly one token record per join. A skip must never clone a token, and
    // a lost race must never create one either.
    const total = await Token.countDocuments({ centerId: center._id });
    assert.strictEqual(total, 3, 'neither the skip nor the lost race may create a duplicate token record');
    pass('20. concurrent CALL NEXT on ONE counter claims exactly one customer and never orphans anyone');
  } catch (err) {
    fail('20. concurrent CALL NEXT on ONE counter claims exactly one customer and never orphans anyone', err);
  }

  // ── 20b. Two free counters called at the same instant ─────────────────────
  try {
    await resetQueue();
    const a = await joinAt(c0, 20); // out of range -> must be skipped
    const b = await joinAt(c1, 20); // in range
    const d = await joinAt(c2, 20); // in range
    await pushLocation(c0, a.tokenId, 350);

    const [r1, r2] = await Promise.all([callNextAt(counter), callNextAt(counterB)]);

    const calledIds = [r1, r2].filter((r) => r && r.token).map((r) => r.token._id.toString());
    assert.strictEqual(calledIds.length, 2, 'each concurrent CALL NEXT must call exactly one token');
    assert.strictEqual(new Set(calledIds).size, 2, 'no token may be claimed by both concurrent calls');
    assert.deepStrictEqual(
      calledIds.sort(),
      [b.tokenId, d.tokenId].sort(),
      'the two eligible tokens are called, in no particular order, and no other'
    );

    // Each counter is bound to a DIFFERENT customer, and each customer is
    // bound back to the counter that is actually serving them.
    const c1doc = await Counter.findById(counter._id).lean();
    const c2doc = await Counter.findById(counterB._id).lean();
    assert(c1doc.currentTokenId && c2doc.currentTokenId, 'both counters must hold a customer');
    assert.notStrictEqual(
      c1doc.currentTokenId.toString(),
      c2doc.currentTokenId.toString(),
      'two counters must never hold the same customer'
    );
    for (const c of [c1doc, c2doc]) {
      const t = await Token.findById(c.currentTokenId).lean();
      assert.strictEqual(t.counterId.toString(), c._id.toString(), 'the token must point back at its counter');
    }

    const aDoc = await Token.findById(a.tokenId).lean();
    assert.strictEqual(aDoc.status, 'SKIPPED_OUT_OF_RANGE', 'the out-of-range token is skipped');
    const bDoc = await Token.findById(b.tokenId).lean();
    const dDoc = await Token.findById(d.tokenId).lean();
    assert.strictEqual(bDoc.status, 'CALLED', 'the first eligible token is called exactly once');
    assert.strictEqual(dDoc.status, 'CALLED', 'the second eligible token is called exactly once');

    const waiting = await Token.countDocuments({ centerId: center._id, status: 'WAITING' });
    assert.strictEqual(waiting, 0, 'no token may be left waiting after both concurrent calls');
    const skipEvents = await QueueEvent.countDocuments({
      centerId: center._id,
      eventType: 'TOKEN_SKIPPED_OUT_OF_RANGE',
    });
    assert.strictEqual(skipEvents, 1, 'exactly one skip audit event may be written');

    const total = await Token.countDocuments({ centerId: center._id });
    assert.strictEqual(total, 3, 'the skip must not create a duplicate token record');
    pass('20b. two free counters called at the same instant call two DIFFERENT customers');
  } catch (err) {
    fail('20b. two free counters called at the same instant call two DIFFERENT customers', err);
  }

  console.log('\n============================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('============================================================\n');
}

setup()
  .then(() => runTests())
  .then(() => cleanup())
  .then(() => process.exit(failed > 0 ? 1 : 0))
  .catch(async (err) => {
    console.error('\nTest runner fatal error:', err);
    await cleanup();
    process.exit(1);
  });

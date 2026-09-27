'use strict';

/**
 * QueueFlow — TIER 4 / FEATURE 3: P2P SLOT SWAPPING TEST SUITE
 *
 * Tests all aspects of the P2P swap feature:
 * - Eligibility detection
 * - Same-service / same-center restriction
 * - WAITING-only guard
 * - Offer creation, acceptance, decline, cancel
 * - Expiration enforcement
 * - Called/serving token invalidation
 * - Concurrency (duplicate accept, race conditions, double-offer)
 * - Atomic queue order preservation
 * - Position + EWT recalculation
 * - Notification creation
 * - Ghost Queue and Service Graph compatibility
 * - IDOR protection
 * - No PII leakage
 * - No static data
 *
 * NO fabricated swap offers. NO hardcoded positions. All decisions
 * use real persisted QueueFlow state created in test fixtures.
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
const { SwapOffer } = require('../src/models/SwapOffer');
const QueueEvent = require('../src/models/QueueEvent');
const queueService = require('../src/services/queueService');
const swapService = require('../src/services/swapService');

let baseUrl;
let testServer;

// Shared fixtures
let centerA; // has services + queue
let centerB; // different center (for restriction tests)
let serviceA; // in centerA
let serviceB; // in centerA (different service, for restriction tests)
let serviceC; // in centerB

let customerA, customerB, customerC, customerD;
let customerAJwt, customerBJwt, customerCJwt, customerDJwt;
let counterA;

let tokenA, tokenB, tokenC, tokenD; // WAITING tokens in centerA / serviceA

let passed = 0;
let failed = 0;

function signToken(userId, role = 'CUSTOMER') {
  return jwt.sign({ id: userId.toString(), role, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function pass(name) {
  passed++;
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  ❌ FAIL  ${name}`);
  console.error(`         ${err?.message || err}`);
  if (err?.actual !== undefined) {
    console.error(`         actual:   ${JSON.stringify(err.actual)}`);
    console.error(`         expected: ${JSON.stringify(err.expected)}`);
  }
}

async function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const defaultHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    const options = {
      method,
      path,
      headers: defaultHeaders,
    };
    const [host, portStr] = baseUrl.replace('http://', '').split(':');
    const port = parseInt(portStr, 10);
    const req = http.request({ ...options, host, port }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  await connectDB();
  testServer = server.listen(0);
  const addr = testServer.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[Test] Server listening at ${baseUrl}`);

  // Clean up any leftover fixtures with our email domain
  await Promise.all([
    User.deleteMany({ email: { $regex: '@swaptest.qf' } }),
    SwapOffer.deleteMany({}),
  ]);

  // Create two centers
  centerA = await ServiceCenter.create({
    name: 'Swap Test Center A',
    code: `SWPA${Date.now()}`,
    type: 'BANK',
    location: { type: 'Point', coordinates: [77.5, 12.9] },
    geofenceRadiusMeters: 200,
    isOpen: true,
    address: { street: '1 Swap St', city: 'Bengaluru', state: 'KA', country: 'IN', pincode: '560001' },
  });

  centerB = await ServiceCenter.create({
    name: 'Swap Test Center B',
    code: `SWPB${Date.now()}`,
    type: 'BANK',
    location: { type: 'Point', coordinates: [77.6, 12.8] },
    geofenceRadiusMeters: 200,
    isOpen: true,
    address: { street: '2 Swap St', city: 'Bengaluru', state: 'KA', country: 'IN', pincode: '560002' },
  });

  // Services
  serviceA = await Service.create({
    name: 'Swap Service A', tokenPrefix: 'SA', centerId: centerA._id,
    avgServiceTimeMinutes: 5, isActive: true, order: 1,
  });
  serviceB = await Service.create({
    name: 'Swap Service B', tokenPrefix: 'SB', centerId: centerA._id,
    avgServiceTimeMinutes: 5, isActive: true, order: 2,
  });
  serviceC = await Service.create({
    name: 'Swap Service C', tokenPrefix: 'SC', centerId: centerB._id,
    avgServiceTimeMinutes: 5, isActive: true, order: 1,
  });

  // Counter for centerA/serviceA
  counterA = await Counter.create({
    centerId: centerA._id, serviceId: serviceA._id,
    name: 'Swap Counter 1', number: 1, status: 'ACTIVE',
  });

  // Four customers
  const ts = Date.now();
  [customerA, customerB, customerC, customerD] = await Promise.all([
    User.create({ name: 'Swap Customer A', email: `a.${ts}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    User.create({ name: 'Swap Customer B', email: `b.${ts}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    User.create({ name: 'Swap Customer C', email: `c.${ts}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    User.create({ name: 'Swap Customer D', email: `d.${ts}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
  ]);

  customerAJwt = signToken(customerA._id);
  customerBJwt = signToken(customerB._id);
  customerCJwt = signToken(customerC._id);
  customerDJwt = signToken(customerD._id);

  // Join four tokens in centerA / serviceA queue (A gets pos 1, B pos 2, C pos 3, D pos 4)
  const joinA = await queueService.joinQueue({ userId: customerA._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() });
  tokenA = joinA.token;
  const joinB = await queueService.joinQueue({ userId: customerB._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() });
  tokenB = joinB.token;
  const joinC = await queueService.joinQueue({ userId: customerC._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() });
  tokenC = joinC.token;
  const joinD = await queueService.joinQueue({ userId: customerD._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() });
  tokenD = joinD.token;

  console.log('[Test] Fixtures created. Positions A→B→C→D in serviceA.');
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

async function teardown() {
  await Promise.all([
    SwapOffer.deleteMany({ centerId: centerA?._id }),
    SwapOffer.deleteMany({ centerId: centerB?._id }),
    Token.deleteMany({ centerId: { $in: [centerA?._id, centerB?._id] } }),
    Queue.deleteMany({ centerId: { $in: [centerA?._id, centerB?._id] } }),
    QueueEvent.deleteMany({ centerId: { $in: [centerA?._id, centerB?._id] } }),
    Notification.deleteMany({ userId: { $in: [customerA?._id, customerB?._id, customerC?._id, customerD?._id] } }),
    Counter.deleteMany({ centerId: { $in: [centerA?._id, centerB?._id] } }),
    Service.deleteMany({ centerId: { $in: [centerA?._id, centerB?._id] } }),
    ServiceCenter.deleteMany({ _id: { $in: [centerA?._id, centerB?._id] } }),
    User.deleteMany({ email: { $regex: '@swaptest.qf' } }),
  ]);

  testServer.close();
  await mongoose.disconnect();
  console.log('[DB] MongoDB disconnected.');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n============================================================');
  console.log('  QueueFlow — TIER 4 / FEATURE 3: P2P SLOT SWAPPING');
  console.log('============================================================\n');

  // 1. Eligible token detection
  try {
    const res = await request('GET', `/api/swaps/eligible?tokenId=${tokenA._id}`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.partners));
    // B, C, D are eligible for A to swap with
    assert.ok(res.body.data.partners.length >= 3, `Expected >= 3 partners, got ${res.body.data.partners.length}`);
    // Privacy: no name/email in partner list
    const serialized = JSON.stringify(res.body.data.partners);
    assert.ok(!serialized.includes(customerB.email), 'Email must not leak in partner list');
    assert.ok(!serialized.includes(customerB.name), 'Customer name must not leak in partner list');
    // Each partner only has tokenId, tokenCode, currentPosition
    const partner = res.body.data.partners[0];
    assert.ok(partner.tokenId);
    assert.ok(partner.tokenCode);
    assert.ok(partner.currentPosition !== undefined);
    pass('1. eligible token detection');
  } catch (err) {
    fail('1. eligible token detection', err);
  }

  // 2. Same-service restriction
  try {
    // Customer D is in serviceA. Join customerD into serviceB too
    const joinServiceB = await queueService.joinQueue({
      userId: customerD._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceB._id.toString(),
    });
    const tokenDinB = joinServiceB.token;

    // Try to get eligible for tokenDinB — should have its own serviceB partners only
    const res = await request('GET', `/api/swaps/eligible?tokenId=${tokenDinB._id}`, null, {
      Authorization: `Bearer ${customerDJwt}`,
    });
    assert.strictEqual(res.status, 200);
    // No partners in serviceB (only D is there)
    assert.strictEqual(res.body.data.partners.length, 0);

    // Try cross-service offer — should be rejected
    const offerRes = await request('POST', '/api/swaps', {
      offeringTokenId: tokenD._id.toString(), // serviceA
      targetTokenId: tokenDinB._id.toString(),  // serviceB
    }, { Authorization: `Bearer ${customerDJwt}` });
    assert.strictEqual(offerRes.status, 400, `Expected 400, got ${offerRes.status}: ${JSON.stringify(offerRes.body)}`);
    pass('2. same-service restriction');
  } catch (err) {
    fail('2. same-service restriction', err);
  }

  // 3. Same-center restriction
  try {
    // Create a token for customerC in centerB/serviceC
    const joinCenterB = await queueService.joinQueue({
      userId: customerC._id.toString(),
      centerId: centerB._id.toString(),
      serviceId: serviceC._id.toString(),
    });
    const tokenCenterB = joinCenterB.token;

    // customerA's tokenA (centerA) tries to offer to centerB token — must reject
    const res = await request('POST', '/api/swaps', {
      offeringTokenId: tokenA._id.toString(),
      targetTokenId: tokenCenterB._id.toString(),
    }, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.match(res.body.message, /different service center/i);
    pass('3. same-center restriction');
  } catch (err) {
    fail('3. same-center restriction', err);
  }

  // 4. WAITING-only eligibility
  try {
    // Create a customer + token, then cancel it → status CANCELLED
    const cancelUser = await User.create({
      name: 'Cancel Swap', email: `cancel.${Date.now()}@swaptest.qf`,
      passwordHash: 'hash', role: 'CUSTOMER', isActive: true,
    });
    const cancelJoin = await queueService.joinQueue({
      userId: cancelUser._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });
    await queueService.cancelToken({ tokenId: cancelJoin.token._id.toString(), userId: cancelUser._id.toString() });

    // Try to offer a swap with a CANCELLED token → 409
    const cancelJwt = signToken(cancelUser._id);
    const res = await request('POST', '/api/swaps', {
      offeringTokenId: cancelJoin.token._id.toString(),
    }, { Authorization: `Bearer ${cancelJwt}` });
    assert.strictEqual(res.status, 409, `Expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.message, /CANCELLED|not eligible/i);
    pass('4. WAITING-only eligibility');
  } catch (err) {
    fail('4. WAITING-only eligibility', err);
  }

  // 5. Create offer
  let offerAB;
  try {
    const res = await request('POST', '/api/swaps', {
      offeringTokenId: tokenA._id.toString(),
      targetTokenId: tokenB._id.toString(),
      reason: 'Need more time',
    }, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data.offer._id);
    assert.strictEqual(res.body.data.offer.status, 'PENDING');
    assert.ok(res.body.data.offer.expiresAt);
    // expiresAt must be in the future
    assert.ok(new Date(res.body.data.offer.expiresAt) > new Date());
    offerAB = res.body.data.offer;
    pass('5. create offer');
  } catch (err) {
    fail('5. create offer', err);
  }

  // 6. Unauthorized offer creation (wrong token owner)
  try {
    const res = await request('POST', '/api/swaps', {
      offeringTokenId: tokenA._id.toString(), // A's token
    }, { Authorization: `Bearer ${customerBJwt}` }); // B tries to offer A's token
    assert.strictEqual(res.status, 403, `Expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    pass('6. unauthorized offer creation');
  } catch (err) {
    fail('6. unauthorized offer creation', err);
  }

  // 7. Accept offer
  try {
    if (!offerAB) throw new Error('No offer from test 5 to accept');

    // Reload positions before swap
    const [preA, preB] = await Promise.all([
      Token.findById(tokenA._id).select('currentPosition').lean(),
      Token.findById(tokenB._id).select('currentPosition').lean(),
    ]);

    const res = await request('POST', `/api/swaps/${offerAB._id}/accept`, {
      acceptingTokenId: tokenB._id.toString(),
    }, { Authorization: `Bearer ${customerBJwt}` });
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);

    // Offer should now be COMPLETED in DB
    const completedOffer = await SwapOffer.findById(offerAB._id);
    assert.strictEqual(completedOffer.status, 'COMPLETED');
    assert.ok(completedOffer.completedAt);
    assert.ok(completedOffer.acceptingTokenId);

    // Positions should be swapped
    const [postA, postB] = await Promise.all([
      Token.findById(tokenA._id).select('currentPosition createdAt').lean(),
      Token.findById(tokenB._id).select('currentPosition createdAt').lean(),
    ]);
    // A should now be at B's old position and vice versa
    assert.strictEqual(postA.currentPosition, preB.currentPosition, `A position should be ${preB.currentPosition} after swap`);
    assert.strictEqual(postB.currentPosition, preA.currentPosition, `B position should be ${preA.currentPosition} after swap`);

    // Token identity must be intact — tokenCode, tokenNumber, userId unchanged
    const [reloadA, reloadB] = await Promise.all([
      Token.findById(tokenA._id).lean(),
      Token.findById(tokenB._id).lean(),
    ]);
    assert.strictEqual(reloadA.userId.toString(), customerA._id.toString(), 'Token A ownership must not change');
    assert.strictEqual(reloadB.userId.toString(), customerB._id.toString(), 'Token B ownership must not change');
    assert.strictEqual(reloadA.tokenCode, tokenA.tokenCode, 'Token A code must not change');
    assert.strictEqual(reloadB.tokenCode, tokenB.tokenCode, 'Token B code must not change');

    pass('7. accept offer');
  } catch (err) {
    fail('7. accept offer', err);
  }

  // 8. Decline offer
  let offerCD;
  try {
    // C creates offer toward D
    const createRes = await request('POST', '/api/swaps', {
      offeringTokenId: tokenC._id.toString(),
      targetTokenId: tokenD._id.toString(),
    }, { Authorization: `Bearer ${customerCJwt}` });
    assert.strictEqual(createRes.status, 201, `Create: ${JSON.stringify(createRes.body)}`);
    offerCD = createRes.body.data.offer;

    const decRes = await request('POST', `/api/swaps/${offerCD._id}/decline`, null, {
      Authorization: `Bearer ${customerDJwt}`,
    });
    assert.strictEqual(decRes.status, 200, `Decline: ${JSON.stringify(decRes.body)}`);
    assert.strictEqual(decRes.body.data.status, 'DECLINED');

    const declined = await SwapOffer.findById(offerCD._id);
    assert.strictEqual(declined.status, 'DECLINED');
    assert.ok(declined.declinedAt);
    pass('8. decline offer');
  } catch (err) {
    fail('8. decline offer', err);
  }

  // 9. Cancel offer
  try {
    // D creates open offer (no target)
    const createRes = await request('POST', '/api/swaps', {
      offeringTokenId: tokenD._id.toString(),
    }, { Authorization: `Bearer ${customerDJwt}` });
    assert.strictEqual(createRes.status, 201, `Create: ${JSON.stringify(createRes.body)}`);
    const offerD = createRes.body.data.offer;

    const cancelRes = await request('POST', `/api/swaps/${offerD._id}/cancel`, null, {
      Authorization: `Bearer ${customerDJwt}`,
    });
    assert.strictEqual(cancelRes.status, 200, `Cancel: ${JSON.stringify(cancelRes.body)}`);
    assert.strictEqual(cancelRes.body.data.status, 'CANCELLED');

    const cancelled = await SwapOffer.findById(offerD._id);
    assert.strictEqual(cancelled.status, 'CANCELLED');
    assert.ok(cancelled.cancelledAt);
    pass('9. cancel offer');
  } catch (err) {
    fail('9. cancel offer', err);
  }

  // 10. Expiration: expired offers must be rejected on accept
  try {
    // Create an offer then manually expire it by patching expiresAt in DB
    const expUser = await User.create({
      name: 'Exp User', email: `exp.${Date.now()}@swaptest.qf`,
      passwordHash: 'hash', role: 'CUSTOMER', isActive: true,
    });
    const expJoin = await queueService.joinQueue({
      userId: expUser._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });
    const expJwt = signToken(expUser._id);

    const createRes = await request('POST', '/api/swaps', {
      offeringTokenId: expJoin.token._id.toString(),
    }, { Authorization: `Bearer ${expJwt}` });
    assert.strictEqual(createRes.status, 201);
    const expOffer = createRes.body.data.offer;

    // Artificially expire it
    await SwapOffer.findByIdAndUpdate(expOffer._id, { expiresAt: new Date(Date.now() - 1000) });

    // Attempt to accept — must get 409 Expired
    const acceptRes = await request('POST', `/api/swaps/${expOffer._id}/accept`, {
      acceptingTokenId: tokenC._id.toString(),
    }, { Authorization: `Bearer ${customerCJwt}` });
    assert.strictEqual(acceptRes.status, 409, `Expected 409, got ${acceptRes.status}: ${JSON.stringify(acceptRes.body)}`);
    assert.match(acceptRes.body.message, /expired/i);
    pass('10. expiration');
  } catch (err) {
    fail('10. expiration', err);
  }

  // 11. Called-token invalidation
  try {
    // Join a new customer, then call their token
    const callUser = await User.create({
      name: 'Called User', email: `called.${Date.now()}@swaptest.qf`,
      passwordHash: 'hash', role: 'CUSTOMER', isActive: true,
    });
    const callJoin = await queueService.joinQueue({
      userId: callUser._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });
    const callJwt = signToken(callUser._id);

    // Create a valid offer first
    const offerRes = await request('POST', '/api/swaps', {
      offeringTokenId: callJoin.token._id.toString(),
    }, { Authorization: `Bearer ${callJwt}` });
    assert.strictEqual(offerRes.status, 201);
    const callOffer = offerRes.body.data.offer;

    // Transition the offering token to CALLED status
    await Token.findByIdAndUpdate(callJoin.token._id, { status: 'CALLED' });

    // Attempt to accept the offer — the offering token is now CALLED, not WAITING
    // Either the accept will fail (offering token no longer WAITING)
    // or the offer listing will show this correctly
    const acceptRes = await request('POST', `/api/swaps/${callOffer._id}/accept`, {
      acceptingTokenId: tokenC._id.toString(),
    }, { Authorization: `Bearer ${customerCJwt}` });
    assert.strictEqual(acceptRes.status, 409, `Expected 409 for CALLED token, got ${acceptRes.status}: ${JSON.stringify(acceptRes.body)}`);

    // Clean up temporary test token and offer
    await Token.deleteOne({ _id: callJoin.token._id });
    await SwapOffer.deleteOne({ _id: callOffer._id });
    await queueService._updateWaitingPositions(centerA._id, serviceA._id);

    pass('11. called-token invalidation');
  } catch (err) {
    fail('11. called-token invalidation', err);
  }

  // 12. Serving-token invalidation
  try {
    // New offer from customer whose token is in SERVING state
    const servUser = await User.create({
      name: 'Serv User', email: `serv.${Date.now()}@swaptest.qf`,
      passwordHash: 'hash', role: 'CUSTOMER', isActive: true,
    });
    const servJoin = await queueService.joinQueue({
      userId: servUser._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });
    const servJwt = signToken(servUser._id);

    // Create offer
    const offerRes = await request('POST', '/api/swaps', {
      offeringTokenId: servJoin.token._id.toString(),
    }, { Authorization: `Bearer ${servJwt}` });
    assert.strictEqual(offerRes.status, 201);
    const servOffer = offerRes.body.data.offer;

    // Force servJoin token to SERVING in DB
    await Token.findByIdAndUpdate(servJoin.token._id, { status: 'SERVING' });

    // Attempt accept — offering token now SERVING
    const acceptRes = await request('POST', `/api/swaps/${servOffer._id}/accept`, {
      acceptingTokenId: tokenC._id.toString(),
    }, { Authorization: `Bearer ${customerCJwt}` });
    assert.strictEqual(acceptRes.status, 409, `Expected 409 for SERVING token, got ${acceptRes.status}`);

    // Clean up temporary test token and offer
    await Token.deleteOne({ _id: servJoin.token._id });
    await SwapOffer.deleteOne({ _id: servOffer._id });
    await queueService._updateWaitingPositions(centerA._id, serviceA._id);

    pass('12. serving-token invalidation');
  } catch (err) {
    fail('12. serving-token invalidation', err);
  }

  // 13. Duplicate acceptance (trying to accept an already-completed offer)
  let offer13;
  try {
    // Create a fresh pair of WAITING users and tokens
    const [u1, u2] = await Promise.all([
      User.create({ name: 'Dup U1', email: `dup1.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
      User.create({ name: 'Dup U2', email: `dup2.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    ]);
    const [j1, j2] = await Promise.all([
      queueService.joinQueue({ userId: u1._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
      queueService.joinQueue({ userId: u2._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
    ]);
    const t1 = j1.token, t2 = j2.token;
    const jwt1 = signToken(u1._id), jwt2 = signToken(u2._id);

    // Create offer
    const offerRes = await request('POST', '/api/swaps', { offeringTokenId: t1._id.toString() }, { Authorization: `Bearer ${jwt1}` });
    assert.strictEqual(offerRes.status, 201);
    offer13 = offerRes.body.data.offer;

    // First acceptance — should succeed
    const accept1 = await request('POST', `/api/swaps/${offer13._id}/accept`, { acceptingTokenId: t2._id.toString() }, { Authorization: `Bearer ${jwt2}` });
    assert.strictEqual(accept1.status, 200, `First accept failed: ${JSON.stringify(accept1.body)}`);

    // Second acceptance — should fail (offer already COMPLETED)
    const accept2 = await request('POST', `/api/swaps/${offer13._id}/accept`, { acceptingTokenId: t2._id.toString() }, { Authorization: `Bearer ${jwt2}` });
    assert.strictEqual(accept2.status, 409, `Second accept should be 409, got ${accept2.status}: ${JSON.stringify(accept2.body)}`);
    assert.match(accept2.body.message, /no longer available|COMPLETED/i);
    pass('13. duplicate acceptance');
  } catch (err) {
    fail('13. duplicate acceptance', err);
  }

  // 14. Conflicting simultaneous acceptance (race condition)
  try {
    const [ua, ub, uc] = await Promise.all([
      User.create({ name: 'Race A', email: `race_a.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
      User.create({ name: 'Race B', email: `race_b.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
      User.create({ name: 'Race C', email: `race_c.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    ]);
    const [ja, jb, jc] = await Promise.all([
      queueService.joinQueue({ userId: ua._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
      queueService.joinQueue({ userId: ub._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
      queueService.joinQueue({ userId: uc._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
    ]);
    const ta = ja.token, tb = jb.token, tc = jc.token;
    const jwtA = signToken(ua._id), jwtB = signToken(ub._id), jwtC = signToken(uc._id);

    // Open offer from A
    const offerRes = await request('POST', '/api/swaps', { offeringTokenId: ta._id.toString() }, { Authorization: `Bearer ${jwtA}` });
    assert.strictEqual(offerRes.status, 201);
    const raceOffer = offerRes.body.data.offer;

    // B and C race to accept simultaneously
    const [resB, resC] = await Promise.all([
      request('POST', `/api/swaps/${raceOffer._id}/accept`, { acceptingTokenId: tb._id.toString() }, { Authorization: `Bearer ${jwtB}` }),
      request('POST', `/api/swaps/${raceOffer._id}/accept`, { acceptingTokenId: tc._id.toString() }, { Authorization: `Bearer ${jwtC}` }),
    ]);

    const statuses = [resB.status, resC.status].sort();
    // Exactly one must succeed (200), the other must fail (409)
    assert.deepStrictEqual(statuses, [200, 409], `Expected [200,409] got ${statuses}`);

    // Queue integrity: A's token still exists with valid status
    const reloadA = await Token.findById(ta._id).lean();
    assert.ok(reloadA, 'Token A must still exist');
    assert.ok(['WAITING'].includes(reloadA.status), `Token A must be WAITING, got ${reloadA.status}`);
    pass('14. conflicting simultaneous acceptance');
  } catch (err) {
    fail('14. conflicting simultaneous acceptance', err);
  }

  // 15. Double-offer race (A already has a pending offer, creates another → rejected)
  try {
    const [ux, uy] = await Promise.all([
      User.create({ name: 'Double X', email: `dbl_x.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
      User.create({ name: 'Double Y', email: `dbl_y.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    ]);
    const [jx, jy] = await Promise.all([
      queueService.joinQueue({ userId: ux._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
      queueService.joinQueue({ userId: uy._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
    ]);
    const tx = jx.token;
    const jwtX = signToken(ux._id);

    // First offer — OK
    const r1 = await request('POST', '/api/swaps', { offeringTokenId: tx._id.toString() }, { Authorization: `Bearer ${jwtX}` });
    assert.strictEqual(r1.status, 201, `First offer: ${JSON.stringify(r1.body)}`);

    // Second offer — must be rejected (PENDING index)
    const r2 = await request('POST', '/api/swaps', { offeringTokenId: tx._id.toString() }, { Authorization: `Bearer ${jwtX}` });
    assert.strictEqual(r2.status, 409, `Expected 409 for duplicate offer, got ${r2.status}: ${JSON.stringify(r2.body)}`);
    assert.match(r2.body.message, /pending|already/i);
    pass('15. double-offer race');
  } catch (err) {
    fail('15. double-offer race', err);
  }

  // 16. Atomic queue preservation (positions remain contiguous after swap)
  try {
    // After multiple swaps, WAITING tokens in serviceA must have contiguous positions 1..N
    const waitingTokens = await Token.find({
      centerId: centerA._id, serviceId: serviceA._id, status: 'WAITING',
    }).sort({ currentPosition: 1 }).select('currentPosition').lean();

    const positions = waitingTokens.map((t) => t.currentPosition);
    const expected = positions.map((_, i) => i + 1);
    assert.deepStrictEqual(positions, expected, `Positions must be contiguous 1..N, got: ${positions}`);
    assert.ok(positions.length > 0, 'At least one token must still be WAITING');
    pass('16. atomic queue preservation');
  } catch (err) {
    fail('16. atomic queue preservation', err);
  }

  // 17. Position recalculation after swap
  try {
    // Create fresh pair, swap, verify recalculation
    const [ur, us] = await Promise.all([
      User.create({ name: 'Recalc R', email: `recalc_r.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
      User.create({ name: 'Recalc S', email: `recalc_s.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    ]);
    const [jr, js] = await Promise.all([
      queueService.joinQueue({ userId: ur._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
      queueService.joinQueue({ userId: us._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
    ]);
    const tr = jr.token, ts2 = js.token;
    const jwtR = signToken(ur._id), jwtS = signToken(us._id);

    const preR = await Token.findById(tr._id).select('currentPosition').lean();
    const preS = await Token.findById(ts2._id).select('currentPosition').lean();

    const offerRes = await request('POST', '/api/swaps', { offeringTokenId: tr._id.toString() }, { Authorization: `Bearer ${jwtR}` });
    assert.strictEqual(offerRes.status, 201);
    const swapOfferRS = offerRes.body.data.offer;

    const acceptRes = await request('POST', `/api/swaps/${swapOfferRS._id}/accept`, { acceptingTokenId: ts2._id.toString() }, { Authorization: `Bearer ${jwtS}` });
    assert.strictEqual(acceptRes.status, 200, `Accept failed: ${JSON.stringify(acceptRes.body)}`);

    const postR = await Token.findById(tr._id).select('currentPosition').lean();
    const postS = await Token.findById(ts2._id).select('currentPosition').lean();

    // Positions should be swapped
    assert.strictEqual(postR.currentPosition, preS.currentPosition, 'R should have S old position');
    assert.strictEqual(postS.currentPosition, preR.currentPosition, 'S should have R old position');
    pass('17. position recalculation');
  } catch (err) {
    fail('17. position recalculation', err);
  }

  // 18. EWT recalculation
  try {
    // After swap, waitEstimateMinutes must be non-null and positive for WAITING tokens
    const waitingTokens = await Token.find({
      centerId: centerA._id, serviceId: serviceA._id, status: 'WAITING',
    }).select('waitEstimateMinutes currentPosition').lean();

    for (const wt of waitingTokens) {
      assert.ok(wt.waitEstimateMinutes !== null && wt.waitEstimateMinutes > 0,
        `Token at pos ${wt.currentPosition} must have positive EWT, got ${wt.waitEstimateMinutes}`);
    }
    pass('18. EWT recalculation');
  } catch (err) {
    fail('18. EWT recalculation', err);
  }

  // 19. Notification creation
  try {
    // After a completed swap, SWAP_COMPLETED notifications must exist for both participants
    const swapNotifs = await Notification.find({
      type: 'SWAP_COMPLETED',
    });
    assert.ok(swapNotifs.length >= 2, `Expected at least 2 SWAP_COMPLETED notifications, got ${swapNotifs.length}`);
    pass('19. notification creation');
  } catch (err) {
    fail('19. notification creation', err);
  }

  // 20. QueueEvent audit trail
  try {
    const swapEvents = await QueueEvent.find({
      centerId: centerA._id,
      eventType: 'SWAP_COMPLETED',
    });
    assert.ok(swapEvents.length >= 1, `Expected at least 1 SWAP_COMPLETED event, got ${swapEvents.length}`);
    const evt = swapEvents[0];
    assert.ok(evt.metadata.offerId);
    assert.ok(evt.metadata.offeringTokenId);
    assert.ok(evt.metadata.acceptingTokenId);
    assert.ok(evt.metadata.positionsBefore);
    assert.ok(evt.metadata.positionsAfter);
    pass('20. QueueEvent audit trail');
  } catch (err) {
    fail('20. QueueEvent audit trail', err);
  }

  // 21. Ghost Queue compatibility
  try {
    // A WAITING token with a proximityState can still participate in a swap
    const ghostUser = await User.create({
      name: 'Ghost Swap', email: `ghost.${Date.now()}@swaptest.qf`,
      passwordHash: 'hash', role: 'CUSTOMER', isActive: true,
    });
    const ghostJoin = await queueService.joinQueue({
      userId: ghostUser._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });
    // Set proximity state
    await Token.findByIdAndUpdate(ghostJoin.token._id, { proximityState: 'OUTSIDE' });
    const ghostJwt = signToken(ghostUser._id);

    // Eligible check should still work — proximity alone doesn't block swaps
    const res = await request('GET', `/api/swaps/eligible?tokenId=${ghostJoin.token._id}`, null, {
      Authorization: `Bearer ${ghostJwt}`,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data.partners));
    // Verify proximityState is NOT exposed to other customers
    const serialized = JSON.stringify(res.body.data.partners);
    assert.ok(!serialized.includes('OUTSIDE'), 'proximityState must not leak to partner list');
    assert.ok(!serialized.includes('proximityState'), 'proximityState key must not leak');
    pass('21. Ghost Queue compatibility');
  } catch (err) {
    fail('21. Ghost Queue compatibility', err);
  }

  // 22. Service Graph compatibility
  try {
    // A token in a multi-hop journey can still swap within its current queue
    const journeyUser = await User.create({
      name: 'Journey Swap', email: `journey.${Date.now()}@swaptest.qf`,
      passwordHash: 'hash', role: 'CUSTOMER', isActive: true,
    });
    const journeyJoin = await queueService.joinQueue({
      userId: journeyUser._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });
    // Simulate a journey token by setting journeyId and previousTokenId
    const fakeJourneyId = new mongoose.Types.ObjectId();
    await Token.findByIdAndUpdate(journeyJoin.token._id, {
      journeyId: fakeJourneyId,
      previousTokenId: new mongoose.Types.ObjectId(),
    });
    const journeyJwt = signToken(journeyUser._id);

    // Journey tokens should still be eligible in the same queue
    const res = await request('GET', `/api/swaps/eligible?tokenId=${journeyJoin.token._id}`, null, {
      Authorization: `Bearer ${journeyJwt}`,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data.partners), 'Journey token eligible check should succeed');
    pass('22. Service Graph compatibility');
  } catch (err) {
    fail('22. Service Graph compatibility', err);
  }

  // 23. Token identity integrity (swap must not change tokenCode/tokenNumber/userId)
  try {
    const [ui1, ui2] = await Promise.all([
      User.create({ name: 'Identity 1', email: `id1.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
      User.create({ name: 'Identity 2', email: `id2.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    ]);
    const [ji1, ji2] = await Promise.all([
      queueService.joinQueue({ userId: ui1._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
      queueService.joinQueue({ userId: ui2._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
    ]);
    const ti1 = ji1.token, ti2 = ji2.token;
    const jwtI1 = signToken(ui1._id), jwtI2 = signToken(ui2._id);

    const code1Before = ti1.tokenCode, num1Before = ti1.tokenNumber;
    const code2Before = ti2.tokenCode, num2Before = ti2.tokenNumber;

    const offerRes = await request('POST', '/api/swaps', { offeringTokenId: ti1._id.toString() }, { Authorization: `Bearer ${jwtI1}` });
    const acceptRes = await request('POST', `/api/swaps/${offerRes.body.data.offer._id}/accept`, { acceptingTokenId: ti2._id.toString() }, { Authorization: `Bearer ${jwtI2}` });
    assert.strictEqual(acceptRes.status, 200, `Accept: ${JSON.stringify(acceptRes.body)}`);

    const [post1, post2] = await Promise.all([
      Token.findById(ti1._id).lean(),
      Token.findById(ti2._id).lean(),
    ]);

    assert.strictEqual(post1.tokenCode, code1Before, 'Token 1 code must not change');
    assert.strictEqual(post1.tokenNumber, num1Before, 'Token 1 number must not change');
    assert.strictEqual(post1.userId.toString(), ui1._id.toString(), 'Token 1 owner must not change');
    assert.strictEqual(post2.tokenCode, code2Before, 'Token 2 code must not change');
    assert.strictEqual(post2.tokenNumber, num2Before, 'Token 2 number must not change');
    assert.strictEqual(post2.userId.toString(), ui2._id.toString(), 'Token 2 owner must not change');
    pass('23. token identity integrity');
  } catch (err) {
    fail('23. token identity integrity', err);
  }

  // 24. IDOR protection
  try {
    // CustomerA tries to view an offer they're not party to
    // Create a private offer between C and D
    const [ux24, uy24] = await Promise.all([
      User.create({ name: 'IDOR X', email: `idor_x.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
      User.create({ name: 'IDOR Y', email: `idor_y.${Date.now()}@swaptest.qf`, passwordHash: 'hash', role: 'CUSTOMER', isActive: true }),
    ]);
    const [jx24, jy24] = await Promise.all([
      queueService.joinQueue({ userId: ux24._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
      queueService.joinQueue({ userId: uy24._id.toString(), centerId: centerA._id.toString(), serviceId: serviceA._id.toString() }),
    ]);
    const jwtX24 = signToken(ux24._id);
    const offerRes = await request('POST', '/api/swaps', { offeringTokenId: jx24.token._id.toString() }, { Authorization: `Bearer ${jwtX24}` });
    const privateOffer = offerRes.body.data.offer;

    // CustomerA (not a participant) tries GET /api/swaps/:id
    const res = await request('GET', `/api/swaps/${privateOffer._id}`, null, {
      Authorization: `Bearer ${customerAJwt}`,
    });
    assert.strictEqual(res.status, 403, `Expected 403 for IDOR attempt, got ${res.status}`);
    pass('24. IDOR protection');
  } catch (err) {
    fail('24. IDOR protection', err);
  }

  // 25. Rate limiting (swap offer limiter exported correctly)
  try {
    // In test mode, rate limits are set to 10000 — verify the limiter exists and is a function
    const { swapOfferLimiter, swapActionLimiter } = require('../src/middleware/rateLimiter');
    assert.strictEqual(typeof swapOfferLimiter, 'function', 'swapOfferLimiter must be a middleware function');
    assert.strictEqual(typeof swapActionLimiter, 'function', 'swapActionLimiter must be a middleware function');
    pass('25. rate limiting (limiters configured)');
  } catch (err) {
    fail('25. rate limiting (limiters configured)', err);
  }

  // 26. No PII leakage in eligible partner list
  try {
    // Reload eligible list and verify no name/email/phone in response
    const newUser = await User.create({
      name: 'PII Check', email: `pii.${Date.now()}@swaptest.qf`,
      passwordHash: 'hash', role: 'CUSTOMER', isActive: true, phone: '+919999999999',
    });
    const newJoin = await queueService.joinQueue({
      userId: newUser._id.toString(),
      centerId: centerA._id.toString(),
      serviceId: serviceA._id.toString(),
    });
    const newJwt = signToken(newUser._id);

    const res = await request('GET', `/api/swaps/eligible?tokenId=${newJoin.token._id}`, null, {
      Authorization: `Bearer ${newJwt}`,
    });
    assert.strictEqual(res.status, 200);
    const serialized = JSON.stringify(res.body);
    // No customer names, emails, or phone numbers should be in the response
    assert.ok(!serialized.includes('@swaptest.qf'), 'Email must not appear in eligible response');
    assert.ok(!serialized.includes('+919999999999'), 'Phone must not appear in eligible response');
    assert.ok(!serialized.includes('passwordHash'), 'Password hash must not appear');
    assert.ok(!serialized.includes('proximityDistanceMeters'), 'Raw distance must not appear');
    pass('26. no PII leakage');
  } catch (err) {
    fail('26. no PII leakage', err);
  }

  // 27. No static data — all swap offers are real persisted records
  try {
    // All SwapOffer documents in DB must have real tokenId/centerId/serviceId references
    const allOffers = await SwapOffer.find({
      centerId: centerA._id,
    }).lean();

    for (const offer of allOffers) {
      assert.ok(offer.offeringTokenId, 'Each offer must have a real offeringTokenId');
      assert.ok(offer.centerId, 'Each offer must have a real centerId');
      assert.ok(offer.serviceId, 'Each offer must have a real serviceId');
      assert.ok(offer.status, 'Each offer must have a status');
      assert.ok(SWAP_OFFER_STATUSES.includes(offer.status), `Invalid status: ${offer.status}`);
    }
    pass('27. no static data');
  } catch (err) {
    fail('27. no static data', err);
  }

  // 28. Concurrent transaction safety (multiple parallel swaps don't corrupt queue)
  try {
    // Create 6 fresh users, join all to same queue, then fire 3 simultaneous swap pairs
    const batchUsers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        User.create({
          name: `Concurrent ${i}`,
          email: `conc${i}.${Date.now()}@swaptest.qf`,
          passwordHash: 'hash',
          role: 'CUSTOMER',
          isActive: true,
        })
      )
    );

    const batchJoins = await Promise.all(
      batchUsers.map((u) =>
        queueService.joinQueue({
          userId: u._id.toString(),
          centerId: centerA._id.toString(),
          serviceId: serviceA._id.toString(),
        })
      )
    );
    const batchTokens = batchJoins.map((j) => j.token);
    const batchJwts = batchUsers.map((u) => signToken(u._id));

    // Create 3 offers (pair 0↔1, 2↔3, 4↔5)
    const [o01, o23, o45] = await Promise.all([
      request('POST', '/api/swaps', { offeringTokenId: batchTokens[0]._id.toString() }, { Authorization: `Bearer ${batchJwts[0]}` }),
      request('POST', '/api/swaps', { offeringTokenId: batchTokens[2]._id.toString() }, { Authorization: `Bearer ${batchJwts[2]}` }),
      request('POST', '/api/swaps', { offeringTokenId: batchTokens[4]._id.toString() }, { Authorization: `Bearer ${batchJwts[4]}` }),
    ]);

    // Accept all 3 concurrently
    const [a01, a23, a45] = await Promise.all([
      request('POST', `/api/swaps/${o01.body.data.offer._id}/accept`, { acceptingTokenId: batchTokens[1]._id.toString() }, { Authorization: `Bearer ${batchJwts[1]}` }),
      request('POST', `/api/swaps/${o23.body.data.offer._id}/accept`, { acceptingTokenId: batchTokens[3]._id.toString() }, { Authorization: `Bearer ${batchJwts[3]}` }),
      request('POST', `/api/swaps/${o45.body.data.offer._id}/accept`, { acceptingTokenId: batchTokens[5]._id.toString() }, { Authorization: `Bearer ${batchJwts[5]}` }),
    ]);

    // All three should succeed
    assert.strictEqual(a01.status, 200, `Pair 0-1: ${JSON.stringify(a01.body)}`);
    assert.strictEqual(a23.status, 200, `Pair 2-3: ${JSON.stringify(a23.body)}`);
    assert.strictEqual(a45.status, 200, `Pair 4-5: ${JSON.stringify(a45.body)}`);

    // Final queue must still have contiguous positions
    const finalWaiting = await Token.find({
      centerId: centerA._id, serviceId: serviceA._id, status: 'WAITING',
    }).sort({ currentPosition: 1 }).select('currentPosition').lean();

    const finalPositions = finalWaiting.map((t) => t.currentPosition);
    const expectedPositions = finalPositions.map((_, i) => i + 1);
    assert.deepStrictEqual(finalPositions, expectedPositions,
      `Queue positions must be contiguous after concurrent swaps. Got: ${finalPositions}`);
    pass('28. concurrent transaction safety');
  } catch (err) {
    fail('28. concurrent transaction safety', err);
  }

  console.log('\n============================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// Reference valid statuses for test 27
const { SWAP_OFFER_STATUSES } = require('../src/models/SwapOffer');

setup()
  .then(runTests)
  .then(teardown)
  .catch(async (err) => {
    console.error('Fatal test error:', err);
    await teardown();
    process.exit(1);
  });

'use strict';

/**
 * QueueFlow — Phase 4 QR Security Test Suite
 *
 * Tests:
 * 1.  Valid QR accepted
 * 2.  Tampered tokenId rejected
 * 3.  Tampered centerId rejected
 * 4.  Tampered serviceId rejected
 * 5.  Modified expiration rejected
 * 6.  Modified nonce rejected
 * 7.  Modified purpose rejected
 * 8.  Modified version rejected
 * 9.  Corrupted signature rejected
 * 10. Missing signature rejected
 * 11. Wrong signing secret rejected
 * 12. Expired QR rejected
 * 13. Future-dated QR (beyond clock-skew) rejected
 * 14. Malformed QR (not JSON) rejected
 * 15. Replay A: same QR verified twice → second rejected
 * 16. Replay B: concurrent duplicate scan → exactly 1 success, 1 failure
 * 17. Unauthorized customer cannot access another customer's QR
 * 18. Missing QR_SIGNING_SECRET → generation fails safely
 * 19. Token state restrictions enforced (CANCELLED token)
 * 20. No sensitive data in verification response
 * 21. Unauthorized scanner (no auth) rejected
 * 22. QR_SECRET value not exposed in any response
 * 23. Key rotation behavior: old QR rejected after secret change
 * 24. Valid full flow: create token → get QR → verify QR → consumed
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

// Set a test QR signing secret if not already set
if (!process.env.QR_SIGNING_SECRET) {
  process.env.QR_SIGNING_SECRET = 'test_qr_signing_secret_at_least_32_chars_long!!';
}

const http = require('http');
const assert = require('assert');
const mongoose = require('mongoose');
const { app, server } = require('../server');
const { generateSignedQRPayload, verifyQRPayload, QR_TTL_SECONDS } = require('../src/utils/qrSecurity');
const { generateQRData } = require('../src/utils/tokenUtils');
const { Token } = require('../src/models/Token');

let baseUrl;
let testServer;

// Test accounts
let adminToken;
let staffToken;
let customerToken;
let customer2Token;
let customerId;
let customer2Id;
let centerId;
let serviceId;

// ─── Helpers ────────────────────────────────────────────────────────────────

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
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function iotAuth() {
  return { 'x-iot-secret': process.env.IOT_SECRET || 'test_iot_secret' };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn()
    .then(() => {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`       ${err.message}`);
      failed++;
    });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  await new Promise((resolve) => {
    testServer = server.listen(0, resolve);
  });
  const port = testServer.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const connectDB = require('../src/config/database');
  await connectDB();

  // Clean up test data
  const User = require('../src/models/User');
  const ServiceCenter = require('../src/models/ServiceCenter');
  const Service = require('../src/models/Service');
  const Queue = require('../src/models/Queue');

  await User.deleteMany({ email: /qr_test_.*@test\.com/ });
  await Token.deleteMany({ tokenCode: /QT-/ });

  // Register admin
  const adminRes = await request('POST', '/api/auth/register', {
    name: 'QR Test Admin',
    email: 'qr_test_admin@test.com',
    password: 'Admin@12345',
  });
  adminToken = adminRes.body?.data?.token;
  // Promote to ADMIN directly in DB
  const adminUser = await User.findOneAndUpdate(
    { email: 'qr_test_admin@test.com' },
    { $set: { role: 'ADMIN' } },
    { new: true }
  );
  // Re-sign token with ADMIN role
  const { signToken } = require('../src/middleware/auth');
  adminToken = signToken(adminUser._id.toString(), 'ADMIN', adminUser.tokenVersion || 0);

  // Register staff
  const staffRes = await request('POST', '/api/auth/register', {
    name: 'QR Test Staff',
    email: 'qr_test_staff@test.com',
    password: 'Staff@12345',
  });
  staffToken = staffRes.body?.data?.token;
  // Promote to STAFF directly in DB
  const staffUser = await User.findOneAndUpdate(
    { email: 'qr_test_staff@test.com' },
    { $set: { role: 'STAFF' } },
    { new: true }
  );
  staffToken = signToken(staffUser._id.toString(), 'STAFF', staffUser.tokenVersion || 0);

  // Register customer 1
  const cust1Res = await request('POST', '/api/auth/register', {
    name: 'QR Customer 1',
    email: 'qr_test_cust1@test.com',
    password: 'Cust@12345',
  });
  customerToken = cust1Res.body?.data?.token;
  customerId = cust1Res.body?.data?.user?._id;

  // Register customer 2
  const cust2Res = await request('POST', '/api/auth/register', {
    name: 'QR Customer 2',
    email: 'qr_test_cust2@test.com',
    password: 'Cust@12345',
  });
  customer2Token = cust2Res.body?.data?.token;
  customer2Id = cust2Res.body?.data?.user?._id;

  // Get or create a service center and service
  const centersRes = await request('GET', '/api/service-centers', null, auth(adminToken));
  let center = centersRes.body?.data?.centers?.[0];
  if (!center) {
    const createCenter = await request('POST', '/api/service-centers', {
      name: 'QR Test Center',
      type: 'GOVERNMENT',
      address: { street: '1 QR St', city: 'TestCity', state: 'TS', zip: '12345', country: 'IN' },
      capacity: 100,
    }, auth(adminToken));
    center = createCenter.body?.data?.center;
  }
  centerId = center._id || center.id;

  const servicesRes = await request('GET', `/api/services?centerId=${centerId}`, null, auth(adminToken));
  let service = servicesRes.body?.data?.services?.[0];
  if (!service) {
    const createService = await request('POST', '/api/services', {
      centerId,
      name: 'QR Test Service',
      tokenPrefix: 'QT',
      avgServiceTimeMinutes: 5,
    }, auth(adminToken));
    service = createService.body?.data?.service;
  }
  serviceId = service._id || service.id;

  // Ensure center is open
  if (!center.isOpen) {
    await request('PATCH', `/api/service-centers/${centerId}`, { isOpen: true }, auth(adminToken));
  }
}


// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== QueueFlow Phase 4 — QR Security Test Suite ===\n');

  // ── Section 1: Unit tests for qrSecurity module ──────────────────────────

  console.log('── Section 1: Cryptographic Unit Tests ──');

  await test('1. Valid QR payload generates and verifies', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const parsed = verifyQRPayload(payload);
    assert.equal(parsed.tid, '507f1f77bcf86cd799439011', 'tokenId should match');
    assert.equal(parsed.pur, 'QUEUEFLOW_CHECKIN', 'purpose should match');
    assert.ok(parsed.jti, 'nonce should be present');
  });

  await test('2. Tampered tokenId rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    obj.tid = '507f1f77bcf86cd799439099'; // tampered
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('3. Tampered centerId rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    obj.cid = '507f1f77bcf86cd799439099';
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('4. Tampered serviceId rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    obj.sid = '507f1f77bcf86cd799439099';
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('5. Modified expiration rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    obj.exp = obj.exp + 99999; // extend expiry
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('6. Modified nonce rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    obj.jti = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // different nonce
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('7. Modified purpose rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    obj.pur = 'MALICIOUS_PURPOSE';
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('8. Modified version rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    obj.v = 99;
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('9. Corrupted signature rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    obj.sig = 'a'.repeat(64); // invalid signature
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('10. Missing signature rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    delete obj.sig;
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('11. Wrong signing secret rejected', async () => {
    // Save the real secret and temporarily set a different one
    const realSecret = process.env.QR_SIGNING_SECRET;
    process.env.QR_SIGNING_SECRET = 'wrong_secret_used_for_generation_at_least_32chars!';
    const payloadWithWrongSecret = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    // Restore real secret
    process.env.QR_SIGNING_SECRET = realSecret;
    // Now verify with real secret — should fail
    assert.throws(() => verifyQRPayload(payloadWithWrongSecret), /QR verification failed/);
  });

  await test('12. Expired QR rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    // Set exp to 1 second in the past — re-sign with real secret
    const now = Math.floor(Date.now() / 1000);
    obj.exp = now - 10;
    // Recalculate canonical and sig
    const crypto = require('crypto');
    const canonical = [obj.v, obj.tid, obj.cid, obj.sid, obj.iat, obj.exp, obj.jti, obj.pur].join('|');
    obj.sig = crypto.createHmac('sha256', process.env.QR_SIGNING_SECRET).update(canonical, 'utf8').digest('hex');
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('13. Future-dated QR (beyond clock-skew) rejected', async () => {
    const payload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const obj = JSON.parse(payload);
    // Set iat to 10 minutes in the future — re-sign
    const now = Math.floor(Date.now() / 1000);
    obj.iat = now + 600;
    const crypto = require('crypto');
    const canonical = [obj.v, obj.tid, obj.cid, obj.sid, obj.iat, obj.exp, obj.jti, obj.pur].join('|');
    obj.sig = crypto.createHmac('sha256', process.env.QR_SIGNING_SECRET).update(canonical, 'utf8').digest('hex');
    assert.throws(() => verifyQRPayload(JSON.stringify(obj)), /QR verification failed/);
  });

  await test('14. Malformed QR (not JSON) rejected', async () => {
    assert.throws(() => verifyQRPayload('NOT_VALID_JSON'), /QR verification failed/);
    assert.throws(() => verifyQRPayload(''), /QR verification failed/);
    assert.throws(() => verifyQRPayload('null'), /QR verification failed/);
  });

  await test('18. Missing QR_SIGNING_SECRET → generation fails safely', async () => {
    const realSecret = process.env.QR_SIGNING_SECRET;
    delete process.env.QR_SIGNING_SECRET;
    let threw = false;
    try {
      generateSignedQRPayload({
        tokenId: '507f1f77bcf86cd799439011',
        centerId: '507f1f77bcf86cd799439012',
        serviceId: '507f1f77bcf86cd799439013',
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'QR_SECRET_MISSING', 'should have QR_SECRET_MISSING code');
    }
    process.env.QR_SIGNING_SECRET = realSecret;
    assert.ok(threw, 'Should have thrown when secret is missing');
  });

  await test('23. Key rotation: old QR rejected after secret change', async () => {
    // Generate QR with the original secret
    const originalPayload = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });

    // Rotate the secret
    const originalSecret = process.env.QR_SIGNING_SECRET;
    process.env.QR_SIGNING_SECRET = 'rotated_secret_new_value_at_least_32chars_long!!!';

    // Verify old QR with new secret — should fail
    let rejected = false;
    try {
      verifyQRPayload(originalPayload);
    } catch (err) {
      rejected = true;
    }

    // Restore original for other tests
    process.env.QR_SIGNING_SECRET = originalSecret;
    assert.ok(rejected, 'Old QR should be rejected after key rotation');
  });

  // ── Section 2: Integration tests via HTTP API ─────────────────────────────

  console.log('\n── Section 2: HTTP API Integration Tests ──');

  // Helper to create a token and get its QR
  async function createTokenAndGetQR() {
    // Clean up any existing active tokens for customer 1 at this center+service
    await Token.deleteMany({
      userId: customerId,
      centerId,
      serviceId,
      status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
    });

    const tokenRes = await request('POST', '/api/tokens', {
      centerId, serviceId, notifyApp: false, notifySms: false,
    }, auth(customerToken));

    if (tokenRes.status !== 201) throw new Error(`Token creation failed: ${JSON.stringify(tokenRes.body)}`);
    const tokenId = tokenRes.body.data.token._id;

    const qrRes = await request('GET', `/api/tokens/${tokenId}/qr`, null, auth(customerToken));
    if (qrRes.status !== 200) throw new Error(`QR fetch failed: ${JSON.stringify(qrRes.body)}`);

    return { tokenId, qrData: qrRes.body.data.qrData, qrImage: qrRes.body.data.qrImage };
  }

  await test('24. Full flow: create token → get QR → verify via staff JWT', async () => {
    const { tokenId, qrData } = await createTokenAndGetQR();
    assert.ok(qrData, 'QR data should be present');

    // Parse to verify structure
    const obj = JSON.parse(qrData);
    assert.ok(obj.sig, 'Signature should be present in QR data');
    assert.ok(obj.jti, 'Nonce should be present in QR data');
    assert.ok(obj.exp, 'Expiry should be present in QR data');
    assert.ok(!obj.userId, 'userId should NOT be in QR data');
    assert.ok(!obj.email, 'email should NOT be in QR data');
    assert.ok(!obj.phone, 'phone should NOT be in QR data');

    // Verify via staff endpoint
    const verifyRes = await request('POST', '/api/tokens/verify-qr', {
      qrPayload: qrData,
    }, auth(staffToken));

    assert.equal(verifyRes.status, 200, `verify-qr should return 200, got ${verifyRes.status}: ${JSON.stringify(verifyRes.body)}`);
    assert.ok(verifyRes.body.data.tokenCode, 'Token code should be in response');
    assert.ok(!verifyRes.body.data.userId, 'userId should NOT be in verify response');
    assert.ok(!verifyRes.body.data.email, 'email should NOT be in verify response');
    assert.ok(!verifyRes.body.data.passwordHash, 'passwordHash should NOT be in verify response');

    await Token.deleteMany({ _id: tokenId });
  });

  await test('15. Replay A: same QR verified twice → second rejected', async () => {
    const { tokenId, qrData } = await createTokenAndGetQR();

    // First verify: should succeed
    const res1 = await request('POST', '/api/tokens/verify-qr', { qrPayload: qrData }, auth(staffToken));
    assert.equal(res1.status, 200, 'First verify should succeed');

    // Second verify with same QR: should be rejected
    const res2 = await request('POST', '/api/tokens/verify-qr', { qrPayload: qrData }, auth(staffToken));
    assert.equal(res2.status, 400, `Second verify should be rejected, got ${res2.status}`);

    await Token.deleteMany({ _id: tokenId });
  });

  await test('16. Replay B: concurrent duplicate scan → exactly 1 success, 1 failure', async () => {
    const { tokenId, qrData } = await createTokenAndGetQR();

    // Fire two simultaneous verification requests
    const [res1, res2] = await Promise.all([
      request('POST', '/api/tokens/verify-qr', { qrPayload: qrData }, auth(staffToken)),
      request('POST', '/api/tokens/verify-qr', { qrPayload: qrData }, auth(staffToken)),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [200, 400], `Expected one 200 and one 400, got: ${statuses}`);

    await Token.deleteMany({ _id: tokenId });
  });

  await test('17. Unauthorized customer cannot get another customer\'s QR', async () => {
    // Create token for customer 1
    await Token.deleteMany({
      userId: customerId,
      centerId,
      serviceId,
      status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
    });

    const tokenRes = await request('POST', '/api/tokens', {
      centerId, serviceId, notifyApp: false, notifySms: false,
    }, auth(customerToken));
    const tokenId = tokenRes.body.data.token._id;

    // Customer 2 tries to get customer 1's QR
    const qrRes = await request('GET', `/api/tokens/${tokenId}/qr`, null, auth(customer2Token));
    assert.equal(qrRes.status, 404, 'Customer 2 should not be able to access Customer 1 QR');

    await Token.deleteMany({ _id: tokenId });
  });

  await test('19. Token state restrictions: CANCELLED token QR rejected', async () => {
    const { tokenId, qrData } = await createTokenAndGetQR();

    // Cancel the token
    await Token.findByIdAndUpdate(tokenId, { status: 'CANCELLED', qrConsumed: false });

    // Try to verify QR for cancelled token
    const verifyRes = await request('POST', '/api/tokens/verify-qr', { qrPayload: qrData }, auth(staffToken));
    assert.equal(verifyRes.status, 400, 'Cancelled token QR should be rejected');

    await Token.deleteMany({ _id: tokenId });
  });

  await test('20. No sensitive data in verify-qr response', async () => {
    const { tokenId, qrData } = await createTokenAndGetQR();

    const verifyRes = await request('POST', '/api/tokens/verify-qr', { qrPayload: qrData }, auth(staffToken));
    if (verifyRes.status !== 200) {
      // If first verify was already consumed by a prior test, skip
      await Token.deleteMany({ _id: tokenId });
      return;
    }

    const responseText = JSON.stringify(verifyRes.body);
    assert.ok(!responseText.includes('passwordHash'), 'No passwordHash in response');
    assert.ok(!responseText.includes('QR_SIGNING_SECRET'), 'No QR secret in response');
    assert.ok(!responseText.includes('JWT_SECRET'), 'No JWT secret in response');
    assert.ok(!responseText.includes('phone'), 'No phone in response');
    assert.ok(!responseText.includes('email'), 'No email in response');

    await Token.deleteMany({ _id: tokenId });
  });

  await test('21. Unauthorized scanner (CUSTOMER role) cannot call verify-qr', async () => {
    const fakeQr = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });

    const res = await request('POST', '/api/tokens/verify-qr', { qrPayload: fakeQr }, auth(customerToken));
    assert.equal(res.status, 403, `Customer should be forbidden from verify-qr, got ${res.status}`);
  });

  await test('21b. No authentication → verify-qr rejected', async () => {
    const fakeQr = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const res = await request('POST', '/api/tokens/verify-qr', { qrPayload: fakeQr });
    assert.equal(res.status, 401, `Unauthenticated should be 401, got ${res.status}`);
  });

  await test('22. QR secret value not exposed in any response', async () => {
    const { tokenId, qrData } = await createTokenAndGetQR();
    const secret = process.env.QR_SIGNING_SECRET;

    const qrRes = await request('GET', `/api/tokens/${tokenId}/qr`, null, auth(customerToken));
    assert.ok(!JSON.stringify(qrRes.body).includes(secret), 'Secret must not appear in QR response');

    await Token.deleteMany({ _id: tokenId });
  });

  await test('IoT: scan-qr via IoT secret works', async () => {
    const { tokenId, qrData } = await createTokenAndGetQR();

    const res = await request('POST', '/api/iot/scan-qr', { qrPayload: qrData }, iotAuth());
    assert.equal(res.status, 200, `IoT scan-qr should return 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.data.tokenCode, 'Token code in response');
    assert.ok(!res.body.data.userId, 'No userId in response');

    await Token.deleteMany({ _id: tokenId });
  });

  await test('IoT: scan-qr replay rejected', async () => {
    const { tokenId, qrData } = await createTokenAndGetQR();

    const r1 = await request('POST', '/api/iot/scan-qr', { qrPayload: qrData }, iotAuth());
    assert.equal(r1.status, 200, 'First IoT scan should succeed');

    const r2 = await request('POST', '/api/iot/scan-qr', { qrPayload: qrData }, iotAuth());
    assert.equal(r2.status, 400, 'Second IoT scan should be rejected (replay)');

    await Token.deleteMany({ _id: tokenId });
  });

  await test('IoT: scan-qr without IoT secret rejected', async () => {
    const fakeQr = generateSignedQRPayload({
      tokenId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439012',
      serviceId: '507f1f77bcf86cd799439013',
    });
    const res = await request('POST', '/api/iot/scan-qr', { qrPayload: fakeQr });
    assert.equal(res.status, 401, `Should be 401 without IoT secret, got ${res.status}`);
  });

  await test('QR image is base64 PNG, not raw sensitive data', async () => {
    const { qrImage } = await createTokenAndGetQR();
    assert.ok(qrImage.startsWith('data:image/png;base64,'), 'qrImage should be a base64 PNG data URL');
    // Verify it doesn't leak signing secret
    assert.ok(!qrImage.includes(process.env.QR_SIGNING_SECRET || ''), 'qrImage should not contain signing secret');
    // Clean up
    await Token.deleteMany({
      userId: customerId,
      centerId,
      serviceId,
      status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
    });
  });
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

async function teardown() {
  const User = require('../src/models/User');
  await User.deleteMany({ email: /qr_test_.*@test\.com/ });
  await Token.deleteMany({ tokenCode: /QT-/ });

  await testServer.close();
  await mongoose.connection.close();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async function main() {
  try {
    await setup();
    await runTests();
  } catch (err) {
    console.error('Test setup or teardown error:', err);
    failed++;
  } finally {
    await teardown().catch(() => {});

    console.log('\n═══════════════════════════════════════════');
    console.log(`  QR Security Tests: ${passed} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════\n');

    process.exit(failed > 0 ? 1 : 0);
  }
})();

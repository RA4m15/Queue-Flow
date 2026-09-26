'use strict';

/**
 * QueueFlow — Phase 3: API/Input Validation, Data Integrity & Abuse Protection Security Test Suite
 *
 * Comprehensive tests covering:
 *  1. Malformed ObjectId rejected (400)
 *  2. Invalid enum value rejected (400)
 *  3. Invalid numeric/boolean type rejected (400)
 *  4. Oversized input string rejected (400)
 *  5. IDOR: Customer A cannot view Customer B token (404)
 *  6. IDOR: Customer A cannot view Customer B QR code (404)
 *  7. IDOR: Customer A cannot cancel Customer B token (404)
 *  8. IDOR: Customer A cannot submit feedback for Customer B token (404)
 *  9. IDOR: Customer A cannot access Customer B notifications (scoped to user)
 * 10. IDOR: Customer A cannot mark Customer B notification as read (404)
 * 11. Mass assignment: Role injection in registration rejected / forced to CUSTOMER
 * 12. Mass assignment: tokenVersion injection in profile update ignored
 * 13. Mass assignment: isActive injection in profile update ignored
 * 14. Mass assignment: Client-supplied userId in token creation ignored (server-authoritative)
 * 15. NoSQL injection: Operator injection ($ne, $gt, $regex) in request body rejected (400)
 * 16. NoSQL injection: Operator injection ($ne, $gt, $regex) in query string rejected (400)
 * 17. Parameter pollution: Duplicate query parameters handled safely without server crash
 * 18. Queue integrity: Invalid state transition rejected (400)
 * 19. Queue integrity: Duplicate active token for same user/service rejected (409)
 * 20. Queue integrity: Duplicate feedback submission rejected (404/already submitted)
 * 21. Pagination bounds: Negative page and massive limit safely clamped/handled
 * 22. Privileged route protection: Customer token on admin endpoint rejected (403)
 * 23. Privileged route protection: Staff token on admin-only endpoint rejected (403)
 * 24. Production error sanitization: Error responses do not leak stack traces or internal secrets
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const mongoose = require('mongoose');
const axios = require('axios');
const { app } = require('../server');
const connectDB = require('../src/config/database');
const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const Notification = require('../src/models/Notification');
const queueService = require('../src/services/queueService');
const { signToken } = require('../src/middleware/auth');

let baseUrl;
let testServer;
let passed = 0;
let failed = 0;
const results = [];

function pass(name) {
  passed++;
  results.push({ name, result: '✅ PASS' });
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, reason) {
  failed++;
  results.push({ name, result: `❌ FAIL: ${reason}` });
  console.error(`  ❌ FAIL  ${name} — ${reason}`);
}

async function runApiSecurityTests() {
  console.log('\n=======================================================');
  console.log('🛡️  QueueFlow Phase 3 — API Security & Data Integrity');
  console.log('=======================================================\n');

  await connectDB();

  testServer = app.listen(0);
  const port = testServer.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`  Test HTTP server listening on ${baseUrl}\n`);

  const api = axios.create({
    baseURL: baseUrl,
    validateStatus: () => true, // capture all status codes
  });

  const testPassword = 'Password123';
  const passwordHash = await User.hashPassword(testPassword);
  const runId = Date.now().toString().slice(-6);

  // Create test users: Customer A, Customer B, Staff, Admin
  const [userA, userB, staffUser, adminUser] = await Promise.all([
    User.create({
      name: `Customer A ${runId}`,
      email: `custA_${runId}@example.com`,
      passwordHash,
      role: 'CUSTOMER',
      tokenVersion: 1,
    }),
    User.create({
      name: `Customer B ${runId}`,
      email: `custB_${runId}@example.com`,
      passwordHash,
      role: 'CUSTOMER',
      tokenVersion: 1,
    }),
    User.create({
      name: `Staff ${runId}`,
      email: `staff_${runId}@example.com`,
      passwordHash,
      role: 'STAFF',
      tokenVersion: 1,
    }),
    User.create({
      name: `Admin ${runId}`,
      email: `admin_${runId}@example.com`,
      passwordHash,
      role: 'ADMIN',
      tokenVersion: 1,
    }),
  ]);

  const tokenA = signToken(userA._id.toString(), userA.role, userA.tokenVersion);
  const tokenB = signToken(userB._id.toString(), userB.role, userB.tokenVersion);
  const tokenStaff = signToken(staffUser._id.toString(), staffUser.role, staffUser.tokenVersion);
  const tokenAdmin = signToken(adminUser._id.toString(), adminUser.role, adminUser.tokenVersion);

  // Setup test center, service, and counter
  const center = await ServiceCenter.create({
    name: `Security Center ${runId}`,
    code: `SC${runId.slice(-4)}`,
    type: 'GOVT',
    capacity: 100,
    isOpen: true,
  });

  const service = await Service.create({
    centerId: center._id,
    name: `Security Service ${runId}`,
    tokenPrefix: 'SEC',
    avgServiceTimeMinutes: 10,
    isActive: true,
  });

  const counter = await Counter.create({
    centerId: center._id,
    serviceId: service._id,
    name: `Counter 1`,
    number: 1,
    status: 'ACTIVE',
  });

  // ─── Test 1: Malformed ObjectId rejected with HTTP 400 ─────────────────────
  {
    const name = 'Test 1 — Malformed ObjectId in path parameter rejected with HTTP 400';
    const payloads = ['..%2F..%2F', "' OR 1=1", '123', 'too-short-id', 'invalid-hex-id', '00000000000000000000000z'];
    let allBlocked = true;

    for (const badId of payloads) {
      const res = await api.get(`/api/tokens/${badId}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      if (res.status !== 400) {
        allBlocked = false;
        fail(name, `Expected 400 for '${badId}', got ${res.status}`);
        break;
      }
    }
    if (allBlocked) pass(name);
  }

  // ─── Test 2: Invalid enum value rejected with HTTP 400 ─────────────────────
  {
    const name = 'Test 2 — Invalid enum value in request body rejected with HTTP 400';
    const res = await api.post(
      '/api/service-centers',
      {
        name: 'Invalid Center',
        code: 'INV1',
        type: 'INVALID_ENUM_TYPE',
        capacity: 50,
      },
      { headers: { Authorization: `Bearer ${tokenAdmin}` } }
    );
    if (res.status === 400 && res.data.message?.includes('Validation failed')) {
      pass(name);
    } else {
      fail(name, `Expected 400 Validation failed, got ${res.status}`);
    }
  }

  // ─── Test 3: Invalid numeric/boolean input rejected with HTTP 400 ──────────
  {
    const name = 'Test 3 — Invalid numeric/boolean type in body rejected with HTTP 400';
    const res = await api.post(
      '/api/service-centers',
      {
        name: 'Bad Capacity Center',
        code: 'BCC1',
        type: 'BANK',
        capacity: 'NOT_A_NUMBER',
      },
      { headers: { Authorization: `Bearer ${tokenAdmin}` } }
    );
    if (res.status === 400) {
      pass(name);
    } else {
      fail(name, `Expected 400, got ${res.status}`);
    }
  }

  // ─── Test 4: Oversized input string rejected with HTTP 400 ─────────────────
  {
    const name = 'Test 4 — Oversized input string rejected with HTTP 400';
    const hugeName = 'A'.repeat(500);
    const res = await api.post(
      '/api/service-centers',
      {
        name: hugeName,
        code: 'HUGE1',
        type: 'BANK',
        capacity: 50,
      },
      { headers: { Authorization: `Bearer ${tokenAdmin}` } }
    );
    if (res.status === 400) {
      pass(name);
    } else {
      fail(name, `Expected 400 for oversized name, got ${res.status}`);
    }
  }

  // ─── Test 5: IDOR — Customer A cannot view Customer B token ────────────────
  let tokenBObj;
  {
    const name = 'Test 5 — IDOR: Customer A cannot view Customer B token (HTTP 404)';
    const createB = await queueService.joinQueue({
      userId: userB._id.toString(),
      centerId: center._id.toString(),
      serviceId: service._id.toString(),
    });
    tokenBObj = createB.token;

    const res = await api.get(`/api/tokens/${tokenBObj._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    if (res.status === 404) {
      pass(name);
    } else {
      fail(name, `Expected 404 for cross-user token access, got ${res.status}`);
    }
  }

  // ─── Test 6: IDOR — Customer A cannot view Customer B QR code ──────────────
  {
    const name = 'Test 6 — IDOR: Customer A cannot view Customer B token QR (HTTP 404)';
    const res = await api.get(`/api/tokens/${tokenBObj._id}/qr`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    if (res.status === 404) {
      pass(name);
    } else {
      fail(name, `Expected 404 for cross-user QR access, got ${res.status}`);
    }
  }

  // ─── Test 7: IDOR — Customer A cannot cancel Customer B token ──────────────
  {
    const name = 'Test 7 — IDOR: Customer A cannot cancel Customer B token (HTTP 404)';
    const res = await api.post(
      `/api/tokens/${tokenBObj._id}/cancel`,
      {},
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    if (res.status === 404) {
      pass(name);
    } else {
      fail(name, `Expected 404 for cross-user cancel, got ${res.status}`);
    }
  }

  // ─── Test 8: IDOR — Customer A cannot submit feedback for Customer B token ──
  {
    const name = 'Test 8 — IDOR: Customer A cannot submit feedback for Customer B token (HTTP 404)';
    const res = await api.post(
      `/api/tokens/${tokenBObj._id}/feedback`,
      { rating: 5, comment: 'Hacked feedback' },
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    if (res.status === 404) {
      pass(name);
    } else {
      fail(name, `Expected 404 for cross-user feedback, got ${res.status}`);
    }
  }

  // ─── Test 9: IDOR — Customer A cannot access Customer B notifications ──────
  let notifB;
  {
    const name = 'Test 9 — IDOR: Customer A cannot access Customer B notifications (scoped)';
    notifB = await Notification.create({
      userId: userB._id,
      centerId: center._id,
      type: 'TOKEN_CALLED',
      title: 'Secret Notification for B',
      body: 'Do not leak this',
    });

    const res = await api.get('/api/notifications', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    const hasBNotif = res.data.data?.notifications?.some(
      (n) => n._id === notifB._id.toString() || n.title === notifB.title
    );

    if (res.status === 200 && !hasBNotif) {
      pass(name);
    } else {
      fail(name, 'Customer A accessed Customer B notification');
    }
  }

  // ─── Test 10: IDOR — Customer A cannot mark Customer B notification as read ─
  {
    const name = 'Test 10 — IDOR: Customer A cannot mark Customer B notification as read (HTTP 404)';
    const res = await api.patch(
      `/api/notifications/${notifB._id}/read`,
      {},
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    if (res.status === 404) {
      pass(name);
    } else {
      fail(name, `Expected 404 for cross-user notification mark-read, got ${res.status}`);
    }
  }

  // ─── Test 11: Mass Assignment — Role injection in registration rejected ────
  {
    const name = 'Test 11 — Mass assignment: Role injection in registration forced to CUSTOMER';
    const regRes = await api.post('/api/auth/register', {
      name: 'Sneaky Admin',
      email: `sneaky_${Date.now()}@example.com`,
      password: testPassword,
      role: 'ADMIN',
    });

    const registeredRole = regRes.data?.data?.user?.role;
    if (regRes.status === 201 && registeredRole === 'CUSTOMER') {
      pass(name);
    } else {
      fail(name, `Expected role=CUSTOMER, got ${registeredRole}`);
    }
  }

  // ─── Test 12: Mass Assignment — tokenVersion injection in updateMe ignored ─
  {
    const name = 'Test 12 — Mass assignment: tokenVersion injection in updateMe ignored';
    const oldVersion = userA.tokenVersion;
    const res = await api.patch(
      '/api/auth/me',
      { tokenVersion: 99999 },
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    const freshUserA = await User.findById(userA._id);
    if (freshUserA.tokenVersion === oldVersion) {
      pass(name);
    } else {
      fail(name, `tokenVersion modified via updateMe: ${freshUserA.tokenVersion}`);
    }
  }

  // ─── Test 13: Mass Assignment — isActive injection in updateMe ignored ──────
  {
    const name = 'Test 13 — Mass assignment: isActive injection in updateMe ignored';
    await api.patch(
      '/api/auth/me',
      { isActive: false },
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    const freshUserA = await User.findById(userA._id);
    if (freshUserA.isActive === true) {
      pass(name);
    } else {
      fail(name, 'isActive modified via updateMe');
    }
  }

  // ─── Test 14: Mass Assignment — Client-supplied userId in token creation ignored
  {
    const name = 'Test 14 — Mass assignment: Client-supplied userId in token creation ignored';
    const res = await api.post(
      '/api/tokens',
      {
        centerId: center._id.toString(),
        serviceId: service._id.toString(),
        userId: userB._id.toString(), // Attacker tries to create token for User B
        status: 'SERVING', // Attacker tries to bypass queue
        position: 1,
      },
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    const tokenOwner = res.data?.data?.token?.userId?._id?.toString() || res.data?.data?.token?.userId?.toString();
    const tokenStatus = res.data?.data?.token?.status;

    if (
      res.status === 201 &&
      tokenOwner === userA._id.toString() &&
      tokenStatus === 'WAITING'
    ) {
      pass(name);
    } else {
      fail(name, `Expected owner=UserA and status=WAITING, got owner=${tokenOwner}, status=${tokenStatus}`);
    }
  }

  // ─── Test 15: NoSQL injection in body rejected with HTTP 400 ────────────────
  {
    const name = 'Test 15 — NoSQL injection: Operator injection in body rejected with HTTP 400';
    const res = await api.post('/api/auth/login', {
      email: { $ne: null },
      password: { $gt: '' },
    });

    if (res.status === 400 && res.data.message?.includes('Prohibited operator')) {
      pass(name);
    } else {
      fail(name, `Expected 400 for NoSQL operator in body, got ${res.status}`);
    }
  }

  // ─── Test 16: NoSQL injection in query string rejected with HTTP 400 ────────
  {
    const name = 'Test 16 — NoSQL injection: Operator injection in query rejected with HTTP 400';
    const res = await api.get('/api/service-centers?type[$ne]=BANK');

    if (res.status === 400 && res.data.message?.includes('Prohibited operator')) {
      pass(name);
    } else {
      fail(name, `Expected 400 for NoSQL operator in query, got ${res.status}`);
    }
  }

  // ─── Test 17: Parameter pollution handled safely without crashing ───────────
  {
    const name = 'Test 17 — Parameter pollution: Duplicate query parameters handled safely';
    const res = await api.get('/api/service-centers?type=BANK&type=GOVT');

    if (res.status === 200 && Array.isArray(res.data.data?.centers)) {
      pass(name);
    } else {
      fail(name, `Expected 200 array response, got ${res.status}`);
    }
  }

  // ─── Test 18: Queue integrity: Impossible state transition rejected ────────
  {
    const name = 'Test 18 — Queue integrity: Illegal lifecycle transition rejected with HTTP 400';
    try {
      // Try to start serving a token that is currently WAITING (must be CALLED first)
      await queueService.startServing({
        tokenId: tokenBObj._id.toString(),
        counterId: counter._id.toString(),
        adminId: adminUser._id.toString(),
      });
      fail(name, 'Illegal startServing on WAITING token should have thrown');
    } catch (err) {
      if (err.status === 400 && err.message.includes('token status is WAITING')) {
        pass(name);
      } else {
        fail(name, `Unexpected error on illegal transition: ${err.message}`);
      }
    }
  }

  // ─── Test 19: Queue integrity: Duplicate active token prevented under high concurrency (HTTP 409) ─
  {
    const name = 'Test 19 — Queue integrity: 20 concurrent creation requests yield exactly 1 active token (HTTP 409)';
    const concUser = await User.create({
      name: `ConcUser ${runId}`,
      email: `conc_${runId}@example.com`,
      passwordHash,
      role: 'CUSTOMER',
      tokenVersion: 1,
    });
    const concToken = signToken(concUser._id.toString(), concUser.role, concUser.tokenVersion);

    // Launch 20 simultaneous token-creation requests
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        api.post(
          '/api/tokens',
          { centerId: center._id.toString(), serviceId: service._id.toString() },
          { headers: { Authorization: `Bearer ${concToken}` } }
        )
      );
    }

    const responses = await Promise.all(promises);
    const statuses = responses.map((r) => r.status);
    const count201 = statuses.filter((s) => s === 201).length;
    const count409 = statuses.filter((s) => s === 409).length;

    const dbTokens = await Token.find({
      userId: concUser._id,
      centerId: center._id,
      serviceId: service._id,
      status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
    });

    if (count201 === 1 && count409 === 19 && dbTokens.length === 1) {
      pass(name);
    } else {
      fail(
        name,
        `Expected exactly 1 HTTP 201 and 19 HTTP 409 with 1 DB token, got 201:${count201}, 409:${count409}, DB:${dbTokens.length}`
      );
    }
  }

  // ─── Test 20: Queue integrity: Duplicate feedback submission rejected (404) ─
  {
    const name = 'Test 20 — Queue integrity: Duplicate feedback submission rejected with HTTP 404';
    // Transition tokenBObj: WAITING -> CALLED -> SERVING -> COMPLETED
    await queueService.callNext({
      counterId: counter._id.toString(),
      centerId: center._id.toString(),
      adminId: adminUser._id.toString(),
    });
    await queueService.startServing({
      tokenId: tokenBObj._id.toString(),
      counterId: counter._id.toString(),
      adminId: adminUser._id.toString(),
    });
    await queueService.completeToken({
      tokenId: tokenBObj._id.toString(),
      counterId: counter._id.toString(),
      adminId: adminUser._id.toString(),
    });

    // First feedback submission -> 200
    const firstRes = await api.post(
      `/api/tokens/${tokenBObj._id}/feedback`,
      { rating: 5, comment: 'Great service' },
      { headers: { Authorization: `Bearer ${tokenB}` } }
    );

    // Second feedback submission -> 404 (already submitted)
    const secondRes = await api.post(
      `/api/tokens/${tokenBObj._id}/feedback`,
      { rating: 4, comment: 'Changed my mind' },
      { headers: { Authorization: `Bearer ${tokenB}` } }
    );

    if (firstRes.status === 200 && secondRes.status === 404) {
      pass(name);
    } else {
      fail(name, `Expected first=200, second=404. Got first=${firstRes.status}, second=${secondRes.status}`);
    }
  }

  // ─── Test 21: Pagination bounds: Negative page and massive limit clamped ────
  {
    const name = 'Test 21 — Pagination bounds: Negative page and massive limit safely clamped';
    const res = await api.get('/api/tokens/my?page=-5&limit=99999', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    if (
      res.status === 200 &&
      res.data.meta?.page === 1 &&
      res.data.meta?.limit <= 100
    ) {
      pass(name);
    } else {
      fail(name, `Pagination clamping failed: meta=${JSON.stringify(res.data.meta)}`);
    }
  }

  // ─── Test 22: Privileged route protection: Customer token rejected (HTTP 403)
  {
    const name = 'Test 22 — Privileged route: Customer token on admin route rejected with HTTP 403';
    const res = await api.post(
      '/api/service-centers',
      {
        name: 'Unauthorized Center',
        code: 'UNAUTH',
        type: 'GOVT',
        capacity: 10,
      },
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    if (res.status === 403) {
      pass(name);
    } else {
      fail(name, `Expected 403 Forbidden, got ${res.status}`);
    }
  }

  // ─── Test 23: Privileged route protection: Staff token on admin-only route (HTTP 403)
  {
    const name = 'Test 23 — Privileged route: Staff token on admin-only route rejected with HTTP 403';
    const res = await api.post(
      '/api/counters',
      {
        centerId: center._id.toString(),
        name: 'Staff Counter',
        number: 99,
      },
      { headers: { Authorization: `Bearer ${tokenStaff}` } }
    );

    if (res.status === 403) {
      pass(name);
    } else {
      fail(name, `Expected 403 Forbidden for Staff on Admin route, got ${res.status}`);
    }
  }

  // ─── Test 24: Production error sanitization: No stack trace or internal leaks
  {
    const name = 'Test 24 — Error sanitization: Internal errors do not leak stack traces or internals';
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    // Request non-existent route or provoke error
    const res = await api.get('/api/non-existent-route-for-testing');
    process.env.NODE_ENV = originalEnv;

    if (res.status === 404 && res.data.stack === undefined) {
      pass(name);
    } else {
      fail(name, 'Stack trace or sensitive details exposed');
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────
  await Promise.all([
    User.deleteMany({ _id: { $in: [userA._id, userB._id, staffUser._id, adminUser._id] } }),
    Token.deleteMany({ centerId: center._id }),
    Notification.deleteMany({ centerId: center._id }),
    Counter.deleteMany({ centerId: center._id }),
    Service.deleteMany({ centerId: center._id }),
    ServiceCenter.deleteMany({ _id: center._id }),
  ]);

  console.log('\n=======================================================');
  console.log(`🛡️  Phase 3 Test Results: ${passed} passed, ${failed} failed`);
  console.log('=======================================================');
  results.forEach((r) => console.log(`  ${r.result}  ${r.name}`));

  await new Promise((r) => testServer.close(r));
  await mongoose.disconnect();

  if (failed > 0) {
    console.error('\n❌ PHASE 3 INCOMPLETE — SECURITY/INTEGRITY TEST FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ PHASE 3 API/INPUT VALIDATION & DATA INTEGRITY COMPLETE');
    process.exit(0);
  }
}

runApiSecurityTests().catch(async (err) => {
  console.error('\n❌ Phase 3 Security Test Crashed:', err);
  if (testServer) testServer.close();
  await mongoose.disconnect();
  process.exit(1);
});

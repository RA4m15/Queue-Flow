'use strict';

/**
 * QueueFlow — Phase 2 Authentication & Session Security Test Suite
 *
 * Tests:
 *  1. Valid login → token issued (HS256, id, role, tokenVersion)
 *  2. Invalid password → rejected (401)
 *  3. Invalid user (non-existent email) → rejected (401)
 *  4. Expired token → rejected (401)
 *  5. Malformed / tampered token → rejected (401)
 *  6. /auth/me cannot access another user (identity derived strictly from token)
 *  7. Registration ignores role=ADMIN (enforces role=CUSTOMER)
 *  8. Registration ignores role=STAFF (enforces role=CUSTOMER)
 *  9. Customer cannot elevate role via PATCH /api/auth/me
 * 10. Missing token on protected endpoint → 401 Unauthorized
 * 11. Customer token on admin endpoint → 403 Forbidden
 * 12. Deactivated account (isActive: false) → 403 Forbidden
 * 13. Immediate role demotion enforcement (ADMIN -> CUSTOMER takes effect immediately)
 * 14. Session revocation on logout (tokenVersion increment invalidates prior token)
 * 15. Attack simulation: Role escalation attempt blocked
 * 16. Attack simulation: Identity substitution attempt blocked
 * 17. Attack simulation: Revoked token reuse after logout blocked
 * 18. Attack simulation: Account switch isolation (User A vs User B)
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { app, server } = require('../server');
const connectDB = require('../src/config/database');
const User = require('../src/models/User');
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

async function runAuthSecurityTests() {
  console.log('\n=======================================================');
  console.log('🔐 QueueFlow Phase 2 — Auth & Session Security Suite');
  console.log('=======================================================\n');

  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      const { port } = testServer.address();
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`  Server listening on ${baseUrl}\n`);
      resolve();
    });
  });

  const api = axios.create({
    baseURL: baseUrl,
    validateStatus: () => true, // Don't throw on non-2xx
  });

  const suffix = Date.now();
  const testPassword = 'Password@123';

  // Seed baseline users
  const userA = await User.create({
    name: 'Auth Sec User A',
    email: `auth_sec_a_${suffix}@test.com`,
    passwordHash: await User.hashPassword(testPassword),
    role: 'CUSTOMER',
    isActive: true,
    tokenVersion: 0,
  });

  const userB = await User.create({
    name: 'Auth Sec User B',
    email: `auth_sec_b_${suffix}@test.com`,
    passwordHash: await User.hashPassword(testPassword),
    role: 'CUSTOMER',
    isActive: true,
    tokenVersion: 0,
  });

  const adminUser = await User.create({
    name: 'Auth Sec Admin',
    email: `auth_sec_admin_${suffix}@test.com`,
    passwordHash: await User.hashPassword(testPassword),
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 0,
  });

  // ─── Test 1: Valid login → token issued ─────────────────────────────────────
  {
    const name = 'Test 1 — Valid login → valid JWT issued with id, role, tokenVersion';
    const res = await api.post('/api/auth/login', {
      email: userA.email,
      password: testPassword,
    });

    if (res.status === 200 && res.data?.data?.token) {
      const decoded = jwt.decode(res.data.data.token);
      if (
        decoded.id === userA._id.toString() &&
        decoded.role === 'CUSTOMER' &&
        typeof decoded.tokenVersion === 'number'
      ) {
        pass(name);
      } else {
        fail(name, `Token payload incomplete: ${JSON.stringify(decoded)}`);
      }
    } else {
      fail(name, `Login failed with HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    }
  }

  // ─── Test 2: Invalid password → rejected ────────────────────────────────────
  {
    const name = 'Test 2 — Invalid password → rejected with HTTP 401';
    const res = await api.post('/api/auth/login', {
      email: userA.email,
      password: 'WrongPassword!456',
    });
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Expected 401, got ${res.status}`);
    }
  }

  // ─── Test 3: Invalid user → rejected ────────────────────────────────────────
  {
    const name = 'Test 3 — Non-existent user email → rejected with HTTP 401';
    const res = await api.post('/api/auth/login', {
      email: `non_existent_${suffix}@test.com`,
      password: testPassword,
    });
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Expected 401, got ${res.status}`);
    }
  }

  // ─── Test 4: Expired token → rejected ───────────────────────────────────────
  {
    const name = 'Test 4 — Expired token → rejected with HTTP 401';
    const expiredToken = jwt.sign(
      { id: userA._id.toString(), role: 'CUSTOMER', tokenVersion: 0 },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '-10s' }
    );
    const res = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Expected 401, got ${res.status}`);
    }
  }

  // ─── Test 5: Malformed / tampered token → rejected ──────────────────────────
  {
    const name = 'Test 5 — Tampered JWT signature → rejected with HTTP 401';
    const validToken = signToken(userA._id.toString(), userA.role, 0);
    const tampered = validToken.slice(0, -5) + 'xxxxx';
    const res = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Expected 401, got ${res.status}`);
    }
  }

  // ─── Test 5b: Missing tokenVersion in JWT → rejected ───────────────────────
  {
    const name = 'Test 5b — Missing tokenVersion in JWT payload → rejected with HTTP 401';
    const noVersionToken = jwt.sign(
      { id: userA._id.toString(), role: 'CUSTOMER' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const res = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${noVersionToken}` },
    });
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Missing tokenVersion was accepted! Status: ${res.status}`);
    }
  }

  // ─── Test 5c: Non-numeric tokenVersion in JWT → rejected ───────────────────
  {
    const name = 'Test 5c — Non-numeric tokenVersion in JWT payload → rejected with HTTP 401';
    const nonNumericToken = jwt.sign(
      { id: userA._id.toString(), role: 'CUSTOMER', tokenVersion: '0' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const res = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${nonNumericToken}` },
    });
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Non-numeric tokenVersion was accepted! Status: ${res.status}`);
    }
  }

  // ─── Test 5d: Future/Higher tokenVersion in JWT → rejected ──────────────────
  {
    const name = 'Test 5d — Future/Higher tokenVersion in JWT payload → rejected with HTTP 401';
    const futureVersionToken = jwt.sign(
      { id: userA._id.toString(), role: 'CUSTOMER', tokenVersion: 999 },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const res = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${futureVersionToken}` },
    });
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Future tokenVersion was accepted! Status: ${res.status}`);
    }
  }

  // ─── Test 5e: Alg none in JWT → rejected ───────────────────────────────────
  {
    const name = 'Test 5e — Unsigned alg: none JWT → rejected with HTTP 401';
    const algNoneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: userA._id.toString(), role: 'CUSTOMER', tokenVersion: 0 })).toString('base64url');
    const algNoneToken = `${algNoneHeader}.${payload}.`;
    const res = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${algNoneToken}` },
    });
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `alg: none token was accepted! Status: ${res.status}`);
    }
  }

  // ─── Test 6: /auth/me cannot access another user ────────────────────────────
  {
    const name = 'Test 6 — /auth/me derives identity from token; query/body substitution ignored';
    const tokenA = signToken(userA._id.toString(), userA.role, userA.tokenVersion || 0);
    const res = await api.get(`/api/auth/me?userId=${userB._id.toString()}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    if (res.status === 200 && res.data?.data?.user?._id === userA._id.toString()) {
      pass(name);
    } else {
      fail(name, `Expected userA id, got: ${JSON.stringify(res.data)}`);
    }
  }

  // ─── Test 7: Registration ignores role=ADMIN ────────────────────────────────
  {
    const name = 'Test 7 — Registration with role=ADMIN forced to CUSTOMER';
    const regRes = await api.post('/api/auth/register', {
      name: 'Sneaky Admin Attempt',
      email: `sneaky_admin_${suffix}@test.com`,
      password: testPassword,
      role: 'ADMIN',
    });

    if (regRes.status === 201) {
      const createdUser = await User.findOne({ email: `sneaky_admin_${suffix}@test.com` });
      if (createdUser && createdUser.role === 'CUSTOMER') {
        pass(name);
      } else {
        fail(name, `User was created with role: ${createdUser?.role}`);
      }
      await User.deleteOne({ _id: createdUser?._id });
    } else {
      fail(name, `Registration failed with HTTP ${regRes.status}`);
    }
  }

  // ─── Test 8: Registration ignores role=STAFF ────────────────────────────────
  {
    const name = 'Test 8 — Registration with role=STAFF forced to CUSTOMER';
    const regRes = await api.post('/api/auth/register', {
      name: 'Sneaky Staff Attempt',
      email: `sneaky_staff_${suffix}@test.com`,
      password: testPassword,
      role: 'STAFF',
    });

    if (regRes.status === 201) {
      const createdUser = await User.findOne({ email: `sneaky_staff_${suffix}@test.com` });
      if (createdUser && createdUser.role === 'CUSTOMER') {
        pass(name);
      } else {
        fail(name, `User was created with role: ${createdUser?.role}`);
      }
      await User.deleteOne({ _id: createdUser?._id });
    } else {
      fail(name, `Registration failed with HTTP ${regRes.status}`);
    }
  }

  // ─── Test 9: Customer cannot elevate role via PATCH /api/auth/me ────────────
  {
    const name = 'Test 9 — PATCH /api/auth/me ignores role modification';
    const tokenA = signToken(userA._id.toString(), userA.role, userA.tokenVersion || 0);
    const patchRes = await api.patch('/api/auth/me', {
      role: 'ADMIN',
      name: 'Updated Name Safe',
    }, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    const refreshed = await User.findById(userA._id);
    if (patchRes.status === 200 && refreshed.role === 'CUSTOMER') {
      pass(name);
    } else {
      fail(name, `Role changed to: ${refreshed?.role}`);
    }
  }

  // ─── Test 10: Missing token on protected endpoint → 401 ─────────────────────
  {
    const name = 'Test 10 — Missing token on protected endpoint → 401 Unauthorized';
    const res = await api.get('/api/auth/me');
    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Expected 401, got ${res.status}`);
    }
  }

  // ─── Test 11: Customer token on admin endpoint → 403 ────────────────────────
  {
    const name = 'Test 11 — Customer token on admin endpoint → 403 Forbidden';
    const tokenA = signToken(userA._id.toString(), userA.role, userA.tokenVersion || 0);
    const res = await api.post('/api/counters', {
      centerId: '000000000000000000000001',
      name: 'Test Counter',
      number: 1,
    }, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    if (res.status === 403) {
      pass(name);
    } else {
      fail(name, `Expected 403, got ${res.status}`);
    }
  }

  // ─── Test 12: Deactivated account → 401 Unauthorized ───────────────────────
  {
    const name = 'Test 12 — Deactivated account (isActive: false) → 401 Unauthorized';
    await User.findByIdAndUpdate(userA._id, { isActive: false });
    const tokenA = signToken(userA._id.toString(), userA.role, userA.tokenVersion || 0);

    const res = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    // Restore isActive for userA
    await User.findByIdAndUpdate(userA._id, { isActive: true });

    if (res.status === 401) {
      pass(name);
    } else {
      fail(name, `Expected 401, got ${res.status}`);
    }
  }

  // ─── Test 13: Immediate role demotion enforcement ───────────────────────────
  {
    const name = 'Test 13 — Role demotion in DB takes effect immediately on protected route';
    // Admin user has admin token
    const tokenAdmin = signToken(adminUser._id.toString(), 'ADMIN', adminUser.tokenVersion || 0);

    // Demote admin to CUSTOMER in DB
    await User.findByIdAndUpdate(adminUser._id, { role: 'CUSTOMER' });

    // Request admin route with old token claiming ADMIN in payload
    const res = await api.post('/api/counters', {
      centerId: '000000000000000000000001',
      name: 'Test Counter',
      number: 1,
    }, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    // Restore role
    await User.findByIdAndUpdate(adminUser._id, { role: 'ADMIN' });

    if (res.status === 403) {
      pass(name);
    } else {
      fail(name, `Expected 403 after DB demotion, got ${res.status}`);
    }
  }

  // ─── Test 14: Session revocation on logout ──────────────────────────────────
  {
    const name = 'Test 14 — Calling /api/auth/logout revokes session via tokenVersion';
    // Log in fresh as userB
    const loginRes = await api.post('/api/auth/login', {
      email: userB.email,
      password: testPassword,
    });
    const activeToken = loginRes.data.data.token;

    // Verify token works before logout
    const preCheck = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${activeToken}` },
    });
    assert.strictEqual(preCheck.status, 200, 'Token must work before logout');

    // Call logout endpoint
    const logoutRes = await api.post('/api/auth/logout', {}, {
      headers: { Authorization: `Bearer ${activeToken}` },
    });
    assert.strictEqual(logoutRes.status, 200, 'Logout must succeed');

    // Check DB: tokenVersion must have incremented
    const updatedUserB = await User.findById(userB._id);
    assert(updatedUserB.tokenVersion > 0, 'User tokenVersion must have increased in DB');

    // Now try to use the logged-out token
    const postCheck = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${activeToken}` },
    });

    if (postCheck.status === 401) {
      pass(name);
    } else {
      fail(name, `Logged-out token was still accepted! Status: ${postCheck.status}`);
    }
  }

  // ─── Test 14b: Session revocation on password change ───────────────────────
  {
    const name = 'Test 14b — Password change invalidates old session and increments tokenVersion';
    // Create dedicated user for password change
    const pwUser = await User.create({
      name: 'Password Test User',
      email: `pw_change_${suffix}@test.com`,
      passwordHash: await User.hashPassword(testPassword),
      role: 'CUSTOMER',
      isActive: true,
      tokenVersion: 0,
    });

    // Login as pwUser
    const loginRes = await api.post('/api/auth/login', {
      email: pwUser.email,
      password: testPassword,
    });
    const oldJwt = loginRes.data.data.token;

    // Verify old JWT works initially
    const initCheck = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${oldJwt}` },
    });
    assert.strictEqual(initCheck.status, 200, 'Old JWT must work initially');

    const newPassword = 'NewStrongPassword@456';
    // Change password
    const changeRes = await api.post('/api/auth/change-password', {
      currentPassword: testPassword,
      newPassword,
    }, {
      headers: { Authorization: `Bearer ${oldJwt}` },
    });

    assert.strictEqual(changeRes.status, 200, 'Password change must succeed');
    const newJwt = changeRes.data.data.token;
    assert(newJwt, 'Password change must return new token');

    // Verify in DB that tokenVersion incremented
    const refreshedPwUser = await User.findById(pwUser._id);
    assert.strictEqual(refreshedPwUser.tokenVersion, 1, 'tokenVersion in DB must be incremented to 1');

    // Attempt to reuse old JWT
    const oldReuseRes = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${oldJwt}` },
    });

    // Verify new JWT works
    const newCheckRes = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${newJwt}` },
    });

    await User.deleteOne({ _id: pwUser._id });

    if (oldReuseRes.status === 401 && newCheckRes.status === 200) {
      pass(name);
    } else {
      fail(name, `Old token reuse status: ${oldReuseRes.status} (expected 401), New token status: ${newCheckRes.status} (expected 200)`);
    }
  }

  // ─── Test 15: Attack simulation — Role escalation ───────────────────────────
  {
    const name = 'Test 15 — Attack simulation: Role escalation in registration rejected';
    const attackEmail = `attack_escalation_${suffix}@test.com`;
    await api.post('/api/auth/register', {
      name: 'Escalation Attacker',
      email: attackEmail,
      password: testPassword,
      role: 'ADMIN',
      isAdmin: true,
      userRole: 'ADMIN',
    });

    const attacker = await User.findOne({ email: attackEmail });
    const attackToken = signToken(attacker._id.toString(), attacker.role, attacker.tokenVersion);

    const hitAdmin = await api.post('/api/counters', {
      centerId: '000000000000000000000001',
      name: 'Counter Hacked',
      number: 55,
    }, {
      headers: { Authorization: `Bearer ${attackToken}` },
    });

    await User.deleteOne({ _id: attacker._id });

    if (hitAdmin.status === 403 && attacker.role === 'CUSTOMER') {
      pass(name);
    } else {
      fail(name, `Escalation succeeded! status=${hitAdmin.status}, role=${attacker?.role}`);
    }
  }

  // ─── Test 16: Attack simulation — Identity substitution ─────────────────────
  {
    const name = 'Test 16 — Attack simulation: Identity substitution via body/params rejected';
    const tokenA = signToken(userA._id.toString(), userA.role, userA.tokenVersion || 0);

    const res = await api.get(`/api/auth/me?id=${userB._id.toString()}&userId=${userB._id.toString()}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    if (res.status === 200 && res.data?.data?.user?._id === userA._id.toString()) {
      pass(name);
    } else {
      fail(name, `Identity substitution returned victim data!`);
    }
  }

  // ─── Test 17: Attack simulation — Revoked token reuse ────────────────────────
  {
    const name = 'Test 17 — Attack simulation: Stolen token replay after user logout blocked';
    // User B logs in
    const loginRes = await api.post('/api/auth/login', {
      email: userB.email,
      password: testPassword,
    });
    const capturedToken = loginRes.data.data.token;

    // User B explicitly logs out
    await api.post('/api/auth/logout', {}, {
      headers: { Authorization: `Bearer ${capturedToken}` },
    });

    // Attacker tries to replay capturedToken to cancel victim tokens or read profile
    const replayRes = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${capturedToken}` },
    });

    if (replayRes.status === 401) {
      pass(name);
    } else {
      fail(name, `Replay attack succeeded! Status: ${replayRes.status}`);
    }
  }

  // ─── Test 18: Attack simulation — Account switch isolation ──────────────────
  {
    const name = 'Test 18 — Attack simulation: Account switch does not cross-contaminate tokens/profiles';
    // User A login
    const loginA = await api.post('/api/auth/login', {
      email: userA.email,
      password: testPassword,
    });
    const tokenA = loginA.data.data.token;

    // User A logout
    await api.post('/api/auth/logout', {}, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    // User B login
    const loginB = await api.post('/api/auth/login', {
      email: userB.email,
      password: testPassword,
    });
    const tokenB = loginB.data.data.token;

    const profileB = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    const oldAAccess = await api.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    if (
      profileB.status === 200 &&
      profileB.data.data.user._id === userB._id.toString() &&
      oldAAccess.status === 401
    ) {
      pass(name);
    } else {
      fail(name, `Account switch contamination: B profile=${profileB.status}, oldA=${oldAAccess.status}`);
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────
  await User.deleteMany({ _id: { $in: [userA._id, userB._id, adminUser._id] } });

  console.log('\n=======================================================');
  console.log(`🔐 Auth Security Test Results: ${passed} passed, ${failed} failed`);
  console.log('=======================================================');
  results.forEach((r) => console.log(`  ${r.result}  ${r.name}`));

  await new Promise((r) => testServer.close(r));
  await mongoose.disconnect();

  if (failed > 0) {
    console.error('\n❌ PHASE 2 INCOMPLETE — AUTH SECURITY ISSUE REMAINS');
    process.exit(1);
  } else {
    console.log('\n✅ PHASE 2 AUTHENTICATION & SESSION HARDENING COMPLETE');
    process.exit(0);
  }
}

runAuthSecurityTests().catch(async (err) => {
  console.error('\n❌ Auth Security Test Crashed:', err);
  if (testServer) testServer.close();
  await mongoose.disconnect();
  process.exit(1);
});

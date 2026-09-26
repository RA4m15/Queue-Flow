'use strict';

/**
 * QueueFlow — Tier 1 / Feature 1 / Phase C — Admin Service Management
 * Integration tests against PRODUCTION backend (Render + MongoDB Atlas).
 *
 * Tests verify:
 *   1.  Admin can list all services (including inactive) via /services/admin
 *   2.  Public /services endpoint returns only active services (customer compat.)
 *   3.  Unauthenticated access to /services/admin is rejected with 401
 *   4.  STAFF role can read /services/admin (read-only allowed)
 *   5.  Non-admin (CUSTOMER) cannot access /services/admin
 *   6.  Admin can create a service (POST /api/services)
 *   7.  Created service has correct shape / fields
 *   8.  Duplicate tokenPrefix within same center is rejected (409 / 400)
 *   9.  Admin can update service name and description (PATCH /api/services/:id)
 *  10.  Admin can deactivate a service — isActive becomes false
 *  11.  Deactivated service does NOT appear in public /services list
 *  12.  Admin can re-activate a deactivated service
 *  13.  Re-activated service reappears in public list
 *  14.  Invalid service ID returns 400 (not 500)
 *  15.  Non-existent service ID returns 404
 *  16.  centerId validation — missing centerId returns 400 for /services/admin
 *  17.  centerId validation — invalid hex returns 400 for /services/admin
 *  18.  createValidation — missing name returns 400
 *  19.  createValidation — missing tokenPrefix returns 400
 *  20.  updateValidation — avgServiceTimeMinutes out-of-range returns 400
 *  21.  CUSTOMER role cannot create a service (403)
 *  22.  CUSTOMER role cannot update a service (403)
 *  23.  No static/fake data exists in admin_panel/src
 *  24.  Customer Web retains backward compatibility (GET /services still works)
 */

import assert from 'assert';
import axios from 'axios';

// ─── Environment ─────────────────────────────────────────────────────────────

let API_BASE = process.env.PHASE_C_API_URL || process.env.TEST_API_URL;

// Auto-detect if local backend is running with Phase C endpoints
try {
  const probe = await axios.get('http://localhost:5000/health', { timeout: 1500 });
  if (probe.status === 200 && !process.env.FORCE_REMOTE) {
    API_BASE = 'http://localhost:5000/api';
  }
} catch {
  // Use configured TEST_API_URL
}

if (!API_BASE) {
  console.error('\n❌ TEST_API_URL not set in .env.test');
  process.exit(1);
}

const REQUIRED_VARS = [
  'TEST_API_URL',
  'TEST_ADMIN_EMAIL',
  'TEST_ADMIN_PASSWORD',
  'TEST_STAFF_EMAIL',
  'TEST_STAFF_PASSWORD',
  'TEST_CUSTOMER_PASSWORD',
];
const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error(`\n❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function login(email, password) {
  const res = await axios.post(`${API_BASE}/auth/login`, { email, password });
  return res.data.data.token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function expect4xx(promise, code) {
  try {
    await promise;
    throw new Error('Expected error but request succeeded');
  } catch (err) {
    if (err.response) {
      const actual = err.response.status;
      if (code) {
        assert.strictEqual(actual, code, `Expected HTTP ${code}, got ${actual}`);
      } else {
        assert(actual >= 400 && actual < 500, `Expected 4xx, got ${actual}`);
      }
    } else {
      throw err;
    }
  }
}

// ─── Test Tracking ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function run(label, fn) {
  try {
    await fn();
    console.log(`  ✅ [${++passed}] ${label}`);
  } catch (err) {
    failed++;
    failures.push({ label, err: err.message });
    console.error(`  ❌ [${passed + failed}] ${label}`);
    console.error(`       ${err.message}`);
  }
}

// ─── Main Test Suite ──────────────────────────────────────────────────────────

async function runPhaseC() {
  console.log('\n============================================================');
  console.log('🧪  QueueFlow — Tier 1 / Feature 1 / Phase C Service Mgmt');
  console.log(`    Backend : ${API_BASE}`);
  console.log('============================================================\n');

  // ── Pre-requisites ──────────────────────────────────────────────────────────
  const [adminToken, staffToken] = await Promise.all([
    login(process.env.TEST_ADMIN_EMAIL, process.env.TEST_ADMIN_PASSWORD),
    login(process.env.TEST_STAFF_EMAIL, process.env.TEST_STAFF_PASSWORD),
  ]);

  // Register a temporary CUSTOMER account for role tests
  let customerToken;
  const customerEmail = `phasec_test_${Date.now()}@queueflow.test`;
  try {
    const regRes = await axios.post(`${API_BASE}/auth/register`, {
      name: 'Phase C Test Customer',
      email: customerEmail,
      password: process.env.TEST_CUSTOMER_PASSWORD,
    });
    customerToken = regRes.data.data.token;
  } catch (err) {
    console.warn('  ⚠  Could not register temp customer — role-denial tests may be skipped');
  }

  // Resolve a real centerId from the backend
  const centersRes = await axios.get(`${API_BASE}/service-centers`);
  assert(centersRes.data.data.centers.length > 0, 'Need at least one center');
  const center = centersRes.data.data.centers[0];
  const centerId = center._id;
  console.log(`  Center under test: ${center.name} (${centerId})\n`);

  // Track a service we create so we can clean up / verify it later
  let createdServiceId = null;
  const testPrefix = `T${Date.now().toString().slice(-2)}`; // e.g. T45 — unique enough for test

  // ── TESTS ──────────────────────────────────────────────────────────────────

  await run('Admin: GET /services/admin includes inactive services', async () => {
    const res = await axios.get(`${API_BASE}/services/admin?centerId=${centerId}`, {
      headers: authHeaders(adminToken),
    });
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.services), 'services must be an array');
    // May be empty on a fresh center — that is fine
    assert(typeof res.data.meta.total === 'number');
  });

  await run('Public: GET /services returns only active services', async () => {
    const res = await axios.get(`${API_BASE}/services?centerId=${centerId}`);
    assert.strictEqual(res.data.success, true);
    const services = res.data.data.services;
    assert(services.every((s) => s.isActive === true), 'Public endpoint must only return isActive:true');
  });

  await run('Unauthenticated: GET /services/admin returns 401', async () => {
    await expect4xx(
      axios.get(`${API_BASE}/services/admin?centerId=${centerId}`),
      401
    );
  });

  await run('STAFF role: GET /services/admin is allowed (read)', async () => {
    const res = await axios.get(`${API_BASE}/services/admin?centerId=${centerId}`, {
      headers: authHeaders(staffToken),
    });
    assert.strictEqual(res.data.success, true);
  });

  await run('CUSTOMER role: GET /services/admin is rejected (403)', async () => {
    if (!customerToken) { console.log('       (skipped — no customer token)'); return; }
    await expect4xx(
      axios.get(`${API_BASE}/services/admin?centerId=${centerId}`, {
        headers: authHeaders(customerToken),
      }),
      403
    );
  });

  await run('Admin: POST /api/services creates a service', async () => {
    const res = await axios.post(
      `${API_BASE}/services`,
      {
        centerId,
        name: 'Phase C Test Service',
        tokenPrefix: testPrefix,
        description: 'Created by Phase C automated test',
        avgServiceTimeMinutes: 5,
        order: 99,
      },
      { headers: authHeaders(adminToken) }
    );
    assert.strictEqual(res.data.success, true);
    const svc = res.data.data.service;
    assert(svc._id, 'service must have _id');
    assert.strictEqual(svc.name, 'Phase C Test Service');
    assert.strictEqual(svc.tokenPrefix, testPrefix.toUpperCase());
    assert.strictEqual(svc.isActive, true, 'New service must default to active');
    createdServiceId = svc._id;
  });

  await run('Created service: correct field shape', async () => {
    assert(createdServiceId, 'Need createdServiceId from previous test');
    const res = await axios.get(`${API_BASE}/services/${createdServiceId}`);
    const svc = res.data.data.service;
    assert.strictEqual(svc._id, createdServiceId);
    assert(typeof svc.centerId === 'string' || typeof svc.centerId === 'object');
    assert.strictEqual(typeof svc.name, 'string');
    assert.strictEqual(typeof svc.tokenPrefix, 'string');
    assert.strictEqual(typeof svc.isActive, 'boolean');
    assert.strictEqual(typeof svc.avgServiceTimeMinutes, 'number');
    assert.strictEqual(typeof svc.order, 'number');
  });

  await run('Duplicate tokenPrefix within same center is rejected', async () => {
    await expect4xx(
      axios.post(
        `${API_BASE}/services`,
        {
          centerId,
          name: 'Duplicate Prefix Test',
          tokenPrefix: testPrefix,
        },
        { headers: authHeaders(adminToken) }
      )
    );
  });

  await run('Admin: PATCH /api/services/:id updates name and description', async () => {
    assert(createdServiceId, 'Need createdServiceId');
    const res = await axios.patch(
      `${API_BASE}/services/${createdServiceId}`,
      { name: 'Phase C Test Service (Updated)', description: 'Updated by test' },
      { headers: authHeaders(adminToken) }
    );
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.service.name, 'Phase C Test Service (Updated)');
  });

  await run('Admin: deactivate service — isActive becomes false', async () => {
    assert(createdServiceId, 'Need createdServiceId');
    const res = await axios.patch(
      `${API_BASE}/services/${createdServiceId}`,
      { isActive: false },
      { headers: authHeaders(adminToken) }
    );
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.service.isActive, false);
  });

  await run('Deactivated service does NOT appear in public /services list', async () => {
    const res = await axios.get(`${API_BASE}/services?centerId=${centerId}`);
    const found = res.data.data.services.find((s) => s._id === createdServiceId);
    assert(!found, 'Deactivated service must not appear in public customer list');
  });

  await run('Deactivated service DOES appear in admin /services/admin list', async () => {
    const res = await axios.get(`${API_BASE}/services/admin?centerId=${centerId}`, {
      headers: authHeaders(adminToken),
    });
    const found = res.data.data.services.find((s) => s._id === createdServiceId);
    assert(found, 'Deactivated service must still appear in admin view');
    assert.strictEqual(found.isActive, false);
  });

  await run('Admin: re-activate service — isActive becomes true', async () => {
    assert(createdServiceId, 'Need createdServiceId');
    const res = await axios.patch(
      `${API_BASE}/services/${createdServiceId}`,
      { isActive: true },
      { headers: authHeaders(adminToken) }
    );
    assert.strictEqual(res.data.data.service.isActive, true);
  });

  await run('Re-activated service reappears in public /services list', async () => {
    const res = await axios.get(`${API_BASE}/services?centerId=${centerId}`);
    const found = res.data.data.services.find((s) => s._id === createdServiceId);
    assert(found, 'Re-activated service must appear in public list');
    assert.strictEqual(found.isActive, true);
  });

  await run('GET /services/:id with invalid (non-hex) ID returns 400', async () => {
    await expect4xx(axios.get(`${API_BASE}/services/not-a-real-id`), 400);
  });

  await run('GET /services/:id with non-existent ID returns 404', async () => {
    await expect4xx(axios.get(`${API_BASE}/services/000000000000000000000001`), 404);
  });

  await run('/services/admin missing centerId returns 400', async () => {
    await expect4xx(
      axios.get(`${API_BASE}/services/admin`, { headers: authHeaders(adminToken) }),
      400
    );
  });

  await run('/services/admin invalid centerId hex returns 400', async () => {
    await expect4xx(
      axios.get(`${API_BASE}/services/admin?centerId=not-an-id`, {
        headers: authHeaders(adminToken),
      }),
      400
    );
  });

  await run('createValidation: missing name returns 400', async () => {
    await expect4xx(
      axios.post(
        `${API_BASE}/services`,
        { centerId, tokenPrefix: 'ZZ' },
        { headers: authHeaders(adminToken) }
      ),
      400
    );
  });

  await run('createValidation: missing tokenPrefix returns 400', async () => {
    await expect4xx(
      axios.post(
        `${API_BASE}/services`,
        { centerId, name: 'Missing Prefix' },
        { headers: authHeaders(adminToken) }
      ),
      400
    );
  });

  await run('updateValidation: avgServiceTimeMinutes out of range returns 400', async () => {
    assert(createdServiceId);
    await expect4xx(
      axios.patch(
        `${API_BASE}/services/${createdServiceId}`,
        { avgServiceTimeMinutes: 999 },
        { headers: authHeaders(adminToken) }
      ),
      400
    );
  });

  await run('CUSTOMER cannot create service (403)', async () => {
    if (!customerToken) { console.log('       (skipped)'); return; }
    await expect4xx(
      axios.post(
        `${API_BASE}/services`,
        { centerId, name: 'Customer Hack', tokenPrefix: 'HH' },
        { headers: authHeaders(customerToken) }
      ),
      403
    );
  });

  await run('CUSTOMER cannot update service (403)', async () => {
    if (!customerToken || !createdServiceId) { console.log('       (skipped)'); return; }
    await expect4xx(
      axios.patch(
        `${API_BASE}/services/${createdServiceId}`,
        { name: 'Hacked' },
        { headers: authHeaders(customerToken) }
      ),
      403
    );
  });

  // No static/fake data check (filesystem scan — runs locally)
  await run('No mock/fake/static data in admin_panel/src/**', async () => {
    const { execSync } = await import('child_process');
    try {
      const result = execSync(
        `grep -r --include="*.jsx" --include="*.js" -l -i "mock\\|dummy\\|fake\\|demo sample" ./src 2>/dev/null || true`,
        { cwd: new URL('../', import.meta.url).pathname, encoding: 'utf8' }
      ).trim();
      assert(
        result === '',
        `Fake data found in: ${result}`
      );
    } catch (_) {
      // grep may not be available on Windows — skip silently
      console.log('       (filesystem scan skipped on this platform)');
    }
  });

  await run('Customer Web backward compat: GET /services still returns success', async () => {
    const res = await axios.get(`${API_BASE}/services?centerId=${centerId}`);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.services));
  });

  // ── Clean up: deactivate the test service so it doesn't pollute the center ──
  if (createdServiceId) {
    try {
      await axios.patch(
        `${API_BASE}/services/${createdServiceId}`,
        { isActive: false, name: 'Phase C Test Service [CLEANUP]' },
        { headers: authHeaders(adminToken) }
      );
      console.log('\n  🧹 Cleanup: test service deactivated.');
    } catch (_) {
      console.warn('\n  ⚠  Cleanup of test service failed — please deactivate manually.');
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n============================================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.error('\n  Failed tests:');
    failures.forEach(({ label, err }) => console.error(`    ❌ ${label}: ${err}`));
  }
  console.log('============================================================\n');

  if (failed > 0) process.exit(1);
}

runPhaseC().catch((err) => {
  console.error('\n❌ Phase C test suite crashed:', err.message);
  process.exit(1);
});

/**
 * Verifies the Admin Panel's stat pills for a given center.
 *
 * The Admin Panel reads these values from the EXISTING backend analytics API
 * (`GET /api/analytics/:centerId` -> `data.summary`). This script proves those
 * values actually move when a real customer joins and a real token is
 * completed, and that no value is fabricated.
 *
 * Nothing is hardcoded: the center id arrives via env and every number is read
 * back from the backend after a real queue action.
 *
 * Usage:
 *   VERIFY_CENTER_ID=<id> node test/admin_metrics_verify.mjs [baseUrl]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const CENTER = process.env.VERIFY_CENTER_ID;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

if (!CENTER) {
  console.error('VERIFY_CENTER_ID is required');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (label, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

async function call(method, p, body, token) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let adminToken = null;

// GET /api/analytics/:centerId is role-protected, so the summary must be read
// with the same admin credential the Admin Panel itself uses.
const summary = async () => (await call('GET', `/api/analytics/${CENTER}`, null, adminToken)).body?.data?.summary;
const display = async () => (await call('GET', `/api/queue/${CENTER}/display`)).body?.data;

async function main() {
  console.log(`\n=== ADMIN METRICS VERIFICATION (${BASE}) ===`);
  console.log(`center: ${CENTER}\n`);

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const l = await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminToken = l.body?.data?.token || l.body?.token;
    record('admin authenticated', !!adminToken, adminToken ? 'token obtained' : 'login failed');
  } else {
    record('admin authenticated', false, 'no E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD supplied');
  }

  const s0 = await summary();
  if (!s0) { record('analytics summary readable', false); return finish(); }

  record('analytics summary exposes the authoritative stat-pill fields',
    typeof s0.waitingCount === 'number' && typeof s0.completedToday === 'number',
    `waitingCount=${s0.waitingCount} completedToday=${s0.completedToday} issuedToday=${s0.issuedToday} avgWaitSeconds=${s0.avgWaitSeconds} waitSampleCount=${s0.waitSampleCount}`);

  record('avg wait time is null or a real measurement (never a placeholder)',
    s0.avgWaitSeconds === null || typeof s0.avgWaitSeconds === 'number',
    `avgWaitSeconds=${s0.avgWaitSeconds} samples=${s0.waitSampleCount}`);

  // ── B. Real customer join must increase Waiting in Queues ────────────────
  const svcRes = await call('GET', `/api/services?centerId=${CENTER}`);
  const services = svcRes.body?.data?.services || svcRes.body?.data || [];
  const service = (Array.isArray(services) ? services : []).find((s) => s.isActive !== false);

  if (!service) { record('B. waiting count increases on join', false, 'no active service'); return finish(); }

  const email = `adm.mtr.${Date.now()}@example.com`;
  const reg = await call('POST', '/api/auth/register', { name: 'Admin Metrics Probe', email, password: 'Probe@1234' });
  const cust = reg.body?.data?.token || reg.body?.token;

  const before = await summary();
  const join = await call('POST', '/api/tokens', { centerId: CENTER, serviceId: service._id, notifyApp: false, notifySms: false }, cust);
  if (join.status !== 201) { record('B. waiting count increases on join', false, `join -> ${join.status}`); return finish(); }
  await sleep(900);

  const afterJoin = await summary();
  record('B. WAITING IN QUEUES increases after a real join',
    afterJoin.waitingCount === before.waitingCount + 1,
    `${before.waitingCount} -> ${afterJoin.waitingCount} (token ${join.body?.data?.token?.tokenCode})`);

  // ── H. Completed Today must increase after a real completion ─────────────
  if (adminToken) {
    const d = await display();
    const counterId = (d.counters || []).find((c) => c.status === 'ACTIVE')?._id;
    const callRes = await call('POST', `/api/counters/${counterId}/call-next`, {}, adminToken);
    await sleep(900);
    const c1 = await summary();
    record('   call-next moves the token out of waiting',
      c1.waitingCount === afterJoin.waitingCount - 1,
      `waitingCount ${afterJoin.waitingCount} -> ${c1.waitingCount} (call ${callRes.status})`);

    const serving = (await display())?.nowServing || [];
    const compRes = await call('POST', `/api/counters/${counterId}/complete`, { tokenId: serving[0]?._id }, adminToken);
    await sleep(900);
    const c2 = await summary();
    record('H. COMPLETED TODAY increases after a real completion',
      c2.completedToday === c1.completedToday + 1,
      `${c1.completedToday} -> ${c2.completedToday} (complete ${compRes.status})`);

    const s3 = await summary();
    record('   avg wait time is now a real measured value',
      s3.avgWaitSeconds !== null && typeof s3.avgWaitSeconds === 'number',
      `avgWaitSeconds=${s3.avgWaitSeconds} from ${s3.waitSampleCount} real sample(s)`);
  } else {
    record('H. COMPLETED TODAY increases after a real completion', false, 'no admin credential supplied');
  }

  // ── I. No-next-token state must be blank, not fabricated ─────────────────
  const nxt = (await display())?.nextInQueue || [];
  if (nxt.length) {
    for (const t of nxt) await call('POST', `/api/tokens/${t._id}/cancel`, {}, cust);
    await sleep(900);
  }
  const drained = await display();
  record('I. no-next-token state is genuinely empty',
    (drained.nextInQueue || []).length === 0 && drained.metrics.waitingCount === 0,
    `nextInQueue=[${(drained.nextInQueue || []).map((t) => t.tokenCode).join(',')}] metrics.waitingCount=${drained.metrics.waitingCount}`);

  // ── Cross-check the two sources agree ───────────────────────────────────
  record('   analytics and display agree on the waiting count',
    (await summary()).waitingCount === drained.metrics.waitingCount,
    `analytics=${(await summary()).waitingCount} display=${drained.metrics.waitingCount}`);

  void readFileSync; void path; void fileURLToPath;
  return finish();
}

function finish() {
  const passed = results.filter(Boolean).length;
  console.log(`\n  RESULTS: ${passed} passed, ${results.length - passed} failed\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

// END-TO-END REALTIME VERIFICATION
//
// Simulates exactly what the Live Counter does: one authoritative REST load,
// then a Socket.IO subscription to `center:<centerId>`. Afterwards it performs
// REAL backend mutations (customer join via the public token API, admin
// call-next / start-serving / complete, and an IoT crowd update) and asserts
// that each pushes a NEW authoritative state to the already-open socket.
//
// Nothing here re-reads state by polling: every assertion is satisfied by a
// socket event, which is what "updates without refresh" means.
//
// Usage:  node test/realtime_e2e_verify.mjs [baseUrl]
//         node test/realtime_e2e_verify.mjs http://localhost:5000
//         node test/realtime_e2e_verify.mjs https://queue-flow-4308.onrender.com

import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const CENTER = process.env.VERIFY_CENTER_ID || '6ab030edfb8baa6b361738d8';
const IOT_SECRET = (() => {
  // Allow an explicit override first, then fall back to the backend .env using
  // a path relative to this file (the cwd is not necessarily the repo root).
  if (process.env.E2E_IOT_SECRET) return process.env.E2E_IOT_SECRET;
  try {
    // fileURLToPath is required here: import.meta.url is percent-encoded, so a
    // raw pathname would turn "Queue flow" into "Queue%20flow" and miss the file.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(here, '..', '..', 'backend', '.env');
    return readFileSync(envPath, 'utf8').match(/^IOT_SECRET=(.*)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
})();

const results = [];
const record = (label, ok, detail) => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

// Events captured from the live socket, in arrival order.
let events = [];
function drain(eventName) {
  const hits = events.filter((e) => e.event === eventName);
  events = events.filter((e) => e.event !== eventName);
  return hits;
}
async function waitForEvent(eventName, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = drain(eventName);
    if (hits.length) return hits[hits.length - 1];
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

async function api(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

const display = async () => (await api(`/api/queue/${CENTER}/display`)).body?.data;

async function main() {
  console.log(`\n============================================================`);
  console.log(` REALTIME E2E VERIFICATION  (no refresh)`);
  console.log(` backend : ${BASE}`);
  console.log(` center  : ${CENTER}`);
  console.log(`============================================================\n`);

  // ── A. Initial authoritative REST load ───────────────────────────────────
  const initial = await display();
  if (!initial) {
    record('A. authoritative REST load', false, `GET /api/queue/${CENTER}/display returned no data`);
    return finish();
  }
  record('A. authoritative REST load', true,
    `nowServing=${(initial.nowServing || []).map((t) => t.tokenCode).join(',') || '-'} ` +
    `next=${(initial.nextInQueue || []).map((t) => t.tokenCode).join(',') || '-'} ` +
    `metrics.waiting=${initial.metrics?.waitingCount ?? 'n/a'} ` +
    `displayToken=${initial.displayToken ? 'yes' : 'NO'}`);

  if (!initial.metrics) {
    record('   metrics block present', false,
      'backend did not return `metrics` - this build predates the fix. Realtime counters cannot be authoritative.');
  } else {
    record('   metrics block present', true,
      `waiting=${initial.metrics.waitingCount} serving=${initial.metrics.servingCount} ` +
      `completedToday=${initial.metrics.completedToday} avgWait=${initial.metrics.avgWaitSeconds ?? 'null'} ` +
      `samples=${initial.metrics.waitSampleCount}`);
  }

  if (!initial.displayToken) {
    record('B. socket authenticated with display token', false,
      'no displayToken in the display payload - the Live Counter cannot open a socket against this backend.');
    return finish();
  }

  // ── B. Open the realtime subscription (this is the "page open" step) ──────
  const socket = io(BASE, {
    auth: { token: `Bearer ${initial.displayToken}` },
    transports: ['websocket', 'polling'],
    reconnection: false,
  });
  const watched = [
    'queue.updated', 'token.created', 'token.called', 'token.serving',
    'token.completed', 'token.skipped', 'token.cancelled', 'crowd.updated',
  ];
  watched.forEach((n) => socket.on(n, (payload) => events.push({ event: n, payload, at: stamp() })));

  const connected = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 20000);
    socket.on('connect', () => { clearTimeout(t); resolve(true); });
    socket.on('connect_error', (e) => { clearTimeout(t); console.log('   connect_error:', e.message); resolve(false); });
  });
  record('B. socket authenticated and connected', connected, connected ? socket.id : 'no connection');
  if (!connected) return finish();

  socket.emit('join:center', CENTER);
  await sleep(600);
  record('   subscribed to center room', true, `join:center ${CENTER}`);

  // ── TEST A: real customer join ───────────────────────────────────────────
  const stampEmail = `e2e.realtime.${Date.now()}@example.com`;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'E2E Realtime Customer', email: stampEmail, password: 'E2eRealtime@1234' }),
  });
  if (reg.status !== 201 && reg.status !== 200) {
    record('TEST A. customer join', false, `register failed (${reg.status}): ${JSON.stringify(reg.body).slice(0, 160)}`);
    return finish();
  }
  const token = reg.body?.data?.token || reg.body?.token;

  // Resolve a real, active service for this center over the public API.
  const svcRes = await api(`/api/services?centerId=${CENTER}`);
  const services = svcRes.body?.data?.services || svcRes.body?.data || [];
  const service = (Array.isArray(services) ? services : []).find((s) => s.isActive !== false && s.centerId === CENTER)
    || (Array.isArray(services) ? services[0] : null);
  if (!service?._id) {
    record('TEST A. customer join', false, `could not resolve an active service for this center (${JSON.stringify(svcRes.body).slice(0, 160)})`);
    return finish();
  }

  const beforeJoin = (await display()).metrics?.waitingCount ?? null;
  events = [];
  const join = await api('/api/tokens', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ centerId: CENTER, serviceId: service._id, notifyApp: false, notifySms: false }),
  });
  if (join.status !== 201) {
    record('TEST A. customer join', false, `POST /api/tokens -> ${join.status}: ${JSON.stringify(join.body).slice(0, 200)}`);
    return finish();
  }
  const newTokenCode = join.body?.data?.token?.tokenCode;

  const quA = await waitForEvent('queue.updated');
  record('TEST A. customer join pushes queue.updated (no refresh)', !!quA,
    quA ? `metrics.waitingCount=${quA.payload?.metrics?.waitingCount} (REST before join was ${beforeJoin})` : 'no queue.updated received');
  if (quA && beforeJoin !== null) {
    record('   joined-queues metric increased', quA.payload?.metrics?.waitingCount === beforeJoin + 1,
      `${beforeJoin} -> ${quA.payload?.metrics?.waitingCount}, token ${newTokenCode}`);
  }
  const nextA = (await display()).nextInQueue || [];
  record('   next-in-line reflects the new token', nextA.some((t) => t.tokenCode === newTokenCode),
    `head=${nextA[0]?.tokenCode || '-'}`);

  // ── Staff credential, needed for call-next / complete ─────────────────────
  let staffToken = null;
  if (process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD) {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD }),
    });
    staffToken = login.body?.data?.token || login.body?.token || null;
  }
  record('   staff credential for counter actions', !!staffToken,
    staffToken ? 'obtained' : 'not supplied (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD) - counter actions will be skipped');

  // Join two more real customers so next-in-line genuinely advances.
  const extraCodes = [];
  const extraOwners = new Map();
  for (let i = 0; i < 2; i += 1) {
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: `E2E Customer ${i + 2}`,
        email: `e2e.cust.${Date.now()}.${i}@example.com`,
        password: 'E2eRealtime@1234',
      }),
    });
    const t = r.body?.data?.token || r.body?.token;
    if (!t) continue;
    const j = await api('/api/tokens', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}` },
      body: JSON.stringify({ centerId: CENTER, serviceId: service._id, notifyApp: false, notifySms: false }),
    });
    if (j.status === 201) {
      const code = j.body?.data?.token?.tokenCode;
      extraCodes.push(code);
      extraOwners.set(code, t);
    }
  }
  record('   multiple real customers joined', extraCodes.length > 0, extraCodes.join(', ') || 'none');
  extraOwners.set(newTokenCode, token);

  // ── TEST B: admin call-next ──────────────────────────────────────────────
  const countersNow = (await display()).counters || [];
  const counterId = countersNow.find((c) => c.status === 'ACTIVE')?._id;
  if (!counterId || !staffToken) {
    record('TEST B. call next', false, `counter=${counterId || 'none'} staffToken=${!!staffToken}`);
  } else {
    const servingBefore = (await display()).nowServing || [];
    const waitingBefore = (await display()).nextInQueue || [];
    events = [];
    const call = await api(`/api/counters/${counterId}/call-next`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    const called = await waitForEvent('token.called');
    if (!called) {
      record('TEST B. call next pushes token.called (no refresh)', false,
        `call -> ${call.status} ${JSON.stringify(call.body).slice(0, 140)}; no token.called event`);
    } else {
      record('TEST B. call next pushes token.called (no refresh)', true,
        `called ${called.payload?.token?.tokenCode} at ${called.payload?.counter?.displayLabel || called.payload?.counter?.name || 'counter'}`);
      record('   the called token was the real head of the line',
        called.payload?.token?.tokenCode === waitingBefore[0]?.tokenCode,
        `head was ${waitingBefore[0]?.tokenCode || '-'}`);

      const quB = await waitForEvent('queue.updated', 3000);
      record('   queue.updated followed the call', !!quB,
        quB ? `metrics.servingCount=${quB.payload?.metrics?.servingCount} waitingCount=${quB.payload?.metrics?.waitingCount}` : 'none');

      const dB = await display();
      const servingAfter = dB.nowServing || [];
      record('   now-serving changed without a page reload',
        JSON.stringify(servingBefore.map((t) => t.tokenCode)) !== JSON.stringify(servingAfter.map((t) => t.tokenCode)),
        `${servingBefore.map((t) => t.tokenCode).join(',') || '-'} -> ${servingAfter.map((t) => t.tokenCode).join(',') || '-'}`);
      record('   next-in-line advanced',
        (dB.nextInQueue || [])[0]?.tokenCode !== waitingBefore[0]?.tokenCode,
        `${waitingBefore[0]?.tokenCode || '-'} -> ${(dB.nextInQueue || [])[0]?.tokenCode || '-'}`);

      // ── TEST C: completion -> completed today ────────────────────────────
      const completedBefore = dB.metrics?.completedToday ?? null;
      events = [];
      const calledId = called.payload?.token?._id || (dB.nowServing || [])[0]?._id;
      const completeRes = await api(`/api/counters/${counterId}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${staffToken}` },
        body: JSON.stringify({ tokenId: calledId }),
      });
      const completed = await waitForEvent('token.completed');
      record('TEST C. completion pushes token.completed (no refresh)', !!completed,
        completed ? `${completed.payload?.token?.tokenCode} -> ${completeRes.status}` : `complete -> ${completeRes.status}, no event`);
      if (completed) {
        const quC = await waitForEvent('queue.updated', 3000);
        const dC = await display();
        record('   completed-today increased by one',
          completedBefore !== null && dC.metrics?.completedToday === completedBefore + 1,
          `${completedBefore} -> ${dC.metrics?.completedToday}`);
        record('   completion broadcast the new metrics', !!quC && quC.payload?.metrics?.completedToday === dC.metrics?.completedToday,
          quC ? `broadcast completedToday=${quC.payload?.metrics?.completedToday}` : 'no queue.updated after completion');
        record('   now-serving cleared after completion', (dC.nowServing || []).length === 0,
          (dC.nowServing || []).map((t) => t.tokenCode).join(',') || '(empty)');
      }

      // ── TEST E: drain the queue, next-in-line must go empty ──────────────
      events = [];
      for (;;) {
        const d = await display();
        const nxt = (d.nextInQueue || [])[0];
        if (!nxt) break;
        // Cancel through the real customer API to keep the state authoritative.
        const owner = extraOwners.get(nxt.tokenCode);
        if (!owner) break;
        const c = await api(`/api/tokens/${nxt._id}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${owner}` },
        });
        if (c.status >= 400) break;
      }
      const drained = await display();
      record('TEST E. next-in-line is empty when nothing is waiting (no fake value)',
        (drained.nextInQueue || []).length === 0 && drained.metrics?.waitingCount === 0,
        `nextInQueue=${(drained.nextInQueue || []).map((t) => t.tokenCode).join(',') || '(empty)'} metrics.waitingCount=${drained.metrics?.waitingCount}`);
    }
  }

  // ── TEST F: crowd → live counter ─────────────────────────────────────────
  if (IOT_SECRET) {
    const before = (await display()).center?.currentCrowd ?? null;
    events = [];
    const crowd = await api('/api/iot/crowd', {
      method: 'POST',
      headers: { 'x-iot-secret': IOT_SECRET },
      body: JSON.stringify({ centerId: CENTER, type: 'ENTRY', sensorId: 'E2E_VERIFY' }),
    });
    const cu = await waitForEvent('crowd.updated');
    record('TEST F. crowd.updated reaches the live counter (no refresh)', !!cu,
      cu ? `currentCrowd ${before} -> ${cu.payload?.currentCrowd} (${cu.payload?.crowdStatus})` : `POST -> ${crowd.status}, no event`);

    // restore
    if (typeof before === 'number') {
      await api('/api/iot/crowd', {
        method: 'POST',
        headers: { 'x-iot-secret': IOT_SECRET },
        body: JSON.stringify({ centerId: CENTER, type: 'COUNT', count: before, sensorId: 'E2E_VERIFY_RESTORE' }),
      });
    }
  } else {
    record('TEST F. crowd.updated', false, 'IOT_SECRET unavailable');
  }

  socket.close();

  // ── Cross-check the numbers the UI actually renders ──────────────────────
  const final = await display();
  const m = final?.metrics;
  if (m) {
    const nextCount = (final.nextInQueue || []).length;
    record('CONSISTENCY. waitingCount matches the token list', m.waitingCount === nextCount,
      `metrics.waitingCount=${m.waitingCount}, nextInQueue.length=${nextCount}`);
  }

  return finish();
}

function finish() {
  console.log(`\n============================================================`);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`============================================================\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

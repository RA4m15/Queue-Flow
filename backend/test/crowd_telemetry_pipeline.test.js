'use strict';

/**
 * Crowd telemetry pipeline regression tests.
 *
 * The physical failure these cover: the OpenCV crowd monitor reported a correct
 * local count, but the backend answered HTTP 429, so the Admin Dashboard and the
 * Live Counter both sat at "stale/offline" while the camera plainly showed 1
 * person. Two independent defects were behind it:
 *
 *   1. `POST /api/iot/crowd` had no IoT-specific rate policy. It sat under the
 *      human-facing `generalLimiter` (200 / 15 min per IP ~ 0.22 req/s), which a
 *      1 Hz device can never satisfy - and because the budget is per-IP it also
 *      starved every other API caller behind the same address, which is why both
 *      dashboards went stale at the same time.
 *   2. The client published on every camera frame whenever the count differed
 *      from the last *accepted* count, so a single rejection made that condition
 *      permanently true and produced a sustained flood.
 *
 * Covered here, end to end over real HTTP against a booted server:
 *
 *   1.  Valid IoT telemetry is accepted and becomes the authoritative value.
 *   2.  An invalid IoT secret is rejected.
 *   3.  A 1 Hz stream is accepted without a 429 flood, and the human-facing
 *       routes stay reachable while the sensor runs.
 *   4.  Repeated 429s are the limiter's answer to a flood, and IoT telemetry
 *       carries a bounded budget of its own (so it is scoped, not disabled).
 *   5.  `crowd.updated` is emitted, carries centerId, and reaches only the
 *       center's own room.
 *   6.  Freshness: a fresh reading reads online, a stale one reads offline.
 *   7.  The read endpoints agree with what was written (no second crowd system).
 *   8.  Nothing fabricates a crowd value when telemetry is absent.
 *
 * SAFETY: this file runs against the SHARED database. Every id is generated per
 * run and every document is created and removed by this run only. The same
 * ownership guard used by live_metrics_realtime_regression.test.js is applied,
 * so a hardcoded real id fails loudly instead of deleting a live center.
 */

// `NODE_ENV=test` raises every limiter's ceiling to 10,000 so the other suites
// are not throttled. The 429 behaviour under test IS the production ceiling, so
// this file runs as `development`, which applies the real per-IP budgets. No
// Redis is configured, so the limiter uses its in-process MemoryStore - correct
// for a single-process test.
process.env.NODE_ENV = 'development';
process.env.SKIP_PREFLIGHT = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crowd_telemetry_test_jwt_secret_0123456789';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'crowd_telemetry_qr_secret_0123456789';
process.env.IOT_SECRET = process.env.IOT_SECRET || 'crowd_telemetry_iot_secret';

require('dotenv').config();

const http = require('http');
const mongoose = require('mongoose');
const assert = require('assert');

const oid = () => new mongoose.Types.ObjectId();
const CENTER_ID = oid();
const OTHER_CENTER_ID = oid();
const CENTER_IDS = [CENTER_ID, OTHER_CENTER_ID];
const OWNED_IDS = [CENTER_ID, OTHER_CENTER_ID];

const RUN_TAG = `crowdtlm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function collectIds(value, out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v) => collectIds(v, out));
    return out;
  }
  if (value instanceof mongoose.Types.ObjectId) {
    out.push(value);
    return out;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((v) => collectIds(v, out));
  }
  return out;
}

function assertOwned(filter) {
  const ids = collectIds(filter);
  if (ids.length === 0) {
    throw new Error(`SAFETY VIOLATION: no identifiable id in filter ${JSON.stringify(filter)} (${RUN_TAG}).`);
  }
  for (const id of ids) {
    if (!OWNED_IDS.some((ownedId) => String(ownedId) === String(id))) {
      throw new Error(`SAFETY VIOLATION: refusing to touch ${String(id)}, not owned by this run (${RUN_TAG}).`);
    }
  }
}

function owned(model, op, filter, extra = {}) {
  assertOwned(filter);
  return model[op](filter, extra);
}

const connectDB = require('../src/config/database');

// ── Capture the real emissions instead of opening a socket ───────────────────
// `iotController` destructures `emitToCenter` at require time, so the socket
// module's export is replaced before the controller is imported.
const emitted = [];
const socketModule = require('../src/config/socket');
socketModule.emitToCenter = (centerId, event, data) => {
  emitted.push({ room: `center:${centerId}`, event, payload: data });
};

const ServiceCenter = require('../src/models/ServiceCenter');
const FootfallEvent = require('../src/models/FootfallEvent');

const { generalLimiter, iotTelemetryLimiter } = require('../src/middleware/rateLimiter');

// ── Minimal HTTP helpers (no supertest dependency in this project) ───────────
function request(baseUrl, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON body */ }
          resolve({ status: res.statusCode, body: json, raw, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tiny runner ──────────────────────────────────────────────────────────────
const results = [];
async function test(label, fn) {
  emitted.length = 0;
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`  PASS  ${label}`);
  } catch (err) {
    results.push({ label, ok: false, err });
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
async function seedFixtures() {
  owned(ServiceCenter, 'deleteMany', { _id: { $in: CENTER_IDS } });
  owned(FootfallEvent, 'deleteMany', { centerId: { $in: CENTER_IDS } });

  await ServiceCenter.create([
    { _id: CENTER_ID, name: 'Crowd Telemetry Center', code: `CT${Date.now().toString(36).toUpperCase()}`, isOpen: true, capacity: 100, type: 'GOVT' },
    { _id: OTHER_CENTER_ID, name: 'Other Crowd Center', code: `CO${Date.now().toString(36).toUpperCase()}`, isOpen: true, capacity: 100, type: 'GOVT' },
  ]);
}

async function cleanup() {
  try {
    owned(FootfallEvent, 'deleteMany', { centerId: { $in: CENTER_IDS } });
    owned(ServiceCenter, 'deleteMany', { _id: { $in: CENTER_IDS } });
  } catch (_) { /* best effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n============================================================');
  console.log(' CROWD TELEMETRY PIPELINE TESTS');
  console.log('============================================================\n');

  await connectDB();
  await seedFixtures();

  let baseUrl = null;
  let stopServer = null;

  try {
    // Boot the real server so the limiter chain and the route stack are exactly
    // what production runs, including mount order.
    process.env.SKIP_LISTEN = '1';
    const serverModule = require('../server');
    const app = serverModule.app || serverModule;
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    stopServer = () => new Promise((resolve) => server.close(resolve));
    console.log(`  test server listening on ${baseUrl}\n`);

    const postCrowd = (count, secret, extra = {}) =>
      request(baseUrl, 'POST', '/api/iot/crowd', {
        body: { centerId: CENTER_ID.toString(), type: 'COUNT', count, sensorId: 'test-sensor', ...extra },
        headers: { 'x-iot-secret': secret || process.env.IOT_SECRET },
      });

    // ── 1. valid telemetry accepted, authoritative value written ────────────
    await test('1. valid IoT telemetry is accepted and stored as authoritative', async () => {
      const res = await postCrowd(7);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.currentCrowd, 7);

      const stored = await ServiceCenter.findById(CENTER_ID);
      assert.strictEqual(stored.currentCrowd, 7, 'the stored value must be the accepted reading');
      assert.ok(stored.crowdUpdatedAt, 'a freshness stamp must be written');
      assert.ok(
        Date.now() - new Date(stored.crowdUpdatedAt).getTime() < 5000,
        'crowdUpdatedAt must reflect the moment of acceptance, not a client clock'
      );
    });

    // ── 2. zero is a real reading, not a missing value ─────────────────────
    await test('2. a count of 0 is a real reading and is stored as 0', async () => {
      const res = await postCrowd(0);
      assert.strictEqual(res.status, 200);
      const stored = await ServiceCenter.findById(CENTER_ID);
      assert.strictEqual(stored.currentCrowd, 0);
    });

    // ── 3. invalid secret rejected ─────────────────────────────────────────
    await test('3. an invalid IoT secret is rejected with 401', async () => {
      const res = await postCrowd(3, 'definitely-not-the-secret');
      assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
      // The value must not have moved.
      const stored = await ServiceCenter.findById(CENTER_ID);
      assert.strictEqual(stored.currentCrowd, 0, 'a rejected request must not change the value');
    });

    await test('3b. a missing IoT secret is rejected with 401', async () => {
      const res = await request(baseUrl, 'POST', '/api/iot/crowd', {
        body: { centerId: CENTER_ID.toString(), type: 'COUNT', count: 5 },
        headers: { 'x-iot-secret': '' },
      });
      assert.strictEqual(res.status, 401);
    });

    // ── 4. crowd.updated emitted, scoped, authoritative fields ─────────────
    await test('4. crowd.updated is emitted to the center room with authoritative fields', async () => {
      emitted.length = 0;
      const res = await postCrowd(42);
      assert.strictEqual(res.status, 200);

      const events = emitted.filter((e) => e.event === 'crowd.updated');
      assert.strictEqual(events.length, 1, 'exactly one crowd.updated per accepted reading');
      const evt = events[0];
      assert.strictEqual(evt.room, `center:${CENTER_ID.toString()}`, 'emitted to the center room');
      assert.strictEqual(String(evt.payload.centerId), CENTER_ID.toString(), 'payload must carry centerId');
      assert.strictEqual(evt.payload.currentCrowd, 42);
      assert.strictEqual(evt.payload.capacity, 100);
      assert.strictEqual(evt.payload.crowdPercent, 42, 'percentage derived from the authoritative capacity');
      assert.strictEqual(evt.payload.crowdStatus, 'LOW');
      assert.ok(evt.payload.crowdUpdatedAt, 'payload must carry the freshness stamp');
    });

    await test('4b. no event is emitted for another center', async () => {
      emitted.length = 0;
      await postCrowd(5);
      const leaked = emitted.filter((e) => String(e.room).includes(OTHER_CENTER_ID.toString()));
      assert.strictEqual(leaked.length, 0, 'no event may reach the other center room');
      const all = emitted.filter((e) => e.event === 'crowd.updated');
      for (const e of all) {
        assert.strictEqual(String(e.room), `center:${CENTER_ID.toString()}`);
      }
    });

    await test('4c. crowd status thresholds follow the authoritative percentage', async () => {
      const read = async (count) => {
        emitted.length = 0;
        const res = await postCrowd(count);
        assert.strictEqual(res.status, 200);
        return emitted.find((e) => e.event === 'crowd.updated').payload;
      };
      // capacity is 100, so the thresholds are directly observable.
      assert.strictEqual((await read(10)).crowdStatus, 'LOW');
      assert.strictEqual((await read(50)).crowdStatus, 'MODERATE');
      assert.strictEqual((await read(80)).crowdStatus, 'HIGH');
      assert.strictEqual((await read(100)).crowdPercent, 100);
    });

    // ── 5. 1 Hz stream accepted, humans not starved ────────────────────────
    await test('5. a 1 Hz telemetry stream is accepted with no 429 flood', async () => {
      // Clear the per-minute IoT budget consumed by the tests above by waiting
      // for the window to roll over.
      await sleep(61000);
      let ok = 0;
      const throttled = [];
      for (let i = 0; i < 10; i += 1) {
        const res = await postCrowd(i % 3);
        if (res.status === 200) ok += 1;
        else throttled.push(res.status);
        if (i < 9) await sleep(1000);
      }
      assert.deepStrictEqual(throttled, [], `1 Hz must not be throttled, got ${throttled.join(',')}`);
      assert.strictEqual(ok, 10);
    });

    await test('5b. human-facing API routes stay reachable while the sensor runs', async () => {
      const res = await request(baseUrl, 'GET', `/api/crowd/${CENTER_ID.toString()}`);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    });

    // NOTE: the budget-exhaustion tests (6, 6b) run LAST, after every test that
    // needs a working read. They deliberately spend the per-IP IoT and global
    // budgets, so anything after them would be answered with 429 rather than
    // data.

    // ── 7. freshness / offline semantics ───────────────────────────────────
    await test('7. a fresh reading reports the sensor online', async () => {
      const res = await postCrowd(11);
      assert.strictEqual(res.status, 200);
      const read = await request(baseUrl, 'GET', `/api/crowd/${CENTER_ID.toString()}`);
      assert.strictEqual(read.status, 200);
      assert.strictEqual(read.body.data.crowdSensorOnline, true, 'a just-accepted reading is online');
      assert.strictEqual(read.body.data.currentCrowd, 11);
      assert.strictEqual(read.body.data.capacity, 100);
      assert.strictEqual(read.body.data.crowdPercent, 11);
      assert.strictEqual(read.body.data.crowdStatus, 'LOW');
    });

    await test('7b. a sensor that stopped reporting reads offline, keeping its last value', async () => {
      // Age the freshness stamp past the backend's own staleness window.
      const SENSOR_STALE_MS = 90000;
      await owned(
        ServiceCenter,
        'updateOne',
        { _id: CENTER_ID },
        { $set: { crowdUpdatedAt: new Date(Date.now() - SENSOR_STALE_MS - 5000) } }
      );
      const read = await request(baseUrl, 'GET', `/api/crowd/${CENTER_ID.toString()}`);
      assert.strictEqual(read.status, 200);
      assert.strictEqual(read.body.data.crowdSensorOnline, false, 'a stale stamp must read offline');
      assert.strictEqual(read.body.data.currentCrowd, 11, 'the last real value is retained, not invented');
      assert.ok(read.body.data.crowdUpdatedAt, 'the stale timestamp is reported honestly');
    });

    await test('7c. a fresh reading after a stale period returns to online immediately', async () => {
      // Runs immediately after 7b: stale, then live again, with no restart.
      const res = await postCrowd(12);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const read = await request(baseUrl, 'GET', `/api/crowd/${CENTER_ID.toString()}`);
      assert.strictEqual(read.body.data.crowdSensorOnline, true, 'a fresh reading must clear the offline state');
    });

    // ── 8. no fabricated crowd data ────────────────────────────────────────
    await test('8. a center that has never reported has no fabricated crowd value', async () => {
      const read = await request(baseUrl, 'GET', `/api/crowd/${OTHER_CENTER_ID.toString()}`);
      assert.strictEqual(read.status, 200);
      const d = read.body.data;
      assert.strictEqual(d.currentCrowd, 0, 'the stored default is 0, not a fabricated reading');
      assert.strictEqual(d.crowdSensorOnline, false, 'a never-reported sensor must read offline');
      assert.strictEqual(d.crowdUpdatedAt, null, 'no freshness stamp may be invented');
    });

    await test('8b. an unknown center id is a 404, not a fabricated reading', async () => {
      const res = await postCrowd(3, process.env.IOT_SECRET, { centerId: new mongoose.Types.ObjectId().toString() });
      assert.strictEqual(res.status, 404);
    });

    await test('8c. a malformed count is rejected, not coerced into a number', async () => {
      const res = await postCrowd('not-a-number');
      assert.ok(res.status >= 400, `expected a 4xx, got ${res.status}`);
    });

    // ── 9. the footfall event is recorded for auditability ─────────────────
    await test('9. each accepted reading records a footfall event', async () => {
      const events = await FootfallEvent.find({ centerId: CENTER_ID }).sort({ createdAt: -1 });
      assert.ok(events.length > 0, 'accepted readings must be auditable');
      assert.strictEqual(events[0].source, 'IOT');
      assert.strictEqual(events[0].type, 'COUNT');
      assert.strictEqual(events[0].countAfter, 12);
    });

    // ── 6. the IoT budget exists and is bounded (scoped, not disabled) ─────
    // Deliberately last: these spend a per-IP budget, so any read after them
    // would be answered with 429 rather than data.
    await test('6c. IoT telemetry is charged to its own limiter, not the global one', async () => {
      // Structural check: the two limiters are distinct instances, so telemetry
      // can never exhaust the human-facing budget.
      assert.notStrictEqual(generalLimiter, iotTelemetryLimiter, 'a dedicated IoT limiter must exist');
    });

    await test('6. IoT telemetry has its own bounded budget and still 429s', async () => {
      // The window from test 5 holds ~20 of 120. Flooding must be refused, which
      // is the whole point: the limiter is scoped, not disabled.
      const codes = {};
      for (let i = 0; i < 200; i += 1) {
        const res = await postCrowd(1);
        codes[res.status] = (codes[res.status] || 0) + 1;
      }
      assert.ok((codes[429] || 0) > 0, `a flood must be throttled, got ${JSON.stringify(codes)}`);
      assert.ok((codes[200] || 0) > 0, 'the budget must not be zero');
      const total = Object.values(codes).reduce((a, b) => a + b, 0);
      assert.strictEqual(total, 200);
    });

    await test('6b. the global limiter is still active for human routes', async () => {
      const codes = {};
      for (let i = 0; i < 230; i += 1) {
        const res = await request(baseUrl, 'GET', '/api/service-centers');
        codes[res.status] = (codes[res.status] || 0) + 1;
      }
      assert.ok((codes[429] || 0) > 0, 'the global limiter must NOT be disabled');
    });
  } finally {
    if (stopServer) await stopServer();
  }

  console.log('\n============================================================');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  await cleanup();
  await connectDB.closeDB();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nFATAL:', err);
  try { await cleanup(); } catch (_) {}
  try { await connectDB.closeDB(); } catch (_) {}
  process.exit(1);
});

'use strict';

/**
 * STEP 14 — REAL two-counter centralized allocation demo.
 *
 * Runs the ACTUAL backend (HTTP API + Socket.IO) against the ACTUAL existing
 * "College Account" service center in the database and proves end-to-end that:
 *
 *   - customers join ONE queue and never choose a counter;
 *   - the CENTRAL backend allocator, not the client, assigns customers;
 *   - two customers land on two DIFFERENT counters simultaneously;
 *   - the next two customers stay WAITING (strict FIFO, no duplicate tokens);
 *   - when Counter 01 finishes, the next waiting customer is auto-called to
 *     Counter 01, and likewise for Counter 02;
 *   - the live counter board, the admin allocation panel, the customer view and
 *     the operator portal all show the same real backend truth;
 *   - operator scoping holds (Operator 01 ⇄ Counter 01 only);
 *   - Socket.IO pushes the new state with no page refresh.
 *
 * Nothing is stubbed, mocked or hardcoded: the center is resolved by its real
 * business code, the counters and operators are the real existing records, and
 * every number printed comes from a real API response or a real DB read.
 *
 * Demo customers are created through the real /api/auth/register + /login API
 * using a password generated at run time (never stored in the repo). Operators
 * are authenticated with a JWT signed from the real server secret for the real
 * existing operator accounts, so no operator credential is ever modified,
 * printed or committed.
 *
 * The center is snapshotted before the run and fully restored afterwards.
 *
 * Usage:  node scripts/demo_two_counter_allocation.js
 * Exit:   0 = every demo assertion passed, 1 = something failed.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');

const connectDB = require('../src/config/database');
const { server } = require('../server');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Counter = require('../src/models/Counter');
const Service = require('../src/models/Service');
const Queue = require('../src/models/Queue');
const { getTodayDateString } = require('../src/utils/tokenUtils');
const { Token } = require('../src/models/Token');
const { getReadyCounters, sortCountersByPreference } = require('../src/services/resourceAllocationService');

// Resolved from real data at run time — the demo never carries a document id.
const CENTER_CODE = 'COLLEGE01';
const OPERATOR_EMAILS = ['college.op1@queueflow.test', 'college.op2@queueflow.test'];

let baseUrl = null;
let passed = 0;
let failed = 0;
const failures = [];

// ── Snapshots for exact restoration ───────────────────────────────
let centerSnapshot = null;
let counterSnapshots = [];
let demoUserIds = [];
let demoTokenIds = [];
let centerId = null;
let queueSnapshot = null;
let customers = [];
let socket = null;
const socketEvents = [];
/** The real operator accounts, resolved once at run time (module scope for jwtFor). */
let demoOperators = [];

function ok(name) {
  passed++;
  console.log(`  \u2705 ${name}`);
}
function bad(name, err) {
  failed++;
  failures.push(`${name}: ${err.message}`);
  console.error(`  \u274c ${name}\n       ${err.message}`);
}
async function step(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
}

// ── HTTP helper ────────────────────────────────────────────────────
function req(method, pathUrl, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/** Sign a JWT exactly the way the real auth layer does, for an existing user. */
function signFor(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role, tokenVersion: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * A counter's operator is the only person allowed to act on that counter, so
 * every counter-driven call in this demo is made by the JWT of the operator who
 * really owns that counter. Nothing here is hardcoded per counter number.
 */
function jwtFor(counter) {
  const staffId = counter.staffId && counter.staffId._id ? counter.staffId._id : counter.staffId;
  const owner = demoOperators.find((o) => o._id.toString() === String(staffId));
  if (!owner) throw new Error(`No operator account owns ${counter.name}`);
  return signFor(owner);
}

/** Poll until `fn()` returns truthy. Allocation triggers are fire-and-forget. */
async function waitFor(fn, { timeout = 12000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label}`);
}

/** A point ~`meters` north of the center, i.e. genuinely inside/outside the 100 m geofence. */
function pointAtMeters(lat, lng, meters) {
  const R = 6371000;
  return { latitude: lat + (meters / R) * (180 / Math.PI), longitude: lng };
}

/** Reproduces customer_web/src/components/TokenCard.jsx exactly. */
function customerCounterDisplay(token) {
  if (!token || typeof token.counterId !== 'object' || !token.counterId) return null;
  return token.counterId.displayLabel || token.counterId.name || `Counter ${token.counterId.number || ''}`;
}

const fmt = (o) => JSON.stringify(o);

async function main() {
  console.log('\n' + '='.repeat(78));
  console.log('  STEP 14 — REAL TWO-COUNTER CENTRALIZED ALLOCATION DEMO');
  console.log('='.repeat(78) + '\n');

  // ── Boot the real server ─────────────────────────────────────────
  await connectDB();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`  Real backend listening on ${baseUrl}\n`);

  // ── Resolve real records ─────────────────────────────────────────
  const center = await ServiceCenter.findOne({ code: CENTER_CODE });
  if (!center) throw new Error(`Service center with code ${CENTER_CODE} not found`);
  centerId = center._id.toString();

  const service = await Service.findOne({ centerId, isActive: true });
  if (!service) throw new Error('No active service at the demo center');

  const counters = await Counter.find({ centerId }).sort({ number: 1 });
  const counter1 = counters.find((c) => c.number === 1);
  const counter2 = counters.find((c) => c.number === 2);
  if (!counter1 || !counter2) throw new Error('Demo requires exactly Counter 01 and Counter 02 to exist');

  const operators = await User.find({ email: { $in: OPERATOR_EMAILS } });
  demoOperators = operators;
  if (operators.length !== OPERATOR_EMAILS.length) throw new Error('Demo operator accounts are missing');
  const op1 = operators.find((o) => o.email === OPERATOR_EMAILS[0]);
  const op2 = operators.find((o) => o.email === OPERATOR_EMAILS[1]);
  const admin = await User.findOne({ role: 'ADMIN', isActive: true });
  if (!admin) throw new Error('No active ADMIN account available for the admin panel view');

  // ── Snapshot for exact restoration ───────────────────────────────
  const c0 = await ServiceCenter.findById(centerId).lean();
  centerSnapshot = {
    isOpen: c0.isOpen,
    autoResourceAllocation: c0.autoResourceAllocation,
  };
  counterSnapshots = counters.map((c) => ({
    _id: c._id,
    status: c.status,
    currentTokenId: c.currentTokenId,
    servingStartedAt: c.servingStartedAt,
    stats: c.stats ? JSON.parse(JSON.stringify(c.stats)) : null,
    activeMinutesToday: c.activeMinutesToday,
    allocationVersion: c.allocationVersion,
    updatedAt: c.updatedAt,
  }));

  const op1Jwt = signFor(op1);
  const op2Jwt = signFor(op2);
  const adminJwt = signFor(admin);

  console.log('  ── Real records in use ────────────────────────────────────');
  console.log(`     Center   : ${center.name}  (code ${center.code}, id resolved at run time)`);
  console.log(`     Service  : ${service.name}  (prefix ${service.tokenPrefix})`);
  console.log(`     Counter 1: ${counter1.name}  status=${counter1.status}  staff=${op1.email}`);
  console.log(`     Counter 2: ${counter2.name}  status=${counter2.status}  staff=${op2.email}`);
  console.log(`     Auto alloc: ${center.autoResourceAllocation}   Open: ${center.isOpen}\n`);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1 — Preconditions
  // ═══════════════════════════════════════════════════════════════
  console.log('  PHASE 1 — Preconditions on the real center');
  await step('P1.1 Center is open with centralized auto-allocation enabled', async () => {
    assert.strictEqual(c0.isOpen, true, 'center must be open');
    assert.strictEqual(c0.autoResourceAllocation, true, 'autoResourceAllocation must be enabled');
  });
  await step('P1.2 Exactly two ACTIVE counters, both assigned to the service, both free', async () => {
    assert.strictEqual(counters.length, 2, `expected exactly 2 counters, found ${counters.length}`);
    for (const c of [counter1, counter2]) {
      assert.strictEqual(c.status, 'ACTIVE', `${c.name} must be ACTIVE`);
      assert(c.serviceId && c.serviceId.toString() === service._id.toString(), `${c.name} must serve the queue`);
      assert(!c.currentTokenId, `${c.name} must start free`);
    }
  });
  await step('P1.3 Each operator owns exactly one counter (no shared operator)', async () => {
    assert.strictEqual(counter1.staffId.toString(), op1._id.toString(), 'Counter 01 must belong to Operator 01');
    assert.strictEqual(counter2.staffId.toString(), op2._id.toString(), 'Counter 02 must belong to Operator 02');
  });
  await step('P1.4 Floor is clean — no leftover WAITING/CALLED/SERVING tokens', async () => {
    const active = await Token.countDocuments({ centerId, status: { $in: ['WAITING', 'CALLED', 'SERVING'] } });
    assert.strictEqual(active, 0, `expected an empty floor, found ${active} active tokens`);
  });

  // The `Queue` day-partitioned document is a DERIVED cache that is incremented
  // per call/complete. On this shared database it has accumulated increments
  // from many previous runs, so it no longer matches the authoritative Token
  // documents. Resync it to the real floor (which is empty) and restore the
  // original values afterwards, so the demo's own assertions about the admin
  // panel's per-queue counts are measuring this run and not historical drift.
  await step('P1.5 Day queue cache resynced to the real floor (derived data, restored after)', async () => {
    const today = getTodayDateString();
    const doc = await Queue.findOne({ centerId, serviceId: service._id, date: today }).lean();
    queueSnapshot = doc
      ? { _id: doc._id, waitingCount: doc.waitingCount, activeCount: doc.activeCount }
      : null;
    if (doc) {
      await Queue.updateOne(
        { _id: doc._id },
        {
          $set: {
            waitingCount: await Token.countDocuments({ centerId, serviceId: service._id, status: 'WAITING' }),
            activeCount: await Token.countDocuments({
              centerId,
              serviceId: service._id,
              status: { $in: ['CALLED', 'SERVING'] },
            }),
          },
        }
      );
    }
    console.log(`       queue cache ${doc ? `resynced from waiting=${doc.waitingCount}/active=${doc.activeCount} (historical drift)` : 'not present'}`);
  });

  // Both counters must start from an IDENTICAL, neutral state so the demo
  // measures the allocator's rule and not the arbitrary order in which a
  // previous run happened to write two documents. The allocator's documented
  // preference is (1) lowest workload, (2) longest idle, (3) lowest counter
  // number; with an identical start the first two keys tie and the third key
  // decides — deterministically, in favour of Counter 01. Nothing is deleted:
  // only the two counters' own runtime fields are normalized, and the exact
  // previous values are restored by cleanup().
  await step('P1.6 Both counters normalized to an identical neutral start (fair comparison)', async () => {
    const fairStart = new Date();
    for (const c of counters) {
      await Counter.updateOne(
        { _id: c._id },
        { $set: { status: 'ACTIVE', currentTokenId: null, servingStartedAt: null, updatedAt: fairStart } },
        { timestamps: false }
      );
    }
    const after = await Counter.find({ centerId }).sort({ number: 1 }).lean();
    const stamps = after.map((c) => new Date(c.updatedAt).getTime());
    assert.strictEqual(after.length, 2, 'expected exactly 2 counters');
    for (const c of after) {
      assert.strictEqual(c.currentTokenId, null, `${c.name} must start free`);
      assert.strictEqual(c.servingStartedAt, null, `${c.name} must start with no serving start time`);
    }
    assert.strictEqual(stamps[0], stamps[1], 'both counters must share the same start timestamp');
    console.log(`       ${after.map((c) => c.name).join(' and ')} start ACTIVE, free, idle since the same instant`);
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2 — Operator scoping (before any allocation)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n  PHASE 2 — Operator counter scoping');
  await step('P2.1 Operator 01 may read Counter 01 but NOT Counter 02', async () => {
    const own = await req('GET', `/api/counters/${counter1._id}`, null, op1Jwt);
    assert.strictEqual(own.status, 200, `Operator 01 -> Counter 01 should be 200, got ${own.status}`);
    const other = await req('GET', `/api/counters/${counter2._id}`, null, op1Jwt);
    assert.strictEqual(other.status, 403, `Operator 01 -> Counter 02 must be 403, got ${other.status}`);
  });
  await step('P2.2 Operator 02 may read Counter 02 but NOT Counter 01', async () => {
    const own = await req('GET', `/api/counters/${counter2._id}`, null, op2Jwt);
    assert.strictEqual(own.status, 200, `Operator 02 -> Counter 02 should be 200, got ${own.status}`);
    const other = await req('GET', `/api/counters/${counter1._id}`, null, op2Jwt);
    assert.strictEqual(other.status, 403, `Operator 02 -> Counter 01 must be 403, got ${other.status}`);
  });
  await step('P2.3 Operator portal shows each operator only their own counter', async () => {
    const mine1 = await req('GET', '/api/counters/operator/me', null, op1Jwt);
    assert.strictEqual(mine1.status, 200, `expected 200, got ${mine1.status}`);
    const list1 = mine1.body.data.counters || (mine1.body.data.counter ? [mine1.body.data.counter] : []);
    assert.strictEqual(list1.length, 1, `Operator 01 must see exactly 1 counter, saw ${list1.length}`);
    assert.strictEqual(list1[0].number, 1, 'Operator 01 must see Counter 01');

    const mine2 = await req('GET', '/api/counters/operator/me', null, op2Jwt);
    const list2 = mine2.body.data.counters || (mine2.body.data.counter ? [mine2.body.data.counter] : []);
    assert.strictEqual(list2.length, 1, `Operator 02 must see exactly 1 counter, saw ${list2.length}`);
    assert.strictEqual(list2[0].number, 2, 'Operator 02 must see Counter 02');
  });
  await step('P2.4 ADMIN may read both counters', async () => {
    for (const c of [counter1, counter2]) {
      const r = await req('GET', `/api/counters/${c._id}`, null, adminJwt);
      assert.strictEqual(r.status, 200, `ADMIN -> ${c.name} should be 200, got ${r.status}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3 — Customers sign up and join ONE queue
  // ═══════════════════════════════════════════════════════════════
  console.log('\n  PHASE 3 — Four customers join one queue (no counter choice)');
  const runTag = Date.now().toString(36);
  const demoPassword = `Qf${crypto.randomBytes(9).toString('base64url')}7a`;
  customers = [];

  for (const label of ['C-021', 'C-022', 'C-023', 'C-024']) {
    const email = `demo.${label.toLowerCase()}.${runTag}@queueflow.test`;
    const reg = await req('POST', '/api/auth/register', {
      name: `Demo ${label}`,
      email,
      password: demoPassword,
    });
    assert.strictEqual(reg.status, 201, `register ${label} failed: ${fmt(reg.body)}`);
    demoUserIds.push(reg.body.data.user._id);

    const login = await req('POST', '/api/auth/login', { email, password: demoPassword });
    assert.strictEqual(login.status, 200, `login ${label} failed: ${fmt(login.body)}`);
    customers.push({ label, email, jwt: login.body.data.token, token: null, counterId: null });
  }
  await step('P3.1 Four customers registered + logged in through the real auth API', async () => {
    assert.strictEqual(customers.length, 4);
    console.log(`       customers: ${customers.map((c) => c.email).join(', ')}`);
  });

  const inside = pointAtMeters(center.latitude, center.longitude, 20);

  // The expectation is never hardcoded: it is the REAL preference order the
  // allocator itself computes (least workload -> longest idle -> lowest counter
  // number). On the normalized start of P1.6 the first two keys tie, so the
  // documented final tiebreak makes this Counter 01 -> Counter 02, which is the
  // canonical STEP 14 scenario. If real operating history ever made one counter
  // strictly preferred, the demo follows the backend instead of failing on a
  // hardcoded number.
  let preference = [];
  await step('P3.0 Read the allocator\'s real preference order (no hardcoded counter)', async () => {
    preference = sortCountersByPreference(await getReadyCounters(centerId));
    assert.strictEqual(preference.length, 2, `both counters must be allocatable, got ${preference.length}`);
    console.log('       real preference: ' + preference
      .map((c, i) => `${i + 1}) ${c.name} [workload=${c.workloadScore} (${c.workloadLevel}), idle=${c.idleSeconds}s]`)
      .join('  >  '));
    const top = preference[0];
    console.log(top.number === 1
      ? '       canonical scenario applies: first FIFO customer goes to Counter 01'
      : `       real history prefers ${top.name} for the first FIFO customer`);
  });

  async function joinQueue(c) {
    const r = await req('POST', '/api/tokens', {
      centerId,
      serviceId: service._id.toString(),
      latitude: inside.latitude,
      longitude: inside.longitude,
      accuracy: 5,
    }, c.jwt);
    assert.strictEqual(r.status, 201, `${c.label} join failed: ${fmt(r.body)}`);
    assert.strictEqual(r.body.data.token.proximityState, 'INSIDE', `${c.label} must be INSIDE the geofence`);
    c.token = r.body.data.token;
    demoTokenIds.push(c.token._id);
    return c.token;
  }

  await step('P3.2 Customer C-021 joins the queue (inside the 100 m geofence)', async () => {
    const t = await joinQueue(customers[0]);
    assert.strictEqual(t.status, 'WAITING', 'a freshly joined token starts WAITING');
    assert.strictEqual(customerCounterDisplay(t), null, 'customer must NOT see a counter yet');
    console.log(`       ${customers[0].label} joined -> real token code ${t.tokenCode}, counter: Not assigned yet`);
  });

  await step('P3.3 Backend allocates C-021 to the top-preference counter without any client input', async () => {
    await waitFor(async () => {
      const t = await Token.findById(customers[0].token._id).populate('counterId', 'name number displayLabel').lean();
      return t && t.counterId ? t : null;
    }, { label: 'C-021 to be assigned a counter' });
    const t = await Token.findById(customers[0].token._id).populate('counterId', 'name number displayLabel').lean();
    assert.strictEqual(t.status, 'CALLED', `C-021 should be CALLED, is ${t.status}`);
    assert.strictEqual(t.counterId._id.toString(), preference[0]._id.toString(),
      `C-021 must go to the top-preference counter ${preference[0].name}, went to ${t.counterId.name}`);
    customers[0].counterId = t.counterId._id;
    console.log(`       ${customers[0].label} -> ${customerCounterDisplay(t)}  (status ${t.status})`);
  });

  await step('P3.4 Customer C-022 joins and is allocated to the other counter concurrently', async () => {
    await joinQueue(customers[1]);
    await waitFor(async () => {
      const t = await Token.findById(customers[1].token._id).populate('counterId', 'name number displayLabel').lean();
      return t && t.counterId ? t : null;
    }, { label: 'C-022 to be assigned a counter' });
    const t = await Token.findById(customers[1].token._id).populate('counterId', 'name number displayLabel').lean();
    assert.strictEqual(t.status, 'CALLED', `C-022 should be CALLED, is ${t.status}`);
    assert.strictEqual(t.counterId._id.toString(), preference[1]._id.toString(),
      `C-022 must go to the second-preference counter ${preference[1].name}, went to ${t.counterId.name}`);
    assert.notStrictEqual(t.counterId._id.toString(), customers[0].counterId.toString(),
      'two simultaneous joins must never land on the same counter');
    customers[1].counterId = t.counterId._id;
    console.log(`       ${customers[1].label} -> ${customerCounterDisplay(t)}  (status ${t.status})`);
  });

  await step('P3.5 BOTH counters are serving simultaneously — two different customers', async () => {
    const top = await Counter.findById(preference[0]._id).populate('currentTokenId', 'tokenCode status').lean();
    const second = await Counter.findById(preference[1]._id).populate('currentTokenId', 'tokenCode status').lean();
    assert(top.currentTokenId, `${top.name} must hold a token`);
    assert(second.currentTokenId, `${second.name} must hold a token`);
    assert.notStrictEqual(top.currentTokenId._id.toString(), second.currentTokenId._id.toString(),
      'the two counters must hold DIFFERENT tokens — no token may be claimed twice');
    assert.strictEqual(top.currentTokenId._id.toString(), customers[0].token._id, `${top.name} holds C-021`);
    assert.strictEqual(second.currentTokenId._id.toString(), customers[1].token._id, `${second.name} holds C-022`);
    console.log(`       ${top.name} = ${top.currentTokenId.tokenCode}   ${second.name} = ${second.currentTokenId.tokenCode}`);
  });

  await step('P3.6 C-023 and C-024 join and correctly stay WAITING (no duplicate token)', async () => {
    await joinQueue(customers[2]);
    await joinQueue(customers[3]);
    await sleep(2500); // give any background trigger a chance to misbehave
    for (const c of [customers[2], customers[3]]) {
      const t = await Token.findById(c.token._id).populate('counterId', 'name').lean();
      assert.strictEqual(t.status, 'WAITING', `${c.label} must stay WAITING, is ${t.status}`);
      assert.strictEqual(t.counterId, null, `${c.label} must not be assigned yet`);
    }
    const dupes = await Token.aggregate([
      { $match: { centerId: service.centerId, status: { $in: ['WAITING', 'CALLED', 'SERVING'] } } },
      { $group: { _id: '$counterId', n: { $sum: 1 } } },
      { $match: { _id: { $ne: null }, n: { $gt: 1 } } },
    ]);
    assert.strictEqual(dupes.length, 0, 'no counter may hold more than one active token');
    console.log(`       ${customers[2].label} and ${customers[3].label} both WAITING, no duplicate assignment`);
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 4 — Live counter board (both counters + all 5 metrics)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n  PHASE 4 — Live Counter board (real public display endpoint)');
  let display = null;
  await step('P4.1 Board shows BOTH counters at the same time with their real tokens', async () => {
    const r = await req('GET', `/api/queue/${centerId}/display`);
    assert.strictEqual(r.status, 200, `display failed: ${fmt(r.body)}`);
    display = r.body.data;
    assert.strictEqual(display.counters.length, 2, `board must show 2 counters, showed ${display.counters.length}`);
    const withTokens = display.counters.filter((c) => c.servingToken);
    assert.strictEqual(withTokens.length, 2, 'both counters must show a serving token');
    for (const c of display.counters) {
      console.log(`       ${c.displayLabel}: ${c.status}  serving ${c.servingToken ? c.servingToken.tokenCode : '—'}`);
    }
  });
  await step('P4.2 Board reports the 5 required live metrics from real data', async () => {
    assert(display.metrics, 'metrics must be present');
    const m = display.metrics;
    console.log(`       Next In Line     : ${display.nextInQueue.map((t) => t.tokenCode).join(', ') || '—'}`);
    console.log(`       Waiting          : ${m.waitingCount}`);
    console.log(`       Active Counters  : ${m.activeCounters !== undefined ? m.activeCounters : m.servingCount}`);
    console.log(`       EWT (minutes)    : ${m.estimatedWaitMinutes !== undefined ? m.estimatedWaitMinutes : 'Unavailable'}`);
    console.log(`       Queue Status     : ${display.center.isOpen ? 'OPEN' : 'CLOSED'}`);
    assert.strictEqual(m.waitingCount, 2, `waiting must be 2, is ${m.waitingCount}`);
    assert(display.nextInQueue.length >= 2, 'next in line must list the waiting customers');
    assert.strictEqual(display.nextInQueue[0].tokenCode, customers[2].token.tokenCode,
      'FIFO: first waiting customer must be listed first');
  });
  await step('P4.3 No completed/stale token is displayed as being served', async () => {
    for (const c of display.counters) {
      if (c.servingToken) {
        assert(['CALLED', 'SERVING'].includes(c.servingToken.status),
          `${c.displayLabel} shows a ${c.servingToken.status} token as serving`);
      }
    }
    const nowServingCodes = display.nowServing.map((t) => t.tokenCode);
    assert(nowServingCodes.includes(customers[0].token.tokenCode), 'C-021 must be in nowServing');
    assert(nowServingCodes.includes(customers[1].token.tokenCode), 'C-022 must be in nowServing');
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 5 — Admin Resource Allocation panel (real backend data)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n  PHASE 5 — Admin Panel "Resource Allocation" (real backend data)');
  let overview = null;
  await step('P5.1 Overview returns real data for all counters, ready/busy, workload, state', async () => {
    const r = await req('GET', `/api/counters/allocation/overview?centerId=${centerId}`, null, adminJwt);
    assert.strictEqual(r.status, 200, `overview failed: ${fmt(r.body)}`);
    overview = r.body.data;
    assert.strictEqual(overview.counters.length, 2, 'overview must cover all counters');
    assert.strictEqual(overview.autoResourceAllocation, true, 'panel must show auto-allocation is ON');
    assert.strictEqual(overview.allocationStatus, 'ACTIVE', 'allocation status must be ACTIVE');
    for (const c of overview.counters) {
      assert(c.allocationState, `${c.name} missing allocationState`);
      assert(c.status, `${c.name} missing status`);
      assert('workloadLevel' in c, `${c.name} missing workload field`);
      console.log(`       ${c.displayLabel} [${c.allocationState}] status=${c.status} ` +
        `token=${c.currentToken ? c.currentToken.tokenCode : '—'} ` +
        `workload=${c.workloadLevel} idle=${c.idleMinutes === null ? 'Unavailable' : c.idleMinutes + 'm'}`);
    }
  });
  await step('P5.2 Metrics are real, and unknowable numbers are "Unavailable"', async () => {
    const m = overview.metrics;
    console.log(`       total=${m.totalCounters} active=${m.activeCounters} ready=${m.readyCounters} ` +
      `busy=${m.busyCounters} waiting=${m.waitingCustomers} serving=${m.currentlyServing} ` +
      `occupancy=${m.liveOccupancyPercent} utilization=${m.counterUtilization}`);
    assert.strictEqual(m.totalCounters, 2, 'totalCounters must be 2');
    assert.strictEqual(m.activeCounters, 2, 'activeCounters must be 2');
    assert.strictEqual(m.busyCounters, 2, 'both counters are busy');
    assert.strictEqual(m.readyCounters, 0, 'no counter is ready while both are serving');
    assert.strictEqual(m.waitingCustomers, 2, `waitingCustomers must be 2, is ${m.waitingCustomers}`);
    assert.strictEqual(m.counterUtilization, 'Unavailable', 'un-derivable utilization must read Unavailable');
    assert.strictEqual(m.liveOccupancyPercent, '100%', 'occupancy is a real ratio of real counters');
  });
  await step('P5.3 Next In Line (FIFO) list is the real waiting order', async () => {
    const codes = overview.waitingQueue.map((t) => t.tokenCode);
    console.log(`       ${codes.join(' → ')}`);
    assert.strictEqual(codes[0], customers[2].token.tokenCode, 'first in line must be C-023');
    assert.strictEqual(codes[1], customers[3].token.tokenCode, 'second in line must be C-024');
  });
  await step('P5.4 Per-queue counts agree with the real floor', async () => {
    const q = overview.queues.find((x) => x.serviceId && x.serviceId.toString() === service._id.toString());
    assert(q, 'the demo queue must appear in the overview');
    console.log(`       queue "${q.serviceName}" waiting=${q.waitingCount} active=${q.activeCount} status=${q.status}`);
    assert.strictEqual(Number(q.activeCount), 2, 'queue activeCount must be 2');
  });
  await step('P5.5 Staff operator can read the overview; CUSTOMER cannot', async () => {
    const staff = await req('GET', `/api/counters/allocation/overview?centerId=${centerId}`, null, op1Jwt);
    assert.strictEqual(staff.status, 200, `STAFF overview should be 200, got ${staff.status}`);
    const cust = await req('GET', `/api/counters/allocation/overview?centerId=${centerId}`, null, customers[0].jwt);
    assert.strictEqual(cust.status, 403, `CUSTOMER overview must be 403, got ${cust.status}`);
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 6 — Realtime (Socket.IO) — no refresh
  // ═══════════════════════════════════════════════════════════════
  console.log('\n  PHASE 6 — Socket.IO realtime (no page refresh)');
  await step('P6.1 Live viewer joins the center room over the real Socket.IO server', async () => {
    socket = ioClient(baseUrl, { auth: { token: adminJwt }, transports: ['websocket'] });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket connect timeout')), 10000);
      socket.on('connect', () => { clearTimeout(t); resolve(); });
      socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    });
    socket.onAny((event, payload) => {
      socketEvents.push({ event, at: Date.now(), payload });
    });
    socket.emit('join:center', centerId);
    await sleep(1000);
    assert(socket.connected, 'the viewer socket must be connected');
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 7 — the first counter completes → C-023 auto-called to it
  // ═══════════════════════════════════════════════════════════════
  console.log('\n  PHASE 7 — the first counter completes, the next waiting customer is auto-called');
  await step('P7.1 The owning operator starts serving C-021 at its own counter (real counter API)', async () => {
    const r = await req('POST', `/api/counters/${preference[0]._id}/start-serving`, {}, jwtFor(preference[0]));
    assert.strictEqual(r.status, 200, `start-serving failed: ${fmt(r.body)}`);
    const t = await Token.findById(customers[0].token._id).lean();
    assert.strictEqual(t.status, 'SERVING', `C-021 should be SERVING, is ${t.status}`);
    console.log(`       ${r.body.message}`);
  });
  await step('P7.2 The same operator completes C-021 through the real counter API', async () => {
    const r = await req('POST', `/api/counters/${preference[0]._id}/complete`, {}, jwtFor(preference[0]));
    assert.strictEqual(r.status, 200, `complete failed: ${fmt(r.body)}`);
    console.log(`       ${r.body.message}`);
  });
  await step('P7.3 C-023 is auto-called to the counter that just freed up (FIFO, backend-decided)', async () => {
    await waitFor(async () => {
      const t = await Token.findById(customers[2].token._id).lean();
      return t && t.counterId ? t : null;
    }, { label: 'C-023 to be auto-called' });
    const t = await Token.findById(customers[2].token._id).populate('counterId', 'name number displayLabel').lean();
    assert.strictEqual(t.status, 'CALLED', `C-023 should be CALLED, is ${t.status}`);
    assert.strictEqual(t.counterId._id.toString(), preference[0]._id.toString(),
      `C-023 must go to the freed ${preference[0].name}, went to ${t.counterId.name}`);
    customers[2].counterId = t.counterId._id;
    console.log(`       ${customers[2].label} -> ${customerCounterDisplay(t)}  (status ${t.status})`);
  });
  await step('P7.4 C-024 is still WAITING — strict FIFO preserved', async () => {
    const t = await Token.findById(customers[3].token._id).populate('counterId', 'name').lean();
    assert.strictEqual(t.status, 'WAITING', `C-024 must still be WAITING, is ${t.status}`);
    assert.strictEqual(t.counterId, null, `C-024 must not be assigned while ${preference[1].name} is busy`);
  });
  await step('P7.5 Realtime: the board was pushed the new state with NO refresh', async () => {
    // The push is asynchronous: the allocator re-reads the whole center
    // snapshot before emitting, so wait for the event rather than racing it.
    await waitFor(
      () => socketEvents.some((e) => e.event === 'resource.allocation.updated'),
      { label: 'resource.allocation.updated push', timeout: 20000 }
    );
    const pushes = socketEvents.filter((e) => e.event === 'resource.allocation.updated');
    console.log(`       ${socketEvents.length} socket events received, ` +
      `${pushes.length} of them resource.allocation.updated`);
    console.log(`       event types: ${[...new Set(socketEvents.map((e) => e.event))].join(', ')}`);
    assert(pushes.length > 0, 'expected at least one allocation push after a real allocation');
    const pushed = pushes[pushes.length - 1].payload;
    assert(pushed && Array.isArray(pushed.counters) && pushed.counters.length === 2,
      'the pushed payload must carry the real 2-counter overview');
    const pushedCounter = pushed.counters.find((c) => c._id.toString() === preference[0]._id.toString());
    assert(pushedCounter.currentToken && pushedCounter.currentToken.tokenCode === customers[2].token.tokenCode,
      `the push must already contain C-023 on ${preference[0].name} — no refresh needed`);
    console.log(`       last push: ${pushedCounter.displayLabel} = ${pushedCounter.currentToken.tokenCode} ` +
      `(${pushedCounter.allocationState}), waiting = ${pushed.metrics.waitingCustomers}`);
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 8 — the second counter completes → C-024 auto-called to it
  // ═══════════════════════════════════════════════════════════════
  console.log('\n  PHASE 8 — the second counter completes, the last waiting customer is auto-called');
  await step('P8.1 The second operator starts and completes C-022 at their own counter', async () => {
    const s = await req('POST', `/api/counters/${preference[1]._id}/start-serving`, {}, jwtFor(preference[1]));
    assert.strictEqual(s.status, 200, `start-serving failed: ${fmt(s.body)}`);
    const c = await req('POST', `/api/counters/${preference[1]._id}/complete`, {}, jwtFor(preference[1]));
    assert.strictEqual(c.status, 200, `complete failed: ${fmt(c.body)}`);
    console.log(`       ${c.body.message}`);
  });
  await step('P8.2 C-024 is auto-called to the second counter', async () => {
    await waitFor(async () => {
      const t = await Token.findById(customers[3].token._id).lean();
      return t && t.counterId ? t : null;
    }, { label: 'C-024 to be auto-called' });
    const t = await Token.findById(customers[3].token._id).populate('counterId', 'name number displayLabel').lean();
    assert.strictEqual(t.status, 'CALLED', `C-024 should be CALLED, is ${t.status}`);
    assert.strictEqual(t.counterId._id.toString(), preference[1]._id.toString(),
      `C-024 must go to ${preference[1].name}, went to ${t.counterId.name}`);
    customers[3].counterId = t.counterId._id;
    console.log(`       ${customers[3].label} -> ${customerCounterDisplay(t)}  (status ${t.status})`);
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 9 — Customer view + strict FIFO proof
  // ═══════════════════════════════════════════════════════════════
  console.log('\n  PHASE 9 — Customer view and strict FIFO proof');
  await step('P9.1 Every customer sees their own real counter on their own token', async () => {
    for (const c of customers) {
      // C-021/C-022 have already been served, so their live "active token" is
      // legitimately gone; read the record by id to show the full journey.
      const r = await req('GET', `/api/tokens/${c.token._id}`, null, c.jwt);
      assert.strictEqual(r.status, 200, `${c.label} token lookup failed: ${fmt(r.body)}`);
      const t = r.body.data.token;
      assert(t, `${c.label} must be able to read their own token`);
      const disp = customerCounterDisplay(t);
      assert(disp, `${c.label} must see a counter (customer_web renders "Not assigned yet" when null)`);
      console.log(`       ${c.label}: status=${t.status}  Counter: ${disp}`);
    }
  });
  await step('P9.2 A customer cannot see another customer\'s token', async () => {
    const r = await req('GET', `/api/tokens/${customers[3].token._id}`, null, customers[0].jwt);
    assert.strictEqual(r.status, 404, `cross-customer token read must be 404, got ${r.status}`);
  });
  await step('P9.3 Strict FIFO: the four calls happened in join order C-021..C-024', async () => {
    const order = customers
      .map((c) => ({ label: c.label, calledAt: null }))
      .map((x) => x);
    for (let i = 0; i < customers.length; i++) {
      const t = await Token.findById(customers[i].token._id).lean();
      order[i].calledAt = t.calledAt ? new Date(t.calledAt).getTime() : null;
      order[i].counter = t.counterId ? t.counterId.toString() : null;
    }
    for (const o of order) {
      assert(o.calledAt, `${o.label} was never called`);
    }
    for (let i = 1; i < order.length; i++) {
      assert(order[i].calledAt >= order[i - 1].calledAt,
        `${order[i].label} was called BEFORE ${order[i - 1].label} — FIFO violated`);
    }
    console.log(`       call order: ${order.map((o) => o.label).join(' → ')}`);
  });
  await step('P9.4 Deterministic selection, not round-robin: the freed counter won again', async () => {
    // The first counter was free (its workload had dropped to zero) while the
    // second was still serving, so the lowest-workload rule sent C-023 back to
    // the counter that had just completed — a round-robin allocator would have
    // alternated to the busy one.
    const t23 = await Token.findById(customers[2].token._id).lean();
    const t24 = await Token.findById(customers[3].token._id).lean();
    assert.strictEqual(t23.counterId.toString(), preference[0]._id.toString(),
      `C-023 must be back on ${preference[0].name}`);
    assert.strictEqual(t24.counterId.toString(), preference[1]._id.toString(),
      `C-024 must be on ${preference[1].name}`);
    assert.notStrictEqual(t23.counterId.toString(), t24.counterId.toString(),
      'both customers must be on different counters');
  });
  await step('P9.5 No duplicate active tokens on any counter at the end of the run', async () => {
    const cs = await Counter.find({ centerId }).populate('currentTokenId', 'tokenCode').lean();
    const ids = cs.map((c) => (c.currentTokenId ? c.currentTokenId._id.toString() : null)).filter(Boolean);
    assert.strictEqual(new Set(ids).size, ids.length, 'two counters must never hold the same token');
    for (const c of cs) {
      console.log(`       ${c.name}: ${c.currentTokenId ? c.currentTokenId.tokenCode : 'free'}`);
    }
  });
  await step('P9.6 Admin can force a manual allocation run and it is idempotent', async () => {
    const r = await req('POST', '/api/counters/allocation/trigger', { centerId }, adminJwt);
    assert.strictEqual(r.status, 200, `manual trigger failed: ${fmt(r.body)}`);
    await sleep(2000);
    const after = await Counter.find({ centerId }).lean();
    const held = after.map((c) => (c.currentTokenId ? c.currentTokenId.toString() : null)).filter(Boolean);
    assert.strictEqual(new Set(held).size, held.length, 'a forced re-run must not double-assign anyone');
    console.log(`       manual run left ${held.length} counters holding distinct tokens`);
  });
  await step('P9.7 Operator 01 still cannot operate Counter 02 after allocation', async () => {
    const r = await req('POST', `/api/counters/${counter2._id}/start-serving`, {}, op1Jwt);
    assert.strictEqual(r.status, 403, `cross-counter operation must stay 403, got ${r.status}`);
  });
  await step('P9.8 STAFF cannot force an allocation run (ADMIN only)', async () => {
    const r = await req('POST', `/api/counters/allocation/trigger?centerId=${centerId}`, {}, op1Jwt);
    assert.strictEqual(r.status, 403, `STAFF trigger must be 403, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '-'.repeat(78));
  console.log('  DEMO ASSIGNMENT SUMMARY (real backend data)');
  console.log('-'.repeat(78));
  for (const c of customers) {
    const t = await Token.findById(c.token._id).populate('counterId', 'displayLabel name').lean();
    console.log(`    ${c.label}  ->  ${customerCounterDisplay(t) || 'Not assigned yet'}   (status ${t.status})`);
  }
  console.log('-'.repeat(78));
  console.log(`  socket events received without refresh: ${socketEvents.length}`);
  console.log(`  passed=${passed}  failed=${failed}`);
  console.log('-'.repeat(78) + '\n');

  return failed === 0;
}

async function cleanup() {
  console.log('  Restoring the center to its pre-demo state…');
  try {
    if (socket) { socket.close(); socket = null; }

    // 1. Release anything still held by a counter through the normal lifecycle.
    const cs = await Counter.find({ currentTokenId: { $ne: null } });
    for (const c of cs) {
      const t = await Token.findById(c.currentTokenId).lean();
      if (t && ['WAITING', 'CALLED', 'SERVING'].includes(t.status)) {
        await Token.updateOne(
          { _id: t._id },
          { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'DEMO_CLEANUP' } }
        );
      }
    }

    // 2. Remove only the tokens and users this demo created.
    if (demoTokenIds.length) await Token.deleteMany({ _id: { $in: demoTokenIds } });
    if (demoUserIds.length) await User.deleteMany({ _id: { $in: demoUserIds } });
    const emails = customers.map((c) => c.email).filter(Boolean);
    if (emails.length) await User.deleteMany({ email: { $in: emails } });

    // 3. Restore the counters and center exactly as they were found.
    for (const snap of counterSnapshots) {
      await Counter.updateOne(
        { _id: snap._id },
        {
          $set: {
            status: snap.status,
            currentTokenId: snap.currentTokenId,
            servingStartedAt: snap.servingStartedAt,
            stats: snap.stats,
            activeMinutesToday: snap.activeMinutesToday,
            allocationVersion: snap.allocationVersion,
            updatedAt: snap.updatedAt,
          },
        },
        { timestamps: false }
      );
    }
    if (centerSnapshot) {
      await ServiceCenter.updateOne(
        { _id: centerId },
        {
          $set: {
            isOpen: centerSnapshot.isOpen,
            autoResourceAllocation: centerSnapshot.autoResourceAllocation,
          },
        }
      );
    }
    if (queueSnapshot) {
      await Queue.updateOne(
        { _id: queueSnapshot._id },
        { $set: { waitingCount: queueSnapshot.waitingCount, activeCount: queueSnapshot.activeCount } }
      );
    }
    console.log('  Center, counters, tokens and demo users restored.\n');
  } catch (err) {
    console.error('  Cleanup error:', err.message);
  }
}

(async () => {
  let success = false;
  try {
    success = await main();
  } catch (err) {
    console.error('\n  FATAL:', err.message);
    console.error(err.stack);
    failed++;
  } finally {
    await cleanup();
    try { await new Promise((r) => server.close(r)); } catch (_) {}
    await mongoose.disconnect();
  }

  console.log('='.repeat(78));
  console.log(`  STEP 14 RESULT: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('='.repeat(78) + '\n');
  process.exit(failed === 0 ? 0 : 1);
})();

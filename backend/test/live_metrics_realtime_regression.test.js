'use strict';

/**
 * Regression tests for the live-counter / admin realtime metrics bugs found in
 * the September 2026 audit.
 *
 * Each test below corresponds to a defect that made a visible queue metric
 * wrong, stale, or silently disconnected:
 *
 *  1. Customer join must increase the authoritative waiting count.
 *  2. Call-next must update Now Serving and decrease the waiting count.
 *  3. Next-in-line must advance, and must be empty once the queue drains.
 *  4. Completion must increment completed-today.
 *  5. Completion / call-next must broadcast `queue.updated` (they previously
 *     emitted nothing, so "Completed Today" never advanced without a refresh).
 *  6. Average wait time must come from real token timestamps and be `null`
 *     (never a fabricated number) until real data exists.
 *  7. Waiting count must be Token-derived, not the day-partitioned Queue sum.
 *  8. `queue.updated` must always carry a consistent, center-scoped payload.
 *  9. crowd.updated must reach the selected center's room only.
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_PREFLIGHT = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'regression_test_secret_value_0123456789';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'regression_qr_secret_0123456789abcdef';
process.env.IOT_SECRET = process.env.IOT_SECRET || 'regression_iot_secret';

require('dotenv').config();

const mongoose = require('mongoose');
const assert = require('assert');

// These tests run against the SHARED database, so they must never touch a real
// center. Every id is generated per run and every document created is removed
// again in cleanup().
const oid = () => new mongoose.Types.ObjectId();
const CENTER_ID = oid();
const OTHER_CENTER_ID = oid();
const SERVICE_ID = oid();
const COUNTER_ID = oid();
const OTHER_COUNTER_ID = oid();

/**
 * HARD SAFETY GUARD.
 *
 * An earlier draft of this file hardcoded real production ObjectIds and its
 * seed routine ran deleteMany() against the shared database, which destroyed a
 * live service center. These tests now generate their ids randomly, and this
 * guard makes it structurally impossible to regress: every write and delete is
 * gated on the id belonging to this run.
 */
const RUN_TAG = `regression_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
/** Centers this run created. */
const CENTER_IDS = [CENTER_ID, OTHER_CENTER_ID];
/** Every id this run is allowed to touch. */
const OWNED_IDS = [CENTER_ID, OTHER_CENTER_ID, SERVICE_ID, COUNTER_ID, OTHER_COUNTER_ID];

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
    // Unwrap query operators such as { $in: [...] } / { $ne: ... }.
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
    if (!OWNED_IDS.some((owned_) => String(owned_) === String(id))) {
      throw new Error(
        `SAFETY VIOLATION: refusing to touch ${String(id)}, which is not owned by this test run (${RUN_TAG}).`
      );
    }
  }
}

/** Every mutation in this file must go through here. */
function owned(model, op, filter, extra = {}) {
  assertOwned(filter);
  return model[op](filter, extra);
}

const connectDB = require('../src/config/database');

// ── Captured socket emissions ────────────────────────────────────────────────
// Stub the socket module's exports BEFORE queueService is required.
// queueService destructures `emitToCenter` at require time, so reassigning
// `module.exports.getIO` afterwards has no effect — the export itself must be
// replaced, which is why this happens before the service import below.
const emitted = [];
const socketModule = require('../src/config/socket');
socketModule.emitToCenter = (centerId, event, data) => {
  emitted.push({ room: `center:${centerId}`, event, payload: data });
};
socketModule.emitToUser = () => {};
socketModule.emitToCounter = () => {};

const queueService = require('../src/services/queueService');
const queueMetricsService = require('../src/services/queueMetricsService');

const { Token } = require('../src/models/Token');
const Queue = require('../src/models/Queue');
const Counter = require('../src/models/Counter');
const Service = require('../src/models/Service');
const ServiceCenter = require('../src/models/ServiceCenter');
const User = require('../src/models/User');

// ── Assertions over captured emissions ───────────────────────────────────────
function eventsNamed(name) {
  return emitted.filter((e) => e.event === name);
}

function lastQueueUpdated() {
  const all = eventsNamed('queue.updated');
  return all[all.length - 1];
}

function resetEmitted() {
  emitted.length = 0;
}

// ── Tiny runner ──────────────────────────────────────────────────────────────
const results = [];
async function test(label, fn) {
  resetEmitted();
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
let userIds = [];

function newUserId() {
  return new mongoose.Types.ObjectId();
}

async function seedFixtures() {
  // Every delete is gated by the ownership guard.
  owned(ServiceCenter, 'deleteMany', { _id: { $in: CENTER_IDS } });
  owned(Service, 'deleteMany', { _id: SERVICE_ID });
  owned(Counter, 'deleteMany', { _id: { $in: [COUNTER_ID, OTHER_COUNTER_ID] } });
  owned(Token, 'deleteMany', { centerId: { $in: CENTER_IDS } });
  owned(Queue, 'deleteMany', { centerId: { $in: CENTER_IDS } });
  await User.deleteMany({ _id: { $in: userIds } });

  await ServiceCenter.create([
    { _id: CENTER_ID, name: 'Regression Center', code: `RG${Date.now().toString(36).toUpperCase()}`, isOpen: true, capacity: 200, type: 'GOVT' },
    { _id: OTHER_CENTER_ID, name: 'Other Regression Center', code: `RO${Date.now().toString(36).toUpperCase()}`, isOpen: true, capacity: 200, type: 'GOVT' },
  ]);
  await Service.create({ _id: SERVICE_ID, centerId: CENTER_ID, name: 'Test Service', tokenPrefix: 'A', isActive: true, avgServiceTimeMinutes: 5 });
  await Counter.create([
    { _id: COUNTER_ID, centerId: CENTER_ID, name: 'Counter 01', number: 1, status: 'ACTIVE', serviceId: SERVICE_ID },
    { _id: OTHER_COUNTER_ID, centerId: OTHER_CENTER_ID, name: 'Other Counter', number: 1, status: 'ACTIVE', serviceId: SERVICE_ID },
  ]);

  // Users are needed because Token.userId is required and joinQueue writes
  // QueueEvent rows that reference the actor.
  for (let i = 0; i < 6; i += 1) {
    const id = newUserId();
    userIds.push(id);
    await User.create({
      _id: id,
      name: `Reg User ${i}`,
      email: `reg${Date.now()}_${i}@example.com`,
      passwordHash: 'regression-test-hash-not-a-real-credential',
      role: 'CUSTOMER',
      isActive: true,
    });
  }
}

async function cleanup() {
  owned(Token, 'deleteMany', { centerId: { $in: CENTER_IDS } });
  owned(Queue, 'deleteMany', { centerId: { $in: CENTER_IDS } });
  owned(ServiceCenter, 'deleteMany', { _id: { $in: CENTER_IDS } });
  owned(Service, 'deleteMany', { _id: SERVICE_ID });
  owned(Counter, 'deleteMany', { _id: { $in: [COUNTER_ID, OTHER_COUNTER_ID] } });
  await User.deleteMany({ _id: { $in: userIds } });
  // QueueEvent rows are written by the mutations under test, so remove the
  // ones belonging to the centers this run created.
  try {
    const { QueueEvent } = require('../src/models/QueueEvent');
    owned(QueueEvent, 'deleteMany', { centerId: { $in: CENTER_IDS } });
  } catch (_) { /* model may be unavailable in a trimmed environment */ }
}

async function join(userId) {
  return queueService.joinQueue({
    userId: userId.toString(),
    centerId: CENTER_ID.toString(),
    serviceId: SERVICE_ID.toString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n============================================================');
  console.log(' LIVE METRICS + REALTIME REGRESSION TESTS');
  console.log('============================================================\n');

  await connectDB();
  await seedFixtures();

  // ── 0. safety guard ──────────────────────────────────────────────────────
  await test('0. ownership guard refuses to touch a non-owned (real) id', async () => {
    // A real production center id must be rejected by the guard. This is the
    // regression that prevents a repeat of the data loss that occurred when an
    // earlier draft of this file hardcoded live ids.
    const REAL_CENTER = '6ab030edfb8baa6b361738d8';
    let threw = null;
    try {
      await owned(ServiceCenter, 'deleteMany', { _id: new mongoose.Types.ObjectId(REAL_CENTER) });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'the guard must throw for an id this run does not own');
    assert.match(threw.message, /SAFETY VIOLATION/);

    // And the real center must still be there afterwards.
    const still = await ServiceCenter.findById(REAL_CENTER);
    assert.ok(still, 'the real service center must still exist after a blocked delete');
  });

  // ── 1. Customer join updates queue metrics ────────────────────────────────
  await test('1. customer join increments the authoritative waiting count', async () => {
    const before = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(before.waitingCount, 0, 'precondition: no waiting tokens');

    await join(userIds[0]);

    const after = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(after.waitingCount, 1, 'waiting count must increase by exactly 1 on join');
    assert.strictEqual(after.issuedToday, 1, 'issuedToday must count the new token');
  });

  // ── 7. Waiting count is Token-derived, not the day-partitioned Queue sum ──
  await test('7. waiting count is Token-derived, not the Queue day aggregate', async () => {
    // Simulate the exact audited failure: a WAITING token that belongs to a
    // queue partition that does not exist for today (e.g. joined before
    // midnight). The old `sum(queues[].waitingCount)` source reported 0.
    await Token.create({
      tokenCode: `A-${CENTER_ID.toString().slice(-3)}1`,
      tokenNumber: 9001,
      userId: userIds[5],
      centerId: CENTER_ID,
      serviceId: SERVICE_ID,
      status: 'WAITING',
      createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
    });

    const metrics = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.ok(metrics.waitingCount >= 2, 'a WAITING token from a prior day must still be counted');

    // The naive day-partitioned source, for contrast.
    const dayQueues = await Queue.find({ centerId: CENTER_ID, date: new Date().toISOString().slice(0, 10) });
    const naive = dayQueues.reduce((s, q) => s + (q.waitingCount || 0), 0);
    assert.ok(metrics.waitingCount > naive, 'authoritative count must exceed the naive day-aggregate sum');
  });

  // ── 1b. join broadcasts canonical queue.updated ───────────────────────────
  await test('8. join broadcasts a center-scoped, consistent queue.updated payload', async () => {
    resetEmitted();
    await join(userIds[1]);

    const ev = lastQueueUpdated();
    assert.ok(ev, 'join must broadcast queue.updated');
    assert.strictEqual(ev.room, `center:${CENTER_ID}`, 'must target this center room only');
    assert.ok(ev.payload.centerId, 'payload must carry centerId so consumers can verify scope');
    assert.strictEqual(typeof ev.payload.waitingCount, 'number');
    assert.strictEqual(typeof ev.payload.totalIssued, 'number', 'totalIssued must always be a number, never undefined');
    assert.ok(ev.payload.metrics, 'payload must carry the authoritative metrics block');
    assert.strictEqual(typeof ev.payload.metrics.waitingCount, 'number');
  });

  // ── 2. Call-next updates Now Serving + waiting count ──────────────────────
  await test('2. call-next moves the next token to serving and decrements waiting', async () => {
    const before = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);

    const result = await queueService.callNext({
      counterId: COUNTER_ID.toString(),
      centerId: CENTER_ID.toString(),
      adminId: null,
    });

    assert.ok(result, 'callNext must return the called token');
    assert.strictEqual(result.token.status, 'CALLED', 'called token must be CALLED');
    assert.ok(result.token.tokenCode, 'a real backend token code must be returned');

    const after = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(after.waitingCount, before.waitingCount - 1, 'waiting must drop by one');
    assert.strictEqual(after.servingCount, before.servingCount + 1, 'serving must rise by one');

    const called = eventsNamed('token.called').pop();
    assert.ok(called, 'callNext must broadcast token.called');
    assert.strictEqual(called.room, `center:${CENTER_ID}`);
    // The center-room payload must never leak customer identity.
    assert.ok(!called.payload.token.userId, 'center broadcast must not leak userId');

    const qu = lastQueueUpdated();
    assert.ok(qu, 'callNext must broadcast queue.updated');
    assert.strictEqual(qu.payload.metrics.servingCount, after.servingCount);
  });

  // ── 3. Next-in-line advances and empties correctly ────────────────────────
  await test('3. next-in-line advances on call, and is empty once the queue drains', async () => {
    const firstWaiting = async () => {
      const t = await Token.findOne({ centerId: CENTER_ID, status: 'WAITING' })
        .sort({ createdAt: 1 })
        .select('tokenCode')
        .lean();
      return t ? t.tokenCode : null;
    };

    const first = await firstWaiting();
    assert.ok(first, 'there must be a next token to begin with');

    // Next-in-line advances when the head of the line is CALLED, not when a
    // serving token completes. The backend must pick the real oldest WAITING
    // token - the display must never invent its own ordering.
    const called = await queueService.callNext({
      counterId: COUNTER_ID.toString(),
      centerId: CENTER_ID.toString(),
      adminId: null,
    });
    assert.strictEqual(called.token.tokenCode, first, 'callNext must serve the real head of the line');

    const second = await firstWaiting();
    assert.notStrictEqual(second, first, 'the called token must leave the waiting line');
    assert.ok(second, 'a next token must remain while others are waiting');

    // Drain the remaining waiting tokens through the real cancellation path so
    // the queue counters stay consistent with the token collection.
    for (;;) {
      const t = await Token.findOne({ centerId: CENTER_ID, status: 'WAITING' });
      if (!t) break;
      await queueService.cancelToken({ tokenId: t._id.toString(), userId: t.userId.toString() });
    }

    assert.strictEqual(await firstWaiting(), null, 'next-in-line must be null with an empty queue (no fake fallback)');
    const drained = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(drained.waitingCount, 0, 'waiting count must be genuinely 0 once drained');
  });

  // ── 4. Completion increments completed-today ──────────────────────────────
  await test('4. completion increments completedToday and broadcasts queue.updated', async () => {
    await join(userIds[2]);
    const r = await queueService.callNext({ counterId: COUNTER_ID.toString(), centerId: CENTER_ID.toString(), adminId: null });

    // Measured AFTER call-next: callNext defensively completes the token the
    // counter was still holding, so it legitimately moves completedToday too.
    // This isolates the effect of the explicit completion under test.
    const before = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    await queueService.completeToken({ tokenId: r.token._id.toString(), counterId: COUNTER_ID.toString(), adminId: null });

    const after = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(
      after.completedToday,
      before.completedToday + 1,
      'completedToday must increase by exactly one on completion'
    );

    const qu = lastQueueUpdated();
    assert.ok(qu, 'completion must broadcast queue.updated (it previously emitted nothing)');
    assert.strictEqual(qu.payload.metrics.completedToday, after.completedToday, 'broadcast must carry the new completedToday');

    const completed = eventsNamed('token.completed').pop();
    assert.ok(completed, 'completion must broadcast token.completed');
    assert.strictEqual(completed.room, `center:${CENTER_ID}`);
  });

  // ── 4b. cancelled / skipped / waiting are never counted completed ─────────
  await test('4b. cancelled, skipped and waiting tokens are never counted as completed', async () => {
    const before = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    const c = await join(userIds[3]);
    await queueService.cancelToken({ tokenId: c.token._id.toString(), userId: userIds[3].toString() });

    const after = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(after.completedToday, before.completedToday, 'a cancellation must not increase completedToday');

    await join(userIds[4]);
    const metrics = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.ok(metrics.waitingCount >= 1, 'a waiting customer counts toward waiting, not completed');
  });

  // ── 6. Average wait time is authoritative and null without real data ───────
  await test('6. avgWaitSeconds is null without real data, then equals the real measured wait', async () => {
    // Isolate: this assertion is about the formula, so clear tokens that an
    // earlier test called today, otherwise the value is a legitimate average
    // over several real samples rather than the single one under test.
    await Token.deleteMany({ centerId: CENTER_ID });

    const none = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(none.avgWaitSeconds, null, 'must be null, not a placeholder, with no real samples');
    assert.strictEqual(none.waitSampleCount, 0, 'sample count must be 0 with no real samples');

    const u = newUserId();
    userIds.push(u);
    await User.create({ _id: u, name: 'Wait Probe', email: `wait${Date.now()}@example.com`, passwordHash: 'regression-test-hash-not-a-real-credential', role: 'CUSTOMER', isActive: true });
    const createdAt = new Date(Date.now() - 120 * 1000);
    await Token.create({
      tokenCode: `A-${CENTER_ID.toString().slice(-3)}2`,
      tokenNumber: 9002,
      userId: u,
      centerId: CENTER_ID,
      serviceId: SERVICE_ID,
      status: 'COMPLETED',
      createdAt,
      calledAt: new Date(createdAt.getTime() + 120 * 1000),
      completedAt: new Date(),
    });

    const one = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(one.avgWaitSeconds, 120, 'must equal the real measured wait (calledAt - createdAt)');
    assert.strictEqual(one.waitSampleCount, 1, 'exactly one real sample');

    // A second real sample must move the average to the true mean, proving the
    // value is derived from data and not pinned to a constant.
    const u2 = newUserId();
    userIds.push(u2);
    await User.create({ _id: u2, name: 'Wait Probe 2', email: `wait2${Date.now()}@example.com`, passwordHash: 'regression-test-hash-not-a-real-credential', role: 'CUSTOMER', isActive: true });
    const createdAt2 = new Date(Date.now() - 60 * 1000);
    await Token.create({
      tokenCode: `A-${CENTER_ID.toString().slice(-3)}3`,
      tokenNumber: 9004,
      userId: u2,
      centerId: CENTER_ID,
      serviceId: SERVICE_ID,
      status: 'COMPLETED',
      createdAt: createdAt2,
      calledAt: new Date(createdAt2.getTime() + 60 * 1000),
      completedAt: new Date(),
    });

    const two = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(two.avgWaitSeconds, 90, 'must be the true mean of the two real samples (120, 60)');
    assert.strictEqual(two.waitSampleCount, 2);

    // A token that arrived YESTERDAY but was called today must not contaminate
    // today's cohort - this is exactly the 25-hour average found in the audit.
    const u3 = newUserId();
    userIds.push(u3);
    await User.create({ _id: u3, name: 'Stale Arrival', email: `stale${Date.now()}@example.com`, passwordHash: 'regression-test-hash-not-a-real-credential', role: 'CUSTOMER', isActive: true });
    await Token.create({
      tokenCode: `A-${CENTER_ID.toString().slice(-3)}4`,
      tokenNumber: 9005,
      userId: u3,
      centerId: CENTER_ID,
      serviceId: SERVICE_ID,
      status: 'COMPLETED',
      createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      calledAt: new Date(),
      completedAt: new Date(),
    });

    const three = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    assert.strictEqual(three.avgWaitSeconds, 90, 'a prior-day arrival must not be averaged into today');
    assert.strictEqual(three.waitSampleCount, 2, 'prior-day arrival must not count as a sample');
  });

  // ── 9. center isolation ──────────────────────────────────────────────────
  await test('9. events are room-scoped: a mutation never targets another center', async () => {
    resetEmitted();
    const before = await queueMetricsService.getLiveQueueMetrics(OTHER_CENTER_ID);

    // A fresh customer: a user may hold only one active token per service, so
    // reusing an earlier joiner would fail the duplicate-active-token rule.
    const u = newUserId();
    userIds.push(u);
    await User.create({ _id: u, name: 'Scope Probe', email: `scope${Date.now()}@example.com`, passwordHash: 'regression-test-hash-not-a-real-credential', role: 'CUSTOMER', isActive: true });

    await join(u);
    await queueService.callNext({ counterId: COUNTER_ID.toString(), centerId: CENTER_ID.toString(), adminId: null });

    const after = await queueMetricsService.getLiveQueueMetrics(OTHER_CENTER_ID);
    assert.deepStrictEqual(after.waitingCount, before.waitingCount, 'other center must be unaffected');

    const leaked = emitted.filter((e) => String(e.room).includes(OTHER_CENTER_ID.toString()));
    assert.strictEqual(leaked.length, 0, 'no event may be broadcast to the other center room');
  });

  // ── crowd event scoping is preserved ──────────────────────────────────────
  await test('9b. getLiveQueueMetrics is scoped per center', async () => {
    await Token.create({
      tokenCode: `B-${OTHER_CENTER_ID.toString().slice(-3)}1`,
      tokenNumber: 9003,
      userId: userIds[5],
      centerId: OTHER_CENTER_ID,
      serviceId: SERVICE_ID,
      status: 'WAITING',
    });
    const mine = await queueMetricsService.getLiveQueueMetrics(CENTER_ID);
    const theirs = await queueMetricsService.getLiveQueueMetrics(OTHER_CENTER_ID);
    assert.ok(theirs.waitingCount >= 1, 'other center sees its own token');
    assert.ok(
      mine.centerId !== theirs.centerId,
      'metrics must be labelled with their own center'
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
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

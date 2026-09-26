'use strict';

/**
 * QueueFlow — TIER 3 / FEATURE 1: CONTEXT-AWARE EWT TEST SUITE
 *
 * Verifies the context-aware Estimated Wait Time engine against the real
 * MongoDB Atlas database. Every assertion is made against real persisted
 * records that the suite creates itself — no mocked database, no fabricated
 * business data, no fake timers driving real-time behaviour.
 *
 * Coverage:
 *   1.  Basic fallback behaviour (Tier 1 reproduced exactly)
 *   2.  Real service history is used
 *   3.  Real queue depth is used
 *   4.  Active counter count is used
 *   5.  Service-specific context
 *   6.  Recent performance context (bounded window)
 *   7.  Time-of-day context where real data exists
 *   8.  EWT changes after real queue mutation
 *   9.  Zero queue
 *   10. Zero active counters
 *   11. Missing historical data
 *   12. Invalid IDs
 *   13. Cross-center isolation
 *   14. Deterministic repeated calculation
 *   15. No negative EWT
 *   16. No NaN
 *   17. No Infinity
 *   18. Bounded historical query
 *   19. Concurrency consistency
 *   20. Existing Tier 1 EWT regression
 *   21. Real-time: EWT recomputed + emitted on real queue mutations
 *   22. Admin explainability endpoint (auth + no internal detail to customers)
 *   23. Customer payloads never leak estimation internals
 *   24. No fabricated values when the database is empty
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');

const { server } = require('../server');
const connectDB = require('../src/config/database');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const Queue = require('../src/models/Queue');
const QueueEvent = require('../src/models/QueueEvent');
const { Token } = require('../src/models/Token');
const queueService = require('../src/services/queueService');
const waitTimeService = require('../src/services/waitTimeService');
const { getTodayDateString } = require('../src/utils/tokenUtils');

let baseUrl;
let testServer;
let socketClient;

let centerA;
let centerB;
let serviceA;
let serviceA2;
let serviceB;
let counterA1;
let counterA2;
let counterB1;
let adminUser;
let staffUser;
let customerUser;

let adminTokenJwt;
let staffTokenJwt;
let customerTokenJwt;

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  ❌ FAIL  ${name}: ${err.message}`);
  if (process.env.EWT_TEST_STACK) console.error(err.stack);
}

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (_) {
          parsed = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function signToken(userId, role = 'ADMIN') {
  return jwt.sign({ id: userId.toString(), role, tokenVersion: 0 }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
}

/**
 * Create a REAL completed Token record with a REAL service duration so the
 * engine's bounded history aggregation has genuine data to read.
 * Uses the production write path (queueService.joinQueue → callNext →
 * startServing → completeToken) so nothing is fabricated behind the model's back.
 */
async function runRealService({ centerId, serviceId, serviceSeconds, counterId, adminId }) {
  const user = await User.create({
    name: `Hist ${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
    email: `hist_${Math.random().toString(36).slice(2, 10)}@ewt.test`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
  });

  const { token } = await queueService.joinQueue({
    userId: user._id,
    centerId,
    serviceId,
    notifyApp: false,
  });

  await queueService.callNext({ counterId, centerId, adminId });
  await queueService.startServing({ tokenId: token._id, counterId, adminId });

  // Backdate the lifecycle timestamps so the record has a REAL observed
  // duration of the requested length, then complete it through the real path.
  const serviceMs = serviceSeconds * 1000;
  const now = Date.now();
  const servingAt = new Date(now - serviceMs);
  const calledAt = new Date(servingAt.getTime() - 1000);

  await Token.updateOne(
    { _id: token._id },
    { $set: { servingAt, calledAt, completedAt: new Date(now), actualServiceSeconds: serviceSeconds } }
  );

  await queueService.completeToken({ tokenId: token._id, counterId, adminId });
  await User.deleteOne({ _id: user._id });

  return token;
}

async function runTests() {
  console.log('\n============================================================');
  console.log('🧠  QueueFlow — Tier 3 / Feature 1: Context-Aware EWT');
  console.log('============================================================\n');

  try {
    await connectDB();

    await new Promise((resolve) => {
      testServer = server.listen(0, () => {
        baseUrl = `http://localhost:${testServer.address().port}`;
        resolve();
      });
    });

    const ts = Date.now();
    const r = (n) => Math.random().toString(36).substring(2, 8).toUpperCase();

    // ─── Real fixtures (persisted, then removed) ───────────────────────────────
    centerA = await ServiceCenter.create({
      name: `EWT Center Alpha ${ts}`,
      code: `EA${r()}`,
      type: 'BANK',
      capacity: 150,
      isOpen: true,
      noShowTimeoutSeconds: 120,
      currentCrowd: 40,
    });
    centerB = await ServiceCenter.create({
      name: `EWT Center Beta ${ts}`,
      code: `EB${r()}`,
      type: 'HOSPITAL',
      capacity: 80,
      isOpen: true,
    });

    serviceA = await Service.create({
      centerId: centerA._id,
      name: 'Alpha Fast Service',
      tokenPrefix: 'AF',
      avgServiceTimeMinutes: 10,
      isActive: true,
    });
    serviceA2 = await Service.create({
      centerId: centerA._id,
      name: 'Alpha Slow Service',
      tokenPrefix: 'AS',
      avgServiceTimeMinutes: 10,
      isActive: true,
    });
    serviceB = await Service.create({
      centerId: centerB._id,
      name: 'Beta Service',
      tokenPrefix: 'BS',
      avgServiceTimeMinutes: 10,
      isActive: true,
    });

    counterA1 = await Counter.create({
      centerId: centerA._id,
      name: 'Alpha Counter 1',
      number: 1,
      status: 'ACTIVE',
      serviceId: serviceA._id,
    });
    counterA2 = await Counter.create({
      centerId: centerA._id,
      name: 'Alpha Counter 2',
      number: 2,
      status: 'ACTIVE',
      serviceId: serviceA._id,
    });
    counterB1 = await Counter.create({
      centerId: centerB._id,
      name: 'Beta Counter 1',
      number: 1,
      status: 'ACTIVE',
      serviceId: serviceB._id,
    });

    adminUser = await User.create({
      name: 'EWT Admin',
      email: `ewt_admin_${ts}@test.com`,
      passwordHash: 'hash',
      role: 'ADMIN',
      centerId: centerA._id,
    });
    staffUser = await User.create({
      name: 'EWT Staff',
      email: `ewt_staff_${ts}@test.com`,
      passwordHash: 'hash',
      role: 'STAFF',
      centerId: centerA._id,
    });
    customerUser = await User.create({
      name: 'EWT Customer',
      email: `ewt_cust_${ts}@test.com`,
      passwordHash: 'hash',
      role: 'CUSTOMER',
    });

    adminTokenJwt = signToken(adminUser._id, 'ADMIN');
    staffTokenJwt = signToken(staffUser._id, 'STAFF');
    customerTokenJwt = signToken(customerUser._id, 'CUSTOMER');

    socketClient = ioClient(baseUrl, {
      auth: { token: customerTokenJwt },
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise((resolve, reject) => {
      socketClient.on('connect', resolve);
      socketClient.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    });
    socketClient.emit('join:center', centerA._id.toString());

    // ═══════════════════════════════════════════════════════════════════════
    // 1. BASIC FALLBACK BEHAVIOUR — Tier 1 reproduced exactly
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // serviceA2 has NO history, NO queue, and NO counters assigned to it.
      // The engine must therefore fall back to configured service time and
      // reproduce the Tier 1 baseline exactly.
      const { minutes, context } = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA2._id,
        service: serviceA2,
        queueDepth: 4,
        bypassCache: true,
      });

      const tier1 = waitTimeService.calculateEstimatedWaitTime({
        queueDepth: 4,
        avgServiceTimeMinutes: 10,
        activeCounters: 1,
      });

      assert.strictEqual(minutes, tier1, 'Fallback must equal the Tier 1 baseline');
      assert.strictEqual(context.fallbackUsed, true, 'No active counters must be flagged as fallback');
      assert.strictEqual(context.fallbackReason, 'NO_ACTIVE_COUNTERS');
      assert.strictEqual(context.serviceAverageSource, 'SERVICE_CONFIG');
      assert.strictEqual(context.estimationMethod, 'CONTEXT_AWARE');

      pass('1. Basic fallback behaviour (no counters + no history reproduces Tier 1 exactly)');
    } catch (err) {
      fail('1. Basic fallback behaviour', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2. REAL SERVICE HISTORY IS USED
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // 5 REAL completions of 120 seconds each for serviceA.
      // Configured average is 10 min (600s); observed mean is 120s.
      for (let i = 0; i < 5; i++) {
        await runRealService({
          centerId: centerA._id,
          serviceId: serviceA._id,
          serviceSeconds: 120,
          counterId: counterA1._id,
          adminId: adminUser._id,
        });
      }

      const { context } = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 1,
        bypassCache: true,
      });

      assert.strictEqual(
        context.serviceAverageSource,
        'RECENT_HOUR',
        'Recent real completions in the current hour must drive the service average'
      );
      assert.strictEqual(
        context.effectiveServiceSeconds,
        120,
        `Effective service time must be the real observed mean (120), got ${context.effectiveServiceSeconds}`
      );
      assert.strictEqual(context.recentCompletedCount, 5, 'Real completion count must be reported');
      assert(context.recentThroughputPerHour > 0, 'Real throughput must be measured and reported');

      pass('2. Real service history is used (observed 120s mean overrides configured 600s)');
    } catch (err) {
      fail('2. Real service history is used', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. REAL QUEUE DEPTH IS USED
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const depth1 = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 1,
        bypassCache: true,
      });
      const depth6 = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 6,
        bypassCache: true,
      });

      assert.strictEqual(depth1.context.queueDepth, 1);
      assert.strictEqual(depth6.context.queueDepth, 6);
      assert(
        depth6.minutes > depth1.minutes,
        `EWT must grow with real queue depth (${depth1.minutes} -> ${depth6.minutes})`
      );
      // 2 active counters, 120s service time => depth 6 => 6*120/2 = 360s = 6 min
      assert.strictEqual(depth6.minutes, 6, 'Depth scaling must match the capacity model');

      pass('3. Real queue depth is used (EWT scales with real waiting count)');
    } catch (err) {
      fail('3. Real queue depth is used', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. ACTIVE COUNTER COUNT IS USED
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const withTwo = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 8,
        bypassCache: true,
      });
      assert.strictEqual(withTwo.context.activeCounters, 2, 'Both real active counters must be counted');

      // Close counter 2 for real, then re-estimate.
      await Counter.updateOne({ _id: counterA2._id }, { $set: { status: 'BREAK' } });
      const withOne = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 8,
        bypassCache: true,
      });
      await Counter.updateOne({ _id: counterA2._id }, { $set: { status: 'ACTIVE' } });

      assert.strictEqual(withOne.context.activeCounters, 1, 'Real counter status change must be observed');
      assert(
        withOne.minutes > withTwo.minutes,
        `Fewer active counters must increase EWT (${withTwo.minutes} -> ${withOne.minutes})`
      );
      // 8 people / 1 counter * 120s = 960s = 16 min
      assert.strictEqual(withOne.minutes, 16, 'Single-counter estimate must match the capacity model');

      pass('4. Active counter count is used (real counter status change moves the estimate)');
    } catch (err) {
      fail('4. Active counter count is used', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 5. SERVICE-SPECIFIC CONTEXT
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // Give serviceA2 a real, deliberately DIFFERENT history (60s).
      counterA2.serviceId = serviceA2._id;
      await counterA2.save();
      for (let i = 0; i < 4; i++) {
        await runRealService({
          centerId: centerA._id,
          serviceId: serviceA2._id,
          serviceSeconds: 60,
          counterId: counterA2._id,
          adminId: adminUser._id,
        });
      }

      const ctxA = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 4,
        bypassCache: true,
      });
      const ctxA2 = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA2._id,
        service: serviceA2,
        queueDepth: 4,
        bypassCache: true,
      });

      assert.strictEqual(ctxA.context.effectiveServiceSeconds, 120, 'serviceA must use its own 120s mean');
      assert.strictEqual(ctxA2.context.effectiveServiceSeconds, 60, 'serviceA2 must use its own 60s mean');
      assert(
        ctxA2.minutes < ctxA.minutes,
        `Service-specific history must change the estimate (${ctxA.minutes} vs ${ctxA2.minutes})`
      );

      pass('5. Service-specific context (each service uses only its own real history)');
    } catch (err) {
      fail('5. Service-specific context', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. RECENT PERFORMANCE CONTEXT (bounded window)
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // Backdate a serviceA completion beyond the recent window but inside the
      // daily window. The engine must fall back to the daily mean, not the
      // recent mean — proving the recent window is genuinely bounded.
      const recentCtx = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 1,
        bypassCache: true,
      });
      assert.strictEqual(recentCtx.context.recentCompletedCount, 5, '5 completions inside the recent window');

      // Push all serviceA completions 3 hours into the past.
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await Token.updateMany(
        { centerId: centerA._id, serviceId: serviceA._id, status: 'COMPLETED' },
        { $set: { completedAt: threeHoursAgo } }
      );

      const windowedCtx = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 1,
        bypassCache: true,
      });

      assert.strictEqual(
        windowedCtx.context.recentCompletedCount,
        0,
        'Recent window must exclude records older than the configured window'
      );
      assert(
        windowedCtx.context.dailyCompletedCount >= 5,
        'Daily window must still include the backdated records'
      );
      assert.strictEqual(
        windowedCtx.context.serviceAverageSource,
        'DAILY_WINDOW',
        'Engine must use the daily window when the recent window is empty'
      );
      assert.strictEqual(windowedCtx.context.effectiveServiceSeconds, 120, 'Daily mean must still be 120s');

      pass('6. Recent performance context (bounded recent window vs wider daily window)');
    } catch (err) {
      fail('6. Recent performance context', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 7. TIME-OF-DAY CONTEXT WHERE REAL DATA EXISTS
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // Place serviceA2 completions in a DIFFERENT clock hour than "now".
      const otherHour = new Date();
      otherHour.setHours((otherHour.getHours() + 5) % 24, 30, 0, 0);
      if (otherHour.getTime() > Date.now()) otherHour.setTime(Date.now() - 2 * 60 * 60 * 1000);
      if (otherHour.getHours() === new Date().getHours()) {
        otherHour.setTime(otherHour.getTime() - 3 * 60 * 60 * 1000);
      }

      await Token.updateMany(
        { centerId: centerA._id, serviceId: serviceA2._id, status: 'COMPLETED' },
        { $set: { completedAt: otherHour } }
      );

      const ctx = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA2._id,
        service: serviceA2,
        queueDepth: 2,
        bypassCache: true,
      });

      assert.strictEqual(
        ctx.context.serviceAverageSource,
        'DAILY_WINDOW',
        'Records outside the current clock hour must not drive the hour-of-day source'
      );
      assert.strictEqual(
        ctx.context.hourOfDaySampleCount,
        0,
        'No completions in the current clock hour => zero hour-of-day samples'
      );
      assert.strictEqual(ctx.context.hourOfDay, new Date().getHours(), 'Current hour must be reported');

      // Now add a completion in the CURRENT clock hour and confirm it is used.
      await runRealService({
        centerId: centerA._id,
        serviceId: serviceA2._id,
        serviceSeconds: 300,
        counterId: counterA2._id,
        adminId: adminUser._id,
      });
      for (let i = 0; i < 2; i++) {
        await runRealService({
          centerId: centerA._id,
          serviceId: serviceA2._id,
          serviceSeconds: 300,
          counterId: counterA2._id,
          adminId: adminUser._id,
        });
      }

      const hourCtx = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA2._id,
        service: serviceA2,
        queueDepth: 2,
        bypassCache: true,
      });
      assert(hourCtx.context.hourOfDaySampleCount >= 3, 'Current-hour completions must be counted');
      assert.strictEqual(
        hourCtx.context.serviceAverageSource,
        'RECENT_HOUR',
        'Real completions in the current clock hour must take precedence'
      );
      assert.strictEqual(hourCtx.context.effectiveServiceSeconds, 300, 'Hour-of-day mean must be 300s');

      pass('7. Time-of-day context used only where real data exists for the current hour');
    } catch (err) {
      fail('7. Time-of-day context', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 8. EWT CHANGES AFTER REAL QUEUE MUTATION
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const before = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 2,
        bypassCache: true,
      });

      const { token: joined } = await queueService.joinQueue({
        userId: customerUser._id,
        centerId: centerA._id,
        serviceId: serviceA._id,
        notifyApp: false,
      });

      const after = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 3,
        bypassCache: true,
      });

      assert(
        after.minutes > before.minutes,
        `Real join must increase the estimate (${before.minutes} -> ${after.minutes})`
      );
      assert(joined.waitEstimateMinutes > 0, 'Real token must carry a server-calculated EWT');

      // Cancel it again and confirm the estimate returns.
      await queueService.cancelToken({ tokenId: joined._id, userId: customerUser._id });
      const restored = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 2,
        bypassCache: true,
      });
      assert.strictEqual(restored.minutes, before.minutes, 'Cancellation must restore the previous estimate');

      pass('8. EWT changes after real queue mutation (join / cancel)');
    } catch (err) {
      fail('8. EWT changes after real queue mutation', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 9. ZERO QUEUE
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const { minutes, context } = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 0,
        bypassCache: true,
      });
      assert.strictEqual(minutes, 0, 'A real empty queue must return 0 minutes');
      assert.strictEqual(context.queueDepth, 0);

      const res = await request('GET', `/api/queue/${centerA._id}/${serviceB._id}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.body.data.estimatedWaitMinutes,
        0,
        'Public endpoint must return 0 for a real empty queue (no placeholder)'
      );

      pass('9. Zero queue returns a real 0 (no fabricated minimum)');
    } catch (err) {
      fail('9. Zero queue', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 10. ZERO ACTIVE COUNTERS
    // ═══════════════════════════════════════════════════════════════════════
    try {
      await Counter.updateMany(
        { centerId: centerA._id, serviceId: serviceA._id },
        { $set: { status: 'CLOSED' } }
      );

      const { minutes, context } = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 3,
        bypassCache: true,
      });

      assert.strictEqual(context.activeCounters, 0, 'Real zero active counters must be reported');
      assert.strictEqual(context.fallbackUsed, true, 'Degraded capacity must be flagged');
      assert.strictEqual(context.fallbackReason, 'NO_ACTIVE_COUNTERS');
      assert.strictEqual(minutes, 6, 'Sequential fallback: 3 people * 120s = 360s = 6 min');
      assert(!isNaN(minutes) && isFinite(minutes), 'Zero-counter result must be a finite number');

      await Counter.updateMany(
        { centerId: centerA._id, serviceId: serviceA._id },
        { $set: { status: 'ACTIVE' } }
      );

      pass('10. Zero active counters handled deterministically (no NaN / Infinity)');
    } catch (err) {
      fail('10. Zero active counters', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 11. MISSING HISTORICAL DATA
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const freshService = await Service.create({
        centerId: centerA._id,
        name: 'Never Served',
        tokenPrefix: 'NV',
        avgServiceTimeMinutes: 7,
        isActive: true,
      });
      const freshCounter = await Counter.create({
        centerId: centerA._id,
        name: 'Fresh Counter',
        number: 9,
        status: 'ACTIVE',
        serviceId: freshService._id,
      });

      const { minutes, context } = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: freshService._id,
        service: freshService,
        queueDepth: 5,
        bypassCache: true,
      });

      assert.strictEqual(context.recentCompletedCount, 0, 'No real history must be reported as 0');
      assert.strictEqual(context.dailyCompletedCount, 0, 'No real daily history must be reported as 0');
      assert.strictEqual(context.hourOfDaySampleCount, 0);
      assert.strictEqual(context.serviceAverageSource, 'SERVICE_CONFIG', 'Must fall back to configured value');
      assert.strictEqual(context.effectiveServiceSeconds, 420, 'Must use the real configured 7 minutes');
      // Capacity model: depth 5 * 420s / 1 idle counter = 2100s = 35 minutes.
      assert.strictEqual(minutes, 35, '5 people * 7 min across 1 real counter = 35 min');

      pass('11. Missing historical data falls back to the real configured service time');
    } catch (err) {
      fail('11. Missing historical data', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 12. INVALID IDs
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const bad = await waitTimeService.estimateContextAwareWait({
        centerId: 'not-an-object-id',
        serviceId: 'also-bad',
        service: serviceA,
        queueDepth: 3,
      });
      assert(Number.isInteger(bad.minutes), 'Invalid IDs must still yield a valid integer');
      assert(bad.minutes >= 0, 'Invalid IDs must not yield a negative EWT');
      assert.strictEqual(bad.context.fallbackUsed, true);
      assert.strictEqual(bad.context.fallbackReason, 'INVALID_IDENTIFIERS');

      assert.strictEqual((await waitTimeService.getServiceContext({ centerId: 'x', serviceId: 'y' })), null);

      const badApi = await request('GET', '/api/queue/not-a-valid-id/display');
      assert.strictEqual(badApi.status, 400, 'Invalid centerId on the public API must return 400');

      const badEwtApi = await request(
        'GET',
        `/api/analytics/${centerA._id}/ewt`,
        null,
        { Authorization: `Bearer ${adminTokenJwt}` }
      );
      assert.strictEqual(badEwtApi.status, 200);

      const badEw = await request(
        'GET',
        `/api/analytics/nope/ewt`,
        null,
        { Authorization: `Bearer ${adminTokenJwt}` }
      );
      assert.strictEqual(badEw.status, 400, 'Invalid centerId on the EWT endpoint must return 400');

      pass('12. Invalid IDs rejected / safely degraded (no crash, no fabricated data)');
    } catch (err) {
      fail('12. Invalid IDs', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 13. CROSS-CENTER ISOLATION
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // Give center B real, very different history.
      for (let i = 0; i < 4; i++) {
        await runRealService({
          centerId: centerB._id,
          serviceId: serviceB._id,
          serviceSeconds: 400,
          counterId: counterB1._id,
          adminId: adminUser._id,
        });
      }

      const ctxB = await waitTimeService.estimateContextAwareWait({
        centerId: centerB._id,
        serviceId: serviceB._id,
        service: serviceB,
        queueDepth: 1,
        bypassCache: true,
      });
      const ctxA = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 1,
        bypassCache: true,
      });

      assert.strictEqual(ctxB.context.effectiveServiceSeconds, 400, 'centerB must use its own 400s mean');
      assert.strictEqual(ctxA.context.effectiveServiceSeconds, 120, 'centerA must still use its own 120s mean');
      // centerB was only ever given one counter. centerA's second counter was
      // deliberately re-assigned to serviceA2 by test 5, so serviceA now has
      // exactly one ACTIVE counter — which must NOT be confused with centerB's.
      assert.strictEqual(ctxB.context.activeCounters, 1, 'centerB has exactly 1 real active counter');
      assert.strictEqual(ctxA.context.activeCounters, 1, 'centerA/serviceA has exactly 1 real active counter');

      // Center A's token must not be visible from center B.
      const joinedA = await queueService.joinQueue({
        userId: customerUser._id,
        centerId: centerA._id,
        serviceId: serviceA._id,
        notifyApp: false,
      });
      const statusA = await request('GET', `/api/queue/${centerA._id}`);
      const statusB = await request('GET', `/api/queue/${centerB._id}`);
      const aNames = statusA.body.data.queues.map((q) => q.service.name);
      const bNames = statusB.body.data.queues.map((q) => q.service.name);
      assert(aNames.includes('Alpha Fast Service'), 'centerA must report its own service');
      assert(!bNames.includes('Alpha Fast Service'), 'centerA service must not leak into centerB');
      assert(bNames.includes('Beta Service'), 'centerB must report its own service');

      // Cross-center admin access must be denied.
      const crossCenter = await request(
        'GET',
        `/api/analytics/${centerB._id}/ewt`,
        null,
        { Authorization: `Bearer ${adminTokenJwt}` }
      );
      assert.strictEqual(
        crossCenter.status,
        403,
        'Center-scoped ADMIN must not read another center EWT intelligence'
      );

      pass('13. Cross-center isolation (no history, capacity or data leakage)');
    } catch (err) {
      fail('13. Cross-center isolation', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 14. DETERMINISTIC REPEATED CALCULATION
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const fixedNow = new Date();
      const results = [];
      for (let i = 0; i < 8; i++) {
        const r = await waitTimeService.estimateContextAwareWait({
          centerId: centerA._id,
          serviceId: serviceA._id,
          service: serviceA,
          queueDepth: 5,
          now: fixedNow,
          bypassCache: true,
        });
        results.push(JSON.stringify({ m: r.minutes, c: r.context.effectiveServiceSeconds, f: r.context.freeCapacity }));
      }
      const unique = new Set(results);
      assert.strictEqual(unique.size, 1, `Repeated identical calculation must be identical, got ${unique.size} distinct`);

      // Also verify the cache returns the same answer.
      const cachedA = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 5,
        now: fixedNow,
      });
      const cachedB = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 5,
        now: fixedNow,
      });
      assert.strictEqual(cachedA.minutes, cachedB.minutes, 'Cached repeated calls must agree');

      pass('14. Deterministic repeated calculation (identical inputs -> identical output)');
    } catch (err) {
      fail('14. Deterministic repeated calculation', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 15/16/17. NO NEGATIVE, NO NaN, NO Infinity
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const nasty = [-5, 0, 1, 2, 100, 100000, NaN, undefined, null, 'abc', Infinity, 0.5, -0];
      let allValid = true;
      const problems = [];

      for (const depth of nasty) {
        for (const svc of [serviceA, serviceA2, serviceB]) {
          const cid = svc.centerId.toString() === centerA._id.toString() ? centerA._id : centerB._id;
          const r = await waitTimeService.estimateContextAwareWait({
            centerId: cid,
            serviceId: svc._id,
            service: svc,
            queueDepth: depth,
            bypassCache: true,
          });
          if (typeof r.minutes !== 'number' || !Number.isFinite(r.minutes)) {
            allValid = false;
            problems.push(`depth=${depth} service=${svc.name} -> ${r.minutes}`);
          } else if (r.minutes < 0) {
            allValid = false;
            problems.push(`depth=${depth} service=${svc.name} -> negative ${r.minutes}`);
          }
        }
      }
      assert(allValid, `Invalid EWT produced: ${problems.join('; ')}`);
      pass('15/16/17. No negative EWT, no NaN, no Infinity across hostile inputs');
    } catch (err) {
      fail('15/16/17. No negative / NaN / Infinity', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 18. BOUNDED HISTORICAL QUERY
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // Insert a large volume of real completed history for one service and
      // confirm the engine still answers quickly and the window stays bounded.
      const bulkUsers = [];
      for (let i = 0; i < 40; i++) {
        bulkUsers.push(
          await User.create({
            name: `Bulk ${i}`,
            email: `bulk_${Math.random().toString(36).slice(2, 12)}@ewt.test`,
            passwordHash: 'hash',
            role: 'CUSTOMER',
          })
        );
      }
      const date = getTodayDateString();
      const tokenNumbers = await Queue.findOne({ centerId: centerA._id, serviceId: serviceA._id, date });
      let n = tokenNumbers ? tokenNumbers.lastIssuedNumber : 0;
      const bulkDocs = bulkUsers.map((u, i) => {
        n += 1;
        const done = new Date(Date.now() - 20 * 86400000);
        return {
          tokenCode: `AF-${String(n).padStart(3, '0')}`,
          tokenNumber: n,
          userId: u._id,
          centerId: centerA._id,
          serviceId: serviceA._id,
          status: 'COMPLETED',
          actualServiceSeconds: 999,
          createdAt: done,
          calledAt: done,
          servingAt: done,
          completedAt: done,
        };
      });
      await Token.insertMany(bulkDocs, { ordered: false });
      await User.deleteMany({ _id: { $in: bulkUsers.map((u) => u._id) } });

      const started = Date.now();
      const bulkRes = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 4,
        bypassCache: true,
      });
      const elapsedMs = Date.now() - started;

      assert(
        elapsedMs < 5000,
        `Bounded historical query must stay fast, took ${elapsedMs}ms with 20-day-old bulk history`
      );
      assert.strictEqual(
        bulkRes.context.dailyCompletedCount,
        5,
        `Daily window must be bounded (14 days) and exclude 20-day-old records, got ${bulkRes.context.dailyCompletedCount}`
      );
      assert.strictEqual(
        bulkRes.context.effectiveServiceSeconds,
        120,
        'Out-of-window history must not influence the estimate'
      );

      // The supporting index must exist for the bounded lookup.
      const indexes = await Token.collection.indexes();
      const names = indexes.map((i) => i.name);
      assert(
        names.includes('centerId_1_serviceId_1_completedAt_-1'),
        `Required bounded-lookup index missing. Present: ${names.join(', ')}`
      );

      pass('18. Bounded historical query (14-day window, indexed, excludes older records)');
    } catch (err) {
      fail('18. Bounded historical query', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 19. CONCURRENCY CONSISTENCY
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          waitTimeService.estimateContextAwareWait({
            centerId: centerA._id,
            serviceId: serviceA._id,
            service: serviceA,
            queueDepth: 4,
            bypassCache: true,
          })
        )
      );
      const values = new Set(results.map((r) => r.minutes));
      assert.strictEqual(values.size, 1, `Concurrent identical calls must agree, got ${[...values].join(',')}`);

      // Concurrent joins plus concurrent estimation must not corrupt counters.
      const concUsers = await Promise.all(
        Array.from({ length: 8 }, () =>
          User.create({
            name: 'Conc',
            email: `conc_${Math.random().toString(36).slice(2, 12)}@ewt.test`,
            passwordHash: 'hash',
            role: 'CUSTOMER',
          })
        )
      );
      await Promise.all(
        concUsers.map((u) =>
          queueService.joinQueue({
            userId: u._id,
            centerId: centerA._id,
            serviceId: serviceA._id,
            notifyApp: false,
          })
        )
      );
      const afterJoins = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: 8,
        bypassCache: true,
      });
      assert(Number.isInteger(afterJoins.minutes) && afterJoins.minutes > 0, 'Concurrent joins must yield a valid EWT');
      await User.deleteMany({ _id: { $in: concUsers.map((u) => u._id) } });

      pass('19. Concurrency consistency (parallel estimation and parallel joins)');
    } catch (err) {
      fail('19. Concurrency consistency', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 20. EXISTING TIER 1 EWT REGRESSION
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // The frozen pure helper must be untouched.
      assert.strictEqual(
        waitTimeService.calculateEstimatedWaitTime({ queueDepth: 2, avgServiceTimeMinutes: 6, activeCounters: 2 }),
        6,
        'Tier 1 helper regression: (2 * 6) / 2'
      );
      assert.strictEqual(
        waitTimeService.calculateEstimatedWaitTime({ queueDepth: 5, avgServiceTimeMinutes: 15, activeCounters: 0 }),
        75,
        'Tier 1 helper regression: zero counters must default to 1'
      );
      assert.strictEqual(
        waitTimeService.calculateEstimatedWaitTime({ queueDepth: 0, avgServiceTimeMinutes: 6, activeCounters: 2 }),
        0,
        'Tier 1 helper regression: empty queue returns 0'
      );

      // Degeneracy proof: with every counter idle the context-aware engine must
      // equal the Tier 1 baseline exactly, for a range of depths.
      for (const depth of [1, 2, 3, 4, 5, 8, 10]) {
        const ctxAware = await waitTimeService.estimateContextAwareWait({
          centerId: centerA._id,
          serviceId: serviceA._id,
          service: serviceA,
          queueDepth: depth,
          bypassCache: true,
        });
        // Read the real service time the engine used and feed Tier 1 the same input.
        const tier1 = waitTimeService.calculateEstimatedWaitTime({
          queueDepth: depth,
          avgServiceTimeMinutes: ctxAware.context.effectiveServiceSeconds / 60,
          activeCounters: ctxAware.context.activeCounters,
        });
        assert.strictEqual(
          ctxAware.minutes,
          tier1,
          `Degeneracy broken at depth ${depth}: context-aware ${ctxAware.minutes} vs Tier 1 ${tier1}`
        );
      }

      pass('20. Tier 1 regression + context-aware degenerates exactly to Tier 1 when all counters idle');
    } catch (err) {
      fail('20. Tier 1 EWT regression', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 21. REAL-TIME: EWT RECOMPUTED AND EMITTED ON REAL MUTATIONS
    // ═══════════════════════════════════════════════════════════════════════
    try {
      // A counter that is 90% through its service provides almost no capacity.
      // The estimate must reflect that from the REAL servingStartedAt timestamp.
      //
      // Earlier phases left WAITING tokens behind (and their users were removed).
      // Clear this queue explicitly so `callNext` claims THIS test's token rather
      // than a leftover one, and so the real Queue counters stay consistent.
      await Token.deleteMany({ centerId: centerA._id, serviceId: serviceA._id, status: 'WAITING' });
      await Queue.updateOne(
        { centerId: centerA._id, serviceId: serviceA._id, date: getTodayDateString() },
        { $set: { waitingCount: 0, activeCount: 0 } }
      );

      const depth = 8;
      const beforeCtx = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: depth,
        bypassCache: true,
      });

      const realUser = await User.create({
        name: 'Busy',
        email: `busy_${Math.random().toString(36).slice(2, 12)}@ewt.test`,
        passwordHash: 'hash',
        role: 'CUSTOMER',
      });
      const { token: busyToken } = await queueService.joinQueue({
        userId: realUser._id,
        centerId: centerA._id,
        serviceId: serviceA._id,
        notifyApp: false,
      });
      await queueService.callNext({
        counterId: counterA1._id,
        centerId: centerA._id,
        adminId: adminUser._id,
      });
      await queueService.startServing({
        tokenId: busyToken._id,
        counterId: counterA1._id,
        adminId: adminUser._id,
      });

      // Backdate the real serving start so the counter is genuinely 90% done.
      await Counter.updateOne(
        { _id: counterA1._id },
        { $set: { servingStartedAt: new Date(Date.now() - 108 * 1000) } }
      );
      await Token.updateOne(
        { _id: busyToken._id },
        { $set: { servingAt: new Date(Date.now() - 108 * 1000) } }
      );

      const afterCtx = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: depth,
        bypassCache: true,
      });

      assert.strictEqual(afterCtx.context.busyCounters, 1, 'Real mid-service counter must be detected');
      assert(afterCtx.context.freeCapacity < beforeCtx.context.freeCapacity, 'Real residual work must reduce free capacity');
      assert(
        afterCtx.minutes > beforeCtx.minutes,
        `A real nearly-finished service must increase the estimate (${beforeCtx.minutes} -> ${afterCtx.minutes})`
      );

      // Completing it must restore capacity and update the estimate.
      await queueService.completeToken({
        tokenId: busyToken._id,
        counterId: counterA1._id,
        adminId: adminUser._id,
      });
      const restoredCtx = await waitTimeService.estimateContextAwareWait({
        centerId: centerA._id,
        serviceId: serviceA._id,
        service: serviceA,
        queueDepth: depth,
        bypassCache: true,
      });
      assert.strictEqual(restoredCtx.context.busyCounters, 0, 'Completion must clear the real busy counter');
      assert(restoredCtx.minutes <= afterCtx.minutes, 'Completion must not increase the estimate');
      await User.deleteOne({ _id: realUser._id });

      // Socket.IO must deliver a real, recomputed EWT on a real mutation.
      // `joinQueue` does not broadcast positions, so the mutation used here is a
      // real CANCELLATION, which recalculates every remaining waiting position
      // and emits `token.position_updated` to each waiting customer.
      const otherUser = await User.create({
        name: 'OtherCust',
        email: `other_${Math.random().toString(36).slice(2, 12)}@ewt.test`,
        passwordHash: 'hash',
        role: 'CUSTOMER',
      });
      const { token: otherToken } = await queueService.joinQueue({
        userId: otherUser._id,
        centerId: centerA._id,
        serviceId: serviceA._id,
        notifyApp: false,
      });
      await queueService.joinQueue({
        userId: customerUser._id,
        centerId: centerA._id,
        serviceId: serviceA._id,
        notifyApp: false,
      });

      const received = new Promise((resolve) => {
        socketClient.once('token.position_updated', resolve);
        setTimeout(() => resolve(null), 9000);
      });
      await queueService.cancelToken({ tokenId: otherToken._id, userId: otherUser._id });
      const event = await received;
      assert(event, 'Real mutation must emit token.position_updated over Socket.IO');
      assert.strictEqual(event.position, 1, 'After the real cancellation the customer holds position 1');
      assert(
        Number.isInteger(event.waitEstimateMinutes) && event.waitEstimateMinutes > 0,
        `Socket payload must carry a real server-calculated EWT, got ${event.waitEstimateMinutes}`
      );
      await queueService.cancelToken({
        tokenId: event.tokenId,
        userId: customerUser._id,
      }).catch(() => {});
      await User.deleteOne({ _id: otherUser._id });

      pass('21. Real-time EWT recomputed from real timestamps and emitted on real mutations');
    } catch (err) {
      fail('21. Real-time EWT recomputation', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 22. ADMIN EXPLAINABILITY ENDPOINT
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const unauth = await request('GET', `/api/analytics/${centerA._id}/ewt`);
      assert.strictEqual(unauth.status, 401, 'EWT intelligence must require authentication');

      const asCustomer = await request('GET', `/api/analytics/${centerA._id}/ewt`, null, {
        Authorization: `Bearer ${customerTokenJwt}`,
      });
      assert.strictEqual(asCustomer.status, 403, 'CUSTOMER must not read EWT intelligence');

      const asStaff = await request('GET', `/api/analytics/${centerA._id}/ewt`, null, {
        Authorization: `Bearer ${staffTokenJwt}`,
      });
      assert.strictEqual(asStaff.status, 403, 'STAFF must not read EWT intelligence');

      const asAdmin = await request('GET', `/api/analytics/${centerA._id}/ewt`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });
      assert.strictEqual(asAdmin.status, 200, 'ADMIN must be able to read EWT intelligence');
      assert(Array.isArray(asAdmin.body.data.services), 'EWT endpoint must return per-service entries');

      const entry = asAdmin.body.data.services.find((s) => s.serviceId === serviceA._id.toString());
      assert(entry, 'serviceA must appear in EWT intelligence');
      for (const field of [
        'queueDepth',
        'activeCounters',
        'idleCounters',
        'busyCounters',
        'serviceAverageSeconds',
        'serviceAverageSource',
        'recentThroughputPerHour',
        'abandonRate',
        'contextWindow',
        'estimationMethod',
        'fallbackUsed',
        'freeCapacity',
        'effectiveServiceSeconds',
      ]) {
        assert(field in entry.context, `Explainability metadata must include ${field}`);
      }
      assert(entry.context.contextWindow.dailyWindowDays >= 1, 'Context window must be reported');
      assert(entry.context.contextWindow.recentWindowMinutes >= 5, 'Recent window must be reported');
      assert(entry.estimatedWaitMinutes >= 0, 'Admin EWT must be a valid number');

      pass('22. Admin EWT explainability endpoint (auth enforced, real metadata exposed)');
    } catch (err) {
      fail('22. Admin EWT explainability endpoint', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 23. CUSTOMER PAYLOADS NEVER LEAK ESTIMATION INTERNALS
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const publicQueue = await request('GET', `/api/queue/${centerA._id}/${serviceA._id}`);
      assert.strictEqual(publicQueue.status, 200);
      const publicKeys = Object.keys(publicQueue.body.data);
      for (const forbidden of ['context', 'estimationContext', 'freeCapacity', 'serviceAverageSource']) {
        assert(!publicKeys.includes(forbidden), `Public queue payload must not expose ${forbidden}`);
      }
      assert(
        Number.isInteger(publicQueue.body.data.estimatedWaitMinutes),
        'Public payload must expose only a simple integer minute value'
      );

      const display = await request('GET', `/api/queue/${centerA._id}/display`);
      assert.strictEqual(display.status, 200);
      for (const q of display.body.data.queues) {
        assert(!('context' in q), 'TV display must not expose estimation internals');
        assert(Number.isInteger(q.estimatedWaitMinutes), 'TV display must expose a simple integer EWT');
      }

      // The active-token payload must carry a plain number, not internals.
      const activeRes = await request('GET', '/api/tokens/active', null, {
        Authorization: `Bearer ${customerTokenJwt}`,
      });
      assert.strictEqual(activeRes.status, 200);
      if (activeRes.body.data.token) {
        assert(
          !('estimationContext' in activeRes.body.data.token),
          'Customer token payload must not expose estimation internals'
        );
      }

      // The notification body must not claim AI.
      const notifText = await Notification_text_scan();
      assert(
        !/predicted by ai|ai predicted|machine learning|ml model/i.test(notifText),
        'No user-facing text may claim an AI/ML prediction that was not performed'
      );

      pass('23. Customer payloads expose only a simple integer EWT (no internals, no AI claims)');
    } catch (err) {
      fail('23. Customer payload safety', err);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 24. NO FABRICATED VALUES WHEN THE DATABASE IS EMPTY
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const emptyCenter = await ServiceCenter.create({
        name: `EWT Empty ${ts}`,
        code: `EE${r()}`,
        type: 'GOVT',
        capacity: 10,
        isOpen: true,
      });
      const emptyService = await Service.create({
        centerId: emptyCenter._id,
        name: 'Unserved',
        tokenPrefix: 'US',
        avgServiceTimeMinutes: 4,
        isActive: true,
      });

      const res = await request('GET', `/api/queue/${emptyCenter._id}/${emptyService._id}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.body.data.estimatedWaitMinutes,
        0,
        'A completely empty queue must report 0, not an invented value'
      );
      assert.deepStrictEqual(res.body.data.waitingTokens, [], 'Empty waiting list must be empty');

      const status = await request('GET', `/api/queue/${emptyCenter._id}`);
      assert.deepStrictEqual(status.body.data.queues, [], 'No real queue rows => empty list (no demo queues)');

      pass('24. Real empty state returned as empty (no demo queues, no invented EWT)');
    } catch (err) {
      fail('24. No fabricated values for empty database state', err);
    }

    // ─── Cleanup ────────────────────────────────────────────────────────────
    try {
      await Token.deleteMany({ centerId: { $in: [centerA._id, centerB._id] } });
      await QueueEvent.deleteMany({ centerId: { $in: [centerA._id, centerB._id] } });
      await Queue.deleteMany({ centerId: { $in: [centerA._id, centerB._id] } });
      await Counter.deleteMany({ centerId: { $in: [centerA._id, centerB._id] } });
      await Service.deleteMany({ centerId: { $in: [centerA._id, centerB._id] } });
      await ServiceCenter.deleteMany({ _id: { $in: [centerA._id, centerB._id] } });
      await User.deleteMany({ _id: { $in: [adminUser._id, staffUser._id, customerUser._id] } });
      const Notification = require('../src/models/Notification');
      await Notification.deleteMany({ userId: { $in: [adminUser._id, staffUser._id, customerUser._id] } });
    } catch (cleanupErr) {
      console.warn('  ⚠️  Cleanup warning:', cleanupErr.message);
    }

    console.log('\n============================================================');
    console.log(`  Context-Aware EWT Results: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');

    if (socketClient) socketClient.close();
    testServer.close();
    await mongoose.disconnect();

    if (failed > 0) process.exit(1);
  } catch (suiteErr) {
    console.error('Fatal suite error:', suiteErr);
    if (testServer) testServer.close();
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  }
}

/** Scan every persisted notification body for fabricated AI/ML claims. */
async function Notification_text_scan() {
  const Notification = require('../src/models/Notification');
  const docs = await Notification.find({
    centerId: { $in: [centerA._id, centerB._id] },
  })
    .select('title body')
    .lean();
  return docs.map((d) => `${d.title || ''} ${d.body || ''}`).join(' | ');
}

runTests();

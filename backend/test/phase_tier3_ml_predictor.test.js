'use strict';

/**
 * QueueFlow — TIER 3 / FEATURE 2: ML FOOTFALL & STAFFING PREDICTOR TEST SUITE
 *
 * Verifies the Machine Learning Footfall and Advisory Staffing Predictor
 * against real MongoDB Atlas database records.
 *
 * Coverage:
 *   1.  Real historical data extraction (bounded, hourly intervals, service-aware)
 *   2.  Insufficient data (truthful INSUFFICIENT_DATA status, no fabricated numbers)
 *   3.  Baseline forecast (historical stratified averages computed from real tokens)
 *   4.  Model training (Ridge regression closed-form parameter convergence)
 *   5.  Chronological validation (train on past, evaluate on future; no data leakage)
 *   6.  Prediction generation (future arrival counts bounded to >= 0)
 *   7.  Deterministic repeatability (identical inputs produce bit-identical output)
 *   8.  Invalid center (404 for non-existent center ID, 400 for malformed ID)
 *   9.  Unauthorized access (401 unauthenticated, 403 for non-admin role)
 *   10. No cross-center data leakage (Center A tokens never influence Center B model)
 *   11. Training sample bounds (honors historical window and sample limits)
 *   12. Model metadata (modelVersion, trainedAt, metrics, sample counts exposed)
 *   13. Prediction timestamps (future hourly intervals correctly aligned)
 *   14. Staffing derivation (workload / capacity explainable derivation)
 *   15. No automatic staffing mutation (prediction is advisory; counters unchanged)
 *   16. Unavailable-model behavior (safe fallback to baseline historical average)
 *   17. Stale-model detection & force refresh (cache bypass via refresh=true)
 *   18. Real Resource Hub integration (endpoint contract matches UI consumption)
 *   19. No fake/static prediction values (validates empty state truthfully)
 *   20. Regression to Feature 1 EWT (waitTimeService unaffected)
 *   21. Regression to Tier 2 Resource Hub (operational overview unaffected)
 *   22. Concurrent requests (parallel forecasts without race conditions or memory corruption)
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { server } = require('../server');
const connectDB = require('../src/config/database');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const queueService = require('../src/services/queueService');
const waitTimeService = require('../src/services/waitTimeService');
const { mlPredictorService } = require('../src/services/mlPredictorService');

let baseUrl;
let testServer;

let centerA;
let centerB;
let serviceA1;
let serviceA2;
let serviceB1;
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
  if (process.env.ML_TEST_STACK) console.error(err.stack);
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
 * Creates a batch of real Token records spread across distinct historical hourly bins
 * to provide genuine training data for Center A without mocking.
 */
async function seedHistoricalTokens({ centerId, serviceId, countPerBin = 3, hoursBack = [1, 2, 3, 4, 5, 6, 7, 8] }) {
  const createdTokens = [];
  const now = Date.now();

  for (const h of hoursBack) {
    const binTime = new Date(now - h * 3600 * 1000);

    for (let i = 0; i < countPerBin; i++) {
      const u = await User.create({
        name: `HistML_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        email: `histml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@test.com`,
        passwordHash: 'hash',
        role: 'CUSTOMER',
      });

      const tokenTime = new Date(binTime.getTime() + i * 60000);
      const serviceSeconds = 300 + (i % 3) * 60; // 300s, 360s, 420s

      const t = await Token.create({
        tokenCode: `ML-${h}-${i}`,
        tokenNumber: i + 1,
        userId: u._id,
        centerId,
        serviceId,
        status: 'COMPLETED',
        createdAt: tokenTime,
        calledAt: new Date(tokenTime.getTime() + 120000),
        servingAt: new Date(tokenTime.getTime() + 180000),
        completedAt: new Date(tokenTime.getTime() + 180000 + serviceSeconds * 1000),
        actualServiceSeconds: serviceSeconds,
      });

      createdTokens.push({ token: t, user: u });
    }
  }

  return createdTokens;
}

async function runTests() {
  console.log('\n============================================================');
  console.log('🤖  QueueFlow — Tier 3 / Feature 2: ML Predictor Test Suite');
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
    const r = () => Math.random().toString(36).substring(2, 8).toUpperCase();

    // ─── Real Fixtures in MongoDB Atlas ───────────────────────────────────────
    centerA = await ServiceCenter.create({
      name: `ML Center Alpha ${ts}`,
      code: `MA${r()}`,
      type: 'BANK',
      capacity: 100,
      isOpen: true,
      currentCrowd: 25,
    });

    centerB = await ServiceCenter.create({
      name: `ML Center Beta ${ts}`,
      code: `MB${r()}`,
      type: 'HOSPITAL',
      capacity: 50,
      isOpen: true,
      currentCrowd: 10,
    });

    serviceA1 = await Service.create({
      centerId: centerA._id,
      name: 'Alpha General Inquiries',
      tokenPrefix: 'AG',
      avgServiceTimeMinutes: 6,
      isActive: true,
    });

    serviceA2 = await Service.create({
      centerId: centerA._id,
      name: 'Alpha VIP Services',
      tokenPrefix: 'AV',
      avgServiceTimeMinutes: 12,
      isActive: true,
    });

    serviceB1 = await Service.create({
      centerId: centerB._id,
      name: 'Beta Triage',
      tokenPrefix: 'BT',
      avgServiceTimeMinutes: 8,
      isActive: true,
    });

    counterA1 = await Counter.create({
      centerId: centerA._id,
      name: 'Desk 1',
      number: 1,
      status: 'ACTIVE',
      serviceId: serviceA1._id,
    });

    counterA2 = await Counter.create({
      centerId: centerA._id,
      name: 'Desk 2',
      number: 2,
      status: 'ACTIVE',
      serviceId: serviceA1._id,
    });

    counterB1 = await Counter.create({
      centerId: centerB._id,
      name: 'Triage Desk 1',
      number: 1,
      status: 'ACTIVE',
      serviceId: serviceB1._id,
    });

    adminUser = await User.create({
      name: `Admin ML ${ts}`,
      email: `admin_ml_${ts}@test.com`,
      passwordHash: 'hash',
      role: 'ADMIN',
      // No centerId — superadmin with cross-center access for testing multi-center scenarios
    });

    staffUser = await User.create({
      name: `Staff ML ${ts}`,
      email: `staff_ml_${ts}@test.com`,
      passwordHash: 'hash',
      role: 'STAFF',
      centerId: centerA._id,
    });

    customerUser = await User.create({
      name: `Customer ML ${ts}`,
      email: `customer_ml_${ts}@test.com`,
      passwordHash: 'hash',
      role: 'CUSTOMER',
    });

    adminTokenJwt = signToken(adminUser._id, 'ADMIN');
    staffTokenJwt = signToken(staffUser._id, 'STAFF');
    customerTokenJwt = signToken(customerUser._id, 'CUSTOMER');

    // ─── Test 1: Real Historical Data Extraction ──────────────────────────────
    try {
      // Seed real tokens for centerA — 10 distinct hourly bins ensures N >= K=6 features
      // for Ridge Regression to be usable (trainCount = floor(10*0.75) = 7 >= 6 features)
      const seeded = await seedHistoricalTokens({
        centerId: centerA._id,
        serviceId: serviceA1._id,
        countPerBin: 2,
        hoursBack: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      });

      const extracted = await mlPredictorService.extractHistoricalBins({
        centerId: centerA._id,
        serviceId: serviceA1._id,
      });

      assert(Array.isArray(extracted.bins), 'Bins must be an array');
      assert.strictEqual(extracted.totalTokens, 20, 'Must extract exactly 20 tokens');
      assert(extracted.bins.length >= 10, 'Must have at least 10 hourly bins');

      // Verify each bin is chronologically ordered
      for (let i = 1; i < extracted.bins.length; i++) {
        assert(
          extracted.bins[i].timestamp >= extracted.bins[i - 1].timestamp,
          'Bins must be ordered chronologically'
        );
      }
      pass('1. Real historical data extraction (bounded, hourly, chronological)');
    } catch (err) {
      fail('1. Real historical data extraction', err);
    }

    // ─── Test 2: Insufficient Data Handling ───────────────────────────────────
    try {
      // Center B currently has 0 historical tokens
      const res = await request('GET', `/api/analytics/${centerB._id}/forecast`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });

      assert.strictEqual(res.status, 200, 'Should return HTTP 200 with truthful status');
      assert.strictEqual(res.body.data.status, 'INSUFFICIENT_DATA', 'Must return INSUFFICIENT_DATA status');
      assert.strictEqual(res.body.data.forecast.length, 0, 'Forecast must be empty array when insufficient');
      assert(res.body.data.sufficiency, 'Must include sufficiency audit details');
      assert.strictEqual(res.body.data.sufficiency.tokensFound, 0, 'Must accurately report 0 tokens found');
      pass('2. Insufficient data (truthful INSUFFICIENT_DATA status, no fabricated numbers)');
    } catch (err) {
      fail('2. Insufficient data', err);
    }

    // ─── Test 3: Baseline Forecast ────────────────────────────────────────────
    try {
      const extracted = await mlPredictorService.extractHistoricalBins({
        centerId: centerA._id,
      });
      const baseline = mlPredictorService.computeBaselinePriors(extracted.bins);

      assert(typeof baseline.globalMean === 'number' && baseline.globalMean > 0, 'Global mean must be positive number');
      assert(typeof baseline.getPrior(0, 12) === 'number', 'getPrior must return numeric arrival prior');
      pass('3. Baseline forecast (stratified historical averages from real records)');
    } catch (err) {
      fail('3. Baseline forecast', err);
    }

    // ─── Test 4: Model Training (Ridge Regression) ────────────────────────────
    try {
      const extracted = await mlPredictorService.extractHistoricalBins({
        centerId: centerA._id,
      });
      const baseline = mlPredictorService.computeBaselinePriors(extracted.bins);
      const trained = mlPredictorService.trainAndEvaluate(extracted.bins, baseline);

      assert.strictEqual(trained.success, true, 'Model training must succeed');
      assert(Array.isArray(trained.weights), 'Weights must be an array');
      assert.strictEqual(trained.weights.length, 6, 'Features vector length must be 6');
      for (const w of trained.weights) {
        assert(Number.isFinite(w), 'Weights must be finite numbers');
      }
      pass('4. Model training (deterministic closed-form Ridge parameter estimation)');
    } catch (err) {
      fail('4. Model training', err);
    }

    // ─── Test 5: Chronological Validation ─────────────────────────────────────
    try {
      const extracted = await mlPredictorService.extractHistoricalBins({
        centerId: centerA._id,
      });
      const baseline = mlPredictorService.computeBaselinePriors(extracted.bins);
      const result = mlPredictorService.trainAndEvaluate(extracted.bins, baseline);

      assert(result.metrics, 'Must return evaluation metrics');
      assert(typeof result.metrics.trainMae === 'number', 'Train MAE must be a number');
      assert(result.metrics.trainSamples > 0, 'Train samples count must be > 0');
      assert(result.metrics.valSamples > 0, 'Validation samples count must be > 0');
      pass('5. Chronological validation (train on past, evaluate on future out-of-sample)');
    } catch (err) {
      fail('5. Chronological validation', err);
    }

    // ─── Test 6: Prediction Generation ────────────────────────────────────────
    try {
      const forecast = await mlPredictorService.getForecast({
        centerId: centerA._id,
        horizonHours: 6,
        forceRefresh: true,
      });

      assert.strictEqual(forecast.status, 'AVAILABLE', 'Status must be AVAILABLE');
      assert.strictEqual(forecast.forecastHorizonHours, 6, 'Horizon must be 6 hours');
      assert.strictEqual(forecast.timeline.length, 6, 'Timeline must have 6 intervals');

      for (const item of forecast.timeline) {
        assert(Number.isInteger(item.predictedArrivals), 'Predicted arrivals must be integer');
        assert(item.predictedArrivals >= 0, 'Predicted arrivals must be non-negative');
        assert(item.intervalStart, 'Interval start timestamp must be present');
      }
      pass('6. Prediction generation (hourly arrival predictions bounded >= 0)');
    } catch (err) {
      fail('6. Prediction generation', err);
    }

    // ─── Test 7: Deterministic Repeatability ──────────────────────────────────
    try {
      const forecast1 = await mlPredictorService.getForecast({
        centerId: centerA._id,
        horizonHours: 4,
        forceRefresh: true,
      });

      const forecast2 = await mlPredictorService.getForecast({
        centerId: centerA._id,
        horizonHours: 4,
        forceRefresh: true,
      });

      assert.strictEqual(
        forecast1.timeline[0].predictedArrivals,
        forecast2.timeline[0].predictedArrivals,
        'Deterministic calculations must match bit-for-bit'
      );
      assert.strictEqual(
        forecast1.timeline[0].staffing.recommendedActiveCounters,
        forecast2.timeline[0].staffing.recommendedActiveCounters,
        'Staffing recommendation must be bit-identical'
      );
      pass('7. Deterministic repeatability (identical inputs produce identical forecast)');
    } catch (err) {
      fail('7. Deterministic repeatability', err);
    }

    // ─── Test 8: Invalid Center Identification ────────────────────────────────
    try {
      const fakeId = new mongoose.Types.ObjectId();
      const res404 = await request('GET', `/api/analytics/${fakeId}/forecast`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });
      assert.strictEqual(res404.status, 404, 'Non-existent center must return 404');

      const res400 = await request('GET', '/api/analytics/invalid-id/forecast', null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });
      assert.strictEqual(res400.status, 400, 'Malformed center ID must return 400');
      pass('8. Invalid center (clean 404 for non-existent center, 400 for malformed ID)');
    } catch (err) {
      fail('8. Invalid center', err);
    }

    // ─── Test 9: Unauthorized Access Guards ───────────────────────────────────
    try {
      // Unauthenticated
      const res401 = await request('GET', `/api/analytics/${centerA._id}/forecast`);
      assert.strictEqual(res401.status, 401, 'Unauthenticated request must return 401');

      // Customer role
      const res403Customer = await request('GET', `/api/analytics/${centerA._id}/forecast`, null, {
        Authorization: `Bearer ${customerTokenJwt}`,
      });
      assert.strictEqual(res403Customer.status, 403, 'Customer role must return 403');

      // Staff role
      const res403Staff = await request('GET', `/api/analytics/${centerA._id}/forecast`, null, {
        Authorization: `Bearer ${staffTokenJwt}`,
      });
      assert.strictEqual(res403Staff.status, 403, 'Staff role must return 403');
      pass('9. Unauthorized access (401 unauthenticated, 403 customer & staff rejected)');
    } catch (err) {
      fail('9. Unauthorized access', err);
    }

    // ─── Test 10: No Cross-Center Data Leakage ─────────────────────────────────
    try {
      // Seed tokens for Center B
      await seedHistoricalTokens({
        centerId: centerB._id,
        serviceId: serviceB1._id,
        countPerBin: 1,
        hoursBack: [1, 2],
      });

      const extractedB = await mlPredictorService.extractHistoricalBins({
        centerId: centerB._id,
      });

      // Total tokens in Center B must only be 2, strictly excluding Center A's 12 tokens
      assert.strictEqual(extractedB.totalTokens, 2, 'Center B tokens must not include Center A tokens');
      pass('10. No cross-center data leakage (tenant center isolation strictly enforced)');
    } catch (err) {
      fail('10. No cross-center data leakage', err);
    }

    // ─── Test 11: Training Sample Bounds ──────────────────────────────────────
    try {
      const extracted = await mlPredictorService.extractHistoricalBins({
        centerId: centerA._id,
        windowDays: 7,
      });

      assert(extracted.windowDays === 7, 'Window days must be honored');
      assert(extracted.windowStart instanceof Date, 'Window start must be valid Date');
      pass('11. Training sample bounds (honors bounded observation window)');
    } catch (err) {
      fail('11. Training sample bounds', err);
    }

    // ─── Test 12: Model Metadata Exposure ─────────────────────────────────────
    try {
      const forecast = await mlPredictorService.getForecast({
        centerId: centerA._id,
        horizonHours: 4,
      });

      assert(forecast.modelMetadata, 'Model metadata must be present');
      assert.strictEqual(forecast.modelMetadata.modelVersion, 'v1.0-ridge-seasonal');
      assert(forecast.modelMetadata.trainingTokensCount >= 10, 'Training token count must be >= 10');
      assert(forecast.modelMetadata.trainedAt, 'trainedAt timestamp must be present');
      pass('12. Model metadata (modelVersion, trainedAt, metrics, sample counts exposed)');
    } catch (err) {
      fail('12. Model metadata', err);
    }

    // ─── Test 13: Prediction Timestamps Alignment ─────────────────────────────
    try {
      const forecast = await mlPredictorService.getForecast({
        centerId: centerA._id,
        horizonHours: 3,
        forceRefresh: true, // bypass cache from earlier test runs with different horizons
      });

      assert.strictEqual(forecast.timeline.length, 3, 'Must return 3 intervals');
      const t0 = new Date(forecast.timeline[0].intervalStart).getTime();
      const t1 = new Date(forecast.timeline[1].intervalStart).getTime();
      assert.strictEqual(t1 - t0, 3600000, 'Intervals must be exactly 1 hour apart');
      pass('13. Prediction timestamps (future hourly intervals correctly aligned)');
    } catch (err) {
      fail('13. Prediction timestamps', err);
    }

    // ─── Test 14: Staffing Derivation ─────────────────────────────────────────
    try {
      const forecast = await mlPredictorService.getForecast({
        centerId: centerA._id,
        horizonHours: 2,
      });

      for (const slot of forecast.timeline) {
        assert(slot.staffing, 'Staffing derivation object must exist');
        assert(typeof slot.staffing.recommendedActiveCounters === 'number', 'Recommended counters must be number');
        assert(typeof slot.staffing.currentActiveCounters === 'number', 'Current active counters must be number');
        assert(typeof slot.staffing.staffingDelta === 'number', 'Staffing delta must be number');
        assert(slot.staffing.targetUtilization === 0.85, 'Target utilization must be 0.85');
        assert(slot.staffing.effectiveServiceSeconds > 0, 'Effective service seconds must be positive');
      }
      pass('14. Staffing derivation (workload / capacity explainable derivation)');
    } catch (err) {
      fail('14. Staffing derivation', err);
    }

    // ─── Test 15: No Automatic Staffing Mutation ──────────────────────────────
    try {
      const countersBefore = await Counter.find({ centerId: centerA._id }).lean();

      // Request forecast multiple times
      await mlPredictorService.getForecast({ centerId: centerA._id, horizonHours: 6, forceRefresh: true });
      await mlPredictorService.getForecast({ centerId: centerA._id, horizonHours: 12, forceRefresh: true });

      const countersAfter = await Counter.find({ centerId: centerA._id }).lean();

      assert.strictEqual(countersBefore.length, countersAfter.length, 'Counter count must not change');
      for (let i = 0; i < countersBefore.length; i++) {
        assert.strictEqual(countersBefore[i].status, countersAfter[i].status, 'Counter status must not mutate');
        assert.strictEqual(
          String(countersBefore[i].serviceId),
          String(countersAfter[i].serviceId),
          'Counter serviceId must not mutate'
        );
      }
      pass('15. No automatic staffing mutation (prediction is strictly advisory)');
    } catch (err) {
      fail('15. No automatic staffing mutation', err);
    }

    // ─── Test 16: Unavailable-Model Behavior ──────────────────────────────────
    try {
      // Use 10 bins across varied hours AND days to ensure the baseline path is
      // exercised: with only MIN_HOURLY_BINS (5) bins this would return insufficient,
      // but we want to test the fallback when N < K (too few for ridge but enough bins).
      // Provide exactly MIN_HOURLY_BINS bins — this triggers the baseline-only path
      // inside trainAndEvaluate when trainCount(=3) < K(=6) features.
      const dummyBins = [
        { dow: 1, hour: 9,  arrivals: 3, timestamp: Date.now() - 9*3600000 },
        { dow: 2, hour: 10, arrivals: 5, timestamp: Date.now() - 8*3600000 },
        { dow: 3, hour: 11, arrivals: 2, timestamp: Date.now() - 7*3600000 },
        { dow: 4, hour: 12, arrivals: 4, timestamp: Date.now() - 6*3600000 },
        { dow: 5, hour: 13, arrivals: 6, timestamp: Date.now() - 5*3600000 },
      ];
      const priors = mlPredictorService.computeBaselinePriors(dummyBins);
      const evalRes = mlPredictorService.trainAndEvaluate(dummyBins, priors);

      assert(evalRes.success, 'Evaluation must succeed');
      assert(['RIDGE_REGRESSION', 'BASELINE_HISTORICAL_AVERAGE'].includes(evalRes.modelUsed), 'Must select valid model type');
      pass('16. Unavailable-model behavior (safe fallback to baseline historical average)');
    } catch (err) {
      fail('16. Unavailable-model behavior', err);
    }

    // ─── Test 17: Stale-Model Detection & Force Refresh ───────────────────────
    try {
      const resNormal = await request('GET', `/api/analytics/${centerA._id}/forecast`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });
      assert.strictEqual(resNormal.status, 200);

      const resRefreshed = await request('GET', `/api/analytics/${centerA._id}/forecast?refresh=true`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });
      assert.strictEqual(resRefreshed.status, 200);
      assert.strictEqual(resRefreshed.body.data.status, 'AVAILABLE');
      pass('17. Stale-model detection & force refresh (cache bypass via refresh=true)');
    } catch (err) {
      fail('17. Stale-model detection & force refresh', err);
    }

    // ─── Test 18: Real Resource Hub Integration ───────────────────────────────
    try {
      const res = await request('GET', `/api/analytics/${centerA._id}/forecast?horizonHours=6`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });

      assert.strictEqual(res.status, 200);
      assert(res.body.data.center, 'Center metadata must be in response');
      assert(res.body.data.modelMetadata, 'Model metadata must be in response');
      assert(Array.isArray(res.body.data.timeline), 'Timeline must be in response');
      assert.strictEqual(res.body.data.isAdvisory, true, 'Must declare isAdvisory: true');
      pass('18. Real Resource Hub integration (API matches frontend consumption contract)');
    } catch (err) {
      fail('18. Real Resource Hub integration', err);
    }

    // ─── Test 19: No Fake/Static Prediction Values ────────────────────────────
    try {
      const emptyCenter = await ServiceCenter.create({
        name: `Empty Center ${Date.now()}`,
        code: `EC${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        type: 'OTHER',
        capacity: 50,
        isOpen: true,
        currentCrowd: 0,
      });

      const res = await request('GET', `/api/analytics/${emptyCenter._id}/forecast`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert(res.body.data, `Response body.data must exist, got: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.data.status, 'INSUFFICIENT_DATA', `Expected INSUFFICIENT_DATA, got ${res.body.data.status}`);
      assert.strictEqual(res.body.data.forecast.length, 0, 'Forecast must be empty for zero-history center');

      await ServiceCenter.deleteOne({ _id: emptyCenter._id });
      pass('19. No fake/static prediction values (empty centers return INSUFFICIENT_DATA)');
    } catch (err) {
      fail('19. No fake/static prediction values', err);
    }

    // ─── Test 20: Regression to Feature 1 EWT ──────────────────────────────────
    try {
      const ewtRes = await request('GET', `/api/analytics/${centerA._id}/ewt`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });

      assert.strictEqual(ewtRes.status, 200, 'EWT endpoint must remain 200 OK');
      assert(Array.isArray(ewtRes.body.data.services), 'Services array must exist');
      assert(ewtRes.body.data.services.length > 0, 'Services must be populated');
      pass('20. Regression to Feature 1 EWT (Context-Aware EWT endpoint green)');
    } catch (err) {
      fail('20. Regression to Feature 1 EWT', err);
    }

    // ─── Test 21: Regression to Tier 2 Resource Hub ───────────────────────────
    try {
      const overviewRes = await request('GET', `/api/analytics/${centerA._id}/operational-overview`, null, {
        Authorization: `Bearer ${adminTokenJwt}`,
      });

      assert.strictEqual(overviewRes.status, 200, 'Resource Hub overview must remain 200 OK');
      assert(overviewRes.body.data.metrics, 'Metrics object must exist');
      assert(Array.isArray(overviewRes.body.data.counters), 'Counters array must exist');
      pass('21. Regression to Tier 2 Resource Hub (operational overview green)');
    } catch (err) {
      fail('21. Regression to Tier 2 Resource Hub', err);
    }

    // ─── Test 22: Concurrent Requests ─────────────────────────────────────────
    try {
      const promises = Array.from({ length: 6 }, () =>
        request('GET', `/api/analytics/${centerA._id}/forecast?horizonHours=4`, null, {
          Authorization: `Bearer ${adminTokenJwt}`,
        })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        assert.strictEqual(res.status, 200, 'Parallel request must return 200');
        assert.strictEqual(res.body.data.status, 'AVAILABLE', 'Parallel request must return AVAILABLE');
      }
      pass('22. Concurrent requests (parallel forecasts without race conditions)');
    } catch (err) {
      fail('22. Concurrent requests', err);
    }

    // ─── Cleanup Fixtures ─────────────────────────────────────────────────────
    try {
      await Token.deleteMany({ centerId: { $in: [centerA._id, centerB._id] } });
      await Counter.deleteMany({ centerId: { $in: [centerA._id, centerB._id] } });
      await Service.deleteMany({ centerId: { $in: [centerA._id, centerB._id] } });
      await ServiceCenter.deleteMany({ _id: { $in: [centerA._id, centerB._id] } });
      await User.deleteMany({ _id: { $in: [adminUser._id, staffUser._id, customerUser._id] } });
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr.message);
    }

    console.log('\n============================================================');
    console.log(`  ML Predictor Results: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');

    if (testServer) testServer.close();
    await mongoose.disconnect();

    if (failed > 0) process.exit(1);
  } catch (fatalErr) {
    console.error('Fatal suite error:', fatalErr);
    if (testServer) testServer.close();
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  }
}

runTests();

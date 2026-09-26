'use strict';

/**
 * QueueFlow Phase 5 — Step 7: Health, Liveness & Readiness Tests
 *
 * Test Coverage:
 * 1. GET /health/live => 200
 * 2. /health/live does not depend on MongoDB
 * 3. /health/live does not depend on Redis
 * 4. /health/live does not depend on Socket.IO adapter
 * 5. GET /health/ready => 200 when all required production dependencies are ready
 * 6. /health/ready => 503 when MongoDB is not ready
 * 7. /health/ready => 503 when production Redis is unavailable
 * 8. /health/ready => 503 when production Socket.IO adapter is unavailable
 * 9. Development/test mode does not incorrectly require Redis
 * 10. /health contains no NODE_ENV leak
 * 11. No secrets appear in responses
 * 12. No stack traces appear in responses
 * 13. X-Request-Id is present in response headers
 * 14. Readiness failure logs safe diagnostic metadata
 * 15. /health remains backward-compatible
 * 16. Readiness performs no extra DB queries
 * 17. Readiness performs no extra Redis connections
 * 18. Readiness performs no extra Socket.IO connections
 */

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const { app } = require('../server');
const redisModule = require('../src/config/redis');
const socketModule = require('../src/config/socket');
const { logger } = require('../src/utils/logger');

let testServer;
let baseUrl;
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function makeRequest(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${baseUrl}${path}`);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(raw);
          } catch (_) {
            body = raw;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runTest(name, fn) {
  totalTests++;
  process.stdout.write(`  Test ${totalTests}: ${name} ... `);
  try {
    await fn();
    passedTests++;
    console.log('✅ PASS');
  } catch (err) {
    failedTests++;
    console.log('❌ FAIL');
    console.error(`    Error: ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
}

async function runAll() {
  console.log('\n====================================================');
  console.log('🩺  QueueFlow Phase 5 — Step 7: Health & Readiness Tests');
  console.log('====================================================\n');

  // Start test server on ephemeral port
  testServer = http.createServer(app);
  await new Promise((resolve) => testServer.listen(0, resolve));
  const port = testServer.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Preserve original state and functions for cleanup
  const origEnv = process.env.NODE_ENV;
  const origRedisRequired = process.env.REDIS_REQUIRED;
  const origReadyStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  const origIsRedisReady = redisModule.isRedisReady;
  const origGetAdapterStatus = socketModule.getAdapterStatus;

  console.log('▶ [1/4] Liveness Probe (/health/live)');

  // Test 1: GET /health/live => 200
  await runTest('1. GET /health/live returns HTTP 200 with status "alive"', async () => {
    const res = await makeRequest('GET', '/health/live');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.status, 'alive');
  });

  // Test 2: /health/live does not depend on MongoDB
  await runTest('2. /health/live succeeds even when MongoDB is completely disconnected (readyState 0)', async () => {
    Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });
    try {
      const res = await makeRequest('GET', '/health/live');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'alive');
    } finally {
      if (origReadyStateDescriptor) {
        Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDescriptor);
      }
    }
  });

  // Test 3: /health/live does not depend on Redis
  await runTest('3. /health/live succeeds even when Redis is down and in production', async () => {
    process.env.NODE_ENV = 'production';
    redisModule.isRedisReady = () => false;
    try {
      const res = await makeRequest('GET', '/health/live');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'alive');
    } finally {
      process.env.NODE_ENV = origEnv;
      redisModule.isRedisReady = origIsRedisReady;
    }
  });

  // Test 4: /health/live does not depend on Socket.IO adapter
  await runTest('4. /health/live succeeds even when Socket.IO adapter is unready', async () => {
    socketModule.getAdapterStatus = () => ({ mode: 'redis', isReady: false });
    try {
      const res = await makeRequest('GET', '/health/live');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'alive');
    } finally {
      socketModule.getAdapterStatus = origGetAdapterStatus;
    }
  });

  console.log('\n▶ [2/4] Readiness Probe (/health/ready) & Production Policies');

  // Test 5: GET /health/ready => 200 when all required production dependencies are ready
  await runTest('5. GET /health/ready returns HTTP 200 when all production dependencies are ready', async () => {
    process.env.NODE_ENV = 'production';
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
    redisModule.isRedisReady = () => true;
    socketModule.getAdapterStatus = () => ({ mode: 'redis', isReady: true });

    try {
      const res = await makeRequest('GET', '/health/ready');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.status, 'ready');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origReadyStateDescriptor) Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDescriptor);
      redisModule.isRedisReady = origIsRedisReady;
      socketModule.getAdapterStatus = origGetAdapterStatus;
    }
  });

  // Test 6: /health/ready => 503 when MongoDB is not ready
  await runTest('6. /health/ready returns HTTP 503 when MongoDB is not connected', async () => {
    Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });
    redisModule.isRedisReady = () => true;
    socketModule.getAdapterStatus = () => ({ mode: 'memory', isReady: true });

    try {
      const res = await makeRequest('GET', '/health/ready');
      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.status, 'unready');
    } finally {
      if (origReadyStateDescriptor) Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDescriptor);
      redisModule.isRedisReady = origIsRedisReady;
      socketModule.getAdapterStatus = origGetAdapterStatus;
    }
  });

  // Test 7: /health/ready => 503 when production Redis is unavailable
  await runTest('7. /health/ready returns HTTP 503 when production Redis is unavailable', async () => {
    process.env.NODE_ENV = 'production';
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
    redisModule.isRedisReady = () => false; // Redis down
    socketModule.getAdapterStatus = () => ({ mode: 'redis', isReady: true });

    try {
      const res = await makeRequest('GET', '/health/ready');
      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.status, 'unready');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origReadyStateDescriptor) Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDescriptor);
      redisModule.isRedisReady = origIsRedisReady;
      socketModule.getAdapterStatus = origGetAdapterStatus;
    }
  });

  // Test 8: /health/ready => 503 when production Socket.IO adapter is unavailable
  await runTest('8. /health/ready returns HTTP 503 when production Socket.IO adapter is unready', async () => {
    process.env.NODE_ENV = 'production';
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
    redisModule.isRedisReady = () => true;
    socketModule.getAdapterStatus = () => ({ mode: 'redis', isReady: false }); // Adapter unready

    try {
      const res = await makeRequest('GET', '/health/ready');
      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.status, 'unready');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origReadyStateDescriptor) Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDescriptor);
      redisModule.isRedisReady = origIsRedisReady;
      socketModule.getAdapterStatus = origGetAdapterStatus;
    }
  });

  // Test 9: development/test does not incorrectly require Redis
  await runTest('9. Development/test mode does not require Redis for readiness', async () => {
    process.env.NODE_ENV = 'development';
    process.env.REDIS_REQUIRED = 'false';
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
    redisModule.isRedisReady = () => false; // Redis disabled or absent
    socketModule.getAdapterStatus = () => ({ mode: 'memory', isReady: true });

    try {
      const res = await makeRequest('GET', '/health/ready');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.status, 'ready');
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.REDIS_REQUIRED = origRedisRequired;
      if (origReadyStateDescriptor) Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDescriptor);
      redisModule.isRedisReady = origIsRedisReady;
      socketModule.getAdapterStatus = origGetAdapterStatus;
    }
  });

  console.log('\n▶ [3/4] Information Disclosure, Headers & Backward Compatibility');

  // Test 10: /health contains no NODE_ENV leak
  await runTest('10. Health endpoints do not leak NODE_ENV or environment names', async () => {
    const endpoints = ['/health', '/health/live', '/health/ready'];
    for (const ep of endpoints) {
      const res = await makeRequest('GET', ep);
      assert.strictEqual(res.body.environment, undefined, `${ep} leaked environment property`);
      const bodyStr = JSON.stringify(res.body);
      assert(!bodyStr.includes('production'), `${ep} leaked environment value`);
      assert(!bodyStr.includes('development'), `${ep} leaked environment value`);
    }
  });

  // Test 11: no secrets appear in responses
  await runTest('11. No secrets, credentials, or internal URLs appear in health responses', async () => {
    const endpoints = ['/health', '/health/live', '/health/ready'];
    for (const ep of endpoints) {
      const res = await makeRequest('GET', ep);
      const str = JSON.stringify(res.body).toLowerCase();
      assert(!str.includes('mongodb'), `${ep} leaked mongodb`);
      assert(!str.includes('redis://'), `${ep} leaked redis url`);
      assert(!str.includes('secret'), `${ep} leaked secret`);
      assert(!str.includes('password'), `${ep} leaked password`);
    }
  });

  // Test 12: no stack traces appear
  await runTest('12. No stack traces appear in 200 or 503 health responses', async () => {
    Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });
    try {
      const res503 = await makeRequest('GET', '/health/ready');
      assert.strictEqual(res503.statusCode, 503);
      assert.strictEqual(res503.body.stack, undefined);
      assert(!JSON.stringify(res503.body).includes(' at '));
    } finally {
      if (origReadyStateDescriptor) Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDescriptor);
    }
  });

  // Test 13: X-Request-Id is present
  await runTest('13. Valid X-Request-Id is present on all health responses', async () => {
    const customTrace = 'health-check-tracer-778899';
    const res = await makeRequest('GET', '/health/live', { 'x-request-id': customTrace });
    assert.strictEqual(res.headers['x-request-id'], customTrace);

    const resNoId = await makeRequest('GET', '/health/ready');
    assert(resNoId.headers['x-request-id']);
    assert.match(resNoId.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  // Test 14: readiness failure logs safe diagnostic metadata
  await runTest('14. Readiness failure logs safe diagnostic metadata with zero secrets', async () => {
    let capturedLog = null;
    const origWarn = logger.warn;
    logger.warn = (msg, meta) => {
      capturedLog = { msg, meta };
      origWarn.call(logger, msg, meta);
    };

    Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });

    try {
      await makeRequest('GET', '/health/ready');
      assert(capturedLog, 'Logger.warn must be called on readiness failure');
      assert.strictEqual(capturedLog.meta.event, 'HEALTH_READINESS_FAILED');
      assert.strictEqual(capturedLog.meta.mongoReady, false);
      assert(!JSON.stringify(capturedLog).includes('password'));
      assert(!JSON.stringify(capturedLog).includes('mongodb+srv'));
    } finally {
      logger.warn = origWarn;
      if (origReadyStateDescriptor) Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDescriptor);
    }
  });

  // Test 15: /health remains backward-compatible
  await runTest('15. GET /health remains backward-compatible returning 200 OK and success: true', async () => {
    const res = await makeRequest('GET', '/health');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.status, 'alive');
  });

  console.log('\n▶ [4/4] Zero Overhead & Non-Intrusive Probe Verification');

  // Test 16: readiness performs no extra DB queries
  await runTest('16. Readiness probe executes zero extra database queries', async () => {
    let queriesExecuted = 0;
    const origQuery = mongoose.Query.prototype.exec;
    mongoose.Query.prototype.exec = function(...args) {
      queriesExecuted++;
      return origQuery.apply(this, args);
    };

    try {
      await makeRequest('GET', '/health/ready');
      assert.strictEqual(queriesExecuted, 0, 'No Mongoose queries should be executed for readiness check');
    } finally {
      mongoose.Query.prototype.exec = origQuery;
    }
  });

  // Test 17: readiness performs no extra Redis connections
  await runTest('17. Readiness probe opens zero extra Redis client connections', async () => {
    let extraClientsCreated = 0;
    const origCreateClient = redisModule.createRedisClient;
    redisModule.createRedisClient = function(...args) {
      extraClientsCreated++;
      return origCreateClient.apply(this, args);
    };

    try {
      await makeRequest('GET', '/health/ready');
      assert.strictEqual(extraClientsCreated, 0, 'No extra Redis clients should be instantiated');
    } finally {
      redisModule.createRedisClient = origCreateClient;
    }
  });

  // Test 18: readiness performs no extra Socket.IO connections
  await runTest('18. Readiness probe creates zero extra Socket.IO connections', async () => {
    let extraAdaptersCreated = 0;
    const origSetup = socketModule.setupRedisAdapter;
    socketModule.setupRedisAdapter = function(...args) {
      extraAdaptersCreated++;
      return origSetup.apply(this, args);
    };

    try {
      await makeRequest('GET', '/health/ready');
      assert.strictEqual(extraAdaptersCreated, 0, 'No extra Socket.IO adapters should be instantiated');
    } finally {
      socketModule.setupRedisAdapter = origSetup;
    }
  });

  // Close test server
  await new Promise((resolve) => testServer.close(resolve));

  console.log('\n====================================================');
  console.log(`Results: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAll().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

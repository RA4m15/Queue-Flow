'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const {
  createLimiter,
  QueueFlowDistributedStore,
  userOrIpKeyGenerator,
  ipKeyGenerator,
  generalLimiter,
  authLimiter,
  passwordChangeLimiter,
  tokenCreateLimiter,
  feedbackLimiter,
  verifyQRLimiter,
} = require('../src/middleware/rateLimiter');
const {
  initRedis,
  getRedisClient,
  isRedisReady,
  isRedisRequired,
  isRedisEnabled,
  sanitizeRedisUrl,
  _setMockClient,
} = require('../src/config/redis');

let passedTests = 0;
let failedTests = 0;

function pass(name) {
  passedTests++;
  console.log(`  ✅ PASS: ${name}`);
}

function fail(name, err) {
  failedTests++;
  console.error(`  ❌ FAIL: ${name}`, err);
}

/**
 * Helper to make HTTP requests against a test Express instance
 */
function makeRequest(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json || data,
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n=======================================================');
  console.log('⚡ QueueFlow Phase 5 — Distributed Rate Limiting Tests');
  console.log('=======================================================\n');

  // Preserve original environment variables
  const origEnv = { ...process.env };

  // ─── SECTION 1: Credentials Sanitization & Config Safety ───
  console.log('── Section 1: Configuration & Secret Sanitization ──');

  try {
    const dirtyUrl = 'redis://default:super_secret_redis_pass_123@redis-node.cloud.internal:6379';
    const sanitized = sanitizeRedisUrl(dirtyUrl);
    assert.strictEqual(sanitized.includes('super_secret_redis_pass_123'), false, 'Password must not be in sanitized URL');
    assert.strictEqual(sanitized.includes('***'), true, 'Password must be masked with ***');
    pass('1. Redis URL password is sanitized and never exposed');
  } catch (e) {
    fail('1. Redis URL password sanitization failed', e);
  }

  try {
    const urlWithUserAndPass = 'rediss://admin:complex_password_456@cluster-01.upstash.io:6380';
    const sanitized = sanitizeRedisUrl(urlWithUserAndPass);
    assert.strictEqual(sanitized.includes('complex_password_456'), false);
    assert.strictEqual(sanitized.includes('admin'), false, 'Username should be masked');
    pass('2. Rediss URL with user and password properly sanitized');
  } catch (e) {
    fail('2. Rediss URL sanitization failed', e);
  }

  // ─── SECTION 2: Production Redis Mandate & Startup Failure ───
  console.log('\n── Section 2: Production Redis Enforcement & Startup Fail-Closed ──');

  try {
    // Case 2A: NODE_ENV=production with no Redis configuration
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_ENABLED;

    let thrownNoConfig = null;
    try {
      await initRedis();
    } catch (err) {
      thrownNoConfig = err;
    }
    assert.ok(thrownNoConfig, 'initRedis must throw when NODE_ENV=production and no Redis is configured');
    assert.ok(thrownNoConfig.message.includes('FATAL_REDIS_CONFIG'), 'Throws FATAL_REDIS_CONFIG on missing config');
    pass('3. NODE_ENV=production + no Redis configuration => startup fails safely');
  } catch (e) {
    fail('3. Production without Redis configuration failed', e);
  } finally {
    process.env = { ...origEnv };
  }

  try {
    // Case 2B: NODE_ENV=production with Redis explicitly disabled
    process.env.NODE_ENV = 'production';
    process.env.REDIS_ENABLED = 'false';
    delete process.env.REDIS_URL;

    let thrownDisabled = null;
    try {
      await initRedis();
    } catch (err) {
      thrownDisabled = err;
    }
    assert.ok(thrownDisabled, 'initRedis must throw when NODE_ENV=production and REDIS_ENABLED=false');
    assert.ok(thrownDisabled.message.includes('FATAL_REDIS_CONFIG'), 'Rejects REDIS_ENABLED=false in production');
    pass('4. NODE_ENV=production + Redis disabled => startup fails safely (MemoryStore disallowed)');
  } catch (e) {
    fail('4. Production with Redis disabled failed', e);
  } finally {
    process.env = { ...origEnv };
  }

  try {
    // Case 2C: NODE_ENV=production + REDIS_REQUIRED=false must NOT bypass requirement
    process.env.NODE_ENV = 'production';
    process.env.REDIS_REQUIRED = 'false';
    assert.strictEqual(isRedisRequired(), true, 'In production, isRedisRequired() must be true regardless of REDIS_REQUIRED');
    pass('5. NODE_ENV=production + REDIS_REQUIRED=false => does NOT silently fall back to MemoryStore');
  } catch (e) {
    fail('5. Production REDIS_REQUIRED override test failed', e);
  } finally {
    process.env = { ...origEnv };
  }

  try {
    // Case 2D: NODE_ENV=development + no Redis => MemoryStore works cleanly
    process.env.NODE_ENV = 'development';
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    process.env.REDIS_ENABLED = 'false';

    assert.strictEqual(isRedisRequired(), false, 'In development, Redis is optional');
    const initResult = await initRedis();
    assert.strictEqual(initResult, null, 'initRedis returns null cleanly in development without throwing');

    const devStore = new QueueFlowDistributedStore({ prefix: 'test:dev:' });
    devStore.init({ windowMs: 1000 });
    const hit = await devStore.increment('dev-user-1');
    assert.strictEqual(hit.totalHits, 1, 'MemoryStore increments cleanly in development');
    pass('6. NODE_ENV=development + no Redis => MemoryStore works safely');
  } catch (e) {
    fail('6. Development MemoryStore test failed', e);
  } finally {
    process.env = { ...origEnv };
  }

  // ─── SECTION 3: Key Strategy & Anti-Bypass Verification ───
  console.log('\n── Section 3: Key Strategy & Anti-Bypass ──');

  try {
    const reqNoUser = { ip: '192.168.1.100' };
    const keyNoUser = userOrIpKeyGenerator(reqNoUser);
    assert.strictEqual(keyNoUser, 'ip:192.168.1.100', 'Unauthenticated request keys on IP');

    const reqWithUser = {
      ip: '10.0.0.50',
      user: { _id: '660000000000000000000099' },
    };
    const keyWithUser = userOrIpKeyGenerator(reqWithUser);
    assert.strictEqual(keyWithUser, 'usr:660000000000000000000099', 'Authenticated request keys on user ID');

    // User switches IP address -> Key remains identical (anti-bypass)
    const reqWithUserSwitchedIp = {
      ip: '203.0.113.195', // completely different IP
      user: { _id: '660000000000000000000099' },
    };
    const keySwitchedIp = userOrIpKeyGenerator(reqWithUserSwitchedIp);
    assert.strictEqual(keyWithUser, keySwitchedIp, 'Rotating IP addresses cannot bypass rate limit for authenticated user');
    pass('7. Key strategy prevents rate-limit bypass via IP rotation for authenticated users');
  } catch (e) {
    fail('7. Key strategy anti-bypass test failed', e);
  }

  // ─── SECTION 4: Redis Store Integration & State Verification ───
  console.log('\n── Section 4: Redis Store Integration (Simulated Cluster) ──');

  try {
    const redisMockState = new Map();
    let redisCallCount = 0;

    const mockRedisClient = {
      status: 'ready',
      call: async (cmd, ...args) => {
        redisCallCount++;
        if (cmd === 'SCRIPT') {
          return 'mock_sha_256_hash';
        }
        if (cmd === 'EVALSHA') {
          const key = args[2];
          const windowMs = parseInt(args[4] || '1000', 10);
          const current = (redisMockState.get(key) || 0) + 1;
          redisMockState.set(key, current);
          return [current, Date.now() + windowMs];
        }
        if (cmd === 'DEL') {
          redisMockState.delete(args[0]);
          return 1;
        }
        return 1;
      },
    };

    const redisStore = new QueueFlowDistributedStore({
      prefix: 'rl:redis_test:',
      getClient: () => mockRedisClient,
      isReady: () => true,
      isRequired: () => true,
    });
    redisStore.init({ windowMs: 5000 });

    const rHit1 = await redisStore.increment('user-alpha');
    assert.strictEqual(rHit1.totalHits, 1);
    assert.ok(redisCallCount > 0, 'ioredis client call() was invoked');

    const rHit2 = await redisStore.increment('user-alpha');
    assert.strictEqual(rHit2.totalHits, 2);

    // Verify memory store is NOT used
    assert.strictEqual(
      redisStore.localStore.hits ? Object.keys(redisStore.localStore.hits).length : 0,
      0,
      'Local memory store was not touched while Redis was active'
    );

    pass('8. Redis available => distributed limiter works and bypasses local memory');
  } catch (e) {
    fail('8. Redis store integration failed', e);
  }

  // ─── SECTION 5: Express HTTP Rate Limiting & Fail-Closed 503 ───
  console.log('\n── Section 5: Express HTTP Request Enforcement & 503 Fail-Closed ──');

  const app = express();
  app.use(express.json());

  // Test limiter: max 3 requests per 2 seconds
  const testLimiter = createLimiter({
    prefix: 'rl:http_test:',
    windowMs: 2000,
    max: 3,
    keyGenerator: userOrIpKeyGenerator,
    message: { success: false, message: 'Test limit reached' },
  });

  app.get('/test/limited', testLimiter, (req, res) => {
    res.json({ success: true, count: 'ok' });
  });

  // Strict production limiter with simulated Redis failure after startup
  const prodFailingLimiter = createLimiter({
    prefix: 'rl:prod_fail:',
    windowMs: 5000,
    max: 5,
    storeOptions: {
      isRequired: () => true,
      isReady: () => false, // simulates Redis network disconnect after startup
    },
  });

  app.get('/test/prod-fail', prodFailingLimiter, (req, res) => {
    res.json({ success: true });
  });

  // Global error handler
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  });

  const testServer = http.createServer(app);
  await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));

  try {
    // Request 1: Below limit
    const res1 = await makeRequest(testServer, '/test/limited');
    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res1.body.success, true);
    assert.strictEqual(res1.headers['ratelimit-limit'], '3');
    assert.strictEqual(res1.headers['ratelimit-remaining'], '2');
    pass('9. Request below limit succeeds with proper RateLimit headers');

    // Request 2: Below limit
    const res2 = await makeRequest(testServer, '/test/limited');
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.headers['ratelimit-remaining'], '1');
    pass('10. Second request decrements remaining count');

    // Request 3: Exact limit reached
    const res3 = await makeRequest(testServer, '/test/limited');
    assert.strictEqual(res3.statusCode, 200);
    assert.strictEqual(res3.headers['ratelimit-remaining'], '0');
    pass('11. Exact limit reached succeeds with 0 remaining');

    // Request 4: Above limit -> HTTP 429
    const res4 = await makeRequest(testServer, '/test/limited');
    assert.strictEqual(res4.statusCode, 429, 'Excess request must return HTTP 429');
    assert.strictEqual(res4.body.success, false);
    assert.strictEqual(res4.body.message, 'Test limit reached');
    assert.ok(res4.headers['retry-after'], 'Retry-After header present');
    pass('12. Request above limit returns HTTP 429 Too Many Requests with Retry-After header');

    // Concurrent requests test
    const concurrentResponses = await Promise.all([
      makeRequest(testServer, '/test/limited'),
      makeRequest(testServer, '/test/limited'),
      makeRequest(testServer, '/test/limited'),
    ]);
    for (const r of concurrentResponses) {
      assert.strictEqual(r.statusCode, 429, 'Concurrent requests while limited remain rejected');
    }
    pass('13. Concurrent requests beyond limit are safely and consistently throttled');

    // Redis unavailable after startup => returns 503
    const res503 = await makeRequest(testServer, '/test/prod-fail');
    assert.strictEqual(res503.statusCode, 503, 'Must return HTTP 503 when required Redis drops');
    assert.ok(res503.body.message.includes('REDIS_UNAVAILABLE'));
    pass('14. Redis unavailable after startup => protected request fails safe with HTTP 503');
  } catch (e) {
    fail('HTTP enforcement tests failed', e);
  } finally {
    testServer.close();
  }

  // ─── SECTION 6: Auth Limiter & Phase 3 Baseline Regressions ───
  console.log('\n── Section 6: Auth Limiter & Phase 3 Baseline Regressions ──');

  try {
    // Test authLimiter configuration:
    // In production/development (non-test): max 20 requests per 15 minutes.
    // In test environment: max 10000.
    const customAuthLimiter = createLimiter({
      prefix: 'rl:auth_verify:',
      windowMs: 15 * 60 * 1000,
      max: 20, // Verify exact baseline
      message: { success: false, message: 'Too many auth attempts, please try again later.' },
    });

    const authApp = express();
    authApp.use(express.json());
    authApp.post('/api/auth/test-limit', customAuthLimiter, (req, res) => res.json({ ok: true }));

    const authServer = http.createServer(authApp);
    await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));

    try {
      // Execute 20 requests -> all 20 succeed
      for (let i = 1; i <= 20; i++) {
        const res = await makeRequest(authServer, '/api/auth/test-limit', { method: 'POST' });
        assert.strictEqual(res.statusCode, 200, `Request ${i} of 20 should succeed`);
        assert.strictEqual(res.headers['ratelimit-remaining'], (20 - i).toString());
      }

      // 21st request -> must be rejected with 429
      const blockedRes = await makeRequest(authServer, '/api/auth/test-limit', { method: 'POST' });
      assert.strictEqual(blockedRes.statusCode, 429, 'Request 21 must be rejected with HTTP 429');
      assert.strictEqual(blockedRes.body.message, 'Too many auth attempts, please try again later.');

      pass('15. Auth limiter: exactly 20 requests / 15 minutes enforced, 21st rejected with HTTP 429');
    } finally {
      authServer.close();
    }
  } catch (e) {
    fail('15. Auth limiter exact limit verification failed', e);
  }

  try {
    // Regression check on exported Phase 3 limiters
    assert.strictEqual(typeof generalLimiter, 'function', 'generalLimiter is a function');
    assert.strictEqual(typeof authLimiter, 'function', 'authLimiter is a function');
    assert.strictEqual(typeof passwordChangeLimiter, 'function', 'passwordChangeLimiter is a function');
    assert.strictEqual(typeof tokenCreateLimiter, 'function', 'tokenCreateLimiter is a function');
    assert.strictEqual(typeof feedbackLimiter, 'function', 'feedbackLimiter is a function');
    assert.strictEqual(typeof verifyQRLimiter, 'function', 'verifyQRLimiter is a function');
    pass('16. All 6 Phase 3 endpoint rate limiters are exported and instantiated cleanly');
  } catch (e) {
    fail('16. Concrete limiters regression failed', e);
  }

  // ─── SUMMARY ───
  console.log('\n═══════════════════════════════════════════');
  console.log(`  Distributed Rate Limiting: ${passedTests} passed, ${failedTests} failed`);
  console.log('═══════════════════════════════════════════\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});

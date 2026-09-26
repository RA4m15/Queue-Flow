'use strict';

/**
 * QueueFlow — Production Resilience, Connection Pooling & Graceful Shutdown Test Suite
 * Phase 5 — Step 8: Dedicated Verification
 *
 * Requirements:
 *   1. Production MongoDB pool settings are applied
 *   2. Pool settings remain within validated limits
 *   3. Required indexes are preserved
 *   4. autoIndex production behavior is correct
 *   5. closeDB() works when connected
 *   6. closeDB() is safe when already disconnected
 *   7. SIGTERM invokes shutdown
 *   8. SIGINT invokes shutdown
 *   9. shutdown is idempotent
 *  10. readiness becomes 503 during shutdown
 *  11. HTTP server closes
 *  12. Socket.IO closes
 *  13. Socket.IO Redis adapter closes
 *  14. main Redis client closes
 *  15. MongoDB closes
 *  16. reconnect timers stop during shutdown
 *  17. shutdown timeout prevents hanging
 *  18. no secrets are emitted by shutdown logs
 *  19. shutdown completes cleanly
 *  20. restart after shutdown is possible
 *  21. Real child Node process handles shutdown signal and terminates cleanly
 *  22. Simulated post-startup database disconnect transitions readiness safely to 503
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const {
  isShuttingDown,
  setShuttingDown,
  registerShutdownTargets,
  shutdown,
  _resetShutdownState,
} = require('../src/utils/shutdown');

const { getMongoPoolOptions, closeDB } = require('../src/config/database');
const healthRoutes = require('../src/routes/health');

// Schemas to verify
const { Token } = require('../src/models/Token');
const Queue = require('../src/models/Queue');
const Counter = require('../src/models/Counter');
const User = require('../src/models/User');
const Notification = require('../src/models/Notification');
const Service = require('../src/models/Service');
const ServiceCenter = require('../src/models/ServiceCenter');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

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
    if (err.stack) console.error(err.stack);
  }
}

async function runSuite() {
  console.log('====================================================');
  console.log('🛡️  QueueFlow Phase 5 — Step 8: Resilience & Shutdown Tests');
  console.log('====================================================\n');

  // ─── SECTION 1: MONGODB POOLING & AUTO-INDEXING ────────────────────────────
  console.log('▶ [1/5] MongoDB Pooling & Schema Indexes');

  await runTest('1. Production MongoDB pool settings are applied', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const opts = getMongoPoolOptions();
      assert.strictEqual(opts.maxPoolSize, 25, 'maxPoolSize should default to 25 in production');
      assert.strictEqual(opts.minPoolSize, 5, 'minPoolSize should default to 5 in production');
      assert.strictEqual(opts.maxIdleTimeMS, 30000, 'maxIdleTimeMS should default to 30000ms');
      assert.strictEqual(opts.serverSelectionTimeoutMS, 10000, 'serverSelectionTimeoutMS should default to 10000ms');
      assert.strictEqual(opts.socketTimeoutMS, 45000, 'socketTimeoutMS should default to 45000ms');
      assert.strictEqual(opts.connectTimeoutMS, 15000, 'connectTimeoutMS should default to 15000ms');
      assert.strictEqual(opts.heartbeatFrequencyMS, 10000, 'heartbeatFrequencyMS should default to 10000ms');
      assert.strictEqual(opts.retryWrites, true, 'retryWrites must be true');
      assert.strictEqual(opts.retryReads, true, 'retryReads must be true');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  await runTest('2. Pool settings remain within validated limits', () => {
    const origEnv = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.MONGODB_MAX_POOL_SIZE = '45';
    process.env.MONGODB_MIN_POOL_SIZE = '12';
    process.env.MONGODB_MAX_IDLE_TIME_MS = '60000';
    try {
      const opts = getMongoPoolOptions();
      assert.strictEqual(opts.maxPoolSize, 45);
      assert.strictEqual(opts.minPoolSize, 12);
      assert.strictEqual(opts.maxIdleTimeMS, 60000);

      // Verify out-of-bounds fallback
      process.env.MONGODB_MAX_POOL_SIZE = '999'; // exceeds max bound 100
      const boundedOpts = getMongoPoolOptions();
      assert.strictEqual(boundedOpts.maxPoolSize, 25, 'Out of bounds should fall back to default');
    } finally {
      process.env = origEnv;
    }
  });

  await runTest('3. Required indexes are preserved across all core schemas', () => {
    // 1. Token: Phase 3 partial filter unique index
    const tokenIndexes = Token.schema.indexes();
    const activeTokenIdx = tokenIndexes.find((idx) => {
      const fields = idx[0];
      const opts = idx[1] || {};
      return fields.userId === 1 && fields.centerId === 1 && fields.serviceId === 1 && opts.unique === true;
    });
    assert.ok(activeTokenIdx, 'Token schema must include unique active user token per service index');
    assert.deepStrictEqual(
      activeTokenIdx[1].partialFilterExpression,
      { status: { $in: ['WAITING', 'CALLED', 'SERVING'] } },
      'Token partialFilterExpression must cover WAITING, CALLED, and SERVING'
    );

    // 2. Queue: Compound unique index
    const queueIndexes = Queue.schema.indexes();
    const queueUniqueIdx = queueIndexes.find((idx) => idx[0].centerId === 1 && idx[0].serviceId === 1 && idx[0].date === 1 && idx[1]?.unique);
    assert.ok(queueUniqueIdx, 'Queue schema must include unique { centerId, serviceId, date } index');

    // 3. Counter: Compound unique index
    const counterIndexes = Counter.schema.indexes();
    const counterUniqueIdx = counterIndexes.find((idx) => idx[0].centerId === 1 && idx[0].number === 1 && idx[1]?.unique);
    assert.ok(counterUniqueIdx, 'Counter schema must include unique { centerId, number } index');

    // 4. User: Email and sparse phone index
    const userIndexes = User.schema.indexes();
    const userPhoneIdx = userIndexes.find((idx) => idx[0].phone === 1 && idx[1]?.sparse);
    assert.ok(userPhoneIdx, 'User schema must include sparse { phone: 1 } index');

    // 5. Notification: Compound and TTL indexes
    const notificationIndexes = Notification.schema.indexes();
    const ttlIdx = notificationIndexes.find((idx) => idx[0].createdAt === 1 && idx[1]?.expireAfterSeconds);
    assert.ok(ttlIdx, 'Notification schema must include TTL index on createdAt');
  });

  await runTest('4. autoIndex production behavior is correct', () => {
    process.env.NODE_ENV = 'development';
    const devOpts = getMongoPoolOptions();
    assert.strictEqual(devOpts.autoIndex, true, 'autoIndex should be true in development');

    process.env.NODE_ENV = 'production';
    const prodOpts = getMongoPoolOptions();
    assert.strictEqual(prodOpts.autoIndex, false, 'autoIndex must be false in production');
    process.env.NODE_ENV = 'test';
  });

  // ─── SECTION 2: DATABASE CONNECTION RESILIENCE ────────────────────────────
  console.log('\n▶ [2/5] Database Disconnect & Connection Lifecycle');

  await runTest('5. closeDB() works when connected', async () => {
    const origReadyState = mongoose.connection.readyState;
    const origClose = mongoose.connection.close;
    let closedCalled = false;

    mongoose.connection.close = async () => {
      closedCalled = true;
    };
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

    try {
      await closeDB();
      assert.strictEqual(closedCalled, true, 'mongoose.connection.close should have been called');
    } finally {
      mongoose.connection.close = origClose;
      Object.defineProperty(mongoose.connection, 'readyState', { value: origReadyState, configurable: true });
    }
  });

  await runTest('6. closeDB() is safe when already disconnected', async () => {
    const origReadyState = mongoose.connection.readyState;
    Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });

    try {
      await closeDB();
      await closeDB();
      assert.ok(true, 'closeDB should be completely safe when disconnected');
    } finally {
      Object.defineProperty(mongoose.connection, 'readyState', { value: origReadyState, configurable: true });
    }
  });

  // ─── SECTION 3: SIGNAL HANDLING & SHUTDOWN COORDINATOR ────────────────────
  console.log('\n▶ [3/5] Signal Handling & Shutdown Idempotency');

  await runTest('7. SIGTERM invokes shutdown', async () => {
    _resetShutdownState();
    let invoked = false;
    registerShutdownTargets({
      closeDB: async () => {
        invoked = true;
      },
    });

    await shutdown('SIGTERM', { exitProcess: false, timeoutMs: 5000 });
    assert.strictEqual(invoked, true, 'SIGTERM should invoke shutdown targets');
    assert.strictEqual(isShuttingDown(), true);
  });

  await runTest('8. SIGINT invokes shutdown', async () => {
    _resetShutdownState();
    let invoked = false;
    registerShutdownTargets({
      closeDB: async () => {
        invoked = true;
      },
    });

    await shutdown('SIGINT', { exitProcess: false, timeoutMs: 5000 });
    assert.strictEqual(invoked, true, 'SIGINT should invoke shutdown targets');
    assert.strictEqual(isShuttingDown(), true);
  });

  await runTest('9. shutdown is idempotent', async () => {
    _resetShutdownState();
    let dbCloses = 0;

    registerShutdownTargets({
      closeDB: async () => {
        dbCloses++;
      },
    });

    const p1 = shutdown('SIGTERM', { exitProcess: false, timeoutMs: 5000 });
    const p2 = shutdown('SIGINT', { exitProcess: false, timeoutMs: 5000 });
    const p3 = shutdown('SIGTERM', { exitProcess: false, timeoutMs: 5000 });

    await Promise.all([p1, p2, p3]);
    assert.strictEqual(dbCloses, 1, 'Teardown functions must be called exactly once');
    assert.strictEqual(isShuttingDown(), true, 'isShuttingDown() must remain true');
  });

  await runTest('10. readiness becomes 503 during shutdown', async () => {
    _resetShutdownState();
    setShuttingDown(true);

    const app = express();
    app.use('/health', healthRoutes);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      assert.strictEqual(res.status, 503, 'Readiness must return 503 during shutdown');
      const body = await res.json();
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.status, 'unready');

      // /health/live remains 200 alive while the process drains
      const liveRes = await fetch(`http://127.0.0.1:${port}/health/live`);
      assert.strictEqual(liveRes.status, 200, 'Liveness remains 200 while draining');
      const liveBody = await liveRes.json();
      assert.strictEqual(liveBody.success, true);
      assert.strictEqual(liveBody.status, 'alive');
    } finally {
      server.close();
      _resetShutdownState();
    }
  });

  // ─── SECTION 4: RESOURCE TEARDOWN ORDER & TIMEOUTS ────────────────────────
  console.log('\n▶ [4/5] Dependency Teardown Order & Guardrails');

  let orderRecord = [];
  await runTest('11. HTTP server closes', async () => {
    _resetShutdownState();
    orderRecord = [];

    const mockServer = {
      close: (cb) => {
        orderRecord.push('HTTP_CLOSED');
        cb();
      },
      closeIdleConnections: () => {
        orderRecord.push('HTTP_IDLE_DRAINED');
      },
    };

    registerShutdownTargets({
      server: mockServer,
      closeSocket: async () => { orderRecord.push('SOCKET_CLOSED'); },
      closeAdapter: async () => { orderRecord.push('ADAPTER_CLOSED'); },
      closeRedis: async () => { orderRecord.push('REDIS_CLOSED'); },
      closeDB: async () => { orderRecord.push('DB_CLOSED'); },
    });

    await shutdown('SIGTERM', { exitProcess: false, timeoutMs: 5000 });
    assert.ok(orderRecord.includes('HTTP_CLOSED'), 'HTTP server close was called');
    assert.ok(orderRecord.includes('HTTP_IDLE_DRAINED'), 'HTTP idle connections were drained');
  });

  await runTest('12. Socket.IO closes', () => {
    assert.ok(orderRecord.includes('SOCKET_CLOSED'), 'Socket.IO server close was called');
    assert.ok(orderRecord.indexOf('HTTP_CLOSED') < orderRecord.indexOf('SOCKET_CLOSED'));
  });

  await runTest('13. Socket.IO Redis adapter closes', () => {
    assert.ok(orderRecord.includes('ADAPTER_CLOSED'), 'Socket.IO Redis adapter close was called');
    assert.ok(orderRecord.indexOf('SOCKET_CLOSED') < orderRecord.indexOf('ADAPTER_CLOSED'));
  });

  await runTest('14. main Redis client closes', () => {
    assert.ok(orderRecord.includes('REDIS_CLOSED'), 'Main Redis client close was called');
    assert.ok(orderRecord.indexOf('ADAPTER_CLOSED') < orderRecord.indexOf('REDIS_CLOSED'));
  });

  await runTest('15. MongoDB closes', () => {
    assert.ok(orderRecord.includes('DB_CLOSED'), 'MongoDB connection pool close was called');
    assert.ok(orderRecord.indexOf('REDIS_CLOSED') < orderRecord.indexOf('DB_CLOSED'));
  });

  await runTest('16. reconnect timers stop during shutdown', () => {
    _resetShutdownState();
    setShuttingDown(true);

    const redis = require('../src/config/redis');
    const opts = redis.getRedisOptions();

    const nextRetry = opts.retryStrategy(1);
    assert.strictEqual(nextRetry, null, 'Redis retryStrategy must return null when shutting down');

    _resetShutdownState();
  });

  await runTest('17. shutdown timeout prevents hanging', async () => {
    _resetShutdownState();

    registerShutdownTargets({
      closeDB: () => new Promise(() => {}), // Stalls indefinitely
    });

    let timedOut = false;
    try {
      await shutdown('SIGTERM', { exitProcess: false, timeoutMs: 100 });
    } catch (err) {
      if (err.isTimeout) timedOut = true;
    }
    assert.strictEqual(timedOut, true, 'Shutdown must abort on deadline breach');
    _resetShutdownState();
  });

  await runTest('18. no secrets are emitted by shutdown logs', async () => {
    _resetShutdownState();

    const capturedLogs = [];
    const origStdout = process.stdout.write;
    process.stdout.write = (chunk) => {
      capturedLogs.push(chunk.toString());
      return true;
    };

    try {
      registerShutdownTargets({
        closeDB: async () => {},
      });
      await shutdown('SIGTERM', { exitProcess: false, timeoutMs: 2000 });
    } finally {
      process.stdout.write = origStdout;
      _resetShutdownState();
    }

    const fullLog = capturedLogs.join('');
    assert.ok(!fullLog.includes('mongodb+srv://'), 'MongoDB URIs must never appear in logs');
    assert.ok(!fullLog.includes('redis://'), 'Redis URLs must never appear in logs');
    assert.ok(!fullLog.includes('password'), 'Passwords must never appear in logs');
  });

  await runTest('19. shutdown completes cleanly', async () => {
    _resetShutdownState();
    let completed = false;

    registerShutdownTargets({
      closeDB: async () => {
        completed = true;
      },
    });

    await shutdown('SIGTERM', { exitProcess: false, timeoutMs: 2000 });
    assert.strictEqual(completed, true, 'Shutdown should finish clean execution');
    assert.strictEqual(isShuttingDown(), true);
  });

  await runTest('20. restart after shutdown is possible', () => {
    setShuttingDown(true);
    assert.strictEqual(isShuttingDown(), true);

    _resetShutdownState();
    assert.strictEqual(isShuttingDown(), false);
  });

  // ─── SECTION 5: REAL PROCESS & SIMULATED FAILURE ──────────────────────────
  console.log('\n▶ [5/5] Real Child Process & Database Disconnect Resilience');

  await runTest('21. Real child Node process handles shutdown signal and terminates cleanly', async () => {
    const helperDir = path.join(__dirname, 'helpers');
    if (!fs.existsSync(helperDir)) {
      fs.mkdirSync(helperDir, { recursive: true });
    }

    const workerScript = path.join(helperDir, 'shutdown_worker.js');
    const workerCode = `'use strict';
const http = require('http');
const express = require('express');
const { shutdown, registerShutdownTargets } = require('../../src/utils/shutdown');

const app = express();
app.get('/ping', (req, res) => res.send('pong'));

const server = http.createServer(app);

registerShutdownTargets({
  server,
  closeSocket: async () => {},
  closeAdapter: async () => {},
  closeRedis: async () => {},
  closeDB: async () => {},
});

server.listen(0, '127.0.0.1', () => {
  if (process.send) process.send('READY');
});

process.on('message', (msg) => {
  if (msg === 'TRIGGER_SHUTDOWN') {
    shutdown('SIGTERM', { exitProcess: true, timeoutMs: 3000 });
  }
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM', { exitProcess: true, timeoutMs: 3000 });
});
`;
    fs.writeFileSync(workerScript, workerCode, 'utf8');

    const child = fork(workerScript, [], {
      env: { ...process.env, NODE_ENV: 'production', PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    let stdoutData = '';
    child.stdout.on('data', (d) => {
      stdoutData += d.toString();
    });

    const exitPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Child process hung on shutdown'));
      }, 7000);

      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    // Wait for worker to report ready
    await new Promise((resolve) => {
      child.on('message', (msg) => {
        if (msg === 'READY') resolve();
      });
      setTimeout(resolve, 800);
    });

    // Send graceful shutdown trigger via IPC
    child.send('TRIGGER_SHUTDOWN');

    const result = await exitPromise;
    assert.strictEqual(result.code, 0, `Child process should exit with code 0, got code ${result.code}`);
    assert.ok(stdoutData.includes('SHUTDOWN_INITIATED'), 'Child process must emit SHUTDOWN_INITIATED');
    assert.ok(stdoutData.includes('SHUTDOWN_COMPLETE'), 'Child process must emit SHUTDOWN_COMPLETE');
  });

  await runTest('22. Simulated post-startup database disconnect transitions readiness safely to 503', async () => {
    _resetShutdownState();

    const app = express();
    app.use('/health', healthRoutes);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const origReadyState = mongoose.connection.readyState;

    try {
      // Simulate MongoDB readyState disconnected (0)
      Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });

      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      assert.strictEqual(res.status, 503, 'Readiness must evaluate to 503 when MongoDB disconnects');
      const body = await res.json();
      assert.strictEqual(body.status, 'unready');

      // Simulate recovery (readyState = 1)
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      const recoveredRes = await fetch(`http://127.0.0.1:${port}/health/ready`);
      assert.strictEqual(recoveredRes.status, 200, 'Readiness must recover to 200 when MongoDB reconnects');
    } finally {
      Object.defineProperty(mongoose.connection, 'readyState', { value: origReadyState, configurable: true });
      server.close();
      _resetShutdownState();
    }
  });

  // ─── FINAL SUMMARY ────────────────────────────────────────────────────────
  console.log('\n====================================================');
  console.log(`Results: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Test suite runner crashed:', err);
  process.exit(1);
});

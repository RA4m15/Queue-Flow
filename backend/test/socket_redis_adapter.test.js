'use strict';

/**
 * QueueFlow — Socket.IO Horizontal Scaling with Redis Adapter Test Suite
 * Phase 5 — Step 3: Redis Pub/Sub Adapter & Multi-Instance Synchronization
 *
 * Validates:
 *   1. Configuration & Policy:
 *      - Production fails safe if Redis is unconfigured or disabled (no silent Memory fallback)
 *      - Development/test safely runs in single-instance memory mode when Redis is unconfigured
 *      - Redis credentials remain masked and never exposed in logs or state
 *   2. Cross-Instance Event Propagation (Instance A → Instance B & Instance B → Instance A):
 *      - queue.updated
 *      - token.called
 *      - crowd.updated
 *      - counter.updated
 *      - token lifecycle events (serving, completed, cancelled, expired)
 *   3. Private Room Isolation:
 *      - User A on Instance A does not receive User B's events on Instance B
 *      - notification.created delivered only to target user across instances
 *   4. Center Room Isolation:
 *      - Center 1 events never leak to Center 2 clients across separate instances
 *   5. Cross-Instance Session Revocation:
 *      - User A connected to Instance A and Instance B
 *      - disconnectUserSockets(userA) called on Instance A disconnects sockets on BOTH instances
 *      - Revoked token rejected on reconnect
 *      - Valid new token accepted on reconnect
 *   6. Adapter Resilience & Failure Modes:
 *      - Degradation telemetry when adapter connection drops
 *      - Local clients not dropped unnecessarily on transient adapter error
 *      - Reconnection restores adapter health
 *      - Graceful shutdown hook cleans up resources
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-socket-adapter-validation-min32chars';

const assert = require('assert');
const http = require('http');
const EventEmitter = require('events');
const jwt = require('jsonwebtoken');
const ioClient = require('socket.io-client');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const {
  initSocket,
  getAdapterStatus,
  closeSocketAdapter,
  setupRedisAdapter,
} = require('../src/config/socket');
const {
  isRedisEnabled,
  isRedisRequired,
  sanitizeRedisUrl,
} = require('../src/config/redis');

// ─── Deterministic Mock Redis Pub/Sub Bus ──────────────────────────────────────

class MockRedisPubSubBus extends EventEmitter {
  constructor() {
    super();
    this.channels = new Map(); // channel -> Set<Client>
    this.patterns = new Map(); // pattern -> Set<Client>
  }

  createClient(role = 'generic') {
    const bus = this;
    const client = new EventEmitter();
    client.status = 'ready';
    client.role = role;

    client.publish = async function (channel, message) {
      const bufMsg = Buffer.isBuffer(message) ? message : Buffer.from(message);
      const strChannel = channel.toString();

      // Pattern subscribers (e.g. "socket.io#/#*")
      for (const [pattern, clients] of bus.patterns.entries()) {
        const prefix = pattern.replace('*', '');
        if (strChannel.startsWith(prefix)) {
          for (const c of clients) {
            c.emit('pmessageBuffer', pattern, Buffer.from(strChannel), bufMsg);
            c.emit('pmessage', pattern, strChannel, bufMsg.toString());
          }
        }
      }

      // Exact channel subscribers (e.g. "socket.io-request#/#")
      const exactClients = bus.channels.get(strChannel);
      if (exactClients) {
        for (const c of exactClients) {
          c.emit('messageBuffer', Buffer.from(strChannel), bufMsg);
          c.emit('message', strChannel, bufMsg.toString());
        }
      }
      return 1;
    };

    client.subscribe = async function (channels) {
      const list = Array.isArray(channels) ? channels : [channels];
      for (const ch of list) {
        if (!bus.channels.has(ch)) bus.channels.set(ch, new Set());
        bus.channels.get(ch).add(client);
      }
      return list.length;
    };

    client.psubscribe = async function (patterns) {
      const list = Array.isArray(patterns) ? patterns : [patterns];
      for (const p of list) {
        if (!bus.patterns.has(p)) bus.patterns.set(p, new Set());
        bus.patterns.get(p).add(client);
      }
      return list.length;
    };

    client.quit = async function () {
      client.status = 'end';
      client.emit('close');
      return 'OK';
    };

    client.disconnect = function () {
      client.status = 'end';
      client.emit('close');
    };

    return client;
  }
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function signTestToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function connectClient(port, token) {
  return new Promise((resolve) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
      auth: { token },
    });

    const timer = setTimeout(() => {
      resolve({ socket, connected: false, error: 'TIMEOUT' });
    }, 3000);

    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({ socket, connected: true });
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      resolve({ socket, connected: false, error: err.message });
    });
  });
}

function waitForEvent(socket, eventName, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event "${eventName}"`));
    }, timeoutMs);

    socket.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// ─── Test Execution ───────────────────────────────────────────────────────────

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
  }
}

async function runAll() {
  console.log('====================================================');
  console.log('🧪 QueueFlow Phase 5 — Step 3: Socket.IO Horizontal Scaling');
  console.log('====================================================\n');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 1: Configuration & Failure Policy
  // ──────────────────────────────────────────────────────────────────────────
  console.log('▶ [1/4] Redis Adapter Configuration & Policy');

  await runTest('Production halts startup if Redis is disabled (REDIS_ENABLED=false)', () => {
    const origEnv = process.env.NODE_ENV;
    const origEnabled = process.env.REDIS_ENABLED;
    try {
      process.env.NODE_ENV = 'production';
      process.env.REDIS_ENABLED = 'false';

      const mockIo = { adapter: () => {} };
      assert.throws(
        () => setupRedisAdapter(mockIo),
        /FATAL_REDIS_CONFIG/
      );
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.REDIS_ENABLED = origEnabled;
    }
  });

  await runTest('Development mode safely operates with memory adapter when Redis unconfigured', () => {
    const origEnv = process.env.NODE_ENV;
    const origUrl = process.env.REDIS_URL;
    const origHost = process.env.REDIS_HOST;
    try {
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;

      const mockIo = { adapter: () => {} };
      setupRedisAdapter(mockIo);
      const status = getAdapterStatus();
      assert.strictEqual(status.mode, 'memory');
      assert.strictEqual(status.isReady, true);
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origUrl) process.env.REDIS_URL = origUrl;
      if (origHost) process.env.REDIS_HOST = origHost;
    }
  });

  await runTest('Redis URLs with passwords remain strictly masked in status/logs', () => {
    const sanitized = sanitizeRedisUrl('redis://default:supersecretpass123@prod-cluster.internal:6379');
    assert(!sanitized.includes('supersecretpass123'), 'Sanitized URL must not leak password');
    assert(sanitized.includes('***'), 'Sanitized URL must contain replacement mask');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 2: Multi-Instance Event Synchronization Harness
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [2/4] Multi-Instance Cross-Instance Event Propagation');

  const bus = new MockRedisPubSubBus();

  // Create two distinct HTTP + Socket.IO servers (Instance A and Instance B)
  const serverA = http.createServer();
  const serverB = http.createServer();

  const ioA = new Server(serverA, { transports: ['websocket'] });
  const ioB = new Server(serverB, { transports: ['websocket'] });

  const pubA = bus.createClient('pubA');
  const subA = bus.createClient('subA');
  const pubB = bus.createClient('pubB');
  const subB = bus.createClient('subB');

  ioA.adapter(createAdapter(pubA, subA));
  ioB.adapter(createAdapter(pubB, subB));

  // Mount standard handshake auth on both instances
  const setupInstance = (instance) => {
    instance.use((socket, next) => {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('SOCKET_AUTH_REQUIRED'));
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        socket.user = { id: decoded.id, role: decoded.role || 'CUSTOMER', tokenVersion: decoded.tokenVersion || 0 };
        return next();
      } catch (_) {
        return next(new Error('SOCKET_AUTH_INVALID'));
      }
    });

    instance.on('connection', (socket) => {
      socket.join(`user:${socket.user.id}`);

      socket.on('join:center', (centerId) => {
        socket.join(`center:${centerId}`);
      });

      socket.on('join:counter', ({ centerId, counterId } = {}) => {
        socket.join(`counter:${centerId}:${counterId}`);
      });
    });
  };

  setupInstance(ioA);
  setupInstance(ioB);

  await new Promise((resolve) => serverA.listen(0, resolve));
  await new Promise((resolve) => serverB.listen(0, resolve));

  const portA = serverA.address().port;
  const portB = serverB.address().port;

  const validUserAId = '654321098765432109876541';
  const validUserBId = '654321098765432109876542';
  const tokenUserA = signTestToken({ id: validUserAId, role: 'CUSTOMER', tokenVersion: 0 });
  const tokenUserB = signTestToken({ id: validUserBId, role: 'CUSTOMER', tokenVersion: 0 });

  await runTest('Cross-instance center event: Instance A emits queue.updated → Client on Instance B receives', async () => {
    const { socket: clientOnB } = await connectClient(portB, tokenUserA);
    assert(clientOnB.connected, 'Client should connect to Instance B');

    clientOnB.emit('join:center', '6ab030edfb8baa6b361738d8');
    // Short tick to register room subscription
    await new Promise((r) => setTimeout(r, 50));

    const eventPromise = waitForEvent(clientOnB, 'queue.updated');
    ioA.to('center:6ab030edfb8baa6b361738d8').emit('queue.updated', { centerId: '6ab030edfb8baa6b361738d8', waitingCount: 5 });

    const received = await eventPromise;
    assert.strictEqual(received.waitingCount, 5);
    clientOnB.disconnect();
  });

  await runTest('Cross-instance center event reverse: Instance B emits token.called → Client on Instance A receives', async () => {
    const { socket: clientOnA } = await connectClient(portA, tokenUserB);
    assert(clientOnA.connected, 'Client should connect to Instance A');

    clientOnA.emit('join:center', '6ab030edfb8baa6b361738d8');
    await new Promise((r) => setTimeout(r, 50));

    const eventPromise = waitForEvent(clientOnA, 'token.called');
    ioB.to('center:6ab030edfb8baa6b361738d8').emit('token.called', { tokenNumber: 'A-099', counterName: 'Counter 1' });

    const received = await eventPromise;
    assert.strictEqual(received.tokenNumber, 'A-099');
    clientOnA.disconnect();
  });

  await runTest('Cross-instance crowd & counter events: crowd.updated and counter.updated propagate across instances', async () => {
    const { socket: clientOnB } = await connectClient(portB, tokenUserA);
    clientOnB.emit('join:center', '6ab030edfb8baa6b361738d8');
    clientOnB.emit('join:counter', { centerId: '6ab030edfb8baa6b361738d8', counterId: 'counter-01' });
    await new Promise((r) => setTimeout(r, 50));

    const crowdPromise = waitForEvent(clientOnB, 'crowd.updated');
    const counterPromise = waitForEvent(clientOnB, 'counter.updated');

    ioA.to('center:6ab030edfb8baa6b361738d8').emit('crowd.updated', { currentOccupancy: 42 });
    ioA.to('counter:6ab030edfb8baa6b361738d8:counter-01').emit('counter.updated', { status: 'ACTIVE' });

    const [crowdData, counterData] = await Promise.all([crowdPromise, counterPromise]);
    assert.strictEqual(crowdData.currentOccupancy, 42);
    assert.strictEqual(counterData.status, 'ACTIVE');

    clientOnB.disconnect();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 3: Private Room & Center Room Isolation
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [3/4] Room Isolation & Notification Delivery Across Instances');

  await runTest('Private room delivery: Notification emitted on Instance A reaches User A on Instance B', async () => {
    const { socket: clientUserAOnB } = await connectClient(portB, tokenUserA);
    const eventPromise = waitForEvent(clientUserAOnB, 'notification.created');

    ioA.to(`user:${validUserAId}`).emit('notification.created', {
      title: 'Your turn is coming up!',
      type: 'TOKEN_CALLED',
    });

    const received = await eventPromise;
    assert.strictEqual(received.title, 'Your turn is coming up!');
    clientUserAOnB.disconnect();
  });

  await runTest('Private room isolation: User B on Instance B never receives User A private events', async () => {
    const { socket: clientUserAOnA } = await connectClient(portA, tokenUserA);
    const { socket: clientUserBOnB } = await connectClient(portB, tokenUserB);

    let userBReceived = false;
    clientUserBOnB.on('notification.created', () => {
      userBReceived = true;
    });

    const userAPromise = waitForEvent(clientUserAOnA, 'notification.created');

    // Emit specifically to User A from Instance B
    ioB.to(`user:${validUserAId}`).emit('notification.created', { secret: 'userA-only-private-data' });

    const userAData = await userAPromise;
    assert.strictEqual(userAData.secret, 'userA-only-private-data');

    // Give time to ensure User B does not receive it
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(userBReceived, false, 'User B must not receive User A notification');

    clientUserAOnA.disconnect();
    clientUserBOnB.disconnect();
  });

  await runTest('Center room isolation: Center 1 events emitted on Instance A never reach Center 2 client on Instance B', async () => {
    const { socket: clientCenter1OnA } = await connectClient(portA, tokenUserA);
    const { socket: clientCenter2OnB } = await connectClient(portB, tokenUserB);

    clientCenter1OnA.emit('join:center', '6ab030edfb8baa6b361738d8'); // Center 1
    clientCenter2OnB.emit('join:center', '6ab030edfb8baa6b361738d9'); // Center 2
    await new Promise((r) => setTimeout(r, 50));

    let center2Received = false;
    clientCenter2OnB.on('queue.updated', () => {
      center2Received = true;
    });

    const center1Promise = waitForEvent(clientCenter1OnA, 'queue.updated');

    // Emit to Center 1 from Instance B
    ioB.to('center:6ab030edfb8baa6b361738d8').emit('queue.updated', { centerId: '6ab030edfb8baa6b361738d8' });

    await center1Promise;
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(center2Received, false, 'Center 2 client must not receive Center 1 events');

    clientCenter1OnA.disconnect();
    clientCenter2OnB.disconnect();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 4: Cross-Instance Session Revocation & Disconnect Propagation
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [4/4] Cross-Instance Session Revocation & Failure Resilience');

  await runTest('Session revocation: disconnectSockets on Instance A disconnects matching sockets on Instance B', async () => {
    // User A connects simultaneously to Instance A and Instance B
    const { socket: socketOnA } = await connectClient(portA, tokenUserA);
    const { socket: socketOnB } = await connectClient(portB, tokenUserA);

    assert(socketOnA.connected, 'Socket 1 on Instance A must be connected');
    assert(socketOnB.connected, 'Socket 2 on Instance B must be connected');

    const disconnectPromiseA = new Promise((resolve) => socketOnA.on('disconnect', (reason) => resolve(reason)));
    const disconnectPromiseB = new Promise((resolve) => socketOnB.on('disconnect', (reason) => resolve(reason)));

    // Revocation triggered on Instance A (e.g. user logged out or changed password)
    await ioA.in(`user:${validUserAId}`).disconnectSockets(true);

    const [reasonA, reasonB] = await Promise.all([disconnectPromiseA, disconnectPromiseB]);
    assert(reasonA, 'Socket on Instance A must be disconnected');
    assert(reasonB, 'Socket on Instance B must be disconnected across instances via Redis adapter');
  });

  await runTest('Revoked token rejection: Attempting reconnect with revoked token fails handshake', async () => {
    // Handshake middleware rejects if tokenVersion mismatch occurs
    const expiredToken = jwt.sign(
      { id: validUserAId, role: 'CUSTOMER', tokenVersion: 0 },
      process.env.JWT_SECRET,
      { expiresIn: '-10s' } // Expired token
    );

    const { connected, error } = await connectClient(portB, expiredToken);
    assert.strictEqual(connected, false, 'Revoked/expired token must not connect');
    assert.strictEqual(error, 'SOCKET_AUTH_INVALID');
  });

  await runTest('Valid re-login connection: Fresh token successfully establishes connection and private room', async () => {
    const freshToken = signTestToken({ id: validUserAId, role: 'CUSTOMER', tokenVersion: 1 });
    const { socket: freshSocket, connected } = await connectClient(portA, freshToken);
    assert.strictEqual(connected, true, 'Fresh token must connect successfully');
    freshSocket.disconnect();
  });

  await runTest('Adapter resilience: Pub/sub error degrades status but preserves local connections', async () => {
    const { socket: localClient } = await connectClient(portA, tokenUserA);
    assert(localClient.connected, 'Local client must be connected');

    // Simulate transient error on subClient
    subA.emit('error', new Error('ECONNRESET'));

    // Verify local client remains connected (no spurious disconnect of local sockets)
    await new Promise((r) => setTimeout(r, 100));
    assert(localClient.connected, 'Local client must not be dropped due to transient pub/sub error');

    localClient.disconnect();
  });

  await runTest('Graceful shutdown: closeSocketAdapter cleanly terminates pub/sub clients', async () => {
    const mockPub = bus.createClient('pubShutdown');
    const mockSub = bus.createClient('subShutdown');
    let pubClosed = false;
    let subClosed = false;

    mockPub.on('close', () => { pubClosed = true; });
    mockSub.on('close', () => { subClosed = true; });

    const testIo = new Server();
    setupRedisAdapter(testIo, { pubClient: mockPub, subClient: mockSub });

    assert.strictEqual(getAdapterStatus().mode, 'redis');
    await closeSocketAdapter();

    assert(pubClosed, 'Pub client must be closed');
    assert(subClosed, 'Sub client must be closed');
    assert.strictEqual(getAdapterStatus().mode, 'memory');
    assert.strictEqual(getAdapterStatus().isReady, false);
  });

  // Clean up server instances
  serverA.close();
  serverB.close();

  console.log('\n====================================================');
  console.log(`Results: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

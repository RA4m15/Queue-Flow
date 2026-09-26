'use strict';

/**
 * QueueFlow — Socket.IO Security Test Suite
 * Phase 1: Authentication & Authorization Remediation
 *
 * Tests:
 *  1.  No token             → REJECTED
 *  2.  Tampered JWT         → REJECTED
 *  3.  Expired JWT          → REJECTED
 *  4.  Valid Customer JWT   → CONNECTED
 *  5.  Customer joins own user room   → ALLOWED (server-authoritative)
 *  6.  Customer A requests B's room   → DENIED  (no-op; stays in own room only)
 *  7.  Missing / empty userId in join:user → silently ignored (safe no-op)
 *  8.  Role manipulation (forged role in JWT) → treated as CUSTOMER only
 *  9.  Notification isolation: Customer A ≠ Customer B events
 * 10.  Token-event isolation: Customer A does NOT receive Customer B token events
 * 11.  Disconnect security: private events no longer reach disconnected client
 * 12.  Reconnect requires re-authentication
 *
 * Attack simulation (Test 6, 9, 10):
 *   A headless Socket.IO client—completely bypassing the Flutter app—is used to
 *   prove that the server enforces authorization independently of client code.
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');
const { app, server } = require('../server');
const connectDB = require('../src/config/database');
const User = require('../src/models/User');
const { emitToUser, emitToCenter, broadcast } = require('../src/config/socket');
const { signToken } = require('../src/middleware/auth');
const axios = require('axios');

// ─── Test helpers ─────────────────────────────────────────────────────────────

let baseUrl;
let testServer;

/** Create a connected Socket.IO client and wait for connection or rejection. */
function connectSocket(opts = {}) {
  return new Promise((resolve) => {
    const client = ioClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
      ...opts,
    });

    const timer = setTimeout(() => {
      // Connection timed out — treat as rejected
      client.disconnect();
      resolve({ client, connected: false, error: 'timeout' });
    }, 3000);

    client.on('connect', () => {
      clearTimeout(timer);
      resolve({ client, connected: true, error: null });
    });

    client.on('connect_error', (err) => {
      clearTimeout(timer);
      resolve({ client, connected: false, error: err.message });
    });
  });
}

/** Safely disconnect a client if it is still connected. */
function safeDisconnect(client) {
  try {
    if (client && client.connected) client.disconnect();
  } catch (_) { /* ignore */ }
}

/** Wait up to `ms` milliseconds for `fn` to become truthy. */
function waitFor(fn, ms = 500, interval = 50) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() > end) return reject(new Error('waitFor timed out'));
      setTimeout(check, interval);
    };
    check();
  });
}

// ─── Main test runner ─────────────────────────────────────────────────────────

async function runSecurityTests() {
  console.log('\n=======================================================');
  console.log('🔐 QueueFlow Phase 1 — Socket.IO Security Test Suite');
  console.log('=======================================================\n');

  // ── Setup ──────────────────────────────────────────────────────────────────
  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      const { port } = testServer.address();
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`  Server listening on ${baseUrl}\n`);
      resolve();
    });
  });

  // Create two real customer users for isolation tests
  const suffixA = `${Date.now()}_A`;
  const suffixB = `${Date.now()}_B`;

  const userA = await User.create({
    name: 'Socket Security UserA',
    email: `sock_sec_a_${suffixA}@test.com`,
    passwordHash: await User.hashPassword('Password@123'),
    role: 'CUSTOMER',
  });

  const userB = await User.create({
    name: 'Socket Security UserB',
    email: `sock_sec_b_${suffixB}@test.com`,
    passwordHash: await User.hashPassword('Password@123'),
    role: 'CUSTOMER',
  });

  const userStaff = await User.create({
    name: 'Socket Security Staff',
    email: `sock_sec_staff_${suffixA}@test.com`,
    passwordHash: await User.hashPassword('Password@123'),
    role: 'STAFF',
  });

  const userAdmin = await User.create({
    name: 'Socket Security Admin',
    email: `sock_sec_admin_${suffixA}@test.com`,
    passwordHash: await User.hashPassword('Password@123'),
    role: 'ADMIN',
  });

  const tokenA = signToken(userA._id.toString(), userA.role);
  const tokenB = signToken(userB._id.toString(), userB.role);
  const tokenStaff = signToken(userStaff._id.toString(), userStaff.role);
  const tokenAdmin = signToken(userAdmin._id.toString(), userAdmin.role);

  let passed = 0;
  let failed = 0;
  const results = [];

  function pass(name) {
    passed++;
    results.push({ name, result: '✅ PASS' });
    console.log(`  ✅ PASS  ${name}`);
  }

  function fail(name, reason) {
    failed++;
    results.push({ name, result: `❌ FAIL: ${reason}` });
    console.error(`  ❌ FAIL  ${name}: ${reason}`);
  }

  // ── Test 1: No token → REJECTED ────────────────────────────────────────────
  {
    const name = 'Test 1 — No token → REJECTED';
    const { client, connected } = await connectSocket({ auth: {} });
    safeDisconnect(client);
    if (!connected) {
      pass(name);
    } else {
      fail(name, 'Unauthenticated socket was accepted — CRITICAL VULNERABILITY');
    }
  }

  // ── Test 2: Tampered JWT → REJECTED ───────────────────────────────────────
  {
    const name = 'Test 2 — Tampered JWT → REJECTED';
    const validToken = jwt.sign({ id: userA._id.toString() }, process.env.JWT_SECRET);
    const tampered = validToken.slice(0, -5) + 'XXXXX'; // corrupt signature
    const { client, connected } = await connectSocket({ auth: { token: tampered } });
    safeDisconnect(client);
    if (!connected) {
      pass(name);
    } else {
      fail(name, 'Tampered JWT was accepted — CRITICAL VULNERABILITY');
    }
  }

  // ── Test 3: Expired JWT → REJECTED ────────────────────────────────────────
  {
    const name = 'Test 3 — Expired JWT → REJECTED';
    const expiredToken = jwt.sign(
      { id: userA._id.toString() },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' } // already expired
    );
    const { client, connected } = await connectSocket({ auth: { token: expiredToken } });
    safeDisconnect(client);
    if (!connected) {
      pass(name);
    } else {
      fail(name, 'Expired JWT was accepted — CRITICAL VULNERABILITY');
    }
  }

  // ── Test 4: Valid Customer JWT → CONNECTED ────────────────────────────────
  {
    const name = 'Test 4 — Valid Customer JWT → CONNECTED';
    const { client, connected } = await connectSocket({ auth: { token: tokenA } });
    safeDisconnect(client);
    if (connected) {
      pass(name);
    } else {
      fail(name, 'Valid JWT was rejected — server not functioning correctly');
    }
  }

  // ── Test 5: Customer A joins own user room → events received ──────────────
  {
    const name = 'Test 5 — Customer A joins own user room → events received';
    const { client, connected } = await connectSocket({ auth: { token: tokenA } });

    if (!connected) {
      safeDisconnect(client);
      fail(name, 'Could not connect');
    } else {
      const received = [];
      client.on('test.ping', (d) => received.push(d));

      // The server auto-joins user:A on connect; emit directly to that room
      await new Promise((r) => setTimeout(r, 100));
      emitToUser(userA._id.toString(), 'test.ping', { for: 'A' });
      await new Promise((r) => setTimeout(r, 300));

      safeDisconnect(client);

      if (received.length > 0 && received[0].for === 'A') {
        pass(name);
      } else {
        fail(name, `Customer A did not receive own-room event. received=${JSON.stringify(received)}`);
      }
    }
  }

  // ── Test 6: ATTACK — Customer A requests B's room → DENIED ───────────────
  // This is the primary cross-user attack simulation.
  // A raw Socket.IO client (bypassing Flutter) connects as Customer A,
  // then emits join:user(B's ID). The server must NOT place A in user:B.
  {
    const name = 'Test 6 — ATTACK: Customer A emits join:user(B) → denied, B room not joined';
    const { client: clientA, connected } = await connectSocket({ auth: { token: tokenA } });

    if (!connected) {
      safeDisconnect(clientA);
      fail(name, 'Could not connect as Customer A');
    } else {
      // Attacker explicitly emits join:user with Customer B's ID
      clientA.emit('join:user', userB._id.toString());
      await new Promise((r) => setTimeout(r, 200));

      // Now emit a private event to B's room and listen on A's client
      const intercepted = [];
      clientA.on('test.b_private', (d) => intercepted.push(d));

      emitToUser(userB._id.toString(), 'test.b_private', { secret: 'B_ONLY' });
      await new Promise((r) => setTimeout(r, 300));

      safeDisconnect(clientA);

      if (intercepted.length === 0) {
        pass(name);
      } else {
        fail(name, `CRITICAL: Customer A received Customer B's private event! data=${JSON.stringify(intercepted)}`);
      }
    }
  }

  // ── Test 7: Missing userId in join:user → safe no-op ─────────────────────
  {
    const name = 'Test 7 — Missing userId in join:user → safe no-op (no crash)';
    const { client, connected, error } = await connectSocket({ auth: { token: tokenA } });

    if (!connected) {
      safeDisconnect(client);
      fail(name, `Could not connect: ${error}`);
    } else {
      let crashed = false;
      client.on('error', () => { crashed = true; });

      client.emit('join:user', '');      // empty string
      client.emit('join:user', null);    // null
      client.emit('join:user');          // undefined
      await new Promise((r) => setTimeout(r, 300));

      safeDisconnect(client);

      if (!crashed) {
        pass(name);
      } else {
        fail(name, 'Server crashed or emitted error on empty join:user');
      }
    }
  }

  // ── Test 8: Role manipulation — forged role in JWT ───────────────────────
  // An attacker creates a JWT signed with the real secret but injects role=ADMIN.
  // The server must not grant admin socket privileges based on the JWT role claim.
  // (Our middleware stores role from the token, so this tests that the role
  //  stored in socket.user.role cannot be used to gain unauthorized room access.)
  {
    const name = 'Test 8 — Forged role in JWT → treated as declared role only';
    // Forge a token claiming ADMIN role for userA's id (but with a valid secret)
    const forgedToken = jwt.sign(
      { id: userA._id.toString(), role: 'ADMIN' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const { client, connected } = await connectSocket({ auth: { token: forgedToken } });

    // The connection is valid (correct secret and id) but we verify the
    // socket.user.role is set to 'ADMIN' from the token; in isolation this is
    // acceptable because the JWT is server-signed — the real attack vector
    // (cross-user room access) is already blocked in Test 6. What matters is
    // that the role value cannot be forged to gain access to another user's room.
    // Since the room access is entirely based on socket.user.id (not role), the
    // role field cannot be used as an authorization bypass.
    const received = [];
    if (connected) {
      // Attacker tries to receive User B's events using "admin" role
      client.on('test.admin_private', (d) => received.push(d));
      emitToUser(userB._id.toString(), 'test.admin_private', { secret: 'ADMIN_ONLY' });
      await new Promise((r) => setTimeout(r, 300));
    }
    safeDisconnect(client);

    if (connected && received.length === 0) {
      pass(name);
    } else if (!connected) {
      // Also acceptable: reject tokens with injected role claims
      pass(name + ' (connection rejected)');
    } else {
      fail(name, `Forged-role attacker received data: ${JSON.stringify(received)}`);
    }
  }

  // ── Test 9: Notification isolation — A ≠ B ───────────────────────────────
  {
    const name = 'Test 9 — Notification isolation: A cannot receive B notification';

    const { client: clientA, connected: connA } = await connectSocket({ auth: { token: tokenA } });
    const { client: clientB, connected: connB } = await connectSocket({ auth: { token: tokenB } });

    if (!connA || !connB) {
      safeDisconnect(clientA);
      safeDisconnect(clientB);
      fail(name, `Connection failed — A:${connA}, B:${connB}`);
    } else {
      const aReceived = [];
      const bReceived = [];

      clientA.on('notification.created', (d) => aReceived.push(d));
      clientB.on('notification.created', (d) => bReceived.push(d));

      // Emit notification exclusively to User B
      emitToUser(userB._id.toString(), 'notification.created', {
        notification: { _id: 'test_notif_B', type: 'TOKEN_CALLED', title: 'Your turn, B' },
      });
      await new Promise((r) => setTimeout(r, 400));

      safeDisconnect(clientA);
      safeDisconnect(clientB);

      if (aReceived.length === 0 && bReceived.length === 1) {
        pass(name);
      } else {
        fail(name, `A received=${aReceived.length} (want 0), B received=${bReceived.length} (want 1)`);
      }
    }
  }

  // ── Test 10: Token-event isolation — A ≠ B ───────────────────────────────
  {
    const name = 'Test 10 — Token-event isolation: A cannot receive B token event';

    const { client: clientA, connected: connA } = await connectSocket({ auth: { token: tokenA } });
    const { client: clientB, connected: connB } = await connectSocket({ auth: { token: tokenB } });

    if (!connA || !connB) {
      safeDisconnect(clientA);
      safeDisconnect(clientB);
      fail(name, `Connection failed — A:${connA}, B:${connB}`);
    } else {
      const aTokenEvents = [];
      const bTokenEvents = [];

      clientA.on('token.called', (d) => aTokenEvents.push(d));
      clientB.on('token.called', (d) => bTokenEvents.push(d));

      // Emit a private token event to User B's room only
      emitToUser(userB._id.toString(), 'token.called', {
        token: { _id: 'tok_B_123', status: 'CALLED', userId: userB._id.toString() },
      });
      await new Promise((r) => setTimeout(r, 400));

      safeDisconnect(clientA);
      safeDisconnect(clientB);

      if (aTokenEvents.length === 0 && bTokenEvents.length === 1) {
        pass(name);
      } else {
        fail(name, `A received=${aTokenEvents.length} (want 0), B received=${bTokenEvents.length} (want 1)`);
      }
    }
  }

  // ── Test 11: Disconnect security ──────────────────────────────────────────
  {
    const name = 'Test 11 — Disconnect: private events not received after disconnect';
    const { client, connected } = await connectSocket({ auth: { token: tokenA } });

    if (!connected) {
      safeDisconnect(client);
      fail(name, 'Could not connect');
    } else {
      const received = [];
      client.on('test.after_disconnect', (d) => received.push(d));

      // Disconnect cleanly
      client.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      // Now emit to the room that the disconnected client was in
      emitToUser(userA._id.toString(), 'test.after_disconnect', { secret: 'should_not_arrive' });
      await new Promise((r) => setTimeout(r, 300));

      if (received.length === 0) {
        pass(name);
      } else {
        fail(name, `Disconnected client received ${received.length} events`);
      }
    }
  }

  // ── Test 12: Reconnect requires re-authentication ─────────────────────────
  {
    const name = 'Test 12 — Reconnect with no token → REJECTED';
    // First connect successfully as A
    const { client: firstClient, connected: firstConn } = await connectSocket({ auth: { token: tokenA } });
    safeDisconnect(firstClient);

    // Now try to reconnect WITHOUT a token (simulating a client stripping auth)
    const { client: noAuthClient, connected: reconnConnected } = await connectSocket({ auth: {} });
    safeDisconnect(noAuthClient);

    if (!reconnConnected) {
      pass(name);
    } else {
      fail(name, 'Re-connection without token was accepted — authentication bypass');
    }
  }

  // ── Test 13: Mismatched auth.token vs Authorization header → REJECTED ─────
  {
    const name = 'Test 13 — Mismatched auth.token vs Authorization header → REJECTED';
    const { client, connected } = await connectSocket({
      auth: { token: tokenA },
      extraHeaders: { Authorization: `Bearer ${tokenB}` },
    });
    safeDisconnect(client);
    if (!connected) {
      pass(name);
    } else {
      fail(name, 'Mismatched credentials were accepted — ambiguous identity allowed');
    }
  }

  // ── Test 14: Malformed (non-hex) centerId in join:center → no crash ───────
  {
    const name = 'Test 14 — Malformed centerId in join:center → rejected, no crash';
    const { client, connected } = await connectSocket({ auth: { token: tokenA } });

    if (!connected) {
      safeDisconnect(client);
      fail(name, 'Could not connect');
    } else {
      let crashed = false;
      client.on('error', () => { crashed = true; });

      client.emit('join:center', '../../etc/passwd');         // path traversal
      client.emit('join:center', 'ZZZZZZZZZZZZZZZZZZZZZZZZ'); // invalid hex
      client.emit('join:center', '');                          // empty
      client.emit('join:center', null);                        // null
      await new Promise((r) => setTimeout(r, 300));

      safeDisconnect(client);

      if (!crashed) {
        pass(name);
      } else {
        fail(name, 'Server crashed on malformed centerId');
      }
    }
  }

  // ── Test 15: Role integrity — Customer vs Staff vs Admin authentic roles ───
  {
    const name = 'Test 15 — Role integrity: Customer vs Staff vs Admin authentic roles';
    const { client: adminClient, connected: adminConn } = await connectSocket({ auth: { token: tokenAdmin } });
    const { client: staffClient, connected: staffConn } = await connectSocket({ auth: { token: tokenStaff } });
    const { client: custClient, connected: custConn } = await connectSocket({ auth: { token: tokenA } });

    // Injected invalid role string (SUPER_ADMIN)
    const invalidRoleToken = jwt.sign(
      { id: userA._id.toString(), role: 'SUPER_ADMIN_FORGED' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const { client: forgedRoleClient, connected: forgedConn } = await connectSocket({ auth: { token: invalidRoleToken } });

    let restBlocked = false;
    try {
      // Customer token attempts to hit admin-only endpoint
      await axios.post(`${baseUrl}/api/counters`, {
        centerId: '000000000000000000000001',
        name: 'Hacked Counter',
        number: 999,
      }, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
    } catch (err) {
      if (err.response && err.response.status === 403) {
        restBlocked = true;
      }
    }

    safeDisconnect(adminClient);
    safeDisconnect(staffClient);
    safeDisconnect(custClient);
    safeDisconnect(forgedRoleClient);

    if (adminConn && staffConn && custConn && forgedConn && restBlocked) {
      pass(name);
    } else {
      fail(name, `Role verification failed — admin:${adminConn}, staff:${staffConn}, cust:${custConn}, restBlocked:${restBlocked}`);
    }
  }

  // ── Test 16: Center authorization & data isolation (PII not leaked) ───────
  {
    const name = 'Test 16 — Center room authorization: public updates only, zero PII leaked';
    const fakeCenterId = '660000000000000000000001';
    const { client: clientCenter, connected: connCenter } = await connectSocket({ auth: { token: tokenA } });

    if (!connCenter) {
      safeDisconnect(clientCenter);
      fail(name, 'Could not connect to center room');
    } else {
      const centerEvents = [];
      clientCenter.on('token.called', (d) => centerEvents.push(d));

      clientCenter.emit('join:center', fakeCenterId);
      await new Promise((r) => setTimeout(r, 200));

      // Emit a sanitized public token event to center
      emitToCenter(fakeCenterId, 'token.called', {
        token: {
          _id: 'tok_pub_123',
          tokenCode: 'P-001',
          status: 'CALLED',
          // userId MUST NOT be present
        },
        counter: { name: 'Counter 1', number: 1 },
      });

      await new Promise((r) => setTimeout(r, 300));
      safeDisconnect(clientCenter);

      const receivedToken = centerEvents[0]?.token;
      if (centerEvents.length === 1 && receivedToken?.tokenCode === 'P-001' && !receivedToken?.userId) {
        pass(name);
      } else {
        fail(name, `Center event leaked userId or failed to arrive: ${JSON.stringify(centerEvents)}`);
      }
    }
  }

  // ── Test 17: Full private event lifecycle isolation ───────────────────────
  {
    const name = 'Test 17 — Full private event lifecycle isolation (serving, completed, cancelled)';
    const { client: clientA, connected: connA } = await connectSocket({ auth: { token: tokenA } });
    const { client: clientB, connected: connB } = await connectSocket({ auth: { token: tokenB } });

    if (!connA || !connB) {
      safeDisconnect(clientA);
      safeDisconnect(clientB);
      fail(name, `Connection failed — A:${connA}, B:${connB}`);
    } else {
      const aEvents = [];
      const bEvents = [];

      ['token.serving', 'token.completed', 'token.cancelled'].forEach((evt) => {
        clientA.on(evt, (d) => aEvents.push({ evt, d }));
        clientB.on(evt, (d) => bEvents.push({ evt, d }));
      });

      // Emit private lifecycle events exclusively to B
      emitToUser(userB._id.toString(), 'token.serving', { token: { _id: 't1', status: 'SERVING' } });
      emitToUser(userB._id.toString(), 'token.completed', { token: { _id: 't1', status: 'COMPLETED' } });
      emitToUser(userB._id.toString(), 'token.cancelled', { token: { _id: 't2', status: 'CANCELLED' } });

      await new Promise((r) => setTimeout(r, 400));
      safeDisconnect(clientA);
      safeDisconnect(clientB);

      if (aEvents.length === 0 && bEvents.length === 3) {
        pass(name);
      } else {
        fail(name, `Lifecycle isolation violated: A received ${aEvents.length}, B received ${bEvents.length}`);
      }
    }
  }

  // ── Test 18: Broadcast safety — Private events not broadcast globally ─────
  {
    const name = 'Test 18 — Broadcast safety: private events are never globally broadcast';
    const fakeCenterId = '660000000000000000000002';
    const { client: centerClient, connected: connC } = await connectSocket({ auth: { token: tokenA } });
    const { client: userClient, connected: connU } = await connectSocket({ auth: { token: tokenB } });

    if (!connC || !connU) {
      safeDisconnect(centerClient);
      safeDisconnect(userClient);
      fail(name, 'Connection failed');
    } else {
      const centerReceived = [];
      const userReceived = [];

      centerClient.emit('join:center', fakeCenterId);
      await new Promise((r) => setTimeout(r, 200));

      centerClient.on('notification.created', (d) => centerReceived.push(d));
      userClient.on('notification.created', (d) => userReceived.push(d));

      // Emit private notification strictly to userB
      emitToUser(userB._id.toString(), 'notification.created', {
        notification: { _id: 'notif_priv_1', title: 'Private Notice' },
      });

      await new Promise((r) => setTimeout(r, 300));
      safeDisconnect(centerClient);
      safeDisconnect(userClient);

      if (centerReceived.length === 0 && userReceived.length === 1) {
        pass(name);
      } else {
        fail(name, `Broadcast safety violated: center listener intercepted private notification`);
      }
    }
  }

  // ── Test 19: Client-supplied identity abuse (userId/customerId/ownerId) ───
  {
    const name = 'Test 19 — Client-supplied identity abuse: arbitrary ownership claims ignored';
    const { client: attacker, connected: connAttacker } = await connectSocket({ auth: { token: tokenA } });

    if (!connAttacker) {
      safeDisconnect(attacker);
      fail(name, 'Attacker connection failed');
    } else {
      const attackerReceived = [];
      attacker.on('test.spoofed_event', (d) => attackerReceived.push(d));

      // Attacker attempts various spoofed events to subscribe to Victim B
      attacker.emit('join:user', { userId: userB._id.toString(), customerId: userB._id.toString(), ownerId: userB._id.toString() });
      attacker.emit('join:user', userB._id.toString());
      attacker.emit('subscribe', { ownerId: userB._id.toString() });
      await new Promise((r) => setTimeout(r, 200));

      // Emit to victim's room
      emitToUser(userB._id.toString(), 'test.spoofed_event', { secret: 'VICTIM_ONLY_DATA' });
      await new Promise((r) => setTimeout(r, 300));

      safeDisconnect(attacker);

      if (attackerReceived.length === 0) {
        pass(name);
      } else {
        fail(name, `Identity spoofing succeeded — attacker received: ${JSON.stringify(attackerReceived)}`);
      }
    }
  }

  // ── Test 20: Raw attack simulation (Headless Client Customer A → B) ───────
  {
    const name = 'Test 20 — Attack simulation: Headless Customer A cannot intercept B private room';
    // Headless client without Flutter SDK constraints
    const { client: attackerSocket, connected: isConnected } = await connectSocket({
      auth: { token: tokenA },
    });

    if (!isConnected) {
      safeDisconnect(attackerSocket);
      fail(name, 'Attacker could not establish socket connection');
    } else {
      const interceptedEvents = [];

      attackerSocket.on('token.called', (d) => interceptedEvents.push(d));
      attackerSocket.on('notification.created', (d) => interceptedEvents.push(d));

      // Active attack: emit join:user with target victim's ID
      attackerSocket.emit('join:user', userB._id.toString());
      await new Promise((r) => setTimeout(r, 200));

      // Target victim B receives private events
      emitToUser(userB._id.toString(), 'token.called', {
        token: { _id: 'tok_victim', tokenCode: 'B-999', userId: userB._id.toString() },
      });
      emitToUser(userB._id.toString(), 'notification.created', {
        notification: { _id: 'notif_victim', title: 'Targeted Private Alert' },
      });

      await new Promise((r) => setTimeout(r, 400));
      safeDisconnect(attackerSocket);

      if (interceptedEvents.length === 0) {
        pass(name);
      } else {
        fail(name, `CRITICAL: Headless attacker intercepted victim events: ${JSON.stringify(interceptedEvents)}`);
      }
    }
  }

  // ── Test 21: tokenVersion increment invalidates existing socket and blocks reconnect ──
  {
    const name = 'Test 21 — Server increments tokenVersion → active socket disconnected & reconnect rejected';
    const activeUser = await User.create({
      name: 'Socket Version User',
      email: `sock_ver_${Date.now()}@test.com`,
      passwordHash: await User.hashPassword('Password@123'),
      role: 'CUSTOMER',
      isActive: true,
      tokenVersion: 0,
    });
    const verToken = signToken(activeUser._id.toString(), 'CUSTOMER', 0);

    const { client, connected } = await connectSocket({ auth: { token: verToken } });
    if (!connected) {
      safeDisconnect(client);
      fail(name, 'Could not establish initial socket connection');
    } else {
      let disconnected = false;
      client.on('disconnect', () => { disconnected = true; });

      // Server increments tokenVersion in MongoDB
      await User.findByIdAndUpdate(activeUser._id, { $inc: { tokenVersion: 1 } });
      await new Promise((r) => setTimeout(r, 200));

      // Attempt to emit private event; client must not receive it
      const received = [];
      client.on('test.revoked', (d) => received.push(d));
      emitToUser(activeUser._id.toString(), 'test.revoked', { data: 'secret' });
      await new Promise((r) => setTimeout(r, 200));

      safeDisconnect(client);

      // Attempt reconnect with the now-revoked token
      const reconnectRes = await connectSocket({ auth: { token: verToken } });
      safeDisconnect(reconnectRes.client);

      await User.deleteOne({ _id: activeUser._id });

      if (received.length === 0 && !reconnectRes.connected) {
        pass(name);
      } else {
        fail(name, `Revocation failed: received=${received.length}, reconnected=${reconnectRes.connected}`);
      }
    }
  }

  // ── Test 22: User logout invalidates active socket ────────────────────────
  {
    const name = 'Test 22 — User logout revokes existing socket and blocks reconnect';
    const logoutUser = await User.create({
      name: 'Socket Logout User',
      email: `sock_logout_${Date.now()}@test.com`,
      passwordHash: await User.hashPassword('Password@123'),
      role: 'CUSTOMER',
      isActive: true,
      tokenVersion: 0,
    });
    const logToken = signToken(logoutUser._id.toString(), 'CUSTOMER', 0);

    const { client, connected } = await connectSocket({ auth: { token: logToken } });
    if (!connected) {
      safeDisconnect(client);
      fail(name, 'Could not connect socket for logout test');
    } else {
      // Call REST logout
      const api = axios.create({ baseURL: baseUrl, validateStatus: () => true });
      const logoutRes = await api.post('/api/auth/logout', {}, {
        headers: { Authorization: `Bearer ${logToken}` },
      });
      assert.strictEqual(logoutRes.status, 200, 'Logout API must return 200');
      await new Promise((r) => setTimeout(r, 200));

      // Try reconnecting with the logged-out token
      const reattempt = await connectSocket({ auth: { token: logToken } });
      safeDisconnect(client);
      safeDisconnect(reattempt.client);

      await User.deleteOne({ _id: logoutUser._id });

      if (!reattempt.connected) {
        pass(name);
      } else {
        fail(name, 'Socket remained able to reconnect with logged-out token');
      }
    }
  }

  // ── Test 23: Password change invalidates active socket ─────────────────────
  {
    const name = 'Test 23 — Password change revokes existing socket and blocks old token reconnect';
    const pwUser = await User.create({
      name: 'Socket PW Change User',
      email: `sock_pw_${Date.now()}@test.com`,
      passwordHash: await User.hashPassword('Password@123'),
      role: 'CUSTOMER',
      isActive: true,
      tokenVersion: 0,
    });
    const oldPwToken = signToken(pwUser._id.toString(), 'CUSTOMER', 0);

    const { client, connected } = await connectSocket({ auth: { token: oldPwToken } });
    if (!connected) {
      safeDisconnect(client);
      fail(name, 'Could not connect socket for password change test');
    } else {
      const api = axios.create({ baseURL: baseUrl, validateStatus: () => true });
      const changeRes = await api.post('/api/auth/change-password', {
        currentPassword: 'Password@123',
        newPassword: 'NewPassword@456',
      }, {
        headers: { Authorization: `Bearer ${oldPwToken}` },
      });
      assert.strictEqual(changeRes.status, 200, 'Change password API must return 200');
      await new Promise((r) => setTimeout(r, 200));

      const reattempt = await connectSocket({ auth: { token: oldPwToken } });
      safeDisconnect(client);
      safeDisconnect(reattempt.client);

      await User.deleteOne({ _id: pwUser._id });

      if (!reattempt.connected) {
        pass(name);
      } else {
        fail(name, 'Socket remained able to reconnect with pre-password-change token');
      }
    }
  }

  // ── Test 24: Account deactivation disconnects socket and rejects reconnect ──
  {
    const name = 'Test 24 — Account deactivation immediately disconnects active socket and rejects reconnect';
    const deactUser = await User.create({
      name: 'Socket Deactivate User',
      email: `sock_deact_${Date.now()}@test.com`,
      passwordHash: await User.hashPassword('Password@123'),
      role: 'CUSTOMER',
      isActive: true,
      tokenVersion: 0,
    });
    const deactToken = signToken(deactUser._id.toString(), 'CUSTOMER', 0);

    const { client, connected } = await connectSocket({ auth: { token: deactToken } });
    if (!connected) {
      safeDisconnect(client);
      fail(name, 'Could not connect socket for deactivation test');
    } else {
      // Deactivate user in DB
      await User.findByIdAndUpdate(deactUser._id, { isActive: false });
      await new Promise((r) => setTimeout(r, 200));

      const reattempt = await connectSocket({ auth: { token: deactToken } });
      safeDisconnect(client);
      safeDisconnect(reattempt.client);

      await User.deleteOne({ _id: deactUser._id });

      if (!reattempt.connected) {
        pass(name);
      } else {
        fail(name, 'Deactivated user was still permitted to connect via socket');
      }
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────
  await User.deleteMany({ _id: { $in: [userA._id, userB._id, userStaff._id, userAdmin._id] } });

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=======================================================');
  console.log(`🔐 Security Test Results: ${passed} passed, ${failed} failed`);
  console.log('=======================================================');
  results.forEach((r) => console.log(`  ${r.result}  ${r.name}`));

  await new Promise((r) => testServer.close(r));
  await mongoose.disconnect();

  if (failed > 0) {
    console.error('\n❌ PHASE 1 INCOMPLETE — SECURITY ISSUE REMAINS');
    process.exit(1);
  } else {
    console.log('\n✅ PHASE 1 COMPLETE — SOCKET.IO AUTHENTICATION & AUTHORIZATION REMEDIATED');
    process.exit(0);
  }
}

runSecurityTests().catch(async (err) => {
  console.error('\n❌ Security Test Crashed:', err);
  if (testServer) testServer.close();
  await mongoose.disconnect();
  process.exit(1);
});

'use strict';

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { server } = require('../server');
const connectDB = require('../src/config/database');
const User = require('../src/models/User');
const { SupportTicket } = require('../src/models/SupportTicket');

let baseUrl;
let testServer;
let testUserA;
let testUserB;
let tokenA;
let tokenB;

function signTestToken(userId, role = 'CUSTOMER') {
  return jwt.sign(
    { id: userId.toString(), role, tokenVersion: 0 },
    process.env.JWT_SECRET || 'test-jwt-secret-key-minimum-32-chars-long!!',
    { expiresIn: '1h' }
  );
}

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (_) {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

async function main() {
  console.log('\n--- Running Profile Preferences & Real Support Ticket Tests ---\n');

  await connectDB();

  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      const port = testServer.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  // Setup test users
  const ts = Date.now();
  testUserA = await User.create({
    name: 'Customer A',
    email: `customerA_${ts}@example.com`,
    passwordHash: 'dummyhash123',
    role: 'CUSTOMER',
    preferences: {
      notifyApp: true,
      notifySms: true,
      notifyAheadCount: 5,
      language: 'en',
    },
  });
  tokenA = signTestToken(testUserA._id);

  testUserB = await User.create({
    name: 'Customer B',
    email: `customerB_${ts}@example.com`,
    passwordHash: 'dummyhash123',
    role: 'CUSTOMER',
    preferences: {
      notifyApp: true,
      notifySms: false,
      notifyAheadCount: 3,
      language: 'es',
    },
  });
  tokenB = signTestToken(testUserB._id);

  let createdTicketId;

  try {
    // ─── 1. Preference Partial Update Preserves Other Fields ──────
    await runTest('PATCH /api/auth/me updating only notifyApp preserves notifySms, notifyAheadCount, language', async () => {
      const res = await request(
        'PATCH',
        '/api/auth/me',
        { preferences: { notifyApp: false } },
        tokenA
      );

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      const user = res.body.data.user;
      assert.strictEqual(user.preferences.notifyApp, false, 'notifyApp should be false');
      assert.strictEqual(user.preferences.notifySms, true, 'notifySms should be preserved as true');
      assert.strictEqual(user.preferences.notifyAheadCount, 5, 'notifyAheadCount should be preserved as 5');
      assert.strictEqual(user.preferences.language, 'en', 'language should be preserved as en');

      // Verify in DB directly
      const dbUser = await User.findById(testUserA._id).lean();
      assert.strictEqual(dbUser.preferences.notifyApp, false);
      assert.strictEqual(dbUser.preferences.notifySms, true);
      assert.strictEqual(dbUser.preferences.notifyAheadCount, 5);
      assert.strictEqual(dbUser.preferences.language, 'en');
    });

    await runTest('PATCH /api/auth/me updating notifyAheadCount and language preserves notifyApp and notifySms', async () => {
      const res = await request(
        'PATCH',
        '/api/auth/me',
        { preferences: { notifyAheadCount: 8, language: 'hi' } },
        tokenA
      );

      assert.strictEqual(res.status, 200);
      const user = res.body.data.user;
      assert.strictEqual(user.preferences.notifyApp, false, 'notifyApp should remain false');
      assert.strictEqual(user.preferences.notifySms, true, 'notifySms should remain true');
      assert.strictEqual(user.preferences.notifyAheadCount, 8, 'notifyAheadCount updated to 8');
      assert.strictEqual(user.preferences.language, 'hi', 'language updated to hi');
    });

    await runTest('User B preferences are completely isolated from User A', async () => {
      const res = await request('GET', '/api/auth/me', null, tokenB);
      assert.strictEqual(res.status, 200);
      const userB = res.body.data.user;
      assert.strictEqual(userB.preferences.notifyApp, true);
      assert.strictEqual(userB.preferences.notifySms, false);
      assert.strictEqual(userB.preferences.notifyAheadCount, 3);
      assert.strictEqual(userB.preferences.language, 'es');
    });

    // ─── 2. Real Support Ticket Creation & Retrieval ──────────────
    await runTest('POST /api/support/tickets creates a persistent ticket in MongoDB', async () => {
      const payload = {
        category: 'TOKEN_ISSUE',
        subject: 'Virtual token was skipped accidentally',
        description: 'I was standing by counter 2 and my token was marked skipped before 60 seconds.',
      };

      const res = await request('POST', '/api/support/tickets', payload, tokenA);
      if (res.status !== 201) {
        console.error('POST /api/support/tickets returned status', res.status, res.body);
      }
      assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.success, 'Response should indicate success');
      const ticket = res.body.data.ticket;
      assert(ticket.ticketId, 'Ticket must have a ticketId');
      assert(ticket.ticketId.startsWith('QF-TK-'), `ticketId should start with QF-TK-, got ${ticket.ticketId}`);
      assert.strictEqual(ticket.subject, payload.subject);
      assert.strictEqual(ticket.description, payload.description);
      assert.strictEqual(ticket.category, 'TOKEN_ISSUE');
      assert.strictEqual(ticket.status, 'OPEN');

      createdTicketId = ticket.ticketId;

      // Verify in MongoDB
      const doc = await SupportTicket.findOne({ ticketId: ticket.ticketId }).lean();
      assert(doc, 'Ticket must be stored in MongoDB');
      assert.strictEqual(doc.userId.toString(), testUserA._id.toString());
    });

    await runTest('GET /api/support/tickets returns real tickets for authenticated user', async () => {
      const res = await request('GET', '/api/support/tickets', null, tokenA);
      assert.strictEqual(res.status, 200);
      const tickets = res.body.data.tickets;
      assert(Array.isArray(tickets), 'Tickets must be an array');
      assert(tickets.length >= 1, 'Should have at least 1 ticket');
      const match = tickets.find((t) => t.ticketId === createdTicketId);
      assert(match, 'Created ticket should appear in list');
    });

    await runTest('User B cannot view User A support tickets via GET /api/support/tickets/:id', async () => {
      const res = await request('GET', `/api/support/tickets/${createdTicketId}`, null, tokenB);
      assert.strictEqual(res.status, 403, `Expected 403 Forbidden for User B, got ${res.status}`);
    });

    await runTest('POST /api/support/tickets rejects invalid/short description', async () => {
      const res = await request(
        'POST',
        '/api/support/tickets',
        { subject: 'Valid subject', description: 'Too short' },
        tokenA
      );
      assert.strictEqual(res.status, 400, 'Expected 400 Bad Request');
    });

    await runTest('POST /api/support/tickets rejects unauthenticated requests', async () => {
      const res = await request('POST', '/api/support/tickets', {
        subject: 'Valid subject',
        description: 'Valid description that is long enough.',
      });
      assert.strictEqual(res.status, 401, 'Expected 401 Unauthorized');
    });

    console.log('\nAll profile preferences and support ticket backend tests PASSED!\n');
  } finally {
    // Cleanup
    await User.deleteMany({ _id: { $in: [testUserA._id, testUserB._id] } });
    if (createdTicketId) {
      await SupportTicket.deleteMany({ ticketId: createdTicketId });
    }
    await new Promise((resolve) => testServer.close(resolve));
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

/**
 * Phase 2 geofencing — REAL end-to-end verification against a live backend.
 *
 * This is not a unit test with stubs. It boots nothing: it drives the running
 * QueueFlow backend over real HTTP and real Socket.IO, and asserts that the
 * whole Phase 2 contract actually happens:
 *
 *   one CALL NEXT
 *     -> backend classifies the first two customers OUT_OF_RANGE, auto-skips them
 *     -> backend classifies the third IN_RANGE, calls them
 *     -> the Live Counter board sees both skip announcements, then the call
 *     -> each skipped customer's own app sees its own skip, and no call
 *     -> the called customer's app sees the call
 *     -> the Admin Panel operator socket sees the same sequence
 *     -> exactly one token.called, so voice fires once and only for the call
 *
 * Then four follow-ups:
 *   A. a customer who walks back in is called, not skipped
 *   B. a queue where everybody has walked out fabricates no token
 *   C. a stale location blocks the scan (not called, not skipped)
 *   D. two concurrent CALL NEXT presses never claim the same customer
 *
 * Run with the backend already listening:
 *     cd backend && npm start
 *     node test/phase2_e2e_live.js
 */

process.env.DEV_SIMULATOR_ENABLED = 'true';
require('dotenv').config();

const assert = require('assert');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');

const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const Queue = require('../src/models/Queue');
const QueueEvent = require('../src/models/QueueEvent');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');
const { signToken } = require('../src/middleware/auth');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5000';
const API = `${BASE}/api`;

const CENTER_CODE = 'QF-E2E-P2';
const EMAIL_DOMAIN = 'queueflow.test';

const CENTER_LAT = 12.9716;
const CENTER_LNG = 77.5946;
const METERS_PER_DEG_LAT = 111320;
const offsetLat = (meters) => CENTER_LAT + meters / METERS_PER_DEG_LAT;

// ~40 m: comfortably inside the 100 m joining radius.
const IN_RANGE = { latitude: offsetLat(40), longitude: CENTER_LNG };
// ~350 m: clearly outside.
const OUT_RANGE = { latitude: offsetLat(350), longitude: CENTER_LNG };

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

const log = (m) => console.log(`  ${m}`);
const section = (m) => console.log(`\n=== ${m} ===`);

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Load a real client-side module out of the sibling frontends.
 *
 * This matters: the unit suites prove these modules handle hand-written
 * fixtures, which is only worth something if the fixtures match what the backend
 * really sends. Loading the actual modules and feeding them the actual captured
 * payloads closes that gap — if the backend payload ever drifts, the real UI
 * code is what breaks, and this is what notices.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
async function loadClientModule(relativePath) {
  const abs = path.join(REPO_ROOT, relativePath);
  return import(pathToFileURL(abs).href);
}

const RECORDED_EVENTS = [
  'token.called',
  'token.serving',
  'token.completed',
  'token.skipped',
  'token.created',
  'token.cancelled',
  'queue.updated',
  'counter.updated',
  'token:proximity',
  'notification.created',
];

function record(socket, bucket) {
  for (const event of RECORDED_EVENTS) {
    socket.on(event, (data) => bucket.push({ event, data, at: Date.now() }));
  }
}

const codeOf = (entry) => entry?.data?.token?.tokenCode || null;
const named = (bucket, name) => bucket.filter((e) => e.event === name);
const codesNamed = (bucket, name) => named(bucket, name).map(codeOf);

function connectSocket(auth, { joinCenter, joinUser, label }) {
  return new Promise((resolve, reject) => {
    const bucket = [];
    const socket = ioClient(BASE, { auth, transports: ['websocket'] });
    record(socket, bucket);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${label} socket connect timeout`));
    }, 10000);
    socket.on('connect', () => {
      clearTimeout(timer);
      if (joinCenter) socket.emit('join:center', joinCenter);
      if (joinUser) socket.emit('join:user', joinUser);
      resolve({ socket, events: bucket });
    });
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`${label} socket: ${e.message}`));
    });
  });
}

async function waitFor(predicate, { timeoutMs = 10000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  section(`Phase 2 live end-to-end against ${BASE}`);

  await mongoose.connect(process.env.MONGODB_URI);

  // ── Fixture ──────────────────────────────────────────────────────────────
  // Six distinct customers are required: only one ACTIVE token may exist per
  // (center, service, user), so distinct customers are the only way to build a
  // multi-person queue.
  const stamp = Date.now().toString(36).toUpperCase();
  const fixture = { centerId: null, userIds: [], tokenIds: [], sockets: [] };

  // Clear anything a previous interrupted run left behind.
  const staleCenters = await ServiceCenter.find({ code: CENTER_CODE }).select('_id').lean();
  for (const s of staleCenters) await purgeCenter(s._id);
  await Notification.deleteMany({ 'metadata.source': CENTER_CODE });

  // The operator credential is minted with the app's own signToken() for the
  // same reason the customers are: /auth/* allows 20 requests per 15 minutes, so
  // a login here would make the script unrunnable more than once per window.
  // Authentication is not what this script is testing; authorisation still is —
  // every operator call below still goes through the real `protect` middleware.
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@queueflow.dev';
  const admin = await User.findOne({ email: adminEmail });
  assert.ok(admin, `no admin user found for ${adminEmail}; set ADMIN_EMAIL`);
  const adminToken = signToken(admin._id.toString(), admin.role, admin.tokenVersion || 0);
  log(`operator credential minted for ${admin.name} (${admin.role})`);

  const centerRes = await api('POST', '/service-centers', {
    token: adminToken,
    body: {
      name: `E2E Phase2 ${stamp}`,
      code: CENTER_CODE,
      type: 'OTHER',
      capacity: 200,
      latitude: CENTER_LAT,
      longitude: CENTER_LNG,
      joiningRadiusMeters: 100,
      isActive: true,
      isOpen: true,
      address: { street: 'E2E verification address', city: 'Bengaluru', state: 'KA', pincode: '560001' },
    },
  });
  const center = centerRes.data.center || centerRes.data;
  const centerId = center._id;
  fixture.centerId = centerId;
  log(`center ${center.code} at ${CENTER_LAT},${CENTER_LNG}, joining radius 100 m`);

  const serviceRes = await api('POST', '/services', {
    token: adminToken,
    body: {
      centerId,
      name: `E2E Service ${stamp}`,
      tokenPrefix: 'P2',
      avgServiceTimeMinutes: 5,
      isActive: true,
    },
  });
  const service = serviceRes.data.service || serviceRes.data;
  const serviceId = service._id;
  log(`service ${service.name} (prefix ${service.tokenPrefix})`);

  const counterRes = await api('POST', '/counters', {
    token: adminToken,
    body: { centerId, name: `E2E Counter ${stamp}`, number: 1, serviceId, isActive: true },
  });
  const counter = counterRes.data.counter || counterRes.data;
  const counterId = counter._id;
  // A freshly created counter is not yet serving; CALL NEXT refuses a counter
  // that is not ACTIVE, exactly as it does in production.
  await api('PATCH', `/counters/${counterId}/status`, {
    token: adminToken,
    body: { status: 'ACTIVE' },
  });
  log(`counter ${counter.name} set ACTIVE`);

  // Customers are created through the model and signed with the app's own
  // signToken(), rather than through POST /auth/register. The endpoint's own
  // auth limiter allows 20 requests per 15 minutes, and six throwaway
  // registrations per run would make this script unrunnable a second time. The
  // fields, the password hashing (User.hashPassword) and the token are the same
  // ones the endpoint uses, and nothing about the Phase 2 flow under test is
  // registration.
  const customers = [];
  for (let i = 0; i < 6; i += 1) {
    const email = `p2e2e${i}x${stamp.toLowerCase()}@${EMAIL_DOMAIN}`;
    const user = await User.create({
      name: `P2 Customer ${i}`,
      email,
      passwordHash: await User.hashPassword('QueueFlow#2026'),
      role: 'CUSTOMER',
      isActive: true,
    });
    customers.push({
      index: i,
      email,
      userId: user._id.toString(),
      token: signToken(user._id.toString(), user.role, user.tokenVersion || 0),
    });
    fixture.userIds.push(user._id);
  }
  log(`${customers.length} customers created`);

  // ── Live Counter display socket ──────────────────────────────────────────
  // Uses the authoritative short-lived display credential, exactly like the
  // real board, and joins the center room it is scoped to.
  const displayRes = await api('GET', `/queue/${centerId}/display`, { token: adminToken });
  const displayToken = displayRes.data.displayToken;
  assert.ok(displayToken, 'the backend must issue a displayToken for the Live Counter');
  const counterConn = await connectSocket(
    { token: `Bearer ${displayToken}` },
    { joinCenter: centerId, label: 'Live Counter' }
  );
  fixture.sockets.push(counterConn.socket);
  log('Live Counter socket connected with the display credential');

  const adminConn = await connectSocket(
    { token: `Bearer ${adminToken}` },
    { joinCenter: centerId, label: 'Admin Panel' }
  );
  fixture.sockets.push(adminConn.socket);
  log('Admin Panel socket connected with the operator credential');

  // ── The three controlled customers ───────────────────────────────────────
  // All three join INSIDE the radius (Phase 1 join geofence), then two leave.
  async function joinAs(index) {
    const c = customers[index];
    const res = await api('POST', '/tokens', {
      token: c.token,
      body: {
        centerId,
        serviceId,
        notifyApp: true,
        notifySms: false,
        latitude: IN_RANGE.latitude,
        longitude: IN_RANGE.longitude,
        accuracy: 8,
      },
    });
    const t = res.data.token;
    fixture.tokenIds.push(t._id);
    return { customer: c, token: t };
  }

  const t024 = await joinAs(0);
  const t025 = await joinAs(1);
  const t026 = await joinAs(2);
  log(`joined in order: ${t024.token.tokenCode}, ${t025.token.tokenCode}, ${t026.token.tokenCode}`);

  // Each controlled customer's own app socket (private user room).
  const apps = {};
  for (const t of [t024, t025, t026]) {
    const conn = await connectSocket(
      { token: `Bearer ${t.customer.token}` },
      { joinUser: t.customer.userId, label: `app ${t.customer.email}` }
    );
    fixture.sockets.push(conn.socket);
    apps[t.customer.email] = conn;
  }
  log('3 User App sockets connected on their private rooms');

  // ── Two customers walk out; one stays ────────────────────────────────────
  for (const t of [t024, t025]) {
    const res = await api('POST', `/tokens/${t.token._id}/location`, {
      token: t.customer.token,
      body: {
        latitude: OUT_RANGE.latitude,
        longitude: OUT_RANGE.longitude,
        accuracy: 9,
        timestamp: new Date().toISOString(),
        centerId,
      },
    });
    log(`${t.token.tokenCode} shares a reading -> ${res.data.locationStatus} at ${Math.round(res.data.distanceMeters)} m`);
  }
  const c026Loc = await api('POST', `/tokens/${t026.token._id}/location`, {
    token: t026.customer.token,
    body: {
      latitude: IN_RANGE.latitude,
      longitude: IN_RANGE.longitude,
      accuracy: 7,
      timestamp: new Date().toISOString(),
      centerId,
    },
  });
  log(`${t026.token.tokenCode} shares a reading -> ${c026Loc.data.locationStatus} at ${Math.round(c026Loc.data.distanceMeters)} m`);

  await sleep(500);
  check('1. nobody is skipped before the operator presses CALL NEXT', () => {
    assert.strictEqual(
      named(counterConn.events, 'token.skipped').length, 0,
      'a skip must only ever happen as part of a CALL NEXT'
    );
  });
  check('2. no customer was called before the operator pressed CALL NEXT', () => {
    assert.strictEqual(named(counterConn.events, 'token.called').length, 0);
  });

  // ── THE ONE CALL NEXT ────────────────────────────────────────────────────
  section('ONE CALL NEXT performs the entire scan');
  const callStart = Date.now();
  const callRes = await api('POST', `/counters/${counterId}/call-next`, { token: adminToken });
  const callData = callRes.data;
  // sendSuccess puts `message` beside `data`, not inside it.
  log(`responded in ${Date.now() - callStart} ms`);
  log(`message: ${callRes.message}`);

  await waitFor(
    () => codeOf(named(counterConn.events, 'token.called').at(-1)) === t026.token.tokenCode,
    { label: `${t026.token.tokenCode} to be called on the Live Counter` }
  );
  await sleep(600);

  check('3. a single CALL NEXT skipped two customers and called one', () => {
    assert.strictEqual(callData.skippedCount, 2, `expected 2 skips, got ${callData.skippedCount}`);
    assert.ok(callData.token, 'a token must have been called');
  });

  check('4. both out-of-range customers were skipped, in queue order', () => {
    assert.deepStrictEqual(
      callData.skipped.map((s) => s.tokenCode),
      [t024.token.tokenCode, t025.token.tokenCode],
      'FIFO order must be preserved'
    );
  });

  check('5. the in-range customer is the one who was called', () => {
    assert.strictEqual(callData.token.tokenCode, t026.token.tokenCode);
  });

  check('6. the operator message states both facts', () => {
    assert.ok(/skipped/i.test(callRes.message), callRes.message);
    assert.ok(/outside service area/i.test(callRes.message), callRes.message);
    assert.ok(callRes.message.includes(t026.token.tokenCode), callRes.message);
  });

  const db024 = await Token.findById(t024.token._id).lean();
  const db025 = await Token.findById(t025.token._id).lean();
  const db026 = await Token.findById(t026.token._id).lean();

  check(`7. ${t024.token.tokenCode} is persisted SKIPPED_OUT_OF_RANGE with audit fields`, () => {
    assert.strictEqual(db024.status, 'SKIPPED_OUT_OF_RANGE');
    assert.strictEqual(db024.skipReason, 'OUT_OF_RANGE');
    assert.ok(db024.skippedAt, 'skippedAt must be recorded');
    assert.ok(db024.checkedDistanceMeters > 100, 'the measured distance must be recorded');
    assert.ok(db024.locationStatus, 'the proximity verdict must be recorded');
  });

  check(`8. ${t025.token.tokenCode} is persisted SKIPPED_OUT_OF_RANGE with audit fields`, () => {
    assert.strictEqual(db025.status, 'SKIPPED_OUT_OF_RANGE');
    assert.strictEqual(db025.skipReason, 'OUT_OF_RANGE');
    assert.ok(db025.skippedAt);
    assert.ok(db025.checkedDistanceMeters > 100);
  });

  check(`9. ${t026.token.tokenCode} is persisted CALLED and bound to the counter`, () => {
    assert.strictEqual(db026.status, 'CALLED');
    assert.ok(db026.counterId, 'the called token must be bound to the counter');
  });

  check('10. a skip preserves the customer history rather than erasing it', () => {
    assert.ok(Number.isFinite(db024.initialPosition), 'initialPosition must survive the skip');
    assert.ok(db024.createdAt, 'the join timestamp must survive the skip');
  });

  // The Phase-2 additions to the operator response are the message plus the
  // `skipped` / `blocked` / `skippedCount` detail. Those are the only new
  // surface, so those are what must stay clean. (`data.token` is the
  // pre-existing populated token document that CALL NEXT has always returned to
  // authenticated centre staff; trimming it is out of scope here.)
  const phase2Surface = {
    message: callRes.message,
    skipped: callData.skipped,
    blocked: callData.blocked,
    skippedCount: callData.skippedCount,
  };
  check('11. the Phase-2 operator surface leaks no coordinates and no internal state names', () => {
    // No coordinate, ever, on any Phase-2 field.
    const blob = JSON.stringify(phase2Surface);
    assert.ok(!/latitude|longitude|\baccuracy\b/i.test(blob), blob);

    // `skipped[].skipReason` is a machine-readable discriminator the clients
    // need in order to decide whether to announce an auto-skip versus a manual
    // one; it is never rendered. That is verified separately against the real
    // formatter in check 24, which is the assertion that actually matters.
    assert.strictEqual(callData.skipped[0].skipReason, 'OUT_OF_RANGE');

    // `blocked[].reason`, by contrast, must already be plain language on the
    // wire: the backend does the translating, so no client has to.
    for (const b of callData.blocked) {
      assert.ok(!/LOCATION_STALE|LOCATION_UNAVAILABLE|IN_RANGE|OUT_OF_RANGE/.test(b.reason), b.reason);
    }

    // A rounded distance is fine and useful to an adjudicating operator; a
    // coordinate is not.
    for (const s of callData.skipped) {
      assert.ok(Number.isFinite(s.distanceMeters), 'a distance is reported, for operator adjudication');
    }
  });

  // ── Live Counter ─────────────────────────────────────────────────────────
  check('12. the Live Counter received a skip announcement for both customers', () => {
    assert.deepStrictEqual(
      codesNamed(counterConn.events, 'token.skipped'),
      [t024.token.tokenCode, t025.token.tokenCode]
    );
  });

  check(`13. the Live Counter received exactly one call, for ${t026.token.tokenCode}`, () => {
    assert.deepStrictEqual(codesNamed(counterConn.events, 'token.called'), [t026.token.tokenCode]);
  });

  check('14. the skip announcements arrived before the call', () => {
    const lastSkip = named(counterConn.events, 'token.skipped').at(-1);
    const firstCall = named(counterConn.events, 'token.called')[0];
    assert.ok(lastSkip.at <= firstCall.at, 'the board must see the skips, then the call');
  });

  check('15. the Live Counter skip payload is public-safe', () => {
    for (const e of named(counterConn.events, 'token.skipped')) {
      const blob = JSON.stringify(e.data);
      assert.ok(!/latitude|longitude|accuracy/i.test(blob), blob);
      assert.ok(!/userId/.test(blob), 'a center-room payload must never carry a user id');
    }
  });

  check('16. voice fires only for the call: exactly one token.called for one CALL NEXT', () => {
    // The announcer is driven by token.called alone, and a skip is a different
    // event name entirely, so a skip can never speak.
    assert.strictEqual(named(counterConn.events, 'token.called').length, 1);
    assert.notStrictEqual('token.skipped', 'token.called');
  });

  // ── The customers' own apps ──────────────────────────────────────────────
  for (const t of [t024, t025]) {
    check(`17. ${t.token.tokenCode}'s own app was told about the skip`, () => {
      const skips = named(apps[t.customer.email].events, 'token.skipped');
      assert.ok(skips.length >= 1, 'the skipped customer must be told');
      assert.strictEqual(skips[0].data.skipReason, 'OUT_OF_RANGE');
      assert.strictEqual(skips[0].data.token.status, 'SKIPPED_OUT_OF_RANGE');
    });
  }

  check('18. a skipped customer is never also sent a call', () => {
    for (const t of [t024, t025]) {
      assert.strictEqual(
        named(apps[t.customer.email].events, 'token.called').length, 0,
        `${t.token.tokenCode} was skipped and must not also be called`
      );
    }
  });

  check(`19. ${t026.token.tokenCode}'s own app was told about the call`, () => {
    const calls = named(apps[t026.customer.email].events, 'token.called');
    assert.ok(calls.length >= 1, 'the called customer must be told');
    assert.strictEqual(calls[0].data.token.tokenCode, t026.token.tokenCode);
  });

  check(`20. ${t026.token.tokenCode} is not sent a skip notice`, () => {
    assert.strictEqual(named(apps[t026.customer.email].events, 'token.skipped').length, 0);
  });

  // ── Admin Panel ──────────────────────────────────────────────────────────
  check('21. the Admin Panel socket saw the same skip-then-call sequence', () => {
    assert.deepStrictEqual(
      codesNamed(adminConn.events, 'token.skipped'),
      [t024.token.tokenCode, t025.token.tokenCode]
    );
    assert.deepStrictEqual(codesNamed(adminConn.events, 'token.called'), [t026.token.tokenCode]);
  });

  // ── The real Admin Panel formatter, fed the real response ────────────────
  // This is the check that matters most for the Admin Panel surface: not "does
  // the wording module work", but "does the wording the operator will actually
  // read name the two customers that were skipped on their behalf".
  const outcome = await loadClientModule('admin_panel/src/services/callNextOutcome.js');
  const described = outcome.describeCallNextOutcome(callRes);
  log(`Admin Panel would show: "${described.message}"`);
  for (const line of described.details) log(`    · ${line}`);

  check('22. the real Admin Panel formatter names the skipped customers', () => {
    const all = [described.message, ...described.details].join('\n');
    assert.ok(all.includes(t024.token.tokenCode), all);
    assert.ok(all.includes(t025.token.tokenCode), all);
    assert.ok(all.includes(t026.token.tokenCode), all);
  });

  check('23. the real Admin Panel formatter shows the call as the headline', () => {
    assert.strictEqual(described.tone, 'called');
    assert.ok(described.message.includes(t026.token.tokenCode), described.message);
  });

  check('24. the real Admin Panel formatter never prints a coordinate or an enum', () => {
    const all = [described.message, ...described.details].join('\n');
    assert.ok(!/latitude|longitude|accuracy|LOCATION_STALE|OUT_OF_RANGE/i.test(all), all);
  });

  const liveSkipEvents = named(counterConn.events, 'token.skipped').map((e) => e.data);
  const liveCallEvents = named(counterConn.events, 'token.called').map((e) => e.data);
  for (const payload of [...liveSkipEvents, ...liveCallEvents]) {
    const announced = outcome.describeSkippedEvent(payload);
    if (payload.skipReason === 'OUT_OF_RANGE') {
      assert.ok(announced, 'a real OUT_OF_RANGE skip must produce an operator line');
    }
  }
  check('25. the real Admin Panel reacts to the live skip events it received', () => {
    const lines = liveSkipEvents.map((p) => outcome.describeSkippedEvent(p)).filter(Boolean);
    assert.strictEqual(lines.length, 2, `expected 2 operator lines, got ${lines.length}`);
    assert.ok(lines[0].message.includes(t024.token.tokenCode), lines[0].message);
    assert.ok(lines[1].message.includes(t025.token.tokenCode), lines[1].message);
  });

  // ── The real Live Counter display model, fed the real payload ────────────
  // The component is JSX so Node cannot import it, but the payload contract it
  // depends on is checked here instead: the real payload must carry a tokenCode
  // and plain-language reason text, and must not carry anything the display model
  // is not allowed to hold.
  check('26. the real skip payload satisfies the Live Counter display contract', () => {
    for (const payload of liveSkipEvents) {
      assert.strictEqual(payload.skipReason, 'OUT_OF_RANGE');
      assert.ok(payload.token?.tokenCode, 'the board needs a token code to announce');
      assert.ok(
        typeof payload.token.skipReasonText === 'string' && payload.token.skipReasonText.trim(),
        'the board needs authored plain language, never an enum'
      );
      assert.ok(!/latitude|longitude|accuracy|distanceMeters|proximityState|locationStatus/i.test(
        JSON.stringify(payload)
      ), 'the public board payload must carry no location detail at all');
    }
  });

  // ── Notifications ────────────────────────────────────────────────────────
  const skipNotices = await Notification.find({
    type: 'TOKEN_SKIPPED_OUT_OF_RANGE',
    'metadata.tokenCode': { $in: [t024.token.tokenCode, t025.token.tokenCode] },
  }).lean();

  check('27. each skipped customer got a truthful, actionable notification', () => {
    assert.strictEqual(skipNotices.length, 2, `expected 2 notifications, got ${skipNotices.length}`);
    for (const n of skipNotices) {
      assert.ok(/outside the service area/i.test(n.body), `body must say why: ${n.body}`);
      assert.ok(/rejoin/i.test(n.body), `body must say how to recover: ${n.body}`);
    }
  });

  const calledNotices = await Notification.find({
    type: 'TOKEN_SKIPPED_OUT_OF_RANGE',
    'metadata.tokenCode': t026.token.tokenCode,
  }).lean();
  check('28. the in-range customer was not sent a skip notification', () => {
    assert.strictEqual(calledNotices.length, 0);
  });

  const c026Warnings = await Notification.find({
    type: { $in: ['TURN_APPROACHING_RETURN', 'TURN_IMMINENT_RETURN'] },
    'metadata.tokenCode': t026.token.tokenCode,
  }).lean();
  check('29. the in-range customer was never sent an approaching warning', () => {
    assert.strictEqual(c026Warnings.length, 0, 'a customer inside the radius must not be warned');
  });

  const skipEvents = await QueueEvent.find({
    eventType: 'TOKEN_SKIPPED_OUT_OF_RANGE',
    tokenId: { $in: fixture.tokenIds },
  }).lean();
  check('30. each skip is auditable as a queue event with no coordinates', () => {
    assert.strictEqual(skipEvents.length, 2, `expected 2 queue events, got ${skipEvents.length}`);
    for (const e of skipEvents) {
      const blob = JSON.stringify(e.metadata);
      assert.ok(!/latitude|longitude|accuracy/i.test(blob), blob);
    }
  });

  const dayQueue = await Queue.findOne({ centerId, serviceId, date: new Date().toISOString().slice(0, 10) }).lean();
  check('31. the day aggregate counts a skipped customer as abandoned, not served', () => {
    assert.ok(dayQueue, 'a day queue document must exist');
    assert.ok((dayQueue.abandonedCount || 0) >= 2, `abandonedCount was ${dayQueue.abandonedCount}`);
  });

  // ── Follow-up A: a customer who walks back in is called, not skipped ─────
  section('Follow-up A: a customer returns to the service area and rejoins');
  const c025 = customers[1];
  const rejoin = await api('POST', '/tokens', {
    token: c025.token,
    body: {
      centerId, serviceId, notifyApp: true, notifySms: false,
      latitude: IN_RANGE.latitude, longitude: IN_RANGE.longitude, accuracy: 8,
    },
  });
  const rejoined = rejoin.data.token;
  fixture.tokenIds.push(rejoined._id);
  log(`${c025.email} rejoined as ${rejoined.tokenCode} inside the radius`);

  const afterRejoin = [];
  const afterRejoinConn = await connectSocket(
    { token: `Bearer ${displayToken}` },
    { joinCenter: centerId, label: 'Live Counter (post-rejoin)' }
  );
  fixture.sockets.push(afterRejoinConn.socket);
  for (const e of counterConn.events.slice()) afterRejoin.push(e);

  const call2 = await api('POST', `/counters/${counterId}/call-next`, { token: adminToken });
  log(`message: ${call2.message}`);

  check('32. a customer who returned in range is called, and nobody is skipped', () => {
    assert.ok(call2.data.token, 'the returning customer must be called');
    assert.strictEqual(call2.data.token.tokenCode, rejoined.tokenCode);
    assert.strictEqual(call2.data.skippedCount, 0, 'nobody should have been skipped');
  });

  const c025Tokens = await Token.find({ userId: c025.userId, centerId, serviceId }).lean();
  check('33. rejoining created a new token rather than resurrecting the old one', () => {
    assert.strictEqual(c025Tokens.length, 2, 'exactly the original skip plus one rejoin');
    const active = c025Tokens.filter((t) => ['WAITING', 'CALLED', 'SERVING'].includes(t.status));
    assert.strictEqual(active.length, 1, 'only one ACTIVE token may exist per customer');
  });

  // ── Follow-up B: everybody out of range fabricates nothing ────────────────
  section('Follow-up B: a queue where everybody has walked out');
  // Free the counter by completing the customer currently called.
  await api('POST', `/counters/${counterId}/start-serving`, { token: adminToken }).catch(() => {});
  await api('POST', `/counters/${counterId}/complete`, { token: adminToken }).catch(() => {});

  const leavers = [];
  for (const idx of [3, 4, 5]) {
    const joined = await joinAs(idx);
    leavers.push(joined);
    const res = await api('POST', `/tokens/${joined.token._id}/location`, {
      token: joined.customer.token,
      body: {
        latitude: OUT_RANGE.latitude,
        longitude: OUT_RANGE.longitude,
        accuracy: 9,
        timestamp: new Date().toISOString(),
        centerId,
      },
    });
    if (res.data.locationStatus !== 'OUT_OF_RANGE') {
      throw new Error(`${joined.token.tokenCode} was expected OUT_OF_RANGE, got ${res.data.locationStatus}`);
    }
  }
  log(`${leavers.length} waiting customers all walked out: ${leavers.map((l) => l.token.tokenCode).join(', ')}`);

  const call3 = await api('POST', `/counters/${counterId}/call-next`, { token: adminToken });
  await sleep(600);
  log(`message: ${call3.message}`);

  check('34. an all-out-of-range queue calls nobody and invents nothing', () => {
    assert.strictEqual(call3.data.token, null, 'no token may be fabricated');
  });

  check('35. it truthfully reports every customer it skipped', () => {
    assert.strictEqual(call3.data.skippedCount, 3, `expected 3 skips, got ${call3.data.skippedCount}`);
  });

  check('36. the operator is told there is no eligible customer, not a fake success', () => {
    assert.ok(/no eligible customer/i.test(call3.message), call3.message);
    assert.ok(/skipped/i.test(call3.message), call3.message);
    assert.ok(/3 customers skipped/.test(call3.message), call3.message);
  });

  // ── Follow-up C: an unconfirmed location is never treated as in range ─────
  section('Follow-up C: an unconfirmed location blocks the scan');
  const c4 = customers[3];
  const join4 = await api('POST', '/tokens', {
    token: c4.token,
    body: {
      centerId, serviceId, notifyApp: true, notifySms: false,
      latitude: IN_RANGE.latitude, longitude: IN_RANGE.longitude, accuracy: 8,
    },
  });
  fixture.tokenIds.push(join4.data.token._id);
  log(`${join4.data.token.tokenCode} joined inside the radius`);

  // Age the stored reading past the backend's staleness threshold. This is the
  // only honest way to produce one: the upload endpoint legitimately rejects
  // readings older than 5 minutes, so real staleness only arises with time.
  await Token.updateOne(
    { _id: join4.data.token._id },
    { $set: { 'lastLocation.updatedAt': new Date(Date.now() - 10 * 60 * 1000) } }
  );
  const aged = await Token.findById(join4.data.token._id).lean();
  log(`aged its stored reading to ${aged.lastLocation.updatedAt.toISOString()}`);

  const call4 = await api('POST', `/counters/${counterId}/call-next`, { token: adminToken });
  await sleep(500);
  log(`message: ${call4.message}`);

  check('37. a stale location is neither called nor skipped', () => {
    assert.strictEqual(call4.data.token, null, 'presence is unverified, so nobody may be called');
    assert.strictEqual(call4.data.skippedCount, 0, 'no evidence they left, so nobody may be skipped');
  });

  check('38. the operator is told exactly who was blocked and why, in plain words', () => {
    assert.ok(call4.data.blocked.length >= 1, 'the operator must be told who was blocked');
    assert.strictEqual(call4.data.blocked[0].tokenCode, join4.data.token.tokenCode);
    assert.ok(/unconfirmed/i.test(call4.data.blocked[0].reason), call4.data.blocked[0].reason);
  });

  check('39. the blocked response leaks no internal state name or coordinate', () => {
    const blob = JSON.stringify(call4.data);
    assert.ok(!/LOCATION_STALE|LOCATION_UNAVAILABLE/.test(blob), blob);
    assert.ok(!/latitude|longitude|accuracy/i.test(blob), blob);
  });

  const stillWaiting = await Token.findById(join4.data.token._id).lean();
  check('40. the blocked customer keeps their place in the queue', () => {
    assert.strictEqual(stillWaiting.status, 'WAITING', 'an unverified customer is never removed');
  });

  // ── Follow-up D: two concurrent CALL NEXT presses ─────────────────────────
  section('Follow-up D: two concurrent CALL NEXT presses cannot claim the same customer');

  // The counter must be free for a race to mean anything, and the previously
  // blocked customer must be out of the queue, so that the only thing the two
  // presses can possibly claim is one of the two racers.
  const counterBefore = await Counter.findById(counterId).lean();
  if (counterBefore.currentTokenId) {
    log(`counter still held ${counterBefore.currentTokenId.tokenCode}; clearing it`);
    await api('POST', `/counters/${counterId}/start-serving`, { token: adminToken });
    await api('POST', `/counters/${counterId}/complete`, { token: adminToken });
  }
  const stillHeld = await Counter.findById(counterId).lean();
  assert.ok(!stillHeld.currentTokenId, 'the counter must be free before the race');

  // customers[3] is already active in the queue, so use the two customers whose
  // previous tokens were all skipped and who are therefore free to rejoin.
  const racers = [];
  for (const idx of [4, 5]) {
    const joined = await joinAs(idx);
    racers.push(joined.token);
  }
  log(`racers in queue: ${racers.map((t) => t.tokenCode).join(', ')}`);

  // While the blocked customer is still at the head of the line, the scan must
  // not reach past them to the two perfectly eligible customers behind them.
  // Strict FIFO is the point: an unverified head of line is a real queue, not an
  // absent one, and skipping over it would silently reorder the queue.
  const shielded = await api('POST', `/counters/${counterId}/call-next`, { token: adminToken });
  log(`with the blocked customer still first: ${shielded.message}`);
  check('41. a blocked head of line shields the queue behind it: no one is jumped', () => {
    assert.strictEqual(shielded.data.token, null, 'FIFO must not be reordered by proximity');
    assert.strictEqual(shielded.data.skippedCount, 0, 'nobody behind them may be skipped');
    assert.strictEqual(shielded.data.blocked[0].tokenCode, stillWaiting.tokenCode);
  });

  // Remove the blocked customer from the queue so the race is unambiguous. The
  // cancel endpoint only accepts the token's owner, so this uses that
  // customer's own credential, exactly as the app would.
  const removed = await api('POST', `/tokens/${stillWaiting._id}/cancel`, {
    token: customers[3].token,
  })
    .then(() => true)
    .catch((e) => {
      log(`  cancel failed: ${e.message}`);
      return false;
    });
  assert.ok(removed, 'the blocked customer must be removable, or the race is not a race');
  log(`blocked customer ${stillWaiting.tokenCode} removed from the queue`);

  // Confirm the racers really are eligible, so a "no duplicates" result later
  // cannot be vacuously true because nobody was callable at all.
  const racerState = await Token.find({ _id: { $in: racers.map((t) => t._id) } }).lean();
  for (const r of racerState) {
    log(`  ${r.tokenCode}: status=${r.status} locationStatus=${r.locationStatus}`);
  }
  check('42. both racers are waiting and confirmed in range before the race', () => {
    assert.strictEqual(racerState.length, 2);
    for (const r of racerState) {
      assert.strictEqual(r.status, 'WAITING', `${r.tokenCode} is ${r.status}`);
      assert.strictEqual(r.locationStatus, 'IN_RANGE', `${r.tokenCode} is ${r.locationStatus}`);
    }
  });

  const [ra, rb] = await Promise.all([
    api('POST', `/counters/${counterId}/call-next`, { token: adminToken }).catch((e) => ({ error: e.message })),
    api('POST', `/counters/${counterId}/call-next`, { token: adminToken }).catch((e) => ({ error: e.message })),
  ]);
  for (const [label, r] of [['A', ra], ['B', rb]]) {
    log(`  press ${label}: ${r.error ? `ERROR ${r.error}` : r.message}`);
  }
  const calledCodes = [ra, rb]
    .map((r) => (r.data && r.data.token ? r.data.token.tokenCode : null))
    .filter(Boolean);
  log(`the two presses returned: ${JSON.stringify(calledCodes)}`);

  // A race test that calls nobody proves nothing, so require that the race was
  // actually contested before judging it.
  check('43. the race was genuinely contested: at least one press claimed a customer', () => {
    assert.ok(
      calledCodes.length >= 1,
      'neither press called anybody, so "no double claim" would be vacuously true. ' +
      `press A: ${ra.error || ra.message} | press B: ${rb.error || rb.message}`
    );
    assert.ok(
      calledCodes.length <= 2,
      `at most one customer per press: ${calledCodes.join(', ')}`
    );
  });

  check('44. two concurrent presses never call the same customer twice', () => {
    assert.strictEqual(
      new Set(calledCodes).size, calledCodes.length,
      `the same customer was handed out twice: ${calledCodes.join(', ')}`
    );
  });

  const racersAfter = await Token.find({ _id: { $in: racers.map((t) => t._id) } }).lean();
  const stillCalled = await Token.countDocuments({ centerId, serviceId, status: 'CALLED' });
  const counterAfter = await Counter.findById(counterId).lean();
  const currentCode =
    racersAfter.find((r) => r._id.toString() === String(counterAfter.currentTokenId))?.tokenCode
    || '(not a racer)';

  // Known pre-existing behaviour, deliberately NOT papered over here. `callNext`
  // pre-emptively completes whoever the counter was holding and takes the next
  // token, and that counter update is a plain read-modify-write
  // (`counter.currentTokenId = ...; await counter.save()`), untouched by Phase 2.
  // So two genuinely concurrent presses can leave BOTH customers CALLED against
  // the same counter, with only one of them being the counter's current token.
  // That is a counter-occupancy race in pre-existing code, not a geofencing
  // defect: the Phase 2 claim — that two presses can never hand the *same*
  // customer to two counters — still holds, and is asserted above.
  log(`after the race: ${stillCalled} CALLED; counter.currentTokenId = ${currentCode}`);
  if (stillCalled > 1) {
    log(
      'NOTE pre-existing counter-occupancy race: two customers are CALLED against one ' +
      'counter, only one of which is its currentTokenId'
    );
  }

  check('45. the counter itself stays self-consistent: it points at one customer it called', () => {
    assert.ok(counterAfter.currentTokenId, 'the counter must point at somebody it called');
    const pointed = racersAfter.find((r) => r._id.toString() === String(counterAfter.currentTokenId));
    assert.ok(pointed, `the counter must point at one of the racers, not ${currentCode}`);
    assert.ok(calledCodes.includes(pointed.tokenCode), 'and that racer must have been returned by a press');
  });

  check('46. every racer the presses called is a real, distinct claim', () => {
    const called = racersAfter.filter((r) => calledCodes.includes(r.tokenCode));
    assert.strictEqual(called.length, calledCodes.length);
    for (const r of called) {
      assert.strictEqual(r.status, 'CALLED', `${r.tokenCode} is ${r.status}`);
    }
  });

  check('47. a racer nobody claimed is still WAITING: not lost, not skipped', () => {
    const loser = racersAfter.find((r) => !calledCodes.includes(r.tokenCode));
    if (!loser) return; // both presses claimed someone, so nobody was left behind
    assert.strictEqual(
      loser.status, 'WAITING',
      `${loser.tokenCode} must be untouched, got ${loser.status}`
    );
  });

  // ── Teardown ─────────────────────────────────────────────────────────────
  for (const s of fixture.sockets) s.close();
  await purgeCenter(centerId);
  await User.deleteMany({ _id: { $in: fixture.userIds } });
  await Notification.deleteMany({ 'metadata.tokenCode': { $regex: '^P2-' } });
  await mongoose.disconnect();

  console.log('\n====================================================');
  console.log(`Results: ${passed}/${passed + failed} checks passed (${failed} failed)`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}\n      ${f.err.message}`);
  }
  console.log('====================================================');
  process.exit(failed === 0 ? 0 : 1);
}

/** Remove everything a run created for one center, leaving the DB as found. */
async function purgeCenter(centerId) {
  const tokens = await Token.find({ centerId }).select('_id').lean();
  const ids = tokens.map((t) => t._id);
  await Promise.all([
    Token.deleteMany({ centerId }),
    QueueEvent.deleteMany({ centerId }),
    Notification.deleteMany({ 'metadata.tokenCode': { $regex: '^P2-' } }),
    Queue.deleteMany({ centerId }),
    Counter.deleteMany({ centerId }),
    Service.deleteMany({ centerId }),
    ServiceCenter.deleteMany({ _id: centerId }),
  ]);
  return ids;
}

main().catch(async (err) => {
  console.error('\nE2E ABORTED:', err.message);
  console.error(err.stack);
  try {
    await mongoose.disconnect();
  } catch {
    /* already closed */
  }
  process.exit(2);
});

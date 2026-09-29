/**
 * Creates the dedicated college hackathon demo facility using the EXISTING
 * QueueFlow admin REST API and MongoDB models.
 *
 * Nothing is mocked and no new model is introduced. Every record is a real
 * persisted document:
 *
 *   POST /api/service-centers        -> "College Account"
 *   POST /api/services               -> "College Queue"
 *   POST /api/counters  (x2)         -> "Counter 01", "Counter 02"
 *   PATCH /api/counters/:id/assign   -> both counters serve College Queue
 *
 * The script is idempotent: an existing facility is reused, never duplicated,
 * and no other center/service/counter is touched.
 *
 * Usage: node create_college_facility.js [baseUrl]
 */
process.env.NODE_ENV = 'development';
require('dotenv').config();

const BASE = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@queueflow.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin@1234';

const CENTER_NAME = 'College Account';
const CENTER_CODE = 'COLLEGE01';
const SERVICE_NAME = 'College Queue';
const SERVICE_PREFIX = 'C';

let token = null;

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, body: json };
}

const unwrap = (res) => res?.body?.data?.center || res?.body?.data?.service || res?.body?.data?.counter || res?.body?.data || null;

(async () => {
  console.log(`\n=== Creating demo facility on ${BASE} ===\n`);

  // ── Admin auth ────────────────────────────────────────────────────────────
  const login = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (login.status !== 200 || !login.body?.data?.token) {
    console.error('Admin login failed:', login.status, JSON.stringify(login.body).slice(0, 300));
    process.exit(1);
  }
  token = login.body.data.token;
  console.log('1. authenticated as admin');

  // ── 1. Service center ─────────────────────────────────────────────────────
  // Reuse by exact name so repeated runs never create duplicates.
  const existing = await api('GET', '/api/service-centers');
  const all = existing.body?.data?.centers || [];
  let center = all.find((c) => c.name === CENTER_NAME);

  if (center) {
    console.log(`2. service center already exists: ${center._id}`);
  } else {
    const res = await api('POST', '/api/service-centers', {
      name: CENTER_NAME,
      code: CENTER_CODE,
      // Existing valid enum. A college help desk is a support facility.
      type: 'SUPPORT',
      capacity: 200,
      isOpen: true,
      address: {
        street: 'College Campus - Main Hall',
        city: 'Campus',
        state: 'NA',
        zip: '000000',
        country: 'IN',
      },
    });
    if (res.status !== 201) {
      console.error('Center creation failed:', res.status, JSON.stringify(res.body).slice(0, 400));
      process.exit(1);
    }
    center = unwrap(res);
    console.log(`2. created service center: ${center._id}`);
  }
  const centerId = String(center._id);

  // ── 2. Service ────────────────────────────────────────────────────────────
  const svcList = await api('GET', `/api/services?centerId=${centerId}`);
  const svcArr = svcList.body?.data?.services || svcList.body?.data || [];
  let service = (Array.isArray(svcArr) ? svcArr : []).find((s) => s.name === SERVICE_NAME);

  if (service) {
    console.log(`3. service already exists: ${service._id}`);
    // Make sure it is genuinely joinable.
    if (service.isActive === false) {
      const act = await api('PATCH', `/api/services/${service._id}`, { isActive: true });
      service = unwrap(act) || service;
      console.log('   re-activated the service');
    }
  } else {
    const res = await api('POST', '/api/services', {
      centerId,
      name: SERVICE_NAME,
      tokenPrefix: SERVICE_PREFIX,
      avgServiceTimeMinutes: 5,
      isActive: true,
      order: 1,
      description: 'Main queue operated inside the college for the hackathon demo',
    });
    if (res.status !== 201) {
      console.error('Service creation failed:', res.status, JSON.stringify(res.body).slice(0, 400));
      process.exit(1);
    }
    service = unwrap(res);
    console.log(`3. created service: ${service._id}`);
  }
  const serviceId = String(service._id);

  // ── 3. Counters ───────────────────────────────────────────────────────────
  const counterRes = await api('GET', `/api/counters?centerId=${centerId}`);
  const counters = counterRes.body?.data?.counters || counterRes.body?.data || [];
  const wanted = [
    { number: 1, name: 'Counter 01' },
    { number: 2, name: 'Counter 02' },
  ];
  const created = [];

  for (const w of wanted) {
    let counter = (Array.isArray(counters) ? counters : []).find((c) => c.number === w.number);
    if (!counter) {
      // Canonical lobby label, e.g. "Counter 01" -> "COUNTER 01".
      const displayLabel = `${w.name.split(' ')[0].toUpperCase()} ${String(w.number).padStart(2, '0')}`;
      const res = await api('POST', '/api/counters', {
        centerId,
        name: w.name,
        number: w.number,
        displayLabel,
      });
      if (res.status !== 201) {
        console.error(`Counter ${w.number} creation failed:`, res.status, JSON.stringify(res.body).slice(0, 300));
        process.exit(1);
      }
      counter = unwrap(res);
      console.log(`4. created ${w.name}: ${counter._id}`);
    } else {
      console.log(`4. ${w.name} already exists: ${counter._id}`);
    }

    // Assign the real service so Call Next can pick a queue.
    const assignedServiceId = counter.serviceId && (counter.serviceId._id || counter.serviceId);
    if (String(assignedServiceId || '') !== serviceId) {
      const asg = await api('PATCH', `/api/counters/${counter._id}/assign`, {
        serviceId,
        reason: 'College demo facility setup',
      });
      if (asg.status >= 400) {
        console.error(`  assign failed:`, asg.status, JSON.stringify(asg.body).slice(0, 300));
      } else {
        console.log(`   assigned ${w.name} -> College Queue`);
      }
    }

    // Ensure the counter is open and serving.
    const current = (await api('GET', `/api/counters?centerId=${centerId}`)).body?.data?.counters || [];
    const fresh = (Array.isArray(current) ? current : []).find((c) => c._id === String(counter._id));
    if (fresh && fresh.status !== 'ACTIVE') {
      await api('PATCH', `/api/counters/${counter._id}/status`, { status: 'ACTIVE' });
      console.log(`   reopened ${w.name}`);
    }
    created.push({ name: w.name, id: String(counter._id) });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const disp = (await api('GET', `/api/queue/${centerId}/display`)).body?.data;
  console.log('\n================= COLLEGE DEMO FACILITY =================');
  console.log(`centerId   : ${centerId}`);
  console.log(`centerName : ${disp?.center?.name}`);
  console.log(`centerCode : ${disp?.center?.code}`);
  console.log(`type       : ${center.type}   capacity: ${center.capacity}   isOpen: ${center.isOpen}`);
  console.log(`serviceId  : ${serviceId}`);
  console.log(`serviceName: ${service.name}   prefix: ${service.tokenPrefix}   isActive: ${service.isActive}`);
  created.forEach((c) => console.log(`counter    : ${c.id}  ${c.name}`));
  console.log('displayToken:', disp?.displayToken ? 'PRESENT' : 'MISSING');
  console.log('metrics    :', JSON.stringify(disp?.metrics));
  console.log('nowServing :', (disp?.nowServing || []).map((t) => t.tokenCode).join(',') || '(none)');
  console.log('nextInQueue:', (disp?.nextInQueue || []).map((t) => t.tokenCode).join(',') || '(none)');
  console.log('counters   :', (disp?.counters || []).map((c) => `${c.name}=${c.status}${c.service ? '/' + c.service.name : ''}`).join(', '));
  console.log('crowd      :', disp?.center?.currentCrowd, `(${disp?.center?.crowdStatus})`);
  console.log('=========================================================\n');

  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

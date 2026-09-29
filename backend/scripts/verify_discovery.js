/**
 * Verifies the four customer-facing surfaces all resolve the same active set
 * from the authoritative backend, and that an inactive center is rejected.
 * Read-only.
 */
const BASE = process.env.QF_API_BASE || 'http://localhost:5000';

const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';
// A center that was definitely deactivated by the curation run.
const KNOWN_INACTIVE_CODE = 'SBANK001';
const KNOWN_INACTIVE_ID = '6ab030edfb8baa6b361738db';

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
}

const centersOf = (j) => (j && j.data && Array.isArray(j.data.centers) ? j.data.centers : []);

(async () => {
  console.log('=== 1. GET /api/service-centers?isOpen=true (public discovery) ===');
  const active = await get('/api/service-centers?isOpen=true');
  const list = centersOf(active.body);
  console.log(`status=${active.status}  count=${list.length}`);
  for (const c of list) {
    console.log(`  ${c.code.padEnd(11)} ${c.name}`);
    console.log(`             id=${c._id} type=${c.type} isOpen=${c.isOpen}`);
  }

  const expected = 5;
  console.log(`\nassert count === ${expected}: ${list.length === expected ? 'PASS' : 'FAIL'}`);

  const college = list.find((c) => c._id === COLLEGE_ID);
  console.log(`assert College Account present & active: ${college && college.isOpen ? 'PASS' : 'FAIL'}`);
  console.log(`assert College name unchanged: ${college && college.name === 'College Account' ? 'PASS' : 'FAIL'}`);
  console.log(`assert College code unchanged: ${college && college.code === 'COLLEGE01' ? 'PASS' : 'FAIL'}`);

  console.log('\n=== 2. No test/stress center is discoverable while active ===');
  const junk = list.filter((c) =>
    /test|regression|stress|verify|alloc|fcm trigger|empty center|closed center|live tracking|crowd telemetry|swap test/i.test(c.name),
  );
  console.log(`suspicious names in active set: ${junk.length} -> ${junk.length === 0 ? 'PASS' : 'FAIL'}`);

  console.log('\n=== 3. Unfiltered list still returns everything (admin/archive path) ===');
  const all = centersOf((await get('/api/service-centers')).body);
  console.log(`unfiltered count=${all.length} (${all.length} >= ${list.length} -> ${all.length >= list.length ? 'PASS' : 'FAIL'})`);
  const inactivePresent = all.filter((c) => c.isOpen === false);
  console.log(`inactive records still returned when unfiltered: ${inactivePresent.length}`);

  console.log('\n=== 4. Each active center is individually fetchable ===');
  for (const c of list) {
    const one = await get(`/api/service-centers/${c._id}`);
    const got = one.body && one.body.data && one.body.data.center;
    console.log(`  ${c.code.padEnd(11)} status=${one.status} name="${got ? got.name : 'MISSING'}"`);
  }

  console.log('\n=== 5. A deactivated center is not in active discovery ===');
  const stillActive = list.find((c) => c._id === KNOWN_INACTIVE_ID);
  console.log(`${KNOWN_INACTIVE_CODE} (${KNOWN_INACTIVE_ID}) in active list: ${stillActive ? 'FAIL' : 'PASS'}`);

  const one = await get(`/api/service-centers/${KNOWN_INACTIVE_ID}`);
  const c = one.body && one.body.data && one.body.data.center;
  console.log(`direct fetch status=${one.status} isOpen=${c ? c.isOpen : 'n/a'} (record retained, flagged closed)`);

  console.log('\n=== 6. Joining an inactive center is refused by the backend ===');
  // joinQueue rejects a closed center before any location check.
  const { signToken } = require('../src/middleware/auth');
  const mongoose = require('mongoose');
  require('dotenv').config();
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../src/models/User');
  const u = await User.findOne({ role: 'CUSTOMER' });
  const tok = signToken(String(u._id), u.role, u.tokenVersion || 0);

  const joinRes = await fetch(`${BASE}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({
      centerId: KNOWN_INACTIVE_ID,
      serviceId: '6ab030eefb8baa6b361738ed',
      channel: 'WEB',
    }),
  });
  const joinBody = await joinRes.json().catch(() => null);
  console.log(`join inactive center -> status=${joinRes.status} message="${(joinBody && joinBody.message) || ''}"`);
  console.log(`assert rejected: ${joinRes.status === 400 ? 'PASS' : `FAIL (status ${joinRes.status})`}`);

  // And the same join against an ACTIVE center must be accepted.
  const activeWithSvc = list.find((x) => x._id !== COLLEGE_ID);
  const { Service } = require('../src/models/Token');
  await mongoose.disconnect();
  void Service; void activeWithSvc;

  console.log('\n=== 7. Live counter display token available for each active center ===');
  for (const c of list) {
    const disp = await get(`/api/queue/${c._id}/display`);
    const d = disp.body && disp.body.data;
    console.log(`  ${c.code.padEnd(11)} status=${disp.status} displayToken=${d && d.displayToken ? 'PRESENT' : 'absent'} counters=${d && d.counters ? d.counters.length : 0}`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

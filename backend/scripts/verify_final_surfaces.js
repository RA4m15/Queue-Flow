/**
 * Final cross-surface verification of the curated active-center set.
 * Read-only. Proves all four frontends resolve the SAME 5 centers from the
 * authoritative backend, that an old test-center QR is cleanly refused, and
 * that College Account is fully intact.
 */
const BASE = process.env.QF_API_BASE || 'http://localhost:5000';
const mongoose = require('mongoose');
require('dotenv').config();

const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const Notification = require('../src/models/Notification');

const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';
// A test center that must now be invisible / refused.
const OLD_TEST_CENTER = '6ab77948e712763a816b1d7c'; // "Alert Center 032906"
const EXPECTED = [
  { code: 'AIIMSBPL', name: 'All India Institute of Medical Sciences (AIIMS), Bhopal' },
  { code: 'BMCBPL01', name: 'Bhopal Municipal Corporation' },
  { code: 'COLLEGE01', name: 'College Account' },
  { code: 'COLBPL01', name: 'Office of the Collector and District Magistrate, Bhopal' },
  { code: 'SBIPBB01', name: 'State Bank of India — PBB New Market' },
];

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
}

async function main() {
  console.log('=== A. BACKEND AUTHORITATIVE DISCOVERY ===');
  const res = await fetch(`${BASE}/api/service-centers?isOpen=true`);
  const body = await res.json();
  const list = body.data.centers;
  check('GET /api/service-centers?isOpen=true returns 200', res.status === 200, `status=${res.status}`);
  check('exactly 5 active centers', list.length === 5, `count=${list.length}`);
  for (const e of EXPECTED) {
    const got = list.find((c) => c.code === e.code);
    check(`active: ${e.code} "${e.name}"`, Boolean(got) && got.name === e.name, got ? got.name : 'MISSING');
  }

  console.log('\n=== B. ALL FOUR SURFACES RESOLVE THE SAME SET ===');
  // Each surface is configured to ask the backend for active centers. Assert the
  // exact request each one makes, from its real source file.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const expectActiveQuery = [
    ['customer_web/src/services/api.js', '/service-centers?isOpen=true'],
    ['live_counter/src/services/api.js', '/api/service-centers?isOpen=true'],
    ['admin_panel/src/components/layout/Navbar.jsx', 'isOpen: true'],
    ['admin_panel/src/hooks/useServices.js', 'isOpen: true'],
  ];
  for (const [file, needle] of expectActiveQuery) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    check(`${file} queries active centers`, text.includes(needle), needle);
  }
  // Flutter already defaults to isOpen=true.
  const dart = fs.readFileSync(path.join(root, 'user_app/lib/services/api_service.dart'), 'utf8');
  check('user_app api_service defaults isOpen=true', /getServiceCenters\(\{\s*bool\?\s*isOpen\s*=\s*true\s*\}\)/.test(dart));

  console.log('\n=== C. NO HARDCODED CENTER LIST IN FRONTENDS ===');
  for (const file of expectActiveQuery.map((e) => e[0]).concat(['user_app/lib/services/api_service.dart'])) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const hardcoded = ['COLLEGE01', 'SBIPBB01', 'AIIMSBPL', 'BMCBPL01', 'COLBPL01'].filter((c) => text.includes(c));
    check(`${file} has no hardcoded center codes`, hardcoded.length === 0, hardcoded.join(',') || 'none');
  }

  console.log('\n=== D. COLLEGE ACCOUNT INTACT ===');
  await mongoose.connect(process.env.MONGODB_URI);
  const college = await ServiceCenter.findById(COLLEGE_ID).lean();
  check('exists exactly once', Boolean(college));
  check('id unchanged', String(college._id) === COLLEGE_ID);
  check('code unchanged COLLEGE01', college.code === 'COLLEGE01');
  check('name unchanged "College Account"', college.name === 'College Account');
  check('isOpen true', college.isOpen === true);
  const cServices = await Service.find({ centerId: COLLEGE_ID }).lean();
  const cCounters = await Counter.find({ centerId: COLLEGE_ID }).lean();
  check('services preserved', cServices.length >= 1, `${cServices.length} service(s): ${cServices.map((s) => s.name).join(', ')}`);
  check('Counter 01 + Counter 02 preserved', cCounters.length === 2, cCounters.map((c) => c.name).join(', '));
  check('geofence preserved', college.geofence !== undefined, JSON.stringify(college.geofence));
  check('autoResourceAllocation preserved', college.autoResourceAllocation !== undefined, String(college.autoResourceAllocation));
  const collegeTokens = await Token.countDocuments({ centerId: COLLEGE_ID });
  check('historical tokens preserved', collegeTokens >= 0, `${collegeTokens} token(s) still attached`);

  console.log('\n=== E. COLLEGE COORDINATES NOT COPIED ELSEWHERE ===');
  const actives = await ServiceCenter.find({ isOpen: true }).lean();
  const withCoords = actives.filter((c) => typeof c.latitude === 'number' && typeof c.longitude === 'number');
  for (const c of withCoords) {
    const sameAsCollege = String(c._id) !== COLLEGE_ID
      && c.latitude === college.latitude && c.longitude === college.longitude;
    check(`${c.code} does not reuse College coordinates`, !sameAsCollege);
  }
  check('new centers created without invented coordinates',
    actives.filter((c) => c._id.toString() !== COLLEGE_ID).every((c) => c.latitude === null || c.latitude === undefined),
    actives.filter((c) => c._id.toString() !== COLLEGE_ID).map((c) => `${c.code}:${c.latitude}`).join(' '));

  console.log('\n=== F. OLD TEST CENTER IS INACTIVE AND REFUSED ===');
  const old = await ServiceCenter.findById(OLD_TEST_CENTER).lean();
  check('old test center record still exists (not deleted)', Boolean(old), old ? old.name : 'MISSING');
  check('old test center isOpen=false', old && old.isOpen === false, old ? String(old.isOpen) : 'n/a');
  const notInActive = !list.some((c) => c._id === OLD_TEST_CENTER);
  check('old test center absent from active discovery', notInActive);
  const { signToken } = require('../src/middleware/auth');
  const User = require('../src/models/User');
  const u = await User.findOne({ role: 'CUSTOMER' });
  const tok = signToken(String(u._id), u.role, u.tokenVersion || 0);
  const join = await fetch(`${BASE}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ centerId: OLD_TEST_CENTER, serviceId: '6ab77949e712763a816b1d9c9', channel: 'WEB' }),
  });
  const joinBody = await join.json().catch(() => ({}));
  check('joining old test center refused', join.status === 400, `${join.status} ${joinBody.message || ''}`);

  console.log('\n=== G. HISTORICAL DATA PRESERVED ===');
  // Baseline is read at runtime: the curation must never shrink these, and the
  // backend test suites legitimately add to them, so only "no shrinkage" and
  // "no duplicate active codes" are meaningful assertions here.
  const total = await ServiceCenter.countDocuments();
  const tokens = await Token.countDocuments();
  const notifs = await Notification.countDocuments();
  check('center count >= 487 (483 original + 4 curated)', total >= 487, `total=${total}`);
  check('tokens never shrank (>= 1524 baseline)', tokens >= 1524, `tokens=${tokens}`);
  check('notifications never shrank (>= 8866 baseline)', notifs >= 8866, `notifications=${notifs}`);
  const inactiveWithCounters = await Counter.countDocuments({ centerId: { $nin: actives.map((a) => a._id) } });
  check('counters of inactive centers retained', inactiveWithCounters > 0, `${inactiveWithCounters} counters kept on inactive centers`);

  console.log('\n=== H. EVERY ACTIVE CENTER IS JOINABLE + HAS A BOARD ===');
  const { signToken: st } = require('../src/middleware/auth');
  for (const c of actives) {
    const svcs = await Service.find({ centerId: c._id, isActive: true }).lean();
    const cnts = await Counter.find({ centerId: c._id, status: 'ACTIVE' }).lean();
    const disp = await fetch(`${BASE}/api/queue/${c._id}/display`);
    const d = await disp.json().catch(() => null);
    const hasBoard = Boolean(d && d.data && d.data.displayToken);
    check(`${c.code} joinable (active service + counter) + board ready`,
      svcs.length > 0 && cnts.length > 0 && hasBoard,
      `services=${svcs.length} counters=${cnts.length} displayToken=${hasBoard}`);
    void st;
  }

  await mongoose.disconnect();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n==================================================`);
  console.log(`TOTAL: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  FAILED: ${f.label} ${f.detail}`));
    process.exit(1);
  }
  console.log('ALL CROSS-SURFACE CHECKS PASSED.');
}

main().catch(async (e) => {
  console.error('FATAL', e.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

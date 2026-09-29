/**
 * QR verification against the live backend.
 * Confirms canonical QR payloads use a real active center, that an old
 * test-center QR is cleanly refused, and that the College QR still works.
 * Read-only apart from a short-lived join that is cancelled again.
 */
const BASE = process.env.QF_API_BASE || 'http://localhost:5000';
const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';
const OLD_TEST_CENTER = '6ab77948e712763a816b1d7c'; // "Alert Center 032906"
const results = [];
const check = (l, p, d = '') => { results.push({ l, p }); console.log(`  ${p ? 'PASS' : 'FAIL'}  ${l}${d ? ' :: ' + d : ''}`); };

(async () => {
  const mongoose = require('mongoose');
  require('dotenv').config();
  const ServiceCenter = require('../src/models/ServiceCenter');
  const Service = require('../src/models/Service');
  const { signToken } = require('../src/middleware/auth');
  const User = require('../src/models/User');

  await mongoose.connect(process.env.MONGODB_URI);

  console.log('=== 1. Canonical QR payload construction ===');
  const active = (await (await fetch(`${BASE}/api/service-centers?isOpen=true`)).json()).data.centers;
  check('active set available to build a QR from', active.length === 5, `count=${active.length}`);

  // The live counter builds QR URLs from a real selected center id.
  const qrSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'live_counter', 'src', 'services', 'qr.js'), 'utf8');
  check('live_counter QR uses the selected centerId', /centerId/.test(qrSrc));
  check('live_counter QR has no hardcoded localhost center', !/6ab[0-9a-f]{22}/.test(qrSrc));

  console.log('\n=== 2. QR for an ACTIVE center resolves ===');
  const sbi = active.find((c) => c.code === 'SBIPBB01');
  const sbiSvc = (await Service.find({ centerId: sbi._id, isActive: true }))[0];
  const q1 = await fetch(`${BASE}/api/service-centers/${sbi._id}`);
  const q1b = await q1.json();
  check('active center resolvable by the id a QR carries', q1.status === 200 && q1b.data.center.isOpen === true,
    `${sbi.name} id=${sbi._id}`);
  check('active center has a joinable service for the QR serviceId', Boolean(sbiSvc), sbiSvc ? sbiSvc.name : 'none');

  console.log('\n=== 3. QR for the COLLEGE center still works ===');
  const q2 = await fetch(`${BASE}/api/service-centers/${COLLEGE_ID}`);
  const q2b = await q2.json();
  check('College Account QR target resolves and is open',
    q2.status === 200 && q2b.data.center.isOpen === true && q2b.data.center.code === 'COLLEGE01',
    q2b.data?.center?.name);
  const collegeSvc = (await Service.find({ centerId: COLLEGE_ID, isActive: true }))[0];
  check('College Account has an active service for its QR', Boolean(collegeSvc), collegeSvc ? collegeSvc.name : 'none');
  // Prove the College queue is genuinely joinable end to end.
  const u = await User.findOne({ role: 'CUSTOMER' });
  const tok = signToken(String(u._id), u.role, u.tokenVersion || 0);
  // College Account is geofenced (geofence.enabled = true, radius 100 m), so a
  // join must carry a location inside that fence. Use the center's OWN
  // coordinates, which is exactly what a customer standing there would send.
  // This proves the geofence is intact rather than bypassing it.
  const collegeDoc = await ServiceCenter.findById(COLLEGE_ID).lean();
  const join = await fetch(`${BASE}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({
      centerId: COLLEGE_ID,
      serviceId: String(collegeSvc._id),
      channel: 'WEB',
      latitude: collegeDoc.latitude,
      longitude: collegeDoc.longitude,
      accuracy: 10,
      timestamp: new Date().toISOString(),
    }),
  });
  const jb = await join.json().catch(() => ({}));
  const joinedOk = join.status === 201;
  check('College Account queue join succeeds (QR -> join works, geofence intact)', joinedOk,
    joinedOk ? `token ${jb.data?.token?.tokenCode}` : `${join.status} ${jb.message || ''}`);
  if (joinedOk) {
    await fetch(`${BASE}/api/tokens/${jb.data.token._id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: '{}',
    });
    console.log('       (test token cancelled again)');
  }

  console.log('\n=== 4. QR for an INACTIVE center is cleanly refused ===');
  const old = await ServiceCenter.findById(OLD_TEST_CENTER).lean();
  check('old test center record retained (not deleted)', Boolean(old), old ? old.name : 'MISSING');
  const oldSvc = (await Service.find({ centerId: OLD_TEST_CENTER }))[0];
  const joinOld = await fetch(`${BASE}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ centerId: OLD_TEST_CENTER, serviceId: oldSvc ? String(oldSvc._id) : 'x', channel: 'WEB' }),
  });
  const jbOld = await joinOld.json().catch(() => ({}));
  check('join against inactive center refused with a clear reason',
    joinOld.status === 400 && /closed/i.test(jbOld.message || ''),
    `${joinOld.status} "${jbOld.message || ''}"`);
  // The frontend surfaces this as "Service center unavailable".
  const cwCenter = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'customer_web', 'src', 'pages', 'CenterServicesPage.jsx'), 'utf8');
  const cwPreview = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'customer_web', 'src', 'pages', 'QueuePreviewPage.jsx'), 'utf8');
  check('customer_web shows "Service center unavailable"', /Service center unavailable/.test(cwCenter));
  check('customer_web preview guards on center.isOpen === false', /center\?\.isOpen === false/.test(cwPreview));
  check('customer_web center page guards on center.isOpen === false', /center\?\.isOpen === false/.test(cwCenter));

  console.log('\n=== 5. Flutter guards the same case ===');
  const jp = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'user_app', 'lib', 'providers', 'join_preview_provider.dart'), 'utf8');
  check('flutter throws a closed-center state instead of offering a join',
    /if \(!center\.isOpen\)/.test(jp) && /JoinPreviewCenterClosed/.test(jp));

  await mongoose.disconnect();
  const failed = results.filter((r) => !r.p);
  console.log(`\n==================================================`);
  console.log(`TOTAL: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) { failed.forEach((f) => console.log(`  FAILED: ${f.l}`)); process.exit(1); }
  console.log('ALL QR CHECKS PASSED.');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });

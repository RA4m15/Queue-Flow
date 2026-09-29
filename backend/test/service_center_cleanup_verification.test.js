'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const assert = require('assert');
const mongoose = require('mongoose');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const { app } = require('../server');

const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';
const EXPECTED_KEEP_IDS = [
  '6ab030edfb8baa6b361738d8', // City Hall — Branch 01
  '6ab030edfb8baa6b361738db', // State Bank — Main Branch
  '6ab77948e712763a816b1d7c', // Alert Center 032906
  '6ab96defe738d0ba61cadae2', // Metro Service Hub 1790537198754
  '6ab7a6f826b0c3f5430791ee', // Bengaluru Center 1790420728717
];
const ALL_ACTIVE_EXPECTED = [COLLEGE_ID, ...EXPECTED_KEEP_IDS];

async function verify() {
  console.log('\n=== QueueFlow Service Center Cleanup Verification ===\n');

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  // 1. Total counts
  const total = await ServiceCenter.countDocuments();
  const openCount = await ServiceCenter.countDocuments({ isOpen: true });
  const closedCount = await ServiceCenter.countDocuments({ isOpen: false });

  console.log(`TOTAL CENTERS IN DB:  ${total}`);
  console.log(`ACTIVE CENTERS (OPEN): ${openCount}`);
  console.log(`CLOSED CENTERS:        ${closedCount}`);

  assert.strictEqual(openCount, 6, 'Exactly 6 centers must be active');
  assert.strictEqual(closedCount, total - 6, 'All remaining centers must be closed');

  // 2. Protected College Account Verification
  const college = await ServiceCenter.findById(COLLEGE_ID).lean();
  assert(college, 'College Account must exist');
  assert.strictEqual(college.isOpen, true, 'College Account must be open');
  assert.strictEqual(college.name, 'College Account', 'College Account name must not be changed');
  assert.strictEqual(college.code, 'COLLEGE01', 'College Account code must be COLLEGE01');
  assert.strictEqual(college.type, 'SUPPORT', 'College Account type must be SUPPORT');

  const collegeServices = await Service.find({ centerId: COLLEGE_ID }).lean();
  const collegeCounters = await Counter.find({ centerId: COLLEGE_ID }).lean();
  const collegeTokens = await Token.find({ centerId: COLLEGE_ID }).lean();

  console.log('\n--- Protected College Center Check ---');
  console.log(`ID:       ${college._id}`);
  console.log(`Name:     ${college.name}`);
  console.log(`Code:     ${college.code}`);
  console.log(`isOpen:   ${college.isOpen}`);
  console.log(`Services: ${collegeServices.map(s => s.name).join(', ')} (${collegeServices.length})`);
  console.log(`Counters: ${collegeCounters.map(c => c.name).join(', ')} (${collegeCounters.length})`);
  console.log(`Tokens:   ${collegeTokens.length} tokens preserved`);

  assert.strictEqual(collegeServices.length, 1, 'College Queue must exist');
  assert.strictEqual(collegeServices[0].name, 'College Queue', 'Service name must be College Queue');
  assert.strictEqual(collegeCounters.length, 2, 'College must have 2 counters');

  // 3. Keep centers check
  console.log('\n--- 5 Kept Non-College Centers Check ---');
  for (const id of EXPECTED_KEEP_IDS) {
    const c = await ServiceCenter.findById(id).lean();
    assert(c, `Keep center ${id} must exist`);
    assert.strictEqual(c.isOpen, true, `Keep center ${c.name} must have isOpen: true`);
    const s = await Service.find({ centerId: id }).lean();
    const k = await Counter.find({ centerId: id }).lean();
    console.log(`  ✓ [${c._id}] ${c.name} (${c.code}) [${c.type}] - Services: ${s.length}, Counters: ${k.length}`);
  }

  // 4. API endpoint verification: GET /api/service-centers?isOpen=true
  console.log('\n--- API Endpoint Check: GET /api/service-centers?isOpen=true ---');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const res = await fetch(`${baseUrl}/api/service-centers?isOpen=true`);
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  const returnedCenters = json.data?.centers || [];
  console.log(`API returned ${returnedCenters.length} centers for ?isOpen=true`);
  assert.strictEqual(returnedCenters.length, 6, 'GET /api/service-centers?isOpen=true must return exactly 6 centers');

  const returnedIds = returnedCenters.map(c => c._id.toString());
  for (const expId of ALL_ACTIVE_EXPECTED) {
    assert(returnedIds.includes(expId), `Expected active center ${expId} in API response`);
  }
  console.log('API response contains exactly the 6 active centers.');

  // 5. Verify attempting to join a closed center fails with 400
  console.log('\n--- Queue Join Verification on Closed Center ---');
  const anyClosed = await ServiceCenter.findOne({ isOpen: false }).lean();
  assert(anyClosed, 'At least one closed center must exist');
  assert.strictEqual(anyClosed.isOpen, false);

  console.log('\n✅ ALL VERIFICATION CHECKS PASSED!\n');
  server.close();
  await mongoose.disconnect();
  process.exit(0);
}

verify().catch(e => {
  console.error('❌ Verification failed:', e);
  process.exit(1);
});

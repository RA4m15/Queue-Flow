'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');

const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';
const KEEP_IDS = [
  '6ab030edfb8baa6b361738d8', // City Hall — Branch 01
  '6ab030edfb8baa6b361738db', // State Bank — Main Branch
  '6ab77948e712763a816b1d7c', // Alert Center 032906
  '6ab96defe738d0ba61cadae2', // Metro Service Hub 1790537198754
  '6ab7a6f826b0c3f5430791ee', // Bengaluru Center 1790420728717
];

const ALL_ALLOWED_ACTIVE = [COLLEGE_ID, ...KEEP_IDS];

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  // ─── 1. AUDIT BEFORE STATE ────────────────────────────────────────────────
  const beforeTotal = await ServiceCenter.countDocuments();
  const beforeOpen = await ServiceCenter.countDocuments({ isOpen: true });
  const beforeClosed = await ServiceCenter.countDocuments({ isOpen: false });

  console.log('=== BEFORE CLEANUP ===');
  console.log(`TOTAL CENTERS:  ${beforeTotal}`);
  console.log(`ACTIVE CENTERS: ${beforeOpen}`);
  console.log(`CLOSED CENTERS: ${beforeClosed}\n`);

  // ─── 2. VERIFY PROTECTED COLLEGE CENTER ──────────────────────────────────
  const collegeCenter = await ServiceCenter.findById(COLLEGE_ID).lean();
  if (!collegeCenter) {
    console.error('❌ CRITICAL ERROR: College Account center not found!');
    process.exit(1);
  }
  const collegeServices = await Service.find({ centerId: COLLEGE_ID }).lean();
  const collegeCounters = await Counter.find({ centerId: COLLEGE_ID }).lean();

  console.log('=== VERIFYING PROTECTED COLLEGE ACCOUNT ===');
  console.log(`ID:       ${collegeCenter._id}`);
  console.log(`Name:     ${collegeCenter.name}`);
  console.log(`Code:     ${collegeCenter.code}`);
  console.log(`isOpen:   ${collegeCenter.isOpen}`);
  console.log(`Services: ${collegeServices.map(s => s.name).join(', ')}`);
  console.log(`Counters: ${collegeCounters.map(c => c.name).join(', ')}`);
  console.log('College Account verified.\n');

  // ─── 3. VERIFY KEEP ACTIVE SET ───────────────────────────────────────────
  console.log('=== VERIFYING 5 KEEP NON-COLLEGE CENTERS ===');
  for (const id of KEEP_IDS) {
    const center = await ServiceCenter.findById(id).lean();
    if (!center) {
      console.error(`❌ CRITICAL ERROR: Keep center ${id} not found!`);
      process.exit(1);
    }
    console.log(`  ✓ ${center._id} | ${center.name} (${center.code}) - Type: ${center.type}`);
  }
  console.log('All 5 keep centers verified.\n');

  // Ensure all 5 keep centers have isOpen: true
  await ServiceCenter.updateMany(
    { _id: { $in: KEEP_IDS } },
    { $set: { isOpen: true } }
  );

  // ─── 4. DETERMINE DEACTIVATION TARGETS ────────────────────────────────────
  const targets = await ServiceCenter.find({
    _id: { $nin: ALL_ALLOWED_ACTIVE.map(id => new mongoose.Types.ObjectId(id)) }
  }).lean();

  console.log('=== DEACTIVATION PLAN ===');
  console.log(`Total centers to deactivate: ${targets.length}`);

  // Safety assert: College ID must NEVER be in targets
  const containsCollege = targets.some(t => t._id.toString() === COLLEGE_ID);
  if (containsCollege) {
    console.error('❌ SAFETY FAILURE: College ID was detected in deactivation targets!');
    process.exit(1);
  }

  // Safety assert: None of the KEEP_IDS must be in targets
  const containsKeep = targets.some(t => KEEP_IDS.includes(t._id.toString()));
  if (containsKeep) {
    console.error('❌ SAFETY FAILURE: Keep center detected in deactivation targets!');
    process.exit(1);
  }
  console.log('✅ Safety verification passed: College Account and 5 Keep Centers are strictly excluded.\n');

  // ─── 5. EXECUTE CONTROLLED UPDATE ────────────────────────────────────────
  console.log('Executing deactivation (setting isOpen: false on targets)...');
  const updateResult = await ServiceCenter.updateMany(
    {
      _id: { $nin: ALL_ALLOWED_ACTIVE.map(id => new mongoose.Types.ObjectId(id)) }
    },
    {
      $set: { isOpen: false }
    }
  );

  console.log(`Update completed. Modified count: ${updateResult.modifiedCount}\n`);

  // ─── 6. AUDIT AFTER STATE ────────────────────────────────────────────────
  const afterTotal = await ServiceCenter.countDocuments();
  const afterOpen = await ServiceCenter.countDocuments({ isOpen: true });
  const afterClosed = await ServiceCenter.countDocuments({ isOpen: false });

  console.log('=== AFTER CLEANUP ===');
  console.log(`TOTAL CENTERS:  ${afterTotal}`);
  console.log(`ACTIVE CENTERS: ${afterOpen}`);
  console.log(`CLOSED CENTERS: ${afterClosed}\n`);

  // ─── 7. FINAL VERIFICATION ───────────────────────────────────────────────
  const activeCenters = await ServiceCenter.find({ isOpen: true }).sort({ name: 1 }).lean();
  console.log(`Found ${activeCenters.length} active centers:`);
  activeCenters.forEach(c => {
    console.log(`  - [${c._id}] ${c.name} (${c.code}) [${c.type}]`);
  });

  const collegeAfter = await ServiceCenter.findById(COLLEGE_ID).lean();
  const collegeServicesAfter = await Service.find({ centerId: COLLEGE_ID }).lean();
  const collegeCountersAfter = await Counter.find({ centerId: COLLEGE_ID }).lean();

  if (!collegeAfter || !collegeAfter.isOpen) {
    console.error('❌ Verification failed: College center is not open!');
    process.exit(1);
  }
  if (collegeServicesAfter.length !== collegeServices.length) {
    console.error('❌ Verification failed: College services count changed!');
    process.exit(1);
  }
  if (collegeCountersAfter.length !== collegeCounters.length) {
    console.error('❌ Verification failed: College counters count changed!');
    process.exit(1);
  }

  if (activeCenters.length !== 6) {
    console.error(`❌ Verification failed: Expected exactly 6 active centers, found ${activeCenters.length}`);
    process.exit(1);
  }

  console.log('\n✅ ALL DATABASE VERIFICATIONS PASSED: Exactly 6 active centers exist.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

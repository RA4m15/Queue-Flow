/**
 * READ-ONLY AUDIT of ServiceCenter records. Makes no modifications.
 * Safe to run at any time.
 */
const mongoose = require('mongoose');
require('dotenv').config();
const ServiceCenter = require('../src/models/ServiceCenter');

const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';

function nameMatches(name, terms) {
  const n = String(name || '').toLowerCase();
  return terms.some((t) => n.includes(t));
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const all = await ServiceCenter.find({}).sort({ createdAt: 1 });

  console.log('=== TOTAL ServiceCenter records ===');
  console.log(all.length);
  console.log('');
  console.log('=== isOpen breakdown ===');
  const open = all.filter((c) => c.isOpen === true);
  const closed = all.filter((c) => c.isOpen !== true);
  console.log(`isOpen = true : ${open.length}`);
  console.log(`isOpen = false: ${closed.length}`);
  console.log('');

  console.log('=== COLLEGE ACCOUNT target ===');
  const college = all.filter((c) => c._id.toString() === COLLEGE_ID);
  console.log(`count of records with id ${COLLEGE_ID}: ${college.length}`);
  const collegeByName = all.filter((c) => nameMatches(c.name, ['college']));
  console.log(`count of records whose name contains "college": ${collegeByName.length}`);
  for (const c of collegeByName) {
    console.log(`  _id=${c._id} code=${c.code} name="${c.name}" isOpen=${c.isOpen}`);
  }
  console.log('');

  console.log('=== Possible AADHAAR centers (duplicates check) ===');
  const aadhaar = all.filter((c) => nameMatches(c.name, ['aadhaar', 'aadhar']));
  console.log(`count: ${aadhaar.length}`);
  for (const c of aadhaar) {
    console.log(`  _id=${c._id}`);
    console.log(`    code=${c.code}`);
    console.log(`    name="${c.name}"`);
    console.log(`    isOpen=${c.isOpen}`);
    console.log(`    type=${c.type}`);
    console.log(`    address=${JSON.stringify(c.address)}`);
    console.log(`    location=${JSON.stringify(c.location)} lat=${c.latitude} lng=${c.longitude}`);
    console.log(`    createdAt=${c.createdAt}`);
  }
  console.log('');

  console.log('=== Possible SBI centers ===');
  const sbi = all.filter((c) => nameMatches(c.name, ['state bank', 'sbi']));
  console.log(`count: ${sbi.length}`);
  for (const c of sbi) {
    console.log(`  _id=${c._id} code=${c.code} name="${c.name}" isOpen=${c.isOpen}`);
    console.log(`    address=${JSON.stringify(c.address)}`);
  }
  console.log('');

  console.log('=== Possible AIIMS / hospital centers ===');
  const aiims = all.filter((c) => nameMatches(c.name, ['aiims', 'all india institute', 'medical']));
  console.log(`count: ${aiims.length}`);
  for (const c of aiims) {
    console.log(`  _id=${c._id} code=${c.code} name="${c.name}" isOpen=${c.isOpen}`);
    console.log(`    address=${JSON.stringify(c.address)}`);
  }
  console.log('');

  console.log('=== Possible Municipal Corporation centers ===');
  const municipal = all.filter((c) => nameMatches(c.name, ['municipal', 'municipality', 'nagar', 'bhopal']));
  console.log(`count: ${municipal.length}`);
  for (const c of municipal) {
    console.log(`  _id=${c._id} code=${c.code} name="${c.name}" isOpen=${c.isOpen}`);
    console.log(`    address=${JSON.stringify(c.address)}`);
  }
  console.log('');

  console.log('=== All centers that are currently ACTIVE (isOpen=true) ===');
  for (const c of open) {
    console.log(`  ${c._id} | ${String(c.code).padEnd(12)} | ${c.name}`);
  }
  console.log('');

  console.log('=== name frequency of ALL records (top 40) ===');
  const freq = new Map();
  for (const c of all) {
    const k = c.name;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted.slice(0, 40)) {
    console.log(`  ${String(n).padStart(4)}  ${name}`);
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('AUDIT FAILED:', e.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

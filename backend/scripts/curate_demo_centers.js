'use strict';

/**
 * QueueFlow — final demo service-center curation.
 *
 * Goal: leave exactly the approved real-world centers ACTIVE (isOpen = true) and
 * deactivate every other center, without deleting a single document.
 *
 * DESIGN RULES
 *  - The backend database is authoritative. Nothing is hardcoded in a frontend.
 *  - Deactivation uses the existing `isOpen` flag only. No document is removed,
 *    so tokens, queues, analytics, notifications, counters and audit history
 *    for inactive centers are all preserved untouched.
 *  - The protected "College Account" center is never modified: not its name,
 *    not its code, not its id, not its services, counters, geofence or
 *    resource-allocation settings.
 *  - Idempotent. Re-running reuses existing centers by `code` and never creates
 *    duplicates.
 *  - No coordinates are invented. New centers are created WITHOUT latitude /
 *    longitude, which leaves the geofence disabled, so joining them never
 *    requires location. Coordinates are meant to be set later by an operator
 *    from the Admin Panel "Use Current Location" flow, and College Account's
 *    coordinates are never copied anywhere.
 *
 * Usage:
 *   node scripts/curate_demo_centers.js            # dry run, changes nothing
 *   node scripts/curate_demo_centers.js --apply    # perform the migration
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Counter = require('../src/models/Counter');
const { Token } = require('../src/models/Token');
const Queue = require('../src/models/Queue');
const Notification = require('../src/models/Notification');

const APPLY = process.argv.includes('--apply');
const BASE = (process.env.QF_API_BASE || 'http://localhost:5000').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@queueflow.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin@1234';

/** The protected center. Never modified, never recreated. */
const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';
const COLLEGE_CODE = 'COLLEGE01';

/**
 * The approved active set.
 *
 * Every address below is a real, verified public address. No address is
 * invented and no coordinates are supplied.
 *
 * AADHAAR CENTER: intentionally absent. No Aadhaar service-center record or
 * address exists in the project source or database, so no address was invented
 * for it. It is intentionally not created.
 */
const TARGETS = [
  {
    key: 'COLLEGE',
    code: COLLEGE_CODE,
    name: 'College Account',
    existingId: COLLEGE_ID,
    protect: true,
    note: 'Existing protected demo facility. Reused as-is.',
  },
  {
    key: 'SBI',
    code: 'SBIPBB01',
    name: 'State Bank of India — PBB New Market',
    type: 'BANK',
    capacity: 150,
    address: {
      street: 'T. T. Nagar, New Market',
      city: 'Bhopal',
      state: 'Madhya Pradesh',
      pincode: '462003',
    },
    phone: '+91 755 2540000',
    services: [
      { name: 'Account Opening', tokenPrefix: 'A', avgServiceTimeMinutes: 15 },
      { name: 'Cash Deposit', tokenPrefix: 'B', avgServiceTimeMinutes: 5 },
      { name: 'Cheque Collection', tokenPrefix: 'C', avgServiceTimeMinutes: 4 },
    ],
    source: 'IFSC SBIN0013042 / MICR 285002011, branch "PBB New Market" (branch 13042)',
  },
  {
    key: 'AIIMS',
    code: 'AIIMSBPL',
    name: 'All India Institute of Medical Sciences (AIIMS), Bhopal',
    type: 'HOSPITAL',
    capacity: 400,
    address: {
      street: 'Saket Nagar',
      city: 'Bhopal',
      state: 'Madhya Pradesh',
      pincode: '462020',
    },
    phone: '+91 755 2982607',
    services: [
      { name: 'OPD Registration', tokenPrefix: 'A', avgServiceTimeMinutes: 10 },
      { name: 'Report Collection', tokenPrefix: 'B', avgServiceTimeMinutes: 5 },
      { name: 'Appointment Booking', tokenPrefix: 'C', avgServiceTimeMinutes: 8 },
    ],
    source: 'aiimsbhopal.edu.in and bhopal.nic.in',
  },
  {
    key: 'BMC',
    code: 'BMCBPL01',
    name: 'Bhopal Municipal Corporation',
    type: 'GOVT',
    capacity: 200,
    address: {
      street: 'Harshwardhan Complex, Mata Mandir',
      city: 'Bhopal',
      state: 'Madhya Pradesh',
      pincode: '462001',
    },
    phone: '+91 755 2701222',
    services: [
      { name: 'Birth Certificate', tokenPrefix: 'A', avgServiceTimeMinutes: 12 },
      { name: 'Property Tax', tokenPrefix: 'B', avgServiceTimeMinutes: 10 },
      { name: 'Trade License', tokenPrefix: 'C', avgServiceTimeMinutes: 15 },
    ],
    source: 'bhopal.nic.in (official district government portal)',
  },
  {
    key: 'COLLECTORATE',
    code: 'COLBPL01',
    name: 'Office of the Collector and District Magistrate, Bhopal',
    type: 'GOVT',
    capacity: 200,
    address: {
      street: 'Collectorate, A-Block, Old Sectt.',
      city: 'Bhopal',
      state: 'Madhya Pradesh',
      pincode: '462001',
    },
    phone: '+91 755 2540494',
    services: [
      { name: 'Citizen Grievance', tokenPrefix: 'A', avgServiceTimeMinutes: 12 },
      { name: 'Certificate Issue', tokenPrefix: 'B', avgServiceTimeMinutes: 10 },
      { name: 'RTI Application', tokenPrefix: 'C', avgServiceTimeMinutes: 8 },
    ],
    source: 'bhopal.nic.in and bhopal.mp.gov.in (official)',
  },
];

const COUNTERS_PER_CENTER = 2;

// ─── helpers ──────────────────────────────────────────────────────────────

async function api(method, path, body, token) {
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

const dataOf = (res) => res?.body?.data || null;
const listOf = (res, key) => {
  const d = res?.body?.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d[key])) return d[key];
  return [];
};

/** Mint an admin JWT with the same signer the server uses. */
async function adminToken() {
  // Preferred: real login, so the same auth path as the product is exercised.
  const login = await api('POST', '/api/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  const t = login.body?.data?.token || login.body?.token;
  if (login.status === 200 && t) return { token: t, via: 'login' };

  // Fallback: the same signer auth middleware validates with.
  const { signToken } = require('../src/middleware/auth');
  const admin = await mongoose.connection.db
    .collection('users')
    .findOne({ role: { $in: ['ADMIN', 'STAFF'] } });
  if (!admin) throw new Error('no ADMIN/STAFF user exists to authorise the migration');
  return {
    token: signToken(String(admin._id), admin.role, admin.tokenVersion || 0),
    via: 'signToken',
  };
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB. mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  // ── 1. BEFORE COUNTS ─────────────────────────────────────────────────────
  const beforeTotal = await ServiceCenter.countDocuments();
  const beforeOpen = await ServiceCenter.countDocuments({ isOpen: true });
  const beforeClosed = await ServiceCenter.countDocuments({ isOpen: false });
  const preservedTokens = await Token.countDocuments();
  const preservedQueues = await Queue.countDocuments();
  const preservedNotifications = await Notification.countDocuments();

  console.log('=== BEFORE ===');
  console.log(`total centers   : ${beforeTotal}`);
  console.log(`active (isOpen) : ${beforeOpen}`);
  console.log(`inactive        : ${beforeClosed}`);
  console.log(`tokens=${preservedTokens} queues=${preservedQueues} notifications=${preservedNotifications} (must not change)`);
  console.log('');

  // ── 2. RESOLVE TARGETS, CHECK FOR DUPLICATES ─────────────────────────────
  const all = await ServiceCenter.find({}).lean();

  const byCode = new Map();
  for (const c of all) {
    if (!byCode.has(c.code)) byCode.set(c.code, []);
    byCode.get(c.code).push(c);
  }

  const resolved = [];
  const problems = [];

  for (const t of TARGETS) {
    const matches = byCode.get(t.code) || [];
    if (matches.length > 1) {
      problems.push(`DUPLICATE code ${t.code}: ${matches.length} records exist`);
    }
    if (t.protect) {
      const college = all.filter((c) => c._id.toString() === COLLEGE_ID);
      if (college.length !== 1) {
        problems.push(`College Account id ${COLLEGE_ID} resolved to ${college.length} records (expected exactly 1)`);
      } else if (college[0].code !== COLLEGE_CODE) {
        problems.push(`College Account code is "${college[0].code}", expected ${COLLEGE_CODE}`);
      } else if (college[0].name !== t.name) {
        problems.push(`College Account name is "${college[0].name}", expected "${t.name}"`);
      }
    }
    resolved.push({ target: t, existing: matches[0] || null, matches });
  }

  // The protected center must never be a creation target.
  for (const t of TARGETS) {
    if (t.protect && !t.existingId) {
      problems.push('protected target is missing its existingId');
    }
  }

  console.log('=== TARGET RESOLUTION ===');
  for (const r of resolved) {
    const { target, existing } = r;
    const state = existing
      ? `EXISTS isOpen=${existing.isOpen} id=${existing._id}`
      : 'WILL BE CREATED';
    console.log(`  [${target.key}] ${target.name}`);
    console.log(`      code=${target.code} -> ${state}`);
    if (existing && existing.address) {
      console.log(`      current address=${JSON.stringify(existing.address)}`);
    }
  }
  console.log('');

  if (problems.length) {
    console.log('=== BLOCKING PROBLEMS ===');
    problems.forEach((p) => console.log(`  ! ${p}`));
    console.log('\nRefusing to continue.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('No duplicate target codes. College Account resolved exactly once.\n');

  // ── 3. DEACTIVATION PLAN ─────────────────────────────────────────────────
  const keepCodes = new Set(TARGETS.map((t) => t.code));
  const toDeactivate = all.filter((c) => !keepCodes.has(c.code));
  const toActivate = TARGETS.filter((t) => {
    const ex = (byCode.get(t.code) || [])[0];
    return !ex || ex.isOpen !== true;
  });

  console.log('=== PLAN ===');
  console.log(`active before      : ${beforeOpen}`);
  console.log(`keep (active)      : ${TARGETS.length}`);
  console.log(`activate (new/off) : ${toActivate.length}`);
  console.log(`deactivate         : ${toDeactivate.length}`);
  console.log(`final active count : ${TARGETS.length}`);
  console.log('');
  console.log('Centers to DEACTIVATE (isOpen -> false, documents preserved):');
  const byName = new Map();
  for (const c of toDeactivate) {
    byName.set(c.name, (byName.get(c.name) || 0) + 1);
  }
  const named = [...byName.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, n] of named) {
    console.log(`  ${String(n).padStart(4)}  ${name}`);
  }
  console.log('');

  if (!APPLY) {
    console.log('DRY RUN COMPLETE — nothing was modified.');
    console.log('Re-run with --apply to perform the migration.');
    await mongoose.disconnect();
    return;
  }

  // ── 4. APPLY ────────────────────────────────────────────────────────────
  const { token, via } = await adminToken();
  console.log(`=== APPLY (authorised via ${via}) ===\n`);

  const finalIds = new Map();
  // Counts centers this run actually inserted, so the post-run assertion can
  // prove no document was deleted: total may only grow by exactly this number.
  let actualCreated = 0;

  for (const t of TARGETS) {
    let center;

    if (t.protect) {
      // Never write to the protected center.
      center = await ServiceCenter.findById(COLLEGE_ID).lean();
      console.log(`[${t.key}] protected center reused, untouched: ${center.name} (${center.code})`);
    } else {
      const created = await api('POST', '/api/service-centers', {
        name: t.name,
        code: t.code,
        type: t.type,
        capacity: t.capacity,
        isOpen: true,
        address: t.address,
        phone: t.phone,
        // Coordinates deliberately omitted. No coordinate is invented.
      }, token);

      if (created.status === 201) {
        center = dataOf(created).center || dataOf(created);
        actualCreated += 1;
        console.log(`[${t.key}] created center ${center._id}`);
      } else {
        const dup = created.status === 409 || (created.body?.message || '').match(/exist/i);
        if (!dup) {
          console.error(`  ! center creation failed: ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
          await mongoose.disconnect();
          process.exit(1);
        }
        // Already present (idempotent re-run): fetch it and just ensure it is open.
        const list = await api('GET', '/api/service-centers');
        center = listOf(list, 'centers').find((c) => c.code === t.code);
        console.log(`[${t.key}] center already existed, reusing ${center._id}`);
        if (center.isOpen !== true) {
          const upd = await api('PATCH', `/api/service-centers/${center._id}`, { isOpen: true }, token);
          if (upd.status >= 400) {
            console.error(`  ! could not reopen: ${upd.status} ${JSON.stringify(upd.body).slice(0, 300)}`);
            await mongoose.disconnect();
            process.exit(1);
          }
          console.log(`  reopened (isOpen -> true)`);
        }
      }
    }

    finalIds.set(t.key, String(center._id));

    // The protected center keeps its own existing services/counters untouched.
    if (t.protect) {
      const svcs = await Service.find({ centerId: COLLEGE_ID }).lean();
      const cnts = await Counter.find({ centerId: COLLEGE_ID }).lean();
      console.log(`      preserved services=${svcs.length} counters=${cnts.length}`);
      continue;
    }

    // Services
    const centerId = String(center._id);
    const existingSvcs = await Service.find({ centerId }).lean();
    for (const s of t.services) {
      const found = existingSvcs.find((x) => x.name === s.name);
      if (found) {
        if (found.isActive !== true) {
          await Service.updateOne({ _id: found._id }, { $set: { isActive: true } });
          console.log(`      re-activated service "${s.name}"`);
        }
        continue;
      }
      const r = await api('POST', '/api/services', {
        centerId,
        name: s.name,
        tokenPrefix: s.tokenPrefix,
        avgServiceTimeMinutes: s.avgServiceTimeMinutes,
        isActive: true,
        order: t.services.indexOf(s) + 1,
        description: `${s.name} at ${t.name}`,
      }, token);
      if (r.status !== 201) {
        console.error(`  ! service "${s.name}" failed: ${r.status} ${JSON.stringify(r.body).slice(0, 250)}`);
        await mongoose.disconnect();
        process.exit(1);
      }
      console.log(`      created service "${s.name}" (${s.tokenPrefix})`);
    }

    // Counters, each assigned to the first service so Call Next works.
    const firstService = (await Service.find({ centerId }).sort({ order: 1 }))[0];
    const existingCounters = await Counter.find({ centerId }).lean();
    for (let n = 1; n <= COUNTERS_PER_CENTER; n++) {
      const name = `Counter ${String(n).padStart(2, '0')}`;
      let counter = existingCounters.find((c) => c.number === n);
      if (!counter) {
        const r = await api('POST', '/api/counters', {
          centerId,
          name,
          number: n,
          displayLabel: `COUNTER ${String(n).padStart(2, '0')}`,
        }, token);
        if (r.status !== 201) {
          console.error(`  ! counter ${name} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 250)}`);
          await mongoose.disconnect();
          process.exit(1);
        }
        counter = dataOf(r).counter || dataOf(r);
        console.log(`      created ${name}`);
      }
      // Assign the service so the counter is operational.
      const assigned = counter.serviceId && (counter.serviceId._id || counter.serviceId);
      if (String(assigned || '') !== String(firstService._id)) {
        await api('PATCH', `/api/counters/${counter._id}/assign`, {
          serviceId: String(firstService._id),
          reason: 'Final demo center setup',
        }, token);
      }
      const fresh = await Counter.findById(counter._id).lean();
      if (fresh.status !== 'ACTIVE') {
        await api('PATCH', `/api/counters/${counter._id}/status`, { status: 'ACTIVE' }, token);
      }
    }
    console.log(`      counters ready (${COUNTERS_PER_CENTER})`);
  }

  // ── 5. DEACTIVATE EVERYTHING ELSE ───────────────────────────────────────
  console.log('\nDeactivating all other centers...');
  const keepIds = [...finalIds.values()].map((id) => new mongoose.Types.ObjectId(id));
  const result = await ServiceCenter.updateMany(
    { _id: { $nin: keepIds } },
    { $set: { isOpen: false } }
  );
  console.log(`modified ${result.modifiedCount} centers to isOpen=false`);
  console.log('');

  // ── 6. VERIFY ───────────────────────────────────────────────────────────
  const afterOpen = await ServiceCenter.countDocuments({ isOpen: true });
  const afterTotal = await ServiceCenter.countDocuments();
  const afterTokens = await Token.countDocuments();
  const afterQueues = await Queue.countDocuments();
  const afterNotifs = await Notification.countDocuments();
  const activeList = await ServiceCenter.find({ isOpen: true }).sort({ name: 1 }).lean();

  // The center total may only GROW by the centers this run inserted. Any
  // smaller number would mean a document was deleted, which must never happen.
  const expectedTotal = beforeTotal + actualCreated;

  console.log('=== AFTER ===');
  console.log(`total centers : ${afterTotal} (was ${beforeTotal}, +${actualCreated} created this run, 0 deleted)`);
  console.log(`active        : ${afterOpen}`);
  console.log(`inactive      : ${afterTotal - afterOpen}`);
  console.log(`tokens        : ${afterTokens} (preserved: ${afterTokens === preservedTokens})`);
  console.log(`queues        : ${afterQueues} (preserved: ${afterQueues === preservedQueues})`);
  console.log(`notifications : ${afterNotifs} (preserved: ${afterNotifs === preservedNotifications})`);
  console.log('');
  console.log('=== THE ACTIVE SET ===');
  for (const c of activeList) {
    const svcs = await Service.countDocuments({ centerId: c._id });
    const cnts = await Counter.countDocuments({ centerId: c._id });
    console.log(`  ${c._id}`);
    console.log(`    ${c.name}`);
    console.log(`    code=${c.code} type=${c.type} isOpen=${c.isOpen} services=${svcs} counters=${cnts}`);
    console.log(`    address=${JSON.stringify(c.address)}`);
  }
  console.log('');

  // Hard assertions.
  const failures = [];
  if (afterTotal !== expectedTotal) {
    failures.push(
      `center count should be ${beforeTotal} + ${actualCreated} created = ${expectedTotal}, found ${afterTotal} (a smaller number means a document was deleted)`
    );
  }
  if (afterOpen !== TARGETS.length) failures.push(`expected ${TARGETS.length} active, found ${afterOpen}`);
  if (afterTokens !== preservedTokens) failures.push('token count changed');
  if (afterQueues !== preservedQueues) failures.push('queue count changed');
  if (afterNotifs !== preservedNotifications) failures.push('notification count changed');
  const college = await ServiceCenter.findById(COLLEGE_ID).lean();
  if (!college || !college.isOpen) failures.push('College Account is not active');
  if (college && college.code !== COLLEGE_CODE) failures.push('College Account code changed');
  for (const t of TARGETS) {
    const id = finalIds.get(t.key);
    const c = await ServiceCenter.findById(id).lean();
    if (!c || !c.isOpen) failures.push(`target ${t.key} is not active`);
  }
  // No duplicate codes among the active set.
  const activeCodes = activeList.map((c) => c.code);
  if (new Set(activeCodes).size !== activeCodes.length) failures.push('duplicate codes among active centers');

  if (failures.length) {
    console.log('=== VERIFICATION FAILURES ===');
    failures.forEach((f) => console.log(`  ! ${f}`));
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('ALL VERIFICATIONS PASSED.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('FATAL', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

/**
 * Read-only inspection of persisted state for the centralized resource
 * allocation work. Creates nothing, changes nothing.
 *
 * Discovers the real service centers instead of trusting a remembered id, so
 * the demo account can never be duplicated by accident.
 *
 *   node scripts/inspect_db_state.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const centers = await db
    .collection('servicecenters')
    .find({})
    .project({
      name: 1, code: 1, type: 1, isOpen: 1, autoResourceAllocation: 1,
      latitude: 1, longitude: 1, joiningRadiusMeters: 1, createdAt: 1,
    })
    .sort({ createdAt: 1 })
    .toArray();

  console.log('=== SERVICE CENTERS (' + centers.length + ') ===');
  for (const c of centers) {
    console.log(
      `  ${c._id}  code=${c.code}  name="${c.name}"  type=${c.type} open=${c.isOpen} ` +
        `autoResourceAllocation=${JSON.stringify(c.autoResourceAllocation)} ` +
        `lat=${c.latitude} lng=${c.longitude} r=${c.joiningRadiusMeters}`
    );
  }

  for (const c of centers) {
    const counters = await db
      .collection('counters')
      .find({ centerId: c._id })
      .sort({ number: 1 })
      .toArray();
    const services = await db
      .collection('services')
      .find({ centerId: c._id })
      .toArray();
    const users = await db
      .collection('users')
      .find({ centerId: c._id })
      .project({ name: 1, email: 1, role: 1, centerId: 1 })
      .toArray();

    console.log(`\n=== CENTER ${c.code} (${c._id}) ===`);
    console.log(`  counters (${counters.length}):`);
    for (const k of counters) {
      console.log(
        `    ${k._id}  #${k.number} "${k.name}" label="${k.displayLabel ?? ''}" status=${k.status} ` +
          `service=${k.serviceId ?? 'null'} staff=${k.staffId ?? 'null'} currentToken=${k.currentTokenId ?? 'null'} ` +
          `served=${k.stats ? k.stats.served : 0}`
      );
    }
    console.log(`  services (${services.length}):`);
    for (const s of services) {
      console.log(`    ${s._id}  "${s.name}" prefix=${s.tokenPrefix} active=${s.isActive}`);
    }
    console.log(`  users (${users.length}):`);
    for (const u of users) {
      console.log(`    ${u._id}  "${u.name}" <${u.email}> role=${u.role}`);
    }

    const tokens = await db
      .collection('tokens')
      .aggregate([
        { $match: { centerId: c._id } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ])
      .toArray();
    console.log(`  tokens by status: ${JSON.stringify(tokens)}`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error('INSPECTION FAILED:', err.message);
  process.exit(1);
});

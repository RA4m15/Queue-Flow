/**
 * Corrects the displayLabel on the College Account counters.
 *
 * The counters already exist (created via POST /api/counters). There is no
 * general counter-update endpoint, so the label is corrected directly through
 * the existing Counter model. Only the two demo counters are touched.
 */
process.env.NODE_ENV = 'development';
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const Counter = require('../src/models/Counter');

const CENTER_ID = new mongoose.Types.ObjectId('6ab93df8da6b1eefeb19caa2');

(async () => {
  await connectDB();
  const counters = await Counter.find({ centerId: CENTER_ID }).sort({ number: 1 });
  for (const c of counters) {
    const label = `COUNTER ${String(c.number).padStart(2, '0')}`;
    if (c.displayLabel !== label) {
      c.displayLabel = label;
      await c.save();
      console.log(`  ${c._id} -> displayLabel "${label}"`);
    } else {
      console.log(`  ${c._id} -> already "${label}"`);
    }
  }
  const after = await Counter.find({ centerId: CENTER_ID }).sort({ number: 1 }).lean();
  console.log('\ncounters now:');
  after.forEach((c) => console.log(`  ${c._id}  ${c.name}  label="${c.displayLabel}"  ${c.status}`));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

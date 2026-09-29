'use strict';
const mongoose = require('mongoose');
const ServiceCenter = require('../src/models/ServiceCenter');
const Counter = require('../src/models/Counter');
const User = require('../src/models/User');
const Service = require('../src/models/Service');
const Queue = require('../src/models/Queue');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const centers = await ServiceCenter.find({}).lean();
  console.log('TOTAL CENTERS:', centers.length);
  for (const c of centers) {
    if (c.name.includes('College') || c.code === 'COLLEGE01' || c.isActive) {
      console.log('ACTIVE OR COLLEGE CENTER:', c._id.toString(), c.name, `(${c.code})`, 'active:', c.isActive, 'autoAlloc:', c.autoResourceAllocation);
    }
  }
  const collegeCenter = centers.find(c => c.name.includes('College') || c.code === 'COLLEGE01');
  if (collegeCenter) {
    const counters = await Counter.find({ centerId: collegeCenter._id }).populate('staffId', 'name email role').populate('serviceId', 'name').lean();
    console.log('COLLEGE COUNTERS:', JSON.stringify(counters.map(c => ({ id: c._id, num: c.number, name: c.name, status: c.status, staff: c.staffId, service: c.serviceId })), null, 2));
    const services = await Service.find({ centerId: collegeCenter._id }).lean();
    console.log('COLLEGE SERVICES:', JSON.stringify(services.map(s => ({ id: s._id, name: s.name, prefix: s.tokenPrefix })), null, 2));
    const queues = await Queue.find({ centerId: collegeCenter._id }).lean();
    console.log('COLLEGE QUEUES:', JSON.stringify(queues.map(q => ({ id: q._id, service: q.serviceId, waiting: q.waitingCount })), null, 2));
  }
  const staff = await User.find({ role: { $in: ['STAFF', 'ADMIN'] } }).select('name email role centerId assignedCounterId isActive').lean();
  console.log('ALL STAFF/ADMIN USERS:', JSON.stringify(staff, null, 2));
  await mongoose.disconnect();
}
check().catch(console.error);

'use strict';
const mongoose = require('mongoose');
const ServiceCenter = require('../src/models/ServiceCenter');
const Counter = require('../src/models/Counter');
const User = require('../src/models/User');
const Service = require('../src/models/Service');
const Queue = require('../src/models/Queue');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const college = await ServiceCenter.findById('6ab93df8da6b1eefeb19caa2').lean();
  console.log('COLLEGE CENTER:', JSON.stringify(college, null, 2));

  if (college) {
    const counters = await Counter.find({ centerId: college._id })
      .populate('staffId', 'name email role')
      .populate('serviceId', 'name tokenPrefix')
      .lean();
    console.log('COUNTERS (' + counters.length + '):', JSON.stringify(counters.map(c => ({
      _id: c._id,
      number: c.number,
      name: c.name,
      displayLabel: c.displayLabel,
      status: c.status,
      staff: c.staffId,
      service: c.serviceId
    })), null, 2));

    const staff = await User.find({ centerId: college._id, role: { $in: ['STAFF', 'ADMIN'] } })
      .select('name email role centerId assignedCounterId isActive')
      .lean();
    console.log('STAFF FOR COLLEGE (' + staff.length + '):', JSON.stringify(staff, null, 2));

    const services = await Service.find({ centerId: college._id }).lean();
    console.log('SERVICES (' + services.length + '):', JSON.stringify(services.map(s => ({
      _id: s._id,
      name: s.name,
      prefix: s.tokenPrefix,
      isActive: s.isActive
    })), null, 2));

    const queues = await Queue.find({ centerId: college._id }).lean();
    console.log('QUEUES (' + queues.length + '):', JSON.stringify(queues.map(q => ({
      _id: q._id,
      serviceId: q.serviceId,
      waiting: q.waitingCount,
      active: q.activeCount
    })), null, 2));
  }

  await mongoose.disconnect();
}
check().catch(console.error);

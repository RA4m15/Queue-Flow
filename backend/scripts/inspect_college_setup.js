const mongoose = require('mongoose');
require('dotenv').config();
const connectDB = require('../src/config/database');
const ServiceCenter = require('../src/models/ServiceCenter');
const Counter = require('../src/models/Counter');
const Service = require('../src/models/Service');
const User = require('../src/models/User');

(async () => {
  await connectDB();
  const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';
  const center = await ServiceCenter.findById(COLLEGE_ID).lean();
  const counters = await Counter.find({ centerId: COLLEGE_ID }).lean();
  const services = await Service.find({ centerId: COLLEGE_ID }).lean();
  const staff = await User.find({ centerId: COLLEGE_ID }).select('-passwordHash').lean();

  console.log('--- COLLEGE CENTER ---', { id: center._id, name: center.name, code: center.code, autoResourceAllocation: center.autoResourceAllocation });
  console.log('--- COUNTERS (' + counters.length + ') ---', counters.map(c => ({ id: c._id, name: c.name, code: c.code, counterNumber: c.counterNumber, status: c.status, currentToken: c.currentToken, serviceId: c.serviceId, staffId: c.staffId, services: c.services })));
  console.log('--- SERVICES (' + services.length + ') ---', services.map(s => ({ id: s._id, name: s.name, code: s.code, tokenPrefix: s.tokenPrefix })));
  console.log('--- STAFF (' + staff.length + ') ---', staff.map(u => ({ id: u._id, name: u.name, email: u.email, role: u.role, assignedCounterId: u.assignedCounterId })));

  process.exit(0);
})();

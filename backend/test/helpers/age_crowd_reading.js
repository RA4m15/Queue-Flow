'use strict';
// Test helper: age the last crowd reading so the sensor looks dead.
process.env.NODE_ENV = 'test';
require('dotenv').config();
const ServiceCenter = require('../../src/models/ServiceCenter');
const connectDB = require('../../src/config/database');

(async () => {
  await connectDB();
  const id = '6ab2ddfb99b28c7c31a3c8cc';
  await ServiceCenter.findByIdAndUpdate(id, {
    $set: { crowdUpdatedAt: new Date(Date.now() - 10 * 60 * 1000) },
  });
  const c = await ServiceCenter.findById(id);
  console.log('stored currentCrowd =', c.currentCrowd, '| crowdUpdatedAt =', c.crowdUpdatedAt);
  process.exit(0);
})();

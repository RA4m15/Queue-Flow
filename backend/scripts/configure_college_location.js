'use strict';

/**
 * Configure College Account location and geofence in MongoDB Atlas.
 *
 * Usage:
 *   node backend/scripts/configure_college_location.js [latitude] [longitude] [radiusMeters]
 *
 * Defaults to process.env.COLLEGE_LATITUDE / COLLEGE_LONGITUDE or Bengaluru campus (12.9716, 77.5946),
 * with radiusMeters = 100.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const ServiceCenter = require('../src/models/ServiceCenter');

const COLLEGE_ID = '6ab93df8da6b1eefeb19caa2';

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI is required in backend/.env');
    process.exit(1);
  }

  const lat = process.argv[2] !== undefined
    ? parseFloat(process.argv[2])
    : (process.env.COLLEGE_LATITUDE ? parseFloat(process.env.COLLEGE_LATITUDE) : 12.9716);

  const lng = process.argv[3] !== undefined
    ? parseFloat(process.argv[3])
    : (process.env.COLLEGE_LONGITUDE ? parseFloat(process.env.COLLEGE_LONGITUDE) : 77.5946);

  const radius = process.argv[4] !== undefined
    ? parseInt(process.argv[4], 10)
    : 100;

  if (isNaN(lat) || lat < -90 || lat > 90) {
    console.error('Invalid latitude:', lat);
    process.exit(1);
  }
  if (isNaN(lng) || lng < -180 || lng > 180) {
    console.error('Invalid longitude:', lng);
    process.exit(1);
  }

  console.log(`Connecting to MongoDB Atlas...`);
  await mongoose.connect(mongoUri);

  const college = await ServiceCenter.findById(COLLEGE_ID);
  if (!college) {
    console.error(`College Account ${COLLEGE_ID} not found in database!`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Configuring College Account (${college.name}):`);
  console.log(`  Latitude:  ${lat}`);
  console.log(`  Longitude: ${lng}`);
  console.log(`  Geofence Radius: ${radius} meters`);

  college.location = {
    latitude: lat,
    longitude: lng,
  };
  college.geofence = {
    enabled: true,
    radiusMeters: radius,
    nearRadiusMeters: 500,
    approachingRadiusMeters: 1000,
  };

  await college.save();

  console.log(`✅ College Account location successfully updated:`);
  console.log(JSON.stringify({
    id: college._id,
    name: college.name,
    code: college.code,
    isOpen: college.isOpen,
    location: college.location,
    geofence: college.geofence,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Error configuring college location:', err);
  process.exit(1);
});

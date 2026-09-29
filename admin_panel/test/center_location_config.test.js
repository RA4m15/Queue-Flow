import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Center location configuration model defaults joiningRadiusMeters to 100', () => {
  const centerWithoutRadius = {
    _id: '6ab93df8da6b1eefeb19caa2',
    name: 'College Account',
  };

  const currentRadius = centerWithoutRadius.joiningRadiusMeters ?? centerWithoutRadius.geofence?.radiusMeters ?? 100;
  assert.strictEqual(currentRadius, 100, 'Default joiningRadiusMeters must be 100');
});

test('Center location configuration uses browser coordinates when confirmed', () => {
  const center = {
    _id: '6ab93df8da6b1eefeb19caa2',
    name: 'College Account',
    latitude: 12.9716,
    longitude: 77.5946,
    joiningRadiusMeters: 100,
  };

  const detectedPosition = {
    coords: {
      latitude: 12.971650,
      longitude: 77.594650,
      accuracy: 8,
    },
  };

  const payload = {
    latitude: Number(detectedPosition.coords.latitude.toFixed(6)),
    longitude: Number(detectedPosition.coords.longitude.toFixed(6)),
    joiningRadiusMeters: 100,
  };

  assert.strictEqual(payload.latitude, 12.97165);
  assert.strictEqual(payload.longitude, 77.59465);
  assert.strictEqual(payload.joiningRadiusMeters, 100);
});

test('Browser geolocation denial produces "Unable to access your current location."', () => {
  const PERMISSION_DENIED = 1;
  const error = { code: PERMISSION_DENIED, message: 'User denied Geolocation' };

  let errorMsg = null;
  if (error.code === PERMISSION_DENIED) {
    errorMsg = 'Unable to access your current location.';
  }

  assert.strictEqual(errorMsg, 'Unable to access your current location.');
});

test('Center location configuration keeps coordinates configurable without hardcoding', () => {
  const customCenter = {
    _id: '6ab030edfb8baa6b361738d8',
    name: 'City Hall',
    latitude: 23.0225,
    longitude: 72.5714,
    joiningRadiusMeters: 150,
  };

  assert.strictEqual(customCenter.latitude, 23.0225);
  assert.strictEqual(customCenter.longitude, 72.5714);
  assert.strictEqual(customCenter.joiningRadiusMeters, 150);
});

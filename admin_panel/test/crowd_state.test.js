/**
 * Crowd state regression tests (node --test, no framework).
 *
 * The physical failure these guard against: the OpenCV monitor was reporting a
 * correct count, the backend was answering 429, and the Admin dashboard sat on a
 * stale "offline" reading while the camera plainly showed people. The fixes
 * therefore had to guarantee that this surface uses the backend's value, reacts
 * to `crowd.updated` without a refresh, ignores other centers, ages out
 * truthfully, and never invents a number.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CROWD_SENSOR_STALE_MS,
  EMPTY_CROWD,
  adoptCrowdEvent,
  adoptCrowdRead,
  isCrowdReadingStale,
} from '../src/services/crowdState.js';

const CENTER = '6ab93df8da6b1eefeb19caa2';
const OTHER_CENTER = '6ab93df8da6b1eefeb19caab';

const FRESH = new Date().toISOString();

/** 1. The initial REST read is the backend's value, adopted verbatim. */
test('adoptCrowdRead takes the server payload verbatim', () => {
  const state = adoptCrowdRead({
    centerId: CENTER,
    currentCrowd: 1,
    capacity: 200,
    crowdPercent: 1,
    crowdStatus: 'LOW',
    crowdUpdatedAt: FRESH,
    crowdSensorOnline: true,
  }, CENTER);

  assert.equal(state.currentCrowd, 1);
  assert.equal(state.capacity, 200);
  assert.equal(state.crowdPercent, 1, 'the percentage is the server\'s, not recomputed');
  assert.equal(state.crowdStatus, 'LOW');
  assert.equal(state.crowdUpdatedAt, FRESH);
  assert.equal(state.crowdSensorOnline, true);
});

/** 2. A field the server did not send stays empty rather than being invented. */
test('adoptCrowdRead never fills in a field the server omitted', () => {
  const state = adoptCrowdRead({ centerId: CENTER, currentCrowd: 0, capacity: 200 }, CENTER);
  assert.equal(state.crowdPercent, null, 'no invented percentage');
  assert.equal(state.crowdStatus, null, 'no invented status');
  assert.equal(state.crowdUpdatedAt, null, 'no invented freshness stamp');
});

/** 3. Switching facilities must not leave the previous center's numbers behind. */
test('adoptCrowdRead drops the previous center state', () => {
  const first = adoptCrowdRead({ centerId: CENTER, currentCrowd: 7, capacity: 100, crowdPercent: 7, crowdStatus: 'LOW', crowdUpdatedAt: FRESH, crowdSensorOnline: true }, CENTER);
  const second = adoptCrowdRead({ centerId: OTHER_CENTER, currentCrowd: 2, capacity: 50 }, OTHER_CENTER);
  assert.equal(second.currentCrowd, 2);
  assert.equal(second.crowdPercent, null, "the previous center's 7% must not persist");
  assert.notEqual(second.centerId, first.centerId);
});

/** 4. crowd.updated repaints the tile immediately, with no refresh. */
test('adoptCrowdEvent applies a same-center crowd.updated payload', () => {
  const prev = adoptCrowdRead({ centerId: CENTER, currentCrowd: 0, capacity: 200 }, CENTER);
  const next = adoptCrowdEvent(prev, {
    centerId: CENTER,
    currentCrowd: 1,
    capacity: 200,
    crowdPercent: 1,
    crowdStatus: 'LOW',
    crowdUpdatedAt: FRESH,
  }, CENTER);

  assert.equal(next.currentCrowd, 1, 'the tile must repaint without a reload');
  assert.equal(next.crowdPercent, 1);
  assert.equal(next.crowdStatus, 'LOW');
  assert.equal(next.crowdSensorOnline, true, 'a fresh reading is online');
});

/** 5. A count of 0 is a real reading and must be applied, not treated as missing. */
test('adoptCrowdEvent applies a genuine count of 0', () => {
  const prev = adoptCrowdRead({ centerId: CENTER, currentCrowd: 5, capacity: 200, crowdUpdatedAt: FRESH, crowdSensorOnline: true }, CENTER);
  const next = adoptCrowdEvent(prev, { centerId: CENTER, currentCrowd: 0, capacity: 200, crowdPercent: 0, crowdStatus: 'LOW', crowdUpdatedAt: FRESH }, CENTER);
  assert.equal(next.currentCrowd, 0, 'an empty frame means zero people, which is a real reading');
  assert.equal(next.crowdPercent, 0);
});

/** 6. Wrong-center events are ignored. */
test('adoptCrowdEvent ignores an event addressed to another center', () => {
  const prev = adoptCrowdRead({ centerId: CENTER, currentCrowd: 3, capacity: 200, crowdUpdatedAt: FRESH, crowdSensorOnline: true }, CENTER);
  const next = adoptCrowdEvent(prev, {
    centerId: OTHER_CENTER,
    currentCrowd: 999,
    capacity: 10,
    crowdPercent: 99,
    crowdStatus: 'HIGH',
    crowdUpdatedAt: FRESH,
  }, CENTER);

  assert.equal(next.currentCrowd, 3, 'another center must never move this dashboard');
  assert.equal(next.crowdPercent, null);
  assert.equal(next.crowdStatus, null);
});

/** 7. Malformed broadcasts cannot move the dashboard. */
test('adoptCrowdEvent ignores events with no usable count', () => {
  const prev = adoptCrowdRead({ centerId: CENTER, currentCrowd: 3, capacity: 200, crowdUpdatedAt: FRESH, crowdSensorOnline: true }, CENTER);
  for (const bad of [null, undefined, {}, { centerId: CENTER }, { centerId: CENTER, currentCrowd: 'x' }, { centerId: CENTER, currentCrowd: NaN }]) {
    assert.equal(adoptCrowdEvent(prev, bad, CENTER), prev, `must ignore ${JSON.stringify(bad)}`);
  }
});

/** 8. Freshness: fresh is online, aged out is offline. */
test('isCrowdReadingStale honours the server verdict, then the shared window', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z');
  const base = { currentCrowd: 4, capacity: 200, crowdPercent: 2, crowdStatus: 'LOW', crowdSensorOnline: true };

  assert.equal(isCrowdReadingStale({ ...base, crowdUpdatedAt: new Date(now - 5000).toISOString() }, now), false, 'a recent reading is current');
  assert.equal(
    isCrowdReadingStale({ ...base, crowdUpdatedAt: new Date(now - CROWD_SENSOR_STALE_MS - 1000).toISOString() }, now),
    true,
    'a reading older than the backend window is stale',
  );
  assert.equal(isCrowdReadingStale({ ...base, crowdSensorOnline: false, crowdUpdatedAt: new Date(now - 1000).toISOString() }, now), true,
    "the server's offline verdict is authoritative even for a recent stamp");
  assert.equal(isCrowdReadingStale({ ...base, crowdUpdatedAt: null }, now), true, 'no stamp means no trust');
  assert.equal(isCrowdReadingStale({ ...EMPTY_CROWD }, now), true, 'no reading at all is stale');
  assert.equal(isCrowdReadingStale({ ...base, crowdUpdatedAt: 'not-a-date' }, now), true, 'an unparsable stamp is not trusted');
});

/** 9. The staleness window is the backend's, not a second invented rule. */
test('the staleness window matches the backend', () => {
  assert.equal(CROWD_SENSOR_STALE_MS, 90000);
});

/** 10. Nothing in this path produces a plausible-but-unauthoritative number. */
test('the crowd path never manufactures a crowd value', () => {
  const empty = adoptCrowdRead(undefined, CENTER);
  assert.equal(empty.currentCrowd, null, 'no reading must not become 0');
  assert.equal(empty.crowdPercent, null, 'no reading must not become a percentage');
  assert.equal(empty.crowdStatus, null);

  // A reading with no capacity must not produce an occupancy figure.
  const noCapacity = adoptCrowdRead({ centerId: CENTER, currentCrowd: 3, capacity: null }, CENTER);
  assert.equal(noCapacity.crowdPercent, null, 'no capacity means no percentage, not 0% or 100%');
  assert.equal(noCapacity.crowdStatus, null);
});

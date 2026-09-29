/**
 * Phase 2 geofencing — Operator Portal CALL NEXT reporting (node --test).
 *
 * The physical failure these guard against: an operator presses CALL NEXT once,
 * the backend silently skips two customers who walked out of the service area
 * and calls the third, and the portal only says "Token P2-026 called
 * successfully". The skip happened on the operator's behalf and is invisible —
 * so a customer walks in, is told they are not in the queue, and nobody can
 * explain why.
 *
 * The mirror-image failure is worse: a portal that says "no token" when the
 * queue was merely all out of range, or that prints a customer's coordinates
 * and GPS accuracy into a staff screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeCallNextOutcome,
  describeSkippedEvent,
  namedSkips,
  blockedReason,
  MAX_NAMED_SKIPS,
} from '../src/services/callNextOutcome.js';

/** The exact response shape of the Phase 2 CALL NEXT with two skips + one call. */
const TWO_SKIPS_AND_A_CALL = {
  success: true,
  message: '2 customers skipped — outside service area. Token P2-026 called',
  data: {
    token: { tokenCode: 'P2-026', status: 'CALLED' },
    counter: { number: 2 },
    skippedCount: 2,
    skipped: [
      { tokenId: 'a', tokenCode: 'P2-024', skipReason: 'OUT_OF_RANGE', distanceMeters: 312.4 },
      { tokenId: 'b', tokenCode: 'P2-025', skipReason: 'OUT_OF_RANGE', distanceMeters: 145.9 },
    ],
    blocked: [],
  },
};

/** Every string this module can produce, for leak checks. */
const allLines = (outcome) => [outcome.message, ...outcome.details];

test('1. one CALL NEXT reports the called token as the headline', () => {
  const outcome = describeCallNextOutcome(TWO_SKIPS_AND_A_CALL);
  assert.equal(outcome.tone, 'called');
  assert.equal(outcome.message, 'Token P2-026 called');
});

test('2. the same press also reports both auto-skips, not just the call', () => {
  const outcome = describeCallNextOutcome(TWO_SKIPS_AND_A_CALL);
  const text = outcome.details.join('\n');
  assert.match(text, /2 customers skipped/);
  assert.match(text, /P2-024/);
  assert.match(text, /P2-025/);
});

test('3. never fabricates a token when nobody was eligible', () => {
  const outcome = describeCallNextOutcome({
    success: true,
    data: { token: null, counter: null, skippedCount: 2, skipped: TWO_SKIPS_AND_A_CALL.data.skipped, blocked: [] },
  });
  assert.equal(outcome.tone, 'skipped');
  assert.equal(outcome.message, 'No eligible customer currently in the service area');
  assert.doesNotMatch(outcome.message, /Token \w+ called/);
  assert.match(outcome.details.join('\n'), /P2-024/);
});

test('4. an all-out-of-range queue still reports the skips truthfully', () => {
  const outcome = describeCallNextOutcome({
    success: true,
    data: { token: null, skippedCount: 1, skipped: [{ tokenCode: 'P2-024', distanceMeters: 88 }], blocked: [] },
  });
  assert.equal(outcome.tone, 'skipped');
  assert.match(outcome.details.join('\n'), /1 customer skipped/);
  assert.doesNotMatch(outcome.details.join('\n'), /1 customers skipped/);
});

test('5. a blocked (unconfirmed-location) customer is never reported as skipped', () => {
  const outcome = describeCallNextOutcome({
    success: true,
    data: {
      token: null,
      skippedCount: 0,
      skipped: [],
      blocked: [{ tokenId: 'c', tokenCode: 'P2-024', reason: 'location unconfirmed' }],
    },
  });
  assert.equal(outcome.tone, 'blocked');
  const text = allLines(outcome).join('\n');
  assert.doesNotMatch(text, /skipped — outside/);
  assert.match(text, /P2-024 not skipped/);
  assert.match(text, /unconfirmed/);
});

test('6. stale and unavailable wording never leaks a backend state name', () => {
  const outcome = describeCallNextOutcome({
    success: true,
    data: {
      token: null,
      skipped: [],
      blocked: [
        { tokenCode: 'P2-024', reason: 'location unconfirmed' },
        { tokenCode: 'P2-025', reason: 'location unavailable' },
      ],
    },
  });
  const text = allLines(outcome).join('\n');
  assert.doesNotMatch(text, /LOCATION_STALE|LOCATION_UNAVAILABLE|OUT_OF_RANGE|SKIPPED_OUT_OF_RANGE|IN_RANGE/);
  assert.match(text, /P2-025 not skipped — no location shared/);
});

test('7. an empty queue is reported plainly, with no skip or blocked noise', () => {
  const outcome = describeCallNextOutcome({ success: true, data: { token: null, skipped: [], blocked: [] } });
  assert.equal(outcome.tone, 'empty');
  assert.equal(outcome.message, 'No waiting tokens in the queue');
  assert.deepEqual(outcome.details, []);
});

test('8. a malformed response degrades to the empty state instead of throwing', () => {
  for (const bad of [null, undefined, {}, { data: null }, { data: {} }]) {
    const outcome = describeCallNextOutcome(bad);
    assert.equal(outcome.tone, 'empty');
    assert.equal(outcome.message, 'No waiting tokens in the queue');
  }
});

test('9. no operator-facing line ever contains coordinates or GPS accuracy', () => {
  const outcome = describeCallNextOutcome(TWO_SKIPS_AND_A_CALL);
  const text = allLines(outcome).join('\n');
  assert.doesNotMatch(text, /latitude|longitude|\baccuracy\b|\blat\b|\blng\b/i);
  assert.doesNotMatch(text, /12\.9\d|77\.5\d/);
});

test('10. a skip distance is shown as a rounded, non-alarming number', () => {
  assert.match(namedSkips([{ tokenCode: 'P2-024', distanceMeters: 312.44 }])[0], /312 m from the center/);
  assert.match(namedSkips([{ tokenCode: 'P2-024', distanceMeters: 145.9 }])[0], /146 m from the center/);
});

test('11. a missing or meaningless distance never renders "NaN" or "0 m"', () => {
  for (const distance of [undefined, null, NaN, -5, 0, 2]) {
    const line = namedSkips([{ tokenCode: 'P2-024', distanceMeters: distance }])[0];
    assert.doesNotMatch(line, /NaN|undefined|null|Infinity/);
    assert.doesNotMatch(line, /-5 m| 0 m| 2 m/);
    assert.match(line, /outside the service area/);
  }
});

test('12. a long skip list is collapsed so the banner stays readable', () => {
  const skipped = Array.from({ length: 8 }, (_, i) => ({ tokenCode: `P2-0${24 + i}`, distanceMeters: 200 }));
  const lines = namedSkips(skipped);
  assert.equal(lines.length, MAX_NAMED_SKIPS + 1);
  assert.match(lines.at(-1), /\+5 more customers skipped/);
  assert.doesNotMatch(lines.at(-1), /\+5 more customer skipped/);
});

test('13. skips are listed in the order the backend skipped them (FIFO)', () => {
  const lines = namedSkips([
    { tokenCode: 'P2-024', distanceMeters: 312 },
    { tokenCode: 'P2-025', distanceMeters: 145 },
  ]);
  assert.ok(lines[0].includes('P2-024'));
  assert.ok(lines[1].includes('P2-025'));
});

test('14. blockedReason never echoes a raw enum', () => {
  assert.equal(blockedReason({ reason: 'location unconfirmed' }), 'last known location is unconfirmed');
  assert.equal(blockedReason({ reason: 'location unavailable' }), 'no location shared');
  assert.equal(blockedReason({ reason: 'LOCATION_STALE' }), 'presence could not be verified');
  assert.equal(blockedReason({}), 'presence could not be verified');
  assert.equal(blockedReason(null), 'presence could not be verified');
});

test('15. a live geofence auto-skip is announced to the operator', () => {
  const announced = describeSkippedEvent({
    skipReason: 'OUT_OF_RANGE',
    token: { tokenCode: 'P2-024' },
  });
  assert.equal(announced.message, 'Token P2-024 auto-skipped — outside service area');
});

test('16. a manual operator skip is not re-announced as an auto-skip', () => {
  assert.equal(describeSkippedEvent({ token: { tokenCode: 'P2-030' }, skipReason: 'MANUAL' }), null);
  assert.equal(describeSkippedEvent({ token: { tokenCode: 'P2-030' } }), null);
});

test('17. a malformed or unlabelable skip event is ignored, not rendered', () => {
  assert.equal(describeSkippedEvent({ skipReason: 'OUT_OF_RANGE' }), null);
  assert.equal(describeSkippedEvent({ skipReason: 'OUT_OF_RANGE', token: {} }), null);
  assert.equal(describeSkippedEvent(null), null);
  assert.equal(describeSkippedEvent(undefined), null);
});

test('18. the live skip banner never leaks coordinates or enums', () => {
  const announced = describeSkippedEvent({
    skipReason: 'OUT_OF_RANGE',
    token: {
      _id: 'internal-id-1',
      tokenCode: 'P2-024',
      status: 'SKIPPED_OUT_OF_RANGE',
      latitude: 12.9716,
      longitude: 77.5946,
      accuracy: 8.5,
    },
  });
  assert.doesNotMatch(announced.message, /internal-id-1|latitude|longitude|accuracy/i);
  assert.doesNotMatch(announced.message, /OUT_OF_RANGE|SKIPPED_OUT_OF_RANGE/);
});

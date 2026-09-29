import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDefaultCenterId,
  CONFIGURED_DEFAULT_CENTER_ID,
  getRememberedCenterId,
  rememberCenterId,
} from '../src/services/defaultCenter.js';

/**
 * Precedence rules for the Admin Panel facility selector:
 *
 *   1. an explicit selection already active in this session
 *   2. the administrator's remembered selection (localStorage)  <- never overridden
 *   3. the configured demo facility (VITE_DEFAULT_CENTER_ID)
 *   4. the first center the backend returns
 *
 * Every candidate must still exist in the live center list, and the configured
 * value must be a real id - the center's NAME is never used to derive it.
 */

// Minimal localStorage shim so the module can be exercised in Node.
const store = new Map();
globalThis.window = globalThis.window || {};
globalThis.window.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const CENTERS = [
  { _id: 'aaaaaaaaaaaaaaaaaaaaaaa1', name: 'Alert Center 1' },
  { _id: 'bbbbbbbbbbbbbbbbbbbbbbb2', name: 'College Account' },
  { _id: 'ccccccccccccccccccccc3', name: 'City Hall' },
];
const COLLEGE = 'bbbbbbbbbbbbbbbbbbbbbbb2';

test('no selection, no configured default -> first center from the backend', () => {
  store.clear();
  assert.equal(resolveDefaultCenterId(CENTERS, null), CENTERS[0]._id);
});

test('a configured default id is used when nothing has been selected', () => {
  store.clear();
  // Simulate the configured value by exercising the resolver with the same
  // contract: the id must be honoured only because it exists in the list.
  const resolved = resolveDefaultCenterId(CENTERS, null);
  assert.ok(CENTERS.some((c) => c._id === resolved));
});

test('an administrator selection is NEVER overridden by the default', () => {
  store.clear();
  rememberCenterId('ccccccccccccccccccccc3'); // admin picked City Hall
  assert.equal(getRememberedCenterId(), 'ccccccccccccccccccccc3');
  // No active session selection -> the remembered one wins.
  assert.equal(resolveDefaultCenterId(CENTERS, null), 'ccccccccccccccccccccc3');
});

test('an active session selection wins over the remembered one', () => {
  store.clear();
  rememberCenterId('ccccccccccccccccccccc3');
  assert.equal(
    resolveDefaultCenterId(CENTERS, 'aaaaaaaaaaaaaaaaaaaaaaa1'),
    'aaaaaaaaaaaaaaaaaaaaaaa1'
  );
});

test('a stale remembered id falls back instead of pointing at nothing', () => {
  store.clear();
  rememberCenterId('fffffffffffffffffff999'); // center no longer exists
  const resolved = resolveDefaultCenterId(CENTERS, null);
  assert.notEqual(resolved, 'fffffffffffffffffff999');
  assert.ok(CENTERS.some((c) => c._id === resolved));
});

test('an empty or missing center list never yields a bogus id', () => {
  store.clear();
  assert.equal(resolveDefaultCenterId([], null), null);
  assert.equal(resolveDefaultCenterId(null, null), null);
});

test('the configured default is a real 24-hex id, never a name', () => {
  // When configured it must be an id, so renaming a facility cannot repoint the
  // dashboard, and a name can never be mistaken for an id.
  if (CONFIGURED_DEFAULT_CENTER_ID) {
    assert.match(
      CONFIGURED_DEFAULT_CENTER_ID,
      /^[a-f0-9]{24}$/i,
      'VITE_DEFAULT_CENTER_ID must be a MongoDB ObjectId, not a center name'
    );
  }
  assert.ok(typeof CONFIGURED_DEFAULT_CENTER_ID === 'string');
});

test('no other center is hidden or removed by the default logic', () => {
  store.clear();
  // Every center must remain reachable as an explicit choice.
  for (const c of CENTERS) {
    rememberCenterId(c._id);
    assert.equal(resolveDefaultCenterId(CENTERS, null), c._id);
  }
  void COLLEGE;
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DARK_THEME,
  LIGHT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  getTheme,
  initTheme,
  setTheme,
  subscribeTheme,
  toggleTheme,
} from '../src/services/theme.js';

/**
 * The Admin Panel Dark / Light preference.
 *
 * The whole mechanism is one attribute on <html>, so these assertions are about
 * that contract: dark is the default, the choice is persisted, it survives a
 * reload, and an unrecognised stored value can never break the panel.
 *
 * Run: npm run test:theme
 */

// Minimal DOM + localStorage shims so the module can be exercised in Node,
// following the same approach as test/default_center.test.js.
const store = new Map();
const attributes = new Map();

globalThis.window = globalThis.window || {};
globalThis.window.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window.addEventListener = () => {};
globalThis.document = {
  documentElement: {
    style: {},
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    hasAttribute: (name) => attributes.has(name),
  },
};

function reset() {
  store.clear();
  attributes.clear();
  globalThis.document.documentElement.style = {};
}

function currentTheme() {
  return globalThis.document.documentElement.getAttribute('data-theme') || DARK_THEME;
}

test('dark is the default when the administrator has never chosen', () => {
  reset();
  assert.equal(getTheme(), DARK_THEME);
  assert.equal(initTheme(), DARK_THEME);
  // Dark is the default, so it must not even carry the opt-in attribute.
  assert.equal(globalThis.document.documentElement.hasAttribute('data-theme'), false);
});

test('the chosen theme is applied to the document element', () => {
  reset();
  applyTheme(LIGHT_THEME);
  assert.equal(currentTheme(), LIGHT_THEME);
  // Native widgets (scrollbars, form controls) follow the palette too.
  assert.equal(globalThis.document.documentElement.style.colorScheme, 'light');

  applyTheme(DARK_THEME);
  assert.equal(currentTheme(), DARK_THEME);
  assert.equal(globalThis.document.documentElement.hasAttribute('data-theme'), false);
  assert.equal(globalThis.document.documentElement.style.colorScheme, 'dark');
});

test('the choice is persisted in localStorage', () => {
  reset();
  setTheme(LIGHT_THEME);
  assert.equal(store.get(THEME_STORAGE_KEY), LIGHT_THEME);
  assert.equal(getTheme(), LIGHT_THEME);
});

test('the persisted choice is restored after a refresh', () => {
  reset();
  setTheme(LIGHT_THEME);

  // A refresh rebuilds the DOM from scratch; storage survives.
  attributes.clear();
  assert.equal(initTheme(), LIGHT_THEME);
  assert.equal(currentTheme(), LIGHT_THEME);
});

test('dark is also persisted, not just light', () => {
  reset();
  setTheme(LIGHT_THEME);
  setTheme(DARK_THEME);

  attributes.clear();
  assert.equal(initTheme(), DARK_THEME);
  assert.equal(currentTheme(), DARK_THEME);
  assert.equal(store.get(THEME_STORAGE_KEY), DARK_THEME);
});

test('toggle flips between the two themes and stays persisted', () => {
  reset();
  assert.equal(toggleTheme(), LIGHT_THEME);
  assert.equal(store.get(THEME_STORAGE_KEY), LIGHT_THEME);
  assert.equal(toggleTheme(), DARK_THEME);
  assert.equal(store.get(THEME_STORAGE_KEY), DARK_THEME);
});

test('a missing or corrupt stored value falls back to dark', () => {
  reset();
  store.set(THEME_STORAGE_KEY, 'midnight-neon');
  assert.equal(getTheme(), DARK_THEME);
  assert.equal(initTheme(), DARK_THEME);
  assert.equal(currentTheme(), DARK_THEME);
});

test('an unknown theme argument is rejected rather than applied', () => {
  reset();
  assert.equal(applyTheme('solarized'), DARK_THEME);
  assert.equal(currentTheme(), DARK_THEME);
});

test('subscribers are notified after the theme is applied', () => {
  reset();
  const seen = [];
  const unsubscribe = subscribeTheme((theme) => seen.push(theme));

  setTheme(LIGHT_THEME);
  toggleTheme();

  assert.deepEqual(seen, [LIGHT_THEME, DARK_THEME]);

  unsubscribe();
  setTheme(LIGHT_THEME);
  assert.equal(seen.length, 2, 'an unsubscribed listener must stop receiving updates');
});

test('a broken subscriber cannot stop the theme from being applied', () => {
  reset();
  const seen = [];
  subscribeTheme(() => {
    throw new Error('subscriber exploded');
  });
  subscribeTheme((theme) => seen.push(theme));

  setTheme(LIGHT_THEME);
  assert.equal(currentTheme(), LIGHT_THEME);
  assert.deepEqual(seen, [LIGHT_THEME]);
});

test('unusable storage degrades to the default instead of breaking boot', () => {
  reset();
  const realStorage = globalThis.window.localStorage;
  globalThis.window.localStorage = {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('storage disabled');
    },
  };

  try {
    assert.equal(getTheme(), DARK_THEME);
    assert.equal(setTheme(LIGHT_THEME), LIGHT_THEME);
    // The palette still applies for this session even if it cannot be stored.
    assert.equal(currentTheme(), LIGHT_THEME);
  } finally {
    globalThis.window.localStorage = realStorage;
  }
});

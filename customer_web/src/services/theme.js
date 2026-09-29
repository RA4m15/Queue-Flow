/**
 * QueueFlow — Customer Web Theme Service
 *
 * The whole Dark / Light mechanism is ONE attribute on <html>
 * (`data-theme="light"`). Every surface in this app is painted from CSS custom
 * properties in index.css, so switching the theme repaints the whole site
 * without re-rendering, remounting or re-fetching a single component.
 *
 * Contract:
 * - Dark is the default. A missing or unrecognised stored value means dark.
 * - The choice is persisted in localStorage and re-applied by a tiny inline
 *   script in index.html *before first paint*, so a reload never flashes dark.
 * - Other tabs of the same origin are kept in step via the `storage` event.
 *
 * This module deliberately has no React import: it is the reusable core, and
 * `context/ThemeContext.jsx` is the only React binding on top of it. It is also
 * entirely independent of `services/storage.js`, so clearing a session or
 * caching queue snapshots offline can never disturb a customer's appearance.
 */

export const THEME_STORAGE_KEY = 'queueflow_customer_theme';

export const DARK_THEME = 'dark';
export const LIGHT_THEME = 'light';
export const DEFAULT_THEME = DARK_THEME;

const THEMES = [DARK_THEME, LIGHT_THEME];

/** Subscribers are notified after the theme is applied, never before. */
const listeners = new Set();

function isTheme(value) {
  return THEMES.includes(value);
}

/**
 * localStorage throws in private/disabled-storage modes. A theme preference is
 * never important enough to break boot over, so every access is guarded.
 */
function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function persistTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme still applies for this session, it just will not survive reload.
  }
}

function notify(theme) {
  listeners.forEach((listener) => {
    try {
      listener(theme);
    } catch {
      // A broken subscriber must not stop the others from updating.
    }
  });
}

/** The ONLY place the DOM is touched. Idempotent, and safe to call repeatedly. */
export function applyTheme(theme) {
  const next = isTheme(theme) ? theme : DEFAULT_THEME;
  const root = document.documentElement;

  if (next === DEFAULT_THEME) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', next);
  }

  // Keeps native widgets (scrollbars, date pickers, default form controls) in
  // step with the palette instead of staying stubbornly dark.
  root.style.colorScheme = next;

  return next;
}

/** The persisted preference, defaulting to dark. Does not touch the DOM. */
export function getTheme() {
  return readStoredTheme();
}

/** Read the stored preference and put it on the page. Called once at boot. */
export function initTheme() {
  return applyTheme(readStoredTheme());
}

/** Apply + persist + broadcast. Returns the theme that is now in effect. */
export function setTheme(theme) {
  const next = applyTheme(theme);
  persistTheme(next);
  notify(next);
  return next;
}

export function toggleTheme() {
  return setTheme(readStoredTheme() === LIGHT_THEME ? DARK_THEME : LIGHT_THEME);
}

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function subscribeTheme(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Multi-tab sync. A theme change in one tab must not leave another tab stale.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    notify(applyTheme(readStoredTheme()));
  });
}

/**
 * Default / remembered facility selection for the Admin Panel.
 *
 * Precedence, highest first:
 *
 *   1. An explicit, previously saved selection (localStorage). This is an
 *      administrator's deliberate choice, so it is NEVER overridden - not by
 *      the demo default and not by a backend reordering of the center list.
 *   2. `VITE_DEFAULT_CENTER_ID` - the configured demo facility, matched by its
 *      real persisted id. Used only when nothing has been selected yet.
 *   3. The first center the backend returns.
 *
 * Only an id is ever configured. The center's name is never used to derive the
 * id, so renaming a facility cannot silently repoint the dashboard.
 *
 * Every candidate is validated against the live center list, so a stale id in
 * localStorage (or a center that was removed) degrades to the next option
 * instead of leaving the dashboard pointed at nothing.
 */

const STORAGE_KEY = 'queueflow_admin_center_id';

// Vite replaces `import.meta.env` with the real env object at build time.
// In a plain Node context (unit tests) it is undefined, so fall back to an empty
// object rather than throwing. The optional chaining keeps both environments
// working without changing how Vite inlines the value.
const viteEnv = import.meta.env ?? {};

/** Configured demo facility id. Empty string when not configured. */
export const CONFIGURED_DEFAULT_CENTER_ID = (viteEnv.VITE_DEFAULT_CENTER_ID || '').trim();

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    // Private mode / storage disabled.
    return null;
  }
}

/** The administrator's last explicit selection, if any. */
export function getRememberedCenterId() {
  const store = safeStorage();
  if (!store) return null;
  try {
    const value = store.getItem(STORAGE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Record an explicit selection. Called only when the administrator actively
 * changes the facility, never for an automatically resolved default.
 */
export function rememberCenterId(centerId) {
  const store = safeStorage();
  if (!store || !centerId) return;
  try {
    store.setItem(STORAGE_KEY, String(centerId));
  } catch {
    /* non-fatal */
  }
}

const exists = (centers, id) => centers.some((c) => c && String(c._id) === String(id));

/**
 * Resolve which facility the dashboard should open on.
 *
 * @param {Array<{_id: string}>} centers live center list from the backend
 * @param {string|null} [currentCenterId] id already selected in this session
 * @returns {string|null}
 */
export function resolveDefaultCenterId(centers, currentCenterId = null) {
  if (!Array.isArray(centers) || centers.length === 0) return currentCenterId || null;

  // 1. An explicit selection already active in this session always wins.
  if (currentCenterId && exists(centers, currentCenterId)) return currentCenterId;

  // 2. The administrator's remembered selection is never overridden.
  const remembered = getRememberedCenterId();
  if (remembered && exists(centers, remembered)) return remembered;

  // 3. Configured demo facility, only if it is a real, still-present center.
  if (CONFIGURED_DEFAULT_CENTER_ID && exists(centers, CONFIGURED_DEFAULT_CENTER_ID)) {
    return CONFIGURED_DEFAULT_CENTER_ID;
  }

  // 4. Fall back to the first active center returned by the backend, or the first center.
  const firstActive = centers.find((c) => c && c.isOpen);
  return firstActive ? firstActive._id : centers[0]._id;
}

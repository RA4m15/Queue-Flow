/**
 * Authoritative crowd state rules.
 *
 * These are the pure parts of the Admin dashboard's crowd path, kept out of the
 * React hook so they can be asserted directly with `node --test` (this project
 * has no React test runner, and one is not being added).
 *
 * The governing rule: the backend owns every crowd number. Nothing here derives a
 * percentage, classifies a level, or substitutes a plausible value. If the
 * backend has not supplied a field, it stays `null` and the UI says so.
 */

/**
 * How long a reading stays trustworthy, matching the backend's own staleness
 * window. The server decides whether a sensor is online; this only ages a value
 * out between polls, and it deliberately mirrors the server rather than
 * introducing a second freshness rule.
 */
export const CROWD_SENSOR_STALE_MS = 90000;

/** The state before any backend response has been received. */
export const EMPTY_CROWD = Object.freeze({
  currentCrowd: null,
  capacity: null,
  crowdPercent: null,
  crowdStatus: null,
  crowdUpdatedAt: null,
  crowdSensorOnline: false,
});

/**
 * Adopt an authoritative REST read.
 *
 * The server's payload is taken verbatim. A field the server did not send is
 * reset to its empty value rather than being carried over from a previous
 * center, so switching facilities can never leave a stale number on screen.
 */
export function adoptCrowdRead(payload, centerId) {
  if (!payload) return { ...EMPTY_CROWD, centerId };
  return {
    ...EMPTY_CROWD,
    ...payload,
    centerId: payload.centerId ?? centerId,
  };
}

/**
 * Adopt a `crowd.updated` event.
 *
 * Returns the previous state unchanged when the event is not for this center or
 * carries no count, so a stray or malformed broadcast can never move the
 * dashboard. Otherwise the payload is adopted as-is: the server has already
 * validated the reading, derived the percentage and status, and scoped the
 * emission to this center's room.
 */
export function adoptCrowdEvent(previous, data, centerId) {
  if (!data || !centerId) return previous;
  // Scoping is re-checked client-side as well: the room is not the only guard.
  if (String(data.centerId) !== String(centerId)) return previous;
  if (typeof data.currentCrowd !== 'number' || !Number.isFinite(data.currentCrowd)) return previous;

  return {
    ...previous,
    currentCrowd: data.currentCrowd,
    capacity: typeof data.capacity === 'number' ? data.capacity : previous.capacity,
    crowdPercent: typeof data.crowdPercent === 'number' ? data.crowdPercent : null,
    crowdStatus: data.crowdStatus ?? null,
    crowdUpdatedAt: data.crowdUpdatedAt ?? null,
    // A reading that has just arrived is current by definition.
    crowdSensorOnline: true,
  };
}

/**
 * Whether a displayed reading can still be trusted.
 *
 * The backend's verdict is authoritative and is honoured first. The elapsed-time
 * check exists only so a sensor that stops reporting is shown as offline without
 * waiting for the next poll; it uses the same window the server does and never
 * alters a value.
 *
 * @param {object} state          current crowd state
 * @param {number} [now]          epoch ms, injectable for deterministic tests
 * @param {number} [staleMs]      override the staleness window
 */
export function isCrowdReadingStale(state, now = Date.now(), staleMs = CROWD_SENSOR_STALE_MS) {
  if (!state || typeof state.currentCrowd !== 'number') return true;
  if (state.crowdSensorOnline === false) return true;
  if (!state.crowdUpdatedAt) return true;
  const stamp = new Date(state.crowdUpdatedAt).getTime();
  if (Number.isNaN(stamp)) return true;
  return now - stamp > staleMs;
}

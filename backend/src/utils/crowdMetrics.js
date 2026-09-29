'use strict';

/**
 * Authoritative crowd metrics.
 *
 * `ServiceCenter` exposes `crowdPercent` and `crowdStatus` as Mongoose document
 * virtuals, but the read paths use `.lean({ virtuals: true })` to avoid
 * hydrating documents. That option only takes effect when the
 * `mongoose-lean-virtuals` plugin is registered, and it is not a dependency of
 * this project - so every lean read silently produced `undefined` for both
 * fields. Callers that trusted those values (the Admin dashboard's crowd
 * widget, for one) were left with no occupancy percentage or status at all.
 *
 * Rather than add a dependency, the derivation is centralised here and used
 * explicitly by the read paths. The formulas are identical to the schema
 * virtuals and to the inline computation in the IoT and display controllers, so
 * a lean read, a hydrated read, and the socket payload all agree.
 *
 * The thresholds (80 / 50) are the existing QueueFlow semantics and are
 * deliberately not configurable here: every surface must classify the same
 * reading identically, or the two dashboards can disagree.
 */

/** Occupancy as a whole-number percentage of capacity. */
function computeCrowdPercent(currentCrowd, capacity) {
  const cap = Number(capacity);
  if (!cap || cap <= 0) return 0;
  const crowd = Number(currentCrowd);
  if (!Number.isFinite(crowd)) return 0;
  return Math.round((crowd / cap) * 100);
}

/** LOW / MODERATE / HIGH, derived from the same thresholds as the schema. */
function computeCrowdStatus(crowdPercent) {
  const pct = Number(crowdPercent) || 0;
  if (pct >= 80) return 'HIGH';
  if (pct >= 50) return 'MODERATE';
  return 'LOW';
}

/**
 * Freshness of a reading, in the terms the UIs already use.
 *
 * A reading is only trustworthy while the sensor is still reporting, so
 * `crowdUpdatedAt` is compared against the backend's own staleness window. This
 * is the single definition of "sensor offline" for every surface - the
 * dashboards never age a value against a client clock.
 */
const SENSOR_STALE_MS = 90000;

function isCrowdSensorOnline(crowdUpdatedAt, staleMs = SENSOR_STALE_MS) {
  if (!crowdUpdatedAt) return false;
  const ts = new Date(crowdUpdatedAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < staleMs;
}

/**
 * The complete authoritative crowd state for a center, suitable for sending to
 * a client: the stored occupancy, the derived percentage/status, and the
 * sensor's freshness. Every crowd read path should return this so the Admin
 * dashboard, the Live Counter, the customer view and the socket payload cannot
 * drift apart.
 */
function buildCrowdState(center) {
  const currentCrowd = center?.currentCrowd ?? 0;
  const capacity = center?.capacity ?? 0;
  const crowdPercent = computeCrowdPercent(currentCrowd, capacity);
  return {
    centerId: center?._id ?? center?.centerId ?? null,
    currentCrowd,
    capacity,
    crowdPercent,
    crowdStatus: computeCrowdStatus(crowdPercent),
    crowdUpdatedAt: center?.crowdUpdatedAt || null,
    crowdSensorOnline: isCrowdSensorOnline(center?.crowdUpdatedAt),
  };
}

module.exports = {
  SENSOR_STALE_MS,
  computeCrowdPercent,
  computeCrowdStatus,
  isCrowdSensorOnline,
  buildCrowdState,
};

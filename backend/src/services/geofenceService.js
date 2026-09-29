'use strict';

const { Token } = require('../models/Token');
const ServiceCenter = require('../models/ServiceCenter');
const notificationService = require('./notificationService');
const { emitToCenter, emitToUser } = require('../config/socket');
const { logger } = require('../utils/logger');

// Maximum realistic civilian speed in m/s (100 m/s = 360 km/h, e.g. high-speed rail / expressway)
const MAX_REALISTIC_SPEED_MPS = 100;
// Stale threshold for incoming location payload (5 minutes)
const MAX_LOCATION_AGE_MS = 5 * 60 * 1000;
// Maximum allowed accuracy uncertainty in meters (1000m)
const MAX_ALLOWED_ACCURACY_METERS = 1000;
// Read staleness: if no update in 10 minutes, evaluate state as STALE
const READ_STALENESS_MS = 10 * 60 * 1000;
// Phase 2 second-stage geofencing: a waiting token's last known position is
// only trustworthy for a CALL NEXT decision for this long. The user app
// heartbeats every 5-30s depending on queue proximity, so 90s is comfortably
// beyond the slowest cadence while still bounding how far a customer can
// wander before an eligibility decision is made on information we trust.
const LOCATION_STALE_THRESHOLD_MS = 90 * 1000;
// Bounds on how far a still-WAITING token may be from the service center for
// the customer to be skipped automatically. Farther than this and we do not
// know enough to destroy someone's place in line, so the scan stops instead.
const AUTO_SKIP_MAX_DISTANCE_METERS = 2000;

// Transient in-memory velocity cache (tokenId -> { lat, lng, timestamp })
// Purged periodically. Keeps precise coordinates out of permanent database storage.
const transientVelocityCache = new Map();

// Periodic prune of transient cache entries older than 15 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, val] of transientVelocityCache.entries()) {
    if (val.timestamp < cutoff) {
      transientVelocityCache.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Standard Haversine formula for deterministic geodesic distance calculation.
 * Returns distance between two (lat, lon) coordinates in integer meters.
 *
 * @param {number} lat1 Latitude of point 1
 * @param {number} lon1 Longitude of point 1
 * @param {number} lat2 Latitude of point 2
 * @param {number} lon2 Longitude of point 2
 * @returns {number} Distance in meters (rounded to nearest integer)
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * Validate input coordinates strictly against NaN, Infinity, and geographic boundaries.
 */
function validateCoordinates(lat, lng) {
  if (lat === undefined || lat === null || lng === undefined || lng === null) {
    const err = new Error('Latitude and longitude coordinates are required');
    err.status = 400;
    throw err;
  }

  const numLat = Number(lat);
  const numLng = Number(lng);

  if (!Number.isFinite(numLat) || Number.isNaN(numLat)) {
    const err = new Error('Latitude must be a valid finite number');
    err.status = 400;
    throw err;
  }

  if (!Number.isFinite(numLng) || Number.isNaN(numLng)) {
    const err = new Error('Longitude must be a valid finite number');
    err.status = 400;
    throw err;
  }

  if (numLat < -90 || numLat > 90) {
    const err = new Error('Latitude must be between -90 and 90 degrees');
    err.status = 400;
    throw err;
  }

  if (numLng < -180 || numLng > 180) {
    const err = new Error('Longitude must be between -180 and 180 degrees');
    err.status = 400;
    throw err;
  }

  return { latitude: numLat, longitude: numLng };
}

/**
 * Validate location accuracy and timestamp.
 */
function validateAccuracyAndFreshness(accuracy, timestamp) {
  if (accuracy !== undefined && accuracy !== null) {
    const numAccuracy = Number(accuracy);
    if (!Number.isFinite(numAccuracy) || Number.isNaN(numAccuracy) || numAccuracy < 0) {
      const err = new Error('Accuracy must be a valid non-negative number');
      err.status = 400;
      throw err;
    }
    if (numAccuracy > MAX_ALLOWED_ACCURACY_METERS) {
      const err = new Error(`Location accuracy is too low for geofencing (must be within ${MAX_ALLOWED_ACCURACY_METERS} meters)`);
      err.status = 400;
      throw err;
    }
  }

  if (timestamp !== undefined && timestamp !== null) {
    const timeMs = new Date(timestamp).getTime();
    if (Number.isNaN(timeMs)) {
      const err = new Error('Invalid location timestamp format');
      err.status = 400;
      throw err;
    }

    const now = Date.now();
    // Allow up to 60s future clock skew
    if (timeMs > now + 60 * 1000) {
      const err = new Error('Location timestamp cannot be in the future');
      err.status = 400;
      throw err;
    }

    if (now - timeMs > MAX_LOCATION_AGE_MS) {
      const err = new Error('Location update is stale (exceeds 5-minute threshold)');
      err.status = 400;
      throw err;
    }
  }
}

/**
 * Detect unrealistic teleportation jumps (anti-spoofing signal).
 * Returns true if an impossible jump was detected.
 */
function detectUnrealisticJump(tokenId, lat, lng, timestampMs) {
  const last = transientVelocityCache.get(tokenId.toString());
  if (!last) {
    transientVelocityCache.set(tokenId.toString(), { lat, lng, timestamp: timestampMs });
    return false;
  }

  const timeDiffSec = (timestampMs - last.timestamp) / 1000;
  if (timeDiffSec <= 0) return false;

  const jumpMeters = calculateHaversineDistance(last.lat, last.lng, lat, lng);
  const speed = jumpMeters / timeDiffSec;

  // Always update transient position
  transientVelocityCache.set(tokenId.toString(), { lat, lng, timestamp: timestampMs });

  if (speed > MAX_REALISTIC_SPEED_MPS && jumpMeters > 500) {
    logger.warn('geofence.unrealistic_jump_detected', {
      tokenId: tokenId.toString(),
      jumpMeters,
      timeDiffSec,
      speedMps: Math.round(speed),
    });
    return true;
  }

  return false;
}

/**
 * Map distance to authoritative proximity state based on service center geofence radii.
 */
function resolveProximityState(distanceMeters, geofence) {
  const insideRadius = geofence?.radiusMeters || 500;
  const nearRadius = geofence?.nearRadiusMeters || Math.max(insideRadius * 2, insideRadius + 200);
  const approachingRadius = geofence?.approachingRadiusMeters || 2000;

  if (distanceMeters <= insideRadius) {
    return 'INSIDE';
  }
  if (distanceMeters <= nearRadius) {
    return 'NEAR';
  }
  if (distanceMeters <= approachingRadius) {
    return 'APPROACHING';
  }
  return 'OUTSIDE';
}

/**
 * Update a customer's location for an active token.
 * Server-authoritative: validates coordinates, calculates distance, evaluates state,
 * triggers notifications on transitions, and avoids storing raw coordinates.
 *
 * @param {object} params
 * @param {string} params.tokenId
 * @param {string} params.userId
 * @param {string} params.userRole
 * @param {number} params.latitude
 * @param {number} params.longitude
 * @param {number} [params.accuracy]
 * @param {string|number|Date} [params.timestamp]
 * @param {string} [params.clientCenterId]
 * @returns {Promise<{ proximityState: string, distanceMeters: number|null, updatedAt: Date }>}
 */
async function updateCustomerLocation({
  tokenId,
  userId,
  userRole,
  latitude,
  longitude,
  accuracy,
  timestamp,
  clientCenterId,
}) {
  // 1. Fetch token and verify existence
  const token = await Token.findById(tokenId);
  if (!token) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  // 2. Lifecycle check: token must be active (WAITING, CALLED, SERVING)
  if (!['WAITING', 'CALLED', 'SERVING'].includes(token.status)) {
    const err = new Error(`Cannot update location for ${token.status.toLowerCase()} token`);
    err.status = 400;
    throw err;
  }

  // 3. Authorization & IDOR protection: user must own token or be STAFF/ADMIN
  const tokenUserId = token.userId.toString();
  if (tokenUserId !== userId.toString() && userRole !== 'STAFF' && userRole !== 'ADMIN') {
    const err = new Error('Unauthorized: You do not own this token');
    err.status = 403;
    throw err;
  }

  // 4. Cross-center check: if client explicitly supplied a centerId, it must match
  if (clientCenterId && clientCenterId.toString() !== token.centerId.toString()) {
    const err = new Error('Cross-center violation: Provided centerId does not match token service center');
    err.status = 400;
    throw err;
  }

  // 5. Fetch ServiceCenter and verify location/geofence configuration
  const center = await ServiceCenter.findById(token.centerId);
  if (!center) {
    const err = new Error('Service center not found');
    err.status = 404;
    throw err;
  }

  const centerLat = center.latitude !== undefined && center.latitude !== null
    ? center.latitude
    : (center.location ? center.location.latitude : null);
  const centerLng = center.longitude !== undefined && center.longitude !== null
    ? center.longitude
    : (center.location ? center.location.longitude : null);

  const isConfigured =
    centerLat !== null &&
    centerLng !== null &&
    Number.isFinite(centerLat) &&
    Number.isFinite(centerLng);

  if (!isConfigured) {
    // Truthful unavailable state — do not simulate or invent coordinates
    token.proximityState = 'LOCATION_UNAVAILABLE';
    token.locationStatus = 'LOCATION_UNAVAILABLE';
    token.proximityUpdatedAt = new Date();
    token.proximityDistanceMeters = null;
    await token.save();

    return {
      proximityState: 'LOCATION_UNAVAILABLE',
      locationStatus: 'LOCATION_UNAVAILABLE',
      inRange: false,
      distanceMeters: null,
      updatedAt: token.proximityUpdatedAt,
      message: 'Service center location is not configured',
    };
  }

  // 6. Validate customer coordinates and freshness
  const coords = validateCoordinates(latitude, longitude);
  validateAccuracyAndFreshness(accuracy, timestamp);

  const effectiveTimestamp = timestamp ? new Date(timestamp).getTime() : Date.now();
  detectUnrealisticJump(token._id, coords.latitude, coords.longitude, effectiveTimestamp);

  // 7. Calculate deterministic Haversine distance
  const distanceMeters = calculateHaversineDistance(
    coords.latitude,
    coords.longitude,
    centerLat,
    centerLng
  );

  const joiningRadiusMeters = center.joiningRadiusMeters !== undefined && center.joiningRadiusMeters !== null
    ? center.joiningRadiusMeters
    : (center.geofence?.radiusMeters || 100);

  // 8. Determine authoritative proximity state and location status
  const locationStatus = distanceMeters <= joiningRadiusMeters ? 'IN_RANGE' : 'OUT_OF_RANGE';
  const newState = resolveProximityState(distanceMeters, center.geofence);
  const previousState = token.proximityState;

  // 9. Update token record with last location and status
  const locUpdateDate = new Date(effectiveTimestamp);
  token.lastLocation = {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: accuracy !== undefined && accuracy !== null && accuracy !== '' ? Number(accuracy) : null,
    updatedAt: locUpdateDate,
    distanceMeters,
    status: locationStatus,
  };
  token.locationStatus = locationStatus;
  token.proximityState = newState;
  token.proximityUpdatedAt = locUpdateDate;
  token.proximityDistanceMeters = distanceMeters;
  await token.save();

  // 10. Handle state transition notifications with deduplication
  if (previousState !== newState) {
    logger.info('geofence.state_transition', {
      tokenId: token._id.toString(),
      from: previousState,
      to: newState,
      distanceMeters,
    });

    await handleGeofenceTransitionNotification(token, center, previousState, newState, distanceMeters);

    // Emit live Socket.IO proximity event to user and center rooms
    try {
      emitToUser(tokenUserId, 'token:proximity', {
        tokenId: token._id.toString(),
        tokenCode: token.tokenCode,
        proximityState: newState,
        locationStatus,
        distanceMeters,
        inRange: locationStatus === 'IN_RANGE',
      });

      emitToCenter(center._id.toString(), 'token:proximity', {
        tokenId: token._id.toString(),
        tokenCode: token.tokenCode,
        proximityState: newState,
        locationStatus,
      });
    } catch (_) {}
  }

  return {
    proximityState: newState,
    locationStatus,
    inRange: locationStatus === 'IN_RANGE',
    distanceMeters,
    updatedAt: token.proximityUpdatedAt,
  };
}

/**
 * Resolve the service center's authoritative coordinates.
 * Accepts either the flat `latitude`/`longitude` fields or the nested
 * `location` sub-document. Returns nulls when the center has no usable
 * position — never invents or defaults to a coordinate.
 */
function getCenterCoordinates(center) {
  if (!center) return { latitude: null, longitude: null };

  const latitude =
    center.latitude !== undefined && center.latitude !== null
      ? center.latitude
      : (center.location ? center.location.latitude : null);
  const longitude =
    center.longitude !== undefined && center.longitude !== null
      ? center.longitude
      : (center.location ? center.location.longitude : null);

  const usable =
    latitude !== null &&
    latitude !== undefined &&
    longitude !== null &&
    longitude !== undefined &&
    Number.isFinite(Number(latitude)) &&
    Number.isFinite(Number(longitude));

  if (!usable) return { latitude: null, longitude: null };
  return { latitude: Number(latitude), longitude: Number(longitude) };
}

/**
 * The single existing radius used for both Phase 1 (join) and Phase 2 (call
 * eligibility) eligibility. No new radius is ever invented here.
 */
function getCenterJoiningRadiusMeters(center) {
  if (!center) return 100;
  if (center.joiningRadiusMeters !== undefined && center.joiningRadiusMeters !== null) {
    return Number(center.joiningRadiusMeters);
  }
  if (center.geofence && center.geofence.radiusMeters) {
    return Number(center.geofence.radiusMeters);
  }
  return 100;
}

/**
 * Authoritatively classify a token's location eligibility against a center.
 * Possible states: 'IN_RANGE', 'OUT_OF_RANGE', 'LOCATION_STALE', 'LOCATION_UNAVAILABLE'
 *
 * STALE and UNAVAILABLE are deliberately *not* folded into IN_RANGE. A missing
 * or expired reading is not evidence of presence, so a customer is never
 * called on the strength of a position we cannot vouch for.
 *
 * @param {object} token
 * @param {object} center
 * @param {number} [now]
 * @returns {{ locationStatus: string, inRange: boolean, distanceMeters: number|null, reason?: string, ageMs?: number, radiusMeters?: number }}
 */
function classifyTokenLocation(token, center, now = Date.now()) {
  const { latitude: centerLat, longitude: centerLng } = getCenterCoordinates(center);

  if (centerLat === null || centerLng === null) {
    return {
      locationStatus: 'LOCATION_UNAVAILABLE',
      inRange: false,
      distanceMeters: null,
      reason: 'Service center location is not configured',
    };
  }

  const radiusMeters = getCenterJoiningRadiusMeters(center);

  const loc = token ? token.lastLocation : null;
  const updatedAt = (loc && loc.updatedAt) || (token ? token.proximityUpdatedAt : null);
  const hasCoords =
    loc &&
    loc.latitude !== null &&
    loc.latitude !== undefined &&
    loc.longitude !== null &&
    loc.longitude !== undefined &&
    Number.isFinite(Number(loc.latitude)) &&
    Number.isFinite(Number(loc.longitude));

  if (!hasCoords || !updatedAt) {
    return {
      locationStatus: 'LOCATION_UNAVAILABLE',
      inRange: false,
      distanceMeters: null,
      radiusMeters,
      reason: 'No usable location has been reported for this token',
    };
  }

  const locationTimeMs = new Date(updatedAt).getTime();
  if (Number.isNaN(locationTimeMs)) {
    return {
      locationStatus: 'LOCATION_UNAVAILABLE',
      inRange: false,
      distanceMeters: null,
      radiusMeters,
      reason: 'Reported location has no usable timestamp',
    };
  }

  const ageMs = now - locationTimeMs;
  if (ageMs > LOCATION_STALE_THRESHOLD_MS) {
    return {
      locationStatus: 'LOCATION_STALE',
      inRange: false,
      distanceMeters: loc.distanceMeters ?? token.proximityDistanceMeters ?? null,
      ageMs,
      radiusMeters,
      reason: 'Latest location is too old to make a trustworthy decision',
    };
  }

  const distanceMeters = calculateHaversineDistance(
    Number(loc.latitude),
    Number(loc.longitude),
    centerLat,
    centerLng
  );

  if (distanceMeters <= radiusMeters) {
    return {
      locationStatus: 'IN_RANGE',
      inRange: true,
      distanceMeters,
      ageMs,
      radiusMeters,
    };
  }

  return {
    locationStatus: 'OUT_OF_RANGE',
    inRange: false,
    distanceMeters,
    ageMs,
    radiusMeters,
  };
}

/**
 * Send deduplicated notifications when customer transitions into key geofence zones.
 */
async function handleGeofenceTransitionNotification(token, center, fromState, toState, distanceMeters) {
  let notificationType = null;
  let title = '';
  let body = '';

  if (toState === 'APPROACHING') {
    notificationType = 'GEOFENCE_APPROACHING';
    title = 'Approaching Service Center';
    body = `You are approaching ${center.name} (~${Math.round(distanceMeters / 100) / 10} km away). Your turn will arrive soon.`;
  } else if (toState === 'NEAR') {
    notificationType = 'GEOFENCE_NEAR';
    title = 'Near Service Center';
    body = `You are near ${center.name}. Please stay close to the service center.`;
  } else if (toState === 'INSIDE') {
    notificationType = 'GEOFENCE_INSIDE';
    title = 'Inside Service Area';
    body = `You have arrived at ${center.name}. Please be ready for token ${token.tokenCode}.`;
  }

  if (notificationType) {
    const dedupeKey = `geofence_${token._id}_${toState}`;
    try {
      await notificationService.sendTokenNotification(token, notificationType, {
        title,
        body,
        dedupeKey,
        metadata: {
          proximityState: toState,
          distanceMeters,
          centerName: center.name,
        },
      });
    } catch (err) {
      logger.error('geofence.notification_error', { err: err.message });
    }
  }
}

/**
 * Phase 2 approaching warnings, layered on top of the existing authoritative
 * queue position and the existing notification system.
 *
 * Two thresholds, both keyed to the backend's own position count:
 *   - 3-4 tokens remaining -> "remain within <radius> m of the service center"
 *   - 1-2 tokens remaining -> "return to the service area"
 *
 * Rules enforced here:
 *   - Only fires when the customer's own location says they are NOT in range.
 *     A customer already inside is never told to come back.
 *   - Deduplicated. The dedupe key is database-backed and scoped to this
 *     token, so repeated position recomputation cannot spam the customer.
 *   - STALE / UNAVAILABLE location never produces a "return" warning, because
 *     we do not know they left; absence of information is not a warning signal.
 *
 * @param {object} params
 * @param {object} params.token          Token document (must be WAITING)
 * @param {object} params.center         ServiceCenter document
 * @param {number} params.peopleAhead    Authoritative count of tokens ahead
 * @returns {Promise<{level: string, notification: object}|null>}
 */
async function evaluateGeofenceApproachingWarning({ token, center, peopleAhead }) {
  if (!token || !token._id || token.status !== 'WAITING') {
    return null;
  }
  if (!Number.isFinite(Number(peopleAhead))) {
    return null;
  }

  const ahead = Number(peopleAhead);

  // Only these two bands warn. 0 ahead is "you're next", handled by the
  // existing notification service, and 5+ is the existing "5 tokens away".
  let level = null;
  if (ahead >= 1 && ahead <= 2) {
    level = 'TURN_IMMINENT';
  } else if (ahead >= 3 && ahead <= 4) {
    level = 'TURN_APPROACHING';
  }

  if (!level) {
    return null;
  }

  // Gate on the customer's own server-derived location. IN_RANGE => stay quiet.
  const location = classifyTokenLocation(token, center);
  if (location.locationStatus !== 'OUT_OF_RANGE') {
    return null;
  }

  const radiusMeters = getCenterJoiningRadiusMeters(center);
  const tokenId = token._id.toString();

  const spec =
    level === 'TURN_IMMINENT'
      ? {
          title: 'Your turn is coming soon',
          body: 'Your turn is coming soon. Please return to the service area.',
          type: 'TURN_IMMINENT_RETURN',
        }
      : {
          title: 'Your turn is approaching',
          body: `Your turn is approaching. Please remain within ${radiusMeters} m of the service center.`,
          type: 'TURN_APPROACHING_RETURN',
        };

  const notification = await notificationService.sendTokenNotification(token, spec.type, {
    title: spec.title,
    body: spec.body,
    // Stable per token+level: fired once, never repeated for this token.
    dedupeKey: `geofence_return_${tokenId}_${level}`,
    metadata: {
      warningLevel: level,
      locationStatus: location.locationStatus,
      radiusMeters,
      peopleAhead: ahead,
      centerName: center ? center.name : undefined,
    },
  });

  return { level, notification };
}

/**
 * Get read-safe proximity state for a token, taking into account read staleness.
 */
async function getTokenProximity(tokenId, userId, userRole) {
  const token = await Token.findById(tokenId);
  if (!token) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (token.userId.toString() !== userId.toString() && userRole !== 'STAFF' && userRole !== 'ADMIN') {
    const err = new Error('Unauthorized');
    err.status = 403;
    throw err;
  }

  let state = token.proximityState || 'UNKNOWN';

  // Evaluate staleness: if proximity was recorded > 10 minutes ago, mark as STALE
  if (token.proximityUpdatedAt) {
    const ageMs = Date.now() - new Date(token.proximityUpdatedAt).getTime();
    if (ageMs > READ_STALENESS_MS && ['INSIDE', 'NEAR', 'APPROACHING'].includes(state)) {
      state = 'STALE';
    }
  }

  return {
    proximityState: state,
    locationStatus: token.locationStatus || 'LOCATION_UNAVAILABLE',
    distanceMeters: token.proximityDistanceMeters,
    updatedAt: token.proximityUpdatedAt,
  };
}

module.exports = {
  calculateHaversineDistance,
  validateCoordinates,
  validateAccuracyAndFreshness,
  detectUnrealisticJump,
  resolveProximityState,
  updateCustomerLocation,
  getTokenProximity,
  classifyTokenLocation,
  evaluateGeofenceApproachingWarning,
  getCenterCoordinates,
  getCenterJoiningRadiusMeters,
  LOCATION_STALE_THRESHOLD_MS,
  AUTO_SKIP_MAX_DISTANCE_METERS,
  _transientVelocityCache: transientVelocityCache,
};

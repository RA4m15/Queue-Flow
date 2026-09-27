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

  const isConfigured =
    center.location &&
    typeof center.location.latitude === 'number' &&
    typeof center.location.longitude === 'number' &&
    Number.isFinite(center.location.latitude) &&
    Number.isFinite(center.location.longitude);

  if (!isConfigured || !center.geofence?.enabled) {
    // Truthful unavailable state — do not simulate or invent coordinates
    token.proximityState = 'LOCATION_UNAVAILABLE';
    token.proximityUpdatedAt = new Date();
    token.proximityDistanceMeters = null;
    await token.save();

    return {
      proximityState: 'LOCATION_UNAVAILABLE',
      distanceMeters: null,
      updatedAt: token.proximityUpdatedAt,
      message: 'Service center location is not configured or geofencing is disabled',
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
    center.location.latitude,
    center.location.longitude
  );

  // 8. Determine authoritative proximity state
  const newState = resolveProximityState(distanceMeters, center.geofence);
  const previousState = token.proximityState;

  // 9. Update token record with coarse proximity only (ZERO coordinates stored)
  token.proximityState = newState;
  token.proximityUpdatedAt = new Date();
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
        distanceMeters,
      });

      emitToCenter(center._id.toString(), 'token:proximity', {
        tokenId: token._id.toString(),
        tokenCode: token.tokenCode,
        proximityState: newState,
      });
    } catch (_) {}
  }

  return {
    proximityState: newState,
    distanceMeters,
    updatedAt: token.proximityUpdatedAt,
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
  _transientVelocityCache: transientVelocityCache,
};

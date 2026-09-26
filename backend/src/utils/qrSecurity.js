'use strict';

/**
 * QR Cryptographic Security Module — Phase 4
 *
 * Design:
 *   - Payload is signed with HMAC-SHA256 using QR_SIGNING_SECRET (dedicated, separate from JWT_SECRET).
 *   - Canonical representation is pipe-delimited with fixed field order to prevent JSON-key-order attacks.
 *   - Signature is hex-encoded and appended to the JSON envelope as a separate field.
 *   - QR is short-lived (TTL = 30 minutes) — appropriate for a physical check-in flow where the
 *     customer arrives within the same session.
 *   - A random nonce (UUID v4) is embedded in the payload for one-time-use enforcement.
 *   - Clock-skew tolerance of 60 seconds.
 *   - If QR_SIGNING_SECRET is missing, generation fails safely (no unsigned QR).
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ─── Constants ───────────────────────────────────────────────────────────────

/** QR payload schema version — increment when changing field layout. */
const QR_VERSION = 1;

/** QR validity window in seconds (30 minutes). */
const QR_TTL_SECONDS = 30 * 60;

/** Allowed clock-skew in seconds for issuedAt validation. */
const CLOCK_SKEW_SECONDS = 60;

/** Canonical field separator — chosen so it cannot appear in any valid field value. */
const CANONICAL_SEP = '|';

/** Purpose string — prevents cross-purpose signature reuse. */
const QR_PURPOSE = 'QUEUEFLOW_CHECKIN';

// ─── Secret Resolution ────────────────────────────────────────────────────────

/**
 * Resolve and validate the QR signing secret.
 * Throws an error if the secret is missing or too short.
 * @returns {string}
 */
function _getSecret() {
  const secret = process.env.QR_SIGNING_SECRET;
  if (!secret || secret.trim().length < 32) {
    const err = new Error(
      'QR_SIGNING_SECRET is not configured or is too short (minimum 32 characters). ' +
      'QR generation is unavailable.'
    );
    err.code = 'QR_SECRET_MISSING';
    err.status = 503;
    throw err;
  }
  return secret.trim();
}

// ─── Canonical Representation ─────────────────────────────────────────────────

/**
 * Build a deterministic canonical string for HMAC signing.
 * Field order is fixed; no user-controlled JSON key ordering.
 *
 * Format:
 *   version|tokenId|centerId|serviceId|issuedAt|expiresAt|nonce|purpose
 *
 * @param {object} fields
 * @returns {string}
 */
function _canonical({ version, tokenId, centerId, serviceId, issuedAt, expiresAt, nonce, purpose }) {
  return [version, tokenId, centerId, serviceId, issuedAt, expiresAt, nonce, purpose].join(CANONICAL_SEP);
}

// ─── Sign & Verify ────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 over canonical string.
 * @param {string} canonical
 * @param {string} secret
 * @returns {string} hex digest
 */
function _hmac(canonical, secret) {
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/**
 * Timing-safe comparison of two hex strings.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _timingSafeEqual(a, b) {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a signed QR payload for a token.
 *
 * The payload is a JSON string containing:
 *   - v: schema version
 *   - tid: token MongoDB ObjectId (hex string)
 *   - cid: service center MongoDB ObjectId (hex string)
 *   - sid: service MongoDB ObjectId (hex string)
 *   - iat: issued-at Unix timestamp (seconds)
 *   - exp: expires-at Unix timestamp (seconds)
 *   - jti: nonce / JWT-id (UUID v4) — one-time-use identifier
 *   - pur: purpose string
 *   - sig: HMAC-SHA256 hex signature over canonical representation
 *
 * Does NOT include: userId, email, phone, password, JWT, or any other PII.
 *
 * @param {object} params
 * @param {string} params.tokenId   - Token MongoDB _id string
 * @param {string} params.centerId  - Service center MongoDB _id string
 * @param {string} params.serviceId - Service MongoDB _id string
 * @returns {string} JSON string — the complete signed QR payload
 * @throws {Error} if QR_SIGNING_SECRET is not configured
 */
function generateSignedQRPayload({ tokenId, centerId, serviceId }) {
  if (!tokenId || !centerId || !serviceId) {
    const err = new Error('tokenId, centerId, and serviceId are required');
    err.status = 400;
    throw err;
  }

  const secret = _getSecret();
  const now = Math.floor(Date.now() / 1000);
  const nonce = uuidv4();

  const payload = {
    v: QR_VERSION,
    tid: String(tokenId),
    cid: String(centerId),
    sid: String(serviceId),
    iat: now,
    exp: now + QR_TTL_SECONDS,
    jti: nonce,
    pur: QR_PURPOSE,
  };

  const canonical = _canonical({
    version: payload.v,
    tokenId: payload.tid,
    centerId: payload.cid,
    serviceId: payload.sid,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    nonce: payload.jti,
    purpose: payload.pur,
  });

  payload.sig = _hmac(canonical, secret);

  return JSON.stringify(payload);
}

/**
 * Parse and fully verify a signed QR payload string.
 *
 * Checks (in order):
 * 1. Valid JSON.
 * 2. Required fields present and correct types.
 * 3. Schema version match.
 * 4. Purpose match.
 * 5. Signature present.
 * 6. HMAC-SHA256 signature valid (timing-safe).
 * 7. issuedAt not in the future beyond clock-skew.
 * 8. Not expired (currentTime > expiresAt).
 *
 * Does NOT check nonce usage or token DB state — those are done by the caller.
 *
 * @param {string} qrPayloadString - Raw QR payload string (from scanner)
 * @returns {{ v, tid, cid, sid, iat, exp, jti, pur }} — parsed payload (sig stripped)
 * @throws {Error} with code 'QR_INVALID' for any validation failure
 */
function verifyQRPayload(qrPayloadString) {
  // Safe generic error — do not leak which check failed to untrusted callers
  function invalid(reason) {
    // reason is for server-side logging only
    const err = new Error('QR verification failed');
    err.code = 'QR_INVALID';
    err.status = 400;
    err._reason = reason; // internal only
    return err;
  }

  // 1. Parse
  let parsed;
  try {
    parsed = JSON.parse(qrPayloadString);
  } catch {
    throw invalid('malformed_json');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('not_object');
  }

  // 2. Required fields
  const { v, tid, cid, sid, iat, exp, jti, pur, sig } = parsed;

  if (typeof v !== 'number') throw invalid('missing_version');
  if (typeof tid !== 'string' || !tid) throw invalid('missing_tid');
  if (typeof cid !== 'string' || !cid) throw invalid('missing_cid');
  if (typeof sid !== 'string' || !sid) throw invalid('missing_sid');
  if (typeof iat !== 'number') throw invalid('missing_iat');
  if (typeof exp !== 'number') throw invalid('missing_exp');
  if (typeof jti !== 'string' || !jti) throw invalid('missing_jti');
  if (typeof pur !== 'string' || !pur) throw invalid('missing_pur');
  if (typeof sig !== 'string' || !sig) throw invalid('missing_sig');

  // 3. Version
  if (v !== QR_VERSION) throw invalid('wrong_version');

  // 4. Purpose
  if (pur !== QR_PURPOSE) throw invalid('wrong_purpose');

  // 5+6. Signature (verify BEFORE time checks to avoid timing oracle)
  const secret = _getSecret();
  const canonical = _canonical({
    version: v,
    tokenId: tid,
    centerId: cid,
    serviceId: sid,
    issuedAt: iat,
    expiresAt: exp,
    nonce: jti,
    purpose: pur,
  });

  const expected = _hmac(canonical, secret);
  if (!_timingSafeEqual(expected, sig)) throw invalid('bad_signature');

  // 7. issuedAt not too far in the future
  const nowSec = Math.floor(Date.now() / 1000);
  if (iat > nowSec + CLOCK_SKEW_SECONDS) throw invalid('future_iat');

  // 8. Expiry
  if (nowSec > exp) throw invalid('expired');

  // Return parsed payload without signature
  return { v, tid, cid, sid, iat, exp, jti, pur };
}

module.exports = {
  QR_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  QR_VERSION,
  QR_PURPOSE,
  generateSignedQRPayload,
  verifyQRPayload,
};

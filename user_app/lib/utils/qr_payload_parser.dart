library;

/// QR Payload Parser — Customer Queue-Entry QR
///
/// This module handles ONLY the customer-facing "join queue" QR codes.
///
/// It is completely separate from the server-side HMAC-signed token check-in QR
/// (the signed payload with { v, tid, cid, sid, iat, exp, jti, pur, sig }).
///
/// There is ONE canonical customer queue QR format. It is HTTPS:
///
///     HOST/join?centerId=ID
///     HOST/join?centerId=ID&serviceId=ID
///
/// where HOST is the deployed Customer Web domain (scheme included) and ID is a
/// 24-character hex MongoDB ObjectId.
///
/// This single URL is what the Live Counter encodes into the QR image, and it
/// works for every case: an installed app is opened via App Link / Universal
/// Link, a phone without the app falls through to the browser and lands on the
/// very same Customer Web `/join` route, and the in-app scanner recognises the
/// identical string.
///
/// The legacy custom scheme is still accepted so previously printed QR codes and
/// existing deep links keep working:
///
///   queueflow://join?centerId=ID&serviceId=ID
///   queueflow://join?centerId=ID
///
/// ALL of these normalize into the single [QrJoinPayload] consumed by the
/// existing queue join flow, so there is no second QR system.
///
/// All variants must pass strict structural validation before the IDs
/// are used in any backend API call.
///
/// The backend APIs are the authoritative source of truth:
///   - Center existence: GET /api/service-centers/:id
///   - Service belonging to center: GET /api/services?centerId=...
/// Client-side ID validation only prevents structurally invalid input
/// from reaching the backend.

import '../core/config/join_config.dart';

// ─── Result types ─────────────────────────────────────────────────────────────

/// Outcome of a QR parse attempt.
sealed class QrParseResult {
  const QrParseResult();
}

/// The QR was scanned but is not a QueueFlow join QR.
/// This might be a staff check-in QR (HMAC payload) or a completely unrelated QR.
final class QrUnrecognized extends QrParseResult {
  const QrUnrecognized({this.hint});

  /// Non-sensitive diagnostic hint for logging (never shown to user as-is).
  final String? hint;
}

/// The QR looks like a QueueFlow QR but has structural problems.
final class QrInvalid extends QrParseResult {
  const QrInvalid({required this.reason});

  /// User-safe error reason.
  final String reason;
}

// ─── Validation helpers ────────────────────────────────────────────────────────

/// MongoDB ObjectId: exactly 24 hex characters.
final _mongoIdRegex = RegExp(r'^[a-fA-F0-9]{24}$');

/// Validates a string as a MongoDB ObjectId.
bool _isValidMongoId(String? s) =>
    s != null && s.isNotEmpty && _mongoIdRegex.hasMatch(s);

// ─── Parser ───────────────────────────────────────────────────────────────────

/// Which of the two accepted join formats a payload used.
enum QrJoinFormat {
  /// Canonical public format: an HTTPS `/join` URL on the Customer Web domain.
  httpsWeb,

  /// Legacy custom scheme, retained for already-printed codes: `queueflow://join?...`
  legacyScheme,
}

/// The valid join link result.
///
/// [format] records which accepted form the payload arrived in. It exists for
/// diagnostics and tests only — the queue join flow consumes [centerId] and
/// [serviceId] and behaves identically for both.
final class QrJoinPayload extends QrParseResult {
  const QrJoinPayload({
    required this.centerId,
    this.serviceId,
    this.format = QrJoinFormat.legacyScheme,
  });

  /// 24-character hex MongoDB ObjectId — structurally validated.
  final String centerId;

  /// 24-character hex MongoDB ObjectId, present for center+service QRs.
  /// Null means center-only QR → navigate to service selection.
  final String? serviceId;

  /// Which accepted QR format produced this payload.
  final QrJoinFormat format;

  bool get hasService => serviceId != null;
}

/// Parse a raw QR string and classify it.
///
/// This is a pure function — no I/O, no BuildContext, no navigation.
/// All classification happens here; the caller handles routing and API calls.
///
/// Rules:
/// - Input is sanitized (truncated + control chars stripped) before calling this.
/// - Maximum accepted length: 512 characters.
/// - Two accepted forms, both normalizing to [QrJoinPayload]:
///     1. an HTTPS `/join` URL on an allowed Customer Web host   (canonical)
///     2. `queueflow://join?centerId=...[&serviceId=...]`         (legacy)
/// - HTTPS links are only accepted from a host in [queueflowJoinHosts]; a link
///   from any other host is [QrUnrecognized], so an arbitrary third-party QR
///   can never enter the queue flow.
/// - Within an allowed host, only the canonical `/join` path is accepted.
/// - IDs are validated as 24-hex MongoDB ObjectIds before returning.
/// - Unknown/external QR content returns [QrUnrecognized].
/// - Structurally bad QueueFlow QRs return [QrInvalid] with a safe message.
QrParseResult parseQrPayload(String raw) {
  // Hard length cap (defence-in-depth; caller should also sanitize).
  final input = raw.length > 512 ? raw.substring(0, 512) : raw;
  final trimmed = input.trim();

  if (trimmed.isEmpty) {
    return const QrUnrecognized(hint: 'empty_input');
  }

  // ── Reject the staff / IoT check-in QR first ──────────────────────────────
  //
  // The staff check-in HMAC payload starts with `{"v":1,"tid":` and has `"sig":`
  // — it must never be treated as a customer join QR.
  if (_looksLikeHmacTokenQr(trimmed)) {
    return const QrUnrecognized(hint: 'staff_hmac_payload');
  }

  // Parse once; both accepted forms are valid absolute URIs.
  final Uri uri;
  try {
    uri = Uri.parse(trimmed);
  } catch (_) {
    // Not a URI at all (arbitrary text, malformed input).
    return const QrUnrecognized(hint: 'not_a_uri');
  }

  final scheme = uri.scheme.toLowerCase();

  if (scheme == kLegacyJoinScheme) {
    return _parseLegacyScheme(uri);
  }

  if (scheme == 'https' || scheme == 'http') {
    return _parseWebJoinLink(uri, scheme);
  }

  // Any other scheme (competitor app, mailto:, tel:, random custom scheme...).
  return const QrUnrecognized(hint: 'unsupported_scheme');
}

/// Legacy `queueflow://join?...` — kept for backwards compatibility.
QrParseResult _parseLegacyScheme(Uri uri) {
  if (uri.host != 'join') {
    return const QrInvalid(
      reason: 'This QR code is not a valid QueueFlow join link.',
    );
  }

  return _buildJoinPayload(uri, QrJoinFormat.legacyScheme);
}

/// Canonical HTTPS `/join` URL on a trusted Customer Web host - the primary
/// format.
QrParseResult _parseWebJoinLink(Uri uri, String scheme) {
  final host = uri.host;

  // A cleartext production link is not a QueueFlow join link; only dev hosts
  // may use http.
  if (!isAllowedJoinScheme(scheme, host)) {
    return const QrUnrecognized(hint: 'insecure_join_scheme');
  }

  // Reject links from domains this build does not trust. Without this, any QR
  // from any website could be routed into the queue flow.
  if (!isAllowedJoinHost(host)) {
    return const QrUnrecognized(hint: 'untrusted_join_host');
  }

  // Within a trusted host, only the canonical join route is a join QR.
  if (uri.path != kCanonicalJoinPath) {
    return const QrInvalid(
      reason: 'This QR code is not a valid QueueFlow join link.',
    );
  }

  return _buildJoinPayload(uri, QrJoinFormat.httpsWeb);
}

/// Shared validation + normalization for both accepted formats.
///
/// This is the single point where a QR becomes the one internal
/// [ParsedJoinPayload] the queue flow consumes.
QrParseResult _buildJoinPayload(Uri uri, QrJoinFormat format) {
  final centerId = uri.queryParameters['centerId'];
  final serviceId = uri.queryParameters['serviceId'];

  // centerId is always required
  if (!_isValidMongoId(centerId)) {
    return const QrInvalid(
      reason: 'QR code contains an invalid service center reference.',
    );
  }

  // serviceId is optional; if present it must be a valid ObjectId
  if (serviceId != null && !_isValidMongoId(serviceId)) {
    return const QrInvalid(
      reason: 'QR code contains an invalid service reference.',
    );
  }

  // centerId and serviceId must not be equal (sanity guard)
  if (serviceId != null && centerId == serviceId) {
    return const QrInvalid(
      reason: 'QR code contains mismatched identifiers.',
    );
  }

  return QrJoinPayload(
    centerId: centerId!,
    serviceId: serviceId,
    format: format,
  );
}

/// Heuristic check: does the string look like an HMAC-signed token check-in QR?
/// These have the structure {"v":1,"tid":"...","cid":"...","sid":"...","sig":"..."}
bool _looksLikeHmacTokenQr(String s) {
  if (!s.startsWith('{')) return false;
  return s.contains('"sig":') &&
      s.contains('"tid":') &&
      s.contains('"cid":') &&
      s.contains('"pur":"QUEUEFLOW_CHECKIN"');
}

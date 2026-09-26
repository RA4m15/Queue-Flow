library;

/// QR Payload Parser — Customer Queue-Entry QR
///
/// This module handles ONLY the customer-facing "join queue" QR codes.
///
/// It is completely separate from the server-side HMAC-signed token check-in QR
/// (the signed payload with { v, tid, cid, sid, iat, exp, jti, pur, sig }).
///
/// Customer-entry QR format (two variants):
///
///   Variant A — Center + Service (direct-to-join):
///     queueflow://join?centerId=<24hexId>&serviceId=<24hexId>
///
///   Variant B — Center only (opens service selection):
///     queueflow://join?centerId=<24hexId>
///
/// Both variants must pass strict structural validation before the IDs
/// are used in any backend API call.
///
/// The backend APIs are the authoritative source of truth:
///   - Center existence: GET /api/service-centers/:id
///   - Service belonging to center: GET /api/services?centerId=...
/// Client-side ID validation only prevents structurally invalid input
/// from reaching the backend.

// ─── Result types ─────────────────────────────────────────────────────────────

/// Outcome of a QR parse attempt.
sealed class QrParseResult {
  const QrParseResult();
}

/// The QR is a valid QueueFlow join QR.
final class QrJoinPayload extends QrParseResult {
  const QrJoinPayload({
    required this.centerId,
    this.serviceId,
  });

  /// 24-character hex MongoDB ObjectId — structurally validated.
  final String centerId;

  /// 24-character hex MongoDB ObjectId, present for center+service QRs.
  /// Null means center-only QR → navigate to service selection.
  final String? serviceId;

  bool get hasService => serviceId != null;
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

/// Parse a raw QR string and classify it.
///
/// This is a pure function — no I/O, no BuildContext, no navigation.
/// All classification happens here; the caller handles routing and API calls.
///
/// Rules:
/// - Input is sanitized (truncated + control chars stripped) before calling this.
/// - Maximum accepted length: 512 characters.
/// - Only `queueflow://` scheme is recognised as a join QR.
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

  // ── Detect QueueFlow join QR ──────────────────────────────────────────────
  //
  // Only the `queueflow://join` scheme is handled here.
  // The staff check-in HMAC payload starts with `{"v":1,"tid":` and has `"sig":`
  // — we explicitly reject it to avoid confusion.

  if (_looksLikeHmacTokenQr(trimmed)) {
    // This is a staff/IoT check-in QR. Customers cannot use it to join queues.
    return const QrUnrecognized(hint: 'staff_hmac_payload');
  }

  if (!trimmed.startsWith('queueflow://')) {
    return const QrUnrecognized(hint: 'not_queueflow_scheme');
  }

  // Parse as URI
  Uri uri;
  try {
    uri = Uri.parse(trimmed);
  } catch (_) {
    return const QrInvalid(reason: 'QR code is malformed and cannot be read.');
  }

  // Must be queueflow://join
  if (uri.host != 'join') {
    return const QrInvalid(
      reason: 'This QR code is not a valid QueueFlow join link.',
    );
  }

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

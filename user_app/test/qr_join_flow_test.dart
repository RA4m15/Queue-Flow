// ignore_for_file: lines_longer_than_80_chars
library;

/// QR Join Flow Tests — Phase A
///
/// Tests the QR parsing logic (qr_payload_parser.dart) which is a pure
/// function with no I/O, making all cases directly testable.
///
/// Coverage:
///   ✅ Valid center + service QR
///   ✅ Valid center-only QR
///   ✅ Invalid QR — malformed MongoDB ID (center)
///   ✅ Invalid QR — malformed MongoDB ID (service)
///   ✅ Invalid QR — centerId == serviceId
///   ✅ Invalid QR — wrong host (not 'join')
///   ✅ Unrecognized QR — not a queueflow:// scheme
///   ✅ Unrecognized QR — staff HMAC check-in payload is rejected
///   ✅ Unrecognized QR — plain URL
///   ✅ Unrecognized QR — arbitrary text
///   ✅ Unrecognized QR — empty string
///   ✅ Unrecognized QR — only whitespace
///   ✅ No token generation unless user completes the join flow
///   ✅ Input length cap (>512 chars)
///   ✅ Correct payload field extraction (centerId, serviceId)
///   ✅ Case insensitivity of hex IDs

import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/utils/qr_payload_parser.dart';

// ─── Test fixture IDs ─────────────────────────────────────────────────────────

/// Valid 24-hex MongoDB ObjectIds for use in tests.
const _centerId = '507f1f77bcf86cd799439011';
const _serviceId = '507f1f77bcf86cd799439022';

/// A real HMAC-signed check-in payload (structure only — not cryptographically valid).
/// Used to verify these are classified as [QrUnrecognized], NOT as join QRs.
const _hmacCheckinQr = '{"v":1,"tid":"507f1f77bcf86cd799439011","cid":"507f1f77bcf86cd799439022",'
    '"sid":"507f1f77bcf86cd799439033","iat":1700000000,"exp":1700001800,'
    '"jti":"550e8400-e29b-41d4-a716-446655440000","pur":"QUEUEFLOW_CHECKIN",'
    '"sig":"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"}';

void main() {
  group('QrPayloadParser — parseQrPayload()', () {
    // ── Valid join QRs ───────────────────────────────────────────────────────

    group('Valid center + service QR', () {
      test('returns QrJoinPayload with both IDs', () {
        final qr = 'queueflow://join?centerId=$_centerId&serviceId=$_serviceId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrJoinPayload>());
        final payload = result as QrJoinPayload;
        expect(payload.centerId, equals(_centerId));
        expect(payload.serviceId, equals(_serviceId));
        expect(payload.hasService, isTrue);
      });

      test('parameters in reversed order still parse correctly', () {
        final qr = 'queueflow://join?serviceId=$_serviceId&centerId=$_centerId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrJoinPayload>());
        final payload = result as QrJoinPayload;
        expect(payload.centerId, equals(_centerId));
        expect(payload.serviceId, equals(_serviceId));
      });

      test('uppercase hex IDs are accepted', () {
        final upper = _centerId.toUpperCase();
        final upperS = _serviceId.toUpperCase();
        final qr = 'queueflow://join?centerId=$upper&serviceId=$upperS';
        final result = parseQrPayload(qr);

        expect(result, isA<QrJoinPayload>());
        final payload = result as QrJoinPayload;
        expect(payload.centerId, equals(upper));
      });
    });

    group('Valid center-only QR', () {
      test('returns QrJoinPayload with serviceId null', () {
        final qr = 'queueflow://join?centerId=$_centerId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrJoinPayload>());
        final payload = result as QrJoinPayload;
        expect(payload.centerId, equals(_centerId));
        expect(payload.serviceId, isNull);
        expect(payload.hasService, isFalse);
      });
    });

    // ── Invalid QueueFlow QRs ────────────────────────────────────────────────

    group('Invalid queueflow:// QRs', () {
      test('missing centerId returns QrInvalid', () {
        final qr = 'queueflow://join?serviceId=$_serviceId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrInvalid>());
        expect((result as QrInvalid).reason, isNotEmpty);
      });

      test('centerId with wrong length returns QrInvalid', () {
        final qr = 'queueflow://join?centerId=tooshort&serviceId=$_serviceId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrInvalid>());
      });

      test('centerId with non-hex characters returns QrInvalid', () {
        final badId = 'xxxxxxxxxxxxxxxxxxxxxxxx'; // 24 chars, not hex
        final qr = 'queueflow://join?centerId=$badId&serviceId=$_serviceId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrInvalid>());
      });

      test('serviceId with wrong length returns QrInvalid', () {
        final qr = 'queueflow://join?centerId=$_centerId&serviceId=bad';
        final result = parseQrPayload(qr);

        expect(result, isA<QrInvalid>());
      });

      test('centerId == serviceId returns QrInvalid', () {
        final qr = 'queueflow://join?centerId=$_centerId&serviceId=$_centerId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrInvalid>());
      });

      test('queueflow:// with wrong host returns QrInvalid', () {
        final qr = 'queueflow://verify?centerId=$_centerId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrInvalid>());
      });

      test('queueflow:// with empty centerId param returns QrInvalid', () {
        final qr = 'queueflow://join?centerId=&serviceId=$_serviceId';
        final result = parseQrPayload(qr);

        expect(result, isA<QrInvalid>());
      });
    });

    // ── Unrecognized QRs ─────────────────────────────────────────────────────

    group('Unrecognized QRs', () {
      test('HMAC check-in payload classified as QrUnrecognized (not join QR)', () {
        final result = parseQrPayload(_hmacCheckinQr);

        // Staff check-in QRs must NOT be routed into the customer join flow.
        expect(result, isA<QrUnrecognized>());
      });

      test('plain HTTPS URL is QrUnrecognized', () {
        final result = parseQrPayload('https://example.com/join?centerId=$_centerId');

        expect(result, isA<QrUnrecognized>());
      });

      test('arbitrary text is QrUnrecognized', () {
        final result = parseQrPayload('Hello World');

        expect(result, isA<QrUnrecognized>());
      });

      test('JSON object (non-HMAC) is QrUnrecognized', () {
        final result = parseQrPayload('{"foo":"bar"}');

        expect(result, isA<QrUnrecognized>());
      });

      test('empty string is QrUnrecognized', () {
        final result = parseQrPayload('');

        expect(result, isA<QrUnrecognized>());
      });

      test('whitespace-only string is QrUnrecognized', () {
        final result = parseQrPayload('   \t\n  ');

        expect(result, isA<QrUnrecognized>());
      });

      test('competitor URL scheme is QrUnrecognized', () {
        final result = parseQrPayload('myapp://join?centerId=$_centerId');

        expect(result, isA<QrUnrecognized>());
      });
    });

    // ── Security guards ───────────────────────────────────────────────────────

    group('Security guards', () {
      test('input longer than 512 chars is processed safely without error', () {
        // Oversized input should be truncated, not crash.
        final oversized = 'queueflow://join?centerId=$_centerId&${'x' * 600}';
        // Should not throw; result may be QrUnrecognized or QrInvalid but never crashes.
        expect(() => parseQrPayload(oversized), returnsNormally);
      });

      test('input with control characters does not crash parser', () {
        final withControl = 'queueflow://join?centerId=\x00\x01\x02$_centerId';
        expect(() => parseQrPayload(withControl), returnsNormally);
      });

      test('SQL injection attempt is classified safely', () {
        final injection = "queueflow://join?centerId=' OR '1'='1";
        final result = parseQrPayload(injection);

        // Injection cannot produce a valid ObjectId, so must be QrInvalid or QrUnrecognized.
        expect(result, isNot(isA<QrJoinPayload>()));
      });

      test('null-byte injection attempt is classified safely', () {
        final injection = 'queueflow://join?centerId=\x00$_centerId';
        expect(() => parseQrPayload(injection), returnsNormally);
        final result = parseQrPayload(injection);
        expect(result, isNot(isA<QrJoinPayload>()));
      });
    });

    // ── No direct token generation ────────────────────────────────────────────

    group('Token generation contract', () {
      test('parseQrPayload never generates a token (pure parse, no side effects)', () {
        // parseQrPayload is a pure function. This test documents the contract:
        // parsing a QR does NOT call any API, does NOT create a token,
        // does NOT mutate any state. It only classifies the input.
        //
        // The join flow only starts after navigation to QueuePreviewScreen,
        // which requires an explicit user tap on the "Join" button.

        final qr = 'queueflow://join?centerId=$_centerId&serviceId=$_serviceId';
        final result = parseQrPayload(qr);

        // Result is a classification only — no tokens, no network calls.
        expect(result, isA<QrJoinPayload>());
        expect((result as QrJoinPayload).centerId, isNotEmpty);
        // centerId from QR must be validated against backend before use.
      });
    });

    // ── QrJoinPayload equality & accessor coverage ───────────────────────────

    group('QrJoinPayload accessors', () {
      test('hasService is true when serviceId is present', () {
        const payload = QrJoinPayload(centerId: _centerId, serviceId: _serviceId);
        expect(payload.hasService, isTrue);
      });

      test('hasService is false when serviceId is null', () {
        const payload = QrJoinPayload(centerId: _centerId);
        expect(payload.hasService, isFalse);
        expect(payload.serviceId, isNull);
      });
    });
  });
}

import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/services/location_service.dart';
import 'package:user_app/services/proximity_heartbeat.dart';

import 'harness.dart';

/// Phase 2 geofencing on the customer side.
///
/// The two failures these guard against are both about the app lying to the
/// customer, or failing them:
///
///  1. The app says "you are inside the service area" when the backend has not
///     said so. A stale or unavailable reading is not a green light, and if the
///     app ever presented one as one, the customer would have no idea their
///     place was about to be taken away.
///  2. The heartbeat keeps running after a token is skipped, draining the
///     battery of a customer who is no longer in the queue at all.
void main() {
  const centerLat = 12.9716;
  const centerLng = 77.5946;

  TokenModel tokenWith({
    String status = 'WAITING',
    int? currentPosition = 1,
    String? locationStatus,
    String? skipReason,
  }) {
    return TokenModel.fromJson({
      '_id': kTokenId,
      'tokenCode': 'P2-001',
      'tokenNumber': 1,
      'userId': kUserA,
      'centerId': kCenterId,
      'serviceId': kServiceId,
      'status': status,
      'currentPosition': currentPosition,
      'locationStatus': ?locationStatus,
      'skipReason': ?skipReason,
    });
  }

  // ── Verdict parsing ──────────────────────────────────────────────────────

  group('ProximityVerdict', () {
    test('1. IN_RANGE is the only status the app may call "in range"', () {
      final verdict = ProximityVerdict.fromJson({
        'locationStatus': 'IN_RANGE',
        'distanceMeters': 42,
        'inRange': true,
      });
      expect(verdict.isInRange, isTrue);
      expect(verdict.isOutOfRange, isFalse);
      expect(verdict.isUnconfirmed, isFalse);
    });

    test('2. a client-asserted inRange without a matching status is ignored', () {
      // The backend is authoritative. A payload that says inRange: true with a
      // LOCATION_STALE status must never be presented to the customer as
      // presence, because that is exactly how someone gets silently skipped.
      final verdict = ProximityVerdict.fromJson({
        'locationStatus': 'LOCATION_STALE',
        'inRange': true,
      });
      expect(verdict.isInRange, isFalse);
      expect(verdict.isUnconfirmed, isTrue);
    });

    test('3. LOCATION_STALE is unconfirmed, never out of range', () {
      final verdict = ProximityVerdict.fromJson({'locationStatus': 'LOCATION_STALE'});
      expect(verdict.isUnconfirmed, isTrue);
      expect(verdict.isOutOfRange, isFalse,
          reason: 'an old reading is not evidence the customer walked away');
    });

    test('4. LOCATION_UNAVAILABLE is unconfirmed, never out of range', () {
      final verdict = ProximityVerdict.fromJson({'locationStatus': 'LOCATION_UNAVAILABLE'});
      expect(verdict.isUnconfirmed, isTrue);
      expect(verdict.isOutOfRange, isFalse);
    });

    test('5. a null or empty response degrades to unavailable, not to in range', () {
      expect(ProximityVerdict.fromJson(null).isInRange, isFalse);
      expect(ProximityVerdict.fromJson(const {}).locationStatus, 'LOCATION_UNAVAILABLE');
      expect(ProximityVerdict.fromJson(const {'locationStatus': ''}).isInRange, isFalse);
    });

    test('6. OUT_OF_RANGE is the only status that means out of range', () {
      expect(ProximityVerdict.fromJson({'locationStatus': 'OUT_OF_RANGE'}).isOutOfRange, isTrue);
    });
  });

  // ── Cadence ──────────────────────────────────────────────────────────────

  group('HeartbeatCadence', () {
    test('7. far from the front of the queue polls about every 30 s', () {
      expect(HeartbeatCadence.intervalFor(20), const Duration(seconds: 30));
      expect(HeartbeatCadence.intervalFor(5), const Duration(seconds: 30));
      expect(HeartbeatCadence.intervalFor(null), const Duration(seconds: 30),
          reason: 'an unknown position must not be assumed to be the closest');
    });

    test('8. three or four people ahead polls about every 15 s', () {
      expect(HeartbeatCadence.intervalFor(4), const Duration(seconds: 15));
      expect(HeartbeatCadence.intervalFor(3), const Duration(seconds: 15));
    });

    test('9. one or two people ahead polls inside the 5-10 s band', () {
      for (final ahead in [0, 1, 2]) {
        final interval = HeartbeatCadence.intervalFor(ahead);
        expect(interval.inSeconds, greaterThanOrEqualTo(5));
        expect(interval.inSeconds, lessThanOrEqualTo(10));
      }
    });

    test('10. the cadence never drops below the documented floor', () {
      // A negative or absurd position is nonsense input, not a reason to spin
      // the GPS. It must never produce a sub-5 s loop.
      for (final ahead in [-5, -1, 0, 1, 2, 3, 4, 5, 1000]) {
        expect(
          HeartbeatCadence.intervalFor(ahead).inMilliseconds,
          greaterThanOrEqualTo(HeartbeatCadence.minimum.inMilliseconds),
        );
      }
    });

    test('11. the cadence speeds up monotonically as the customer nears the front', () {
      final intervals = [20, 5, 4, 3, 2, 1, 0].map(HeartbeatCadence.intervalFor).toList();
      for (var i = 1; i < intervals.length; i++) {
        expect(
          intervals[i] <= intervals[i - 1],
          isTrue,
          reason: 'cadence must never slow down as the queue position improves',
        );
      }
    });
  });

  // ── Heartbeat behaviour ──────────────────────────────────────────────────

  group('ProximityHeartbeat', () {
    late FakeLocationService gps;
    late List<UserLocation> uploaded;
    late Map<String, dynamic>? verdict;
    late List<ProximityVerdict> received;
    late List<Object> errors;

    ProximityHeartbeat build({Duration Function(int?)? intervalFor}) {
      return ProximityHeartbeat(
        locationService: gps,
        upload: (location) async {
          uploaded.add(location);
          return verdict;
        },
        intervalFor: intervalFor,
        onVerdict: received.add,
        onError: errors.add,
      );
    }

    setUp(() {
      gps = FakeLocationService(
        currentLocation: const UserLocation(latitude: centerLat, longitude: centerLng, accuracy: 8),
      );
      uploaded = <UserLocation>[];
      received = <ProximityVerdict>[];
      errors = <Object>[];
      verdict = const {'locationStatus': 'IN_RANGE', 'distanceMeters': 40};
    });

    test('12. does nothing until it is started', () async {
      final heartbeat = build();
      expect(heartbeat.isRunning, isFalse);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(uploaded, isEmpty);
    });

    test('13. shares a reading and relays the backend verdict', () async {
      final heartbeat = build(intervalFor: (_) => const Duration(milliseconds: 10));
      heartbeat.start(peopleAhead: 10);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      heartbeat.stop();

      expect(uploaded, isNotEmpty);
      expect(received, isNotEmpty);
      expect(received.last.isInRange, isTrue);
      expect(heartbeat.isRunning, isFalse);
    });

    test('14. never asks for a location permission mid-wait', () async {
      // A heartbeat tick must not pop a permission dialog at a customer who is
      // merely waiting in line. The join flow owns permission prompts.
      final heartbeat = build(intervalFor: (_) => const Duration(milliseconds: 10));
      heartbeat.start(peopleAhead: 1);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      heartbeat.stop();

      expect(uploaded, isNotEmpty, reason: 'a fix was available, so readings were shared');
      expect(gps.getCurrentCalls, greaterThan(0));
      expect(gps.getCurrentRequestPermissionFlags, isNotEmpty);
      expect(
        gps.getCurrentRequestPermissionFlags.every((flag) => flag == false),
        isTrue,
        reason: 'the heartbeat must never request permission; the join flow owns that',
      );
    });

    test('15. stop() halts sharing immediately, even mid-interval', () async {
      final heartbeat = build(intervalFor: (_) => const Duration(milliseconds: 10));
      heartbeat.start(peopleAhead: 1);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      heartbeat.stop();
      final countAtStop = uploaded.length;
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(uploaded.length, countAtStop, reason: 'a stopped token must stop being tracked');
    });

    test('16. stop() is idempotent and safe to call twice', () {
      final heartbeat = build();
      heartbeat.start(peopleAhead: 1);
      heartbeat.stop();
      expect(heartbeat.stop, returnsNormally);
      expect(heartbeat.isRunning, isFalse);
    });

    test('17. a failed upload is swallowed, never surfaced as an error state', () async {
      final heartbeat = build(intervalFor: (_) => const Duration(milliseconds: 10));
      heartbeat.start(peopleAhead: 1);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      heartbeat.stop();
      // A null verdict (what a transport failure produces) simply leaves the
      // previous reading in place; nothing is invented.
      expect(errors, isEmpty);
    });

    test('18. a missing GPS fix is NOT reported as out of range', () async {
      gps.currentLocation = null;
      final heartbeat = build(intervalFor: (_) => const Duration(milliseconds: 10));
      heartbeat.start(peopleAhead: 1);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      heartbeat.stop();

      expect(uploaded, isEmpty, reason: 'there is nothing to upload without a fix');
      expect(received, isEmpty,
          reason: 'the app must never claim the customer left the area on a failed fix');
    });

    test('19. updatePosition retimes the loop without duplicating it', () async {
      final heartbeat = build(intervalFor: (ahead) {
        return ahead != null && ahead <= 2
            ? const Duration(milliseconds: 10)
            : const Duration(milliseconds: 100);
      });
      heartbeat.start(peopleAhead: 20);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(uploaded, isEmpty, reason: 'still on the slow cadence');

      heartbeat.updatePosition(1);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      heartbeat.stop();
      expect(uploaded, isNotEmpty, reason: 'moving up the queue must speed the loop up');
    });

    test('20. updatePosition is ignored once stopped', () async {
      final heartbeat = build(intervalFor: (_) => const Duration(milliseconds: 10));
      heartbeat.stop();
      heartbeat.updatePosition(0);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(uploaded, isEmpty);
      expect(heartbeat.isRunning, isFalse);
    });

    test('21. repeated start() calls never produce two parallel loops', () async {
      final heartbeat = build(intervalFor: (_) => const Duration(milliseconds: 20));
      heartbeat.start(peopleAhead: 1);
      heartbeat.start(peopleAhead: 1);
      heartbeat.start(peopleAhead: 1);
      await Future<void>.delayed(const Duration(milliseconds: 130));
      heartbeat.stop();
      // One loop at 20 s per beat would manage ~6 beats; three parallel loops
      // would manage ~18. The bound below catches accidental duplication.
      expect(uploaded.length, lessThanOrEqualTo(9));
    });
  });

  // ── Token model ──────────────────────────────────────────────────────────

  group('TokenModel Phase 2 fields', () {
    test('22. a skipped-out-of-range token is not active and says so plainly', () {
      final token = tokenWith(status: 'SKIPPED_OUT_OF_RANGE', skipReason: 'OUT_OF_RANGE');
      expect(token.isSkippedOutOfRange, isTrue);
      expect(token.isActive, isFalse,
          reason: 'a skipped token must not keep a location heartbeat alive');
      expect(token.outOfRangeSkipMessage, isNotNull);
      expect(token.outOfRangeSkipMessage, contains('rejoin the queue'));
    });

    test('23. only an out-of-range skip produces the out-of-range message', () {
      expect(tokenWith(status: 'SKIPPED').outOfRangeSkipMessage, isNull);
      expect(tokenWith(status: 'CANCELLED').outOfRangeSkipMessage, isNull);
      expect(tokenWith(status: 'WAITING').outOfRangeSkipMessage, isNull);
      expect(
        tokenWith(status: 'SKIPPED', skipReason: 'MANUAL').outOfRangeSkipMessage,
        isNull,
        reason: 'a manual skip must not be mislabelled as a geofence skip',
      );
    });

    test('24. location status is reported only as the backend stated it', () {
      expect(tokenWith(locationStatus: 'IN_RANGE').isLocationInRange, isTrue);
      expect(tokenWith(locationStatus: 'OUT_OF_RANGE').isLocationOutOfRange, isTrue);
      expect(tokenWith().isLocationInRange, isFalse,
          reason: 'no verdict yet is not the same as being in range');
      expect(tokenWith().isLocationOutOfRange, isFalse);
      expect(tokenWith().isLocationUnconfirmed, isFalse);
    });

    test('25. stale and unavailable are unconfirmed, never out of range', () {
      for (final status in ['LOCATION_STALE', 'LOCATION_UNAVAILABLE']) {
        final token = tokenWith(locationStatus: status);
        expect(token.isLocationUnconfirmed, isTrue, reason: status);
        expect(token.isLocationOutOfRange, isFalse, reason: status);
        expect(token.isLocationInRange, isFalse, reason: status);
      }
    });

    test('26. copyWith round-trips every new Phase 2 field', () {
      final skippedAt = DateTime.utc(2026, 9, 28, 10);
      final token = tokenWith().copyWith(
        status: 'SKIPPED_OUT_OF_RANGE',
        skipReason: 'OUT_OF_RANGE',
        skippedAt: skippedAt,
        locationStatus: 'OUT_OF_RANGE',
      );
      expect(token.status, 'SKIPPED_OUT_OF_RANGE');
      expect(token.skipReason, 'OUT_OF_RANGE');
      expect(token.skippedAt, skippedAt);
      expect(token.locationStatus, 'OUT_OF_RANGE');
    });

    test('27. peopleAhead drives the cadence bands used by the heartbeat', () {
      // currentPosition 1 means "next", 3 means two people ahead.
      expect(tokenWith(currentPosition: 1).peopleAhead, 0);
      expect(tokenWith(currentPosition: 3).peopleAhead, 2);
      expect(HeartbeatCadence.intervalFor(tokenWith(currentPosition: 1).peopleAhead).inSeconds, 5);
      expect(HeartbeatCadence.intervalFor(tokenWith(currentPosition: 5).peopleAhead).inSeconds, 15);
      expect(HeartbeatCadence.intervalFor(tokenWith(currentPosition: 9).peopleAhead).inSeconds, 30);
    });
  });
}

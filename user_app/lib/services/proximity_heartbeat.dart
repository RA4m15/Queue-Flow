import 'dart:async';

import 'package:flutter/foundation.dart';

import 'location_service.dart';

/// Backend-authoritative location verdicts (mirrors geofenceService).
class ProximityVerdict {
  const ProximityVerdict({
    required this.locationStatus,
    this.distanceMeters,
    this.updatedAt,
  });

  /// The customer is inside the joining radius. The only state that may ever be
  /// presented to a customer as "you are in the service area".
  static const String inRange = 'IN_RANGE';

  /// The customer is outside the joining radius.
  static const String outOfRange = 'OUT_OF_RANGE';

  /// The last reading is too old to trust.
  static const String locationStale = 'LOCATION_STALE';

  /// No usable reading exists at all.
  static const String locationUnavailable = 'LOCATION_UNAVAILABLE';

  final String locationStatus;

  /// Distance as measured by the backend. Never computed on the client.
  final double? distanceMeters;

  /// Server-side timestamp of the reading.
  final DateTime? updatedAt;

  /// Whether the backend has affirmatively placed this customer inside.
  ///
  /// Derived from the status alone. A payload that merely asserts `inRange`
  /// without a matching status is ignored, so a stale or missing response can
  /// never make the app claim the customer is present.
  bool get isInRange => locationStatus == inRange;

  bool get isOutOfRange => locationStatus == outOfRange;

  /// The customer cannot be confirmed present. Distinct from "out of range":
  /// this says nothing about where they are, and must never lead to a skip.
  bool get isUnconfirmed =>
      locationStatus == locationStale || locationStatus == locationUnavailable;

  /// Parses a `POST /tokens/:id/location` response defensively.
  factory ProximityVerdict.fromJson(Map<String, dynamic>? json) {
    if (json == null) {
      return const ProximityVerdict(locationStatus: locationUnavailable);
    }
    final status = (json['locationStatus'] ?? '').toString().toUpperCase();
    final rawDistance = json['distanceMeters'];
    final stamp =
        json['updatedAt'] != null ? DateTime.tryParse(json['updatedAt'].toString()) : null;

    return ProximityVerdict(
      locationStatus: status.isEmpty ? locationUnavailable : status,
      distanceMeters: rawDistance is num ? rawDistance.toDouble() : null,
      updatedAt: stamp,
    );
  }
}

/// How often the app should share its position while holding a live token.
///
/// The cadence is a pure function of how close the customer is to being
/// called. That is what makes it testable, and it is also what keeps the
/// client honest: the app never decides whether a customer is in range, only
/// how often to ask the backend.
class HeartbeatCadence {
  const HeartbeatCadence._();

  /// Far from the front of the queue: 30 s. Cheap, and the customer is not at
  /// immediate risk of being skipped.
  static const Duration relaxed = Duration(seconds: 30);

  /// Three or four people ahead: 15 s. The customer could be skipped soon.
  static const Duration approaching = Duration(seconds: 15);

  /// One or two people ahead: 5 s, the fast end of the required 5-10 s band.
  /// Chosen deliberately, because the next CALL NEXT may be seconds away and a
  /// stale reading here costs the customer their place in line.
  static const Duration imminent = Duration(seconds: 5);

  /// Never poll faster than this. The backend permits 30 location pings per
  /// minute and 5 s is comfortably inside that, as well as the fastest a
  /// consumer GPS fix is actually useful.
  static const Duration minimum = imminent;

  /// The interval to wait before the next location share.
  ///
  /// @param peopleAhead how many customers are in front of this one, or null
  ///   when the queue position is not known yet.
  static Duration intervalFor(int? peopleAhead) {
    // An unknown position in line is treated as "not close yet" rather than
    // as "closest": polling too slowly is bounded by the relaxed 30 s, while
    // polling too fast only burns battery.
    if (peopleAhead == null) return relaxed;
    if (peopleAhead <= 2) return imminent;
    if (peopleAhead <= 4) return approaching;
    return relaxed;
  }
}

/// Sends one location sample to the backend and returns its raw response.
typedef LocationUploader = Future<Map<String, dynamic>?> Function(UserLocation location);

/// Drives the Phase 2 location heartbeat.
///
/// Constraints this class exists to satisfy:
///  - It never blocks the UI or the queue. Every network call is fire-and-
///    forget from the caller's point of view, and failures are swallowed: a
///    failed location ping is not something the customer can act on, and
///    surfacing it as an error would be theatre.
///  - It stops as soon as the token stops being active, so a skipped,
///    cancelled or completed token stops draining the battery.
///  - It never decides whether a customer is in range. The backend does; this
///    class only relays that verdict.
class ProximityHeartbeat {
  ProximityHeartbeat({
    required LocationService locationService,
    required LocationUploader upload,
    Duration Function(int? peopleAhead)? intervalFor,
    ValueChanged<ProximityVerdict>? onVerdict,
    ValueChanged<Object>? onError,
  })  : _locationService = locationService,
        _upload = upload,
        _intervalFor = intervalFor ?? HeartbeatCadence.intervalFor,
        _onVerdict = onVerdict ?? _ignore,
        _onError = onError ?? _ignore;

  final LocationService _locationService;
  final LocationUploader _upload;
  final Duration Function(int? peopleAhead) _intervalFor;
  final ValueChanged<ProximityVerdict> _onVerdict;
  final ValueChanged<Object> _onError;

  Timer? _timer;
  bool _inFlight = false;
  bool _stopped = true;
  int? _peopleAhead;

  /// Whether the heartbeat is currently armed.
  bool get isRunning => !_stopped;

  /// The interval currently in force. Exposed for the telemetry/debug surface
  /// and for tests.
  Duration get currentInterval => _intervalFor(_peopleAhead);

  /// Starts, or restarts, the heartbeat for an active token.
  ///
  /// Safe to call repeatedly: the timer is replaced, never duplicated.
  void start({int? peopleAhead}) {
    _peopleAhead = peopleAhead;
    _stopped = false;
    _schedule();
  }

  /// Updates the queue position without restarting the loop, so a customer
  /// moving up the queue speeds up without any extra work.
  void updatePosition(int? peopleAhead) {
    if (_stopped || _peopleAhead == peopleAhead) return;
    _peopleAhead = peopleAhead;
    _schedule();
  }

  /// Stops the heartbeat. Idempotent, and safe to call from dispose().
  void stop() {
    _stopped = true;
    _timer?.cancel();
    _timer = null;
  }

  void _schedule() {
    if (_stopped) return;
    _timer?.cancel();
    _timer = Timer(currentInterval, _tick);
  }

  Future<void> _tick() async {
    if (_stopped) return;

    // A slow network must never build up a backlog of pings. Dropping a beat
    // is strictly better than delivering a stale position late.
    if (_inFlight) {
      _schedule();
      return;
    }

    _inFlight = true;
    try {
      final location = await _locationService.getCurrentLocation(requestPermission: false);
      if (_stopped) return;

      if (location == null) {
        // No fix available. Deliberately NOT reported as out of range: the
        // backend keeps the last known reading, which ages into
        // LOCATION_STALE and blocks the call rather than skipping anyone.
        return;
      }

      final response = await _upload(location);
      if (_stopped) return;
      _onVerdict(ProximityVerdict.fromJson(response));
    } catch (error) {
      if (!_stopped) _onError(error);
    } finally {
      _inFlight = false;
      if (!_stopped) _schedule();
    }
  }
}

void _ignore(Object? _) {}

/// Authoritative service-center operating hours.
///
/// ## What the backend actually stores
///
/// `ServiceCenter.operatingHours` is an optional array of
/// `{ day, open, close, isClosed }` documents (`backend/src/models/ServiceCenter.js`).
/// `open` and `close` are `HH:MM` 24-hour strings, admin-configured. It is
/// returned in full by `GET /api/service-centers/:id` and is the ONLY
/// time-bound field in the service-center schema.
///
/// ## What it is deliberately NOT
///
/// * It is not a QR expiry. A printed QR carries no time semantics at all —
///   a static image cannot become short-lived merely by being scanned.
/// * It is not a queue admission deadline. No backend field, and no backend
///   code path, enforces it. `queueService.joinQueue` gates joining on
///   `center.isOpen`, `service.isActive`, queue status, the Document Gate and
///   duplicate tokens — never on `operatingHours`.
/// * It is not used to invent a countdown. When no window is configured for
///   today the result is [JoiningWindowUnconfigured] and the UI shows a plain
///   open/closed status with **no** timer at all.
///
/// ## Clock honesty
///
/// The schema stores wall-clock strings with no timezone and no date, so there
/// is no absolute server instant to count down to. [OperatingHoursWindow.resolve]
/// therefore resolves the configured close time against the device clock, and
/// the UI labels the result as the center's configured hours rather than
/// claiming a server-issued deadline.
library;

/// One configured day of a service center's operating hours.
class OperatingHoursDay {
  const OperatingHoursDay({
    required this.day,
    required this.open,
    required this.close,
    required this.isClosed,
  });

  /// `MON` … `SUN`, exactly as the backend enum.
  final String day;

  /// Opening time as `HH:MM` (24-hour).
  final String open;

  /// Closing time as `HH:MM` (24-hour).
  final String close;

  /// Admin flag: the center does not operate at all on this day.
  final bool isClosed;

  /// The backend's own 3-letter day codes in `DateTime.weekday` order.
  static const List<String> dayCodes = <String>[
    'MON',
    'TUE',
    'WED',
    'THU',
    'FRI',
    'SAT',
    'SUN',
  ];

  /// The day code for [moment], using the same mapping the backend enum uses.
  static String codeFor(DateTime moment) => dayCodes[(moment.weekday - 1).clamp(0, 6)];

  /// Parses `HH:MM` into minutes past midnight, or `null` if malformed.
  static int? parseHhMm(String? raw) {
    if (raw == null) return null;
    final match = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(raw.trim());
    if (match == null) return null;
    final hours = int.tryParse(match.group(1)!);
    final minutes = int.tryParse(match.group(2)!);
    if (hours == null || minutes == null) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  /// Formats minutes-past-midnight back to `HH:MM`.
  static String formatHhMm(int minutesPastMidnight) {
    final clamped = minutesPastMidnight.clamp(0, 24 * 60);
    final h = (clamped ~/ 60).toString().padLeft(2, '0');
    final m = (clamped % 60).toString().padLeft(2, '0');
    return '$h:$m';
  }

  factory OperatingHoursDay.fromJson(Map<String, dynamic> json) {
    return OperatingHoursDay(
      day: (json['day'] ?? '').toString().trim().toUpperCase(),
      open: (json['open'] ?? '').toString().trim(),
      close: (json['close'] ?? '').toString().trim(),
      isClosed: json['isClosed'] == true,
    );
  }
}

/// The outcome of resolving a service center's operating hours for "now".
sealed class OperatingHoursWindow {
  const OperatingHoursWindow();

  /// Whether a countdown may be shown at all.
  ///
  /// Only [JoiningWindowOpen] and [JoiningWindowClosedAfterClose] carry a real
  /// instant. Every other result is [JoiningWindowUnconfigured] or a day the
  /// center does not operate, and must render as a plain status.
  bool get hasCountdown => false;
}

/// The center has no operating hours configured for today.
///
/// The truthful outcome when `operatingHours` is empty (the schema default) or
/// has no entry for the current weekday. No timer is shown — inventing one here
/// is exactly the fake countdown this app must never display.
final class JoiningWindowUnconfigured extends OperatingHoursWindow {
  const JoiningWindowUnconfigured();
}

/// The center is marked closed for the whole of today, or is missing an opening
/// time, so there is no closing instant to count toward.
final class JoiningWindowNotScheduled extends OperatingHoursWindow {
  const JoiningWindowNotScheduled(this.reason);

  final String reason;
}

/// Joining is still inside the configured window.
final class JoiningWindowOpen extends OperatingHoursWindow {
  const JoiningWindowOpen({
    required this.closesAt,
    required this.opensAt,
    required this.now,
  });

  /// The configured closing instant resolved against the device clock.
  final DateTime closesAt;

  /// The configured opening instant resolved against the device clock.
  final DateTime opensAt;

  /// The instant this window was resolved against.
  final DateTime now;

  /// Time left until the configured close, never negative.
  Duration get remaining => closesAt.difference(now);

  @override
  bool get hasCountdown => true;
}

/// The configured closing time has already passed today.
final class JoiningWindowClosedAfterClose extends OperatingHoursWindow {
  const JoiningWindowClosedAfterClose({
    required this.closedAt,
    required this.now,
  });

  final DateTime closedAt;
  final DateTime now;

  Duration get elapsed => now.difference(closedAt);

  @override
  bool get hasCountdown => true;
}

/// Resolves a service center's configured operating hours into a joining window.
///
/// Pure and clock-injected so the behaviour is testable and so the caller can
/// pin "now" instead of depending on wall time.
class OperatingHoursWindowResolver {
  const OperatingHoursWindowResolver._();

  /// Resolve the window for [now] from the center's raw `operatingHours`.
  ///
  /// Returns [JoiningWindowUnconfigured] when there is nothing authoritative to
  /// count down to. Never substitutes a default close time.
  static OperatingHoursWindow resolve(
    List<OperatingHoursDay>? hours,
    DateTime now,
  ) {
    if (hours == null || hours.isEmpty) return const JoiningWindowUnconfigured();

    final todayCode = OperatingHoursDay.codeFor(now);
    final matches = hours.where((h) => h.day == todayCode);
    if (matches.isEmpty) return const JoiningWindowUnconfigured();

    // A duplicated day entry is ambiguous data; refuse to guess.
    if (matches.length > 1) return const JoiningWindowUnconfigured();

    final entry = matches.first;
    if (entry.isClosed) {
      return JoiningWindowNotScheduled('This center is closed on ${_prettyDay(todayCode)}.');
    }

    final openMinutes = OperatingHoursDay.parseHhMm(entry.open);
    final closeMinutes = OperatingHoursDay.parseHhMm(entry.close);
    if (openMinutes == null || closeMinutes == null) {
      return const JoiningWindowNotScheduled(
        'This center has not published valid opening hours for today.',
      );
    }

    final midnight = DateTime(now.year, now.month, now.day);
    var closesAt = midnight.add(Duration(minutes: closeMinutes));
    final opensAt = midnight.add(Duration(minutes: openMinutes));

    // A close at or before the open time is an overnight window, so the
    // closing instant belongs to the following day.
    if (closeMinutes <= openMinutes) {
      closesAt = closesAt.add(const Duration(days: 1));
    }

    if (!now.isBefore(closesAt)) {
      return JoiningWindowClosedAfterClose(closedAt: closesAt, now: now);
    }
    return JoiningWindowOpen(closesAt: closesAt, opensAt: opensAt, now: now);
  }

  static String _prettyDay(String code) {
    const names = <String, String>{
      'MON': 'Mondays',
      'TUE': 'Tuesdays',
      'WED': 'Wednesdays',
      'THU': 'Thursdays',
      'FRI': 'Fridays',
      'SAT': 'Saturdays',
      'SUN': 'Sundays',
    };
    return names[code] ?? code;
  }
}

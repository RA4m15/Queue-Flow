import 'dart:async';
import 'dart:io';

import '../core/network/api_exception.dart';
import 'operating_hours.dart';
import 'service.dart';
import 'service_center.dart';

/// Everything the SCAN TO JOIN screen renders, and where each value came from.
///
/// Every field in this class is a value the backend actually returned. The
/// class deliberately distinguishes "the server said zero / none" from "the
/// server did not tell us", because those two must never look the same on a
/// queue-join screen:
///
///   * [waitingCount] is non-null only when `queue.waitingCount` was present.
///   * [estimatedWaitMinutes] is non-null only when the backend EWT engine
///     returned a number. It is never derived from waiting count × service
///     time, and never clamped away from a real value.
///   * [nowServingTokenCode] / [nextTokenCode] are non-null only when the
///     server actually returned those tokens.
///
/// [fetchedAt] lets the UI state freshness instead of presenting a stale
/// reading as current.
class JoinPreviewData {
  const JoinPreviewData({
    required this.center,
    required this.service,
    required this.fetchedAt,
    this.waitingCount,
    this.queueStatus,
    this.activeCount,
    this.activeCounters = const <ActiveCounterInfo>[],
    this.estimatedWaitMinutes,
    this.nowServingTokenCode,
    this.nextTokenCode,
  });

  /// The service center, from `GET /api/service-centers/:id`.
  final ServiceCenter center;

  /// The service, from `GET /api/services?centerId=…`.
  final Service service;

  /// When this snapshot was received. Drives the freshness indicator.
  final DateTime fetchedAt;

  /// `queue.waitingCount` — people currently waiting for this service.
  final int? waitingCount;

  /// `queue.status` — the backend's own queue state (OPEN / PAUSED / CLOSED).
  final String? queueStatus;

  /// `queue.activeCount` — counters currently serving this service.
  final int? activeCount;

  /// `activeCounters[]` from the queue endpoint.
  final List<ActiveCounterInfo> activeCounters;

  /// `estimatedWaitMinutes` — produced by the backend's context-aware EWT
  /// engine. Rendered as-is; never recomputed on the client.
  final int? estimatedWaitMinutes;

  /// `servingToken.tokenCode` (falls back to the first of `calledTokens`).
  final String? nowServingTokenCode;

  /// `waitingTokens[0].tokenCode` — the next token in the server's own order.
  final String? nextTokenCode;

  /// `activeCounters.length` when the endpoint returned the array.
  ///
  /// Distinct from [activeCount] (the Queue document's counter), which the
  /// backend maintains separately.
  int? get liveCounterCount =>
      activeCounters.isEmpty ? activeCount : activeCounters.length;

  /// How many people the customer would be behind if they joined now.
  ///
  /// This is the backend's [waitingCount] — the queue is first-come, first-served
  /// and no position is reserved before a token exists. The number therefore
  /// changes as the queue moves, and is re-read on every refresh and on every
  /// socket update.
  int? get peopleAhead => waitingCount;

  /// The resolved joining window from the center's configured hours.
  OperatingHoursWindow resolveWindow(DateTime now) =>
      center.resolveJoiningWindow(now);

  /// Whether the backend is currently accepting entries for this pair.
  ///
  /// Mirrors exactly what `queueService.joinQueue` checks and what the queue
  /// endpoint reports. Crowd level is intentionally excluded: the backend does
  /// not restrict joining by crowd, so this app must not either.
  bool get isServiceJoinable =>
      center.isOpen && service.isActive && (queueStatus == null || queueStatus == 'OPEN');

  factory JoinPreviewData.fromApi({
    required ServiceCenter center,
    required Service service,
    required Map<String, dynamic> queuePayload,
    DateTime? fetchedAt,
  }) {
    final queue = queuePayload['queue'];
    final queueMap = queue is Map ? Map<String, dynamic>.from(queue) : null;

    final waiting = (queueMap?['waitingCount'] as num?)?.toInt();
    final queueStatus = queueMap?['status']?.toString();

    // `servingToken` is the backend's single current callout; `calledTokens` is
    // the full CALLED/SERVING list. Prefer the explicit field.
    final serving = queuePayload['servingToken'];
    String? nowServing;
    if (serving is Map) {
      nowServing = (serving['_id'] == null && serving['tokenCode'] == null)
          ? null
          : serving['tokenCode']?.toString();
    }
    final called = queuePayload['calledTokens'];
    if (nowServing == null && called is List && called.isNotEmpty) {
      final first = called.first;
      if (first is Map) nowServing = first['tokenCode']?.toString();
    }

    // The endpoint returns the first 5 waiting tokens already ordered by
    // createdAt, so element 0 is genuinely the next one to be called.
    final waitingTokens = queuePayload['waitingTokens'];
    String? nextToken;
    if (waitingTokens is List && waitingTokens.isNotEmpty) {
      final first = waitingTokens.first;
      if (first is Map) nextToken = first['tokenCode']?.toString();
    }

    final counters = <ActiveCounterInfo>[];
    final rawCounters = queuePayload['activeCounters'];
    if (rawCounters is List) {
      for (final entry in rawCounters) {
        if (entry is Map) counters.add(ActiveCounterInfo.fromJson(Map<String, dynamic>.from(entry)));
      }
    }

    return JoinPreviewData(
      center: center,
      service: service,
      fetchedAt: fetchedAt ?? DateTime.now(),
      waitingCount: waiting,
      queueStatus: queueStatus,
      activeCount: (queueMap?['activeCount'] as num?)?.toInt(),
      activeCounters: List.unmodifiable(counters),
      estimatedWaitMinutes: (queuePayload['estimatedWaitMinutes'] as num?)?.toInt(),
      nowServingTokenCode: (nowServing != null && nowServing.isNotEmpty) ? nowServing : null,
      nextTokenCode: (nextToken != null && nextToken.isNotEmpty) ? nextToken : null,
    );
  }
}

/// One counter the backend reported as ACTIVE for this service.
class ActiveCounterInfo {
  const ActiveCounterInfo({
    required this.id,
    this.label,
    this.number,
    this.currentTokenCode,
  });

  final String id;
  final String? label;
  final int? number;
  final String? currentTokenCode;

  factory ActiveCounterInfo.fromJson(Map<String, dynamic> json) {
    return ActiveCounterInfo(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      label: (json['displayLabel'] ?? json['name'])?.toString(),
      number: (json['number'] as num?)?.toInt(),
      currentTokenCode: json['currentToken']?.toString(),
    );
  }
}

/// The failure modes a SCAN TO JOIN load can end in.
///
/// Each one maps to a distinct, truthful UI state (Step 16) instead of a
/// single generic error.
sealed class JoinPreviewFailure {
  const JoinPreviewFailure();
}

/// The center in the QR does not exist (HTTP 404 / "not found").
final class JoinPreviewInvalidCenter extends JoinPreviewFailure {
  const JoinPreviewInvalidCenter(this.message);

  final String message;
}

/// The service in the QR does not exist, or does not belong to this center.
final class JoinPreviewInvalidService extends JoinPreviewFailure {
  const JoinPreviewInvalidService(this.message);

  final String message;
}

/// The service exists but the backend has it deactivated.
final class JoinPreviewServiceInactive extends JoinPreviewFailure {
  const JoinPreviewServiceInactive(this.service);

  final Service service;
}

/// The center is administratively closed — the backend refuses joins.
final class JoinPreviewCenterClosed extends JoinPreviewFailure {
  const JoinPreviewCenterClosed(this.center);

  final ServiceCenter center;
}

/// No services are published for this center.
final class JoinPreviewNoServices extends JoinPreviewFailure {
  const JoinPreviewNoServices(this.center);

  final ServiceCenter center;
}

/// The request never reached the backend.
final class JoinPreviewNetworkError extends JoinPreviewFailure {
  const JoinPreviewNetworkError(this.message, {this.isSocketIssue = false});

  final String message;

  /// Whether the transport failed at the socket layer.
  ///
  /// Carried explicitly rather than sniffed out of [message]: the message shown
  /// to the customer is deliberately free of exception text, so a predicate that
  /// searched it could only ever answer false.
  final bool isSocketIssue;
}

/// A preview was requested without naming a service.
///
/// Not a bug: it is the center-only QR, where the backend has no single queue
/// to show and the customer has to choose a service first. Signalling it
/// explicitly keeps it from being reported as a generic load failure.
final class JoinPreviewNoServiceSelected extends JoinPreviewFailure {
  const JoinPreviewNoServiceSelected();
}

/// Any other backend or transport failure.
final class JoinPreviewUnexpectedError extends JoinPreviewFailure {
  const JoinPreviewUnexpectedError(this.message);

  final String message;
}

/// Classifies a thrown error from a join-preview load.
///
/// Kept separate from the loading code so the mapping is testable on its own
/// and so no screen has to re-derive it.
JoinPreviewFailure classifyJoinPreviewError(Object error) {
  if (error is JoinPreviewFailure) return error;

  if (error is ApiException) {
    final code = error.code?.toUpperCase();
    if (code == 'ACTIVE_TOKEN_EXISTS') {
      // Reported separately by the join action, not the preview load.
      return JoinPreviewUnexpectedError(error.message);
    }
    if (error.statusCode == 404) {
      // The backend's own wording for a missing center is "Service center not
      // found", which contains the substring "service". Center wording has to be
      // tested first or a missing center is reported as a bad service.
      final message = error.message.toLowerCase();
      if (message.contains('center') || message.contains('centre')) {
        return JoinPreviewInvalidCenter(error.message);
      }
      if (message.contains('service')) {
        return JoinPreviewInvalidService(error.message);
      }
      return JoinPreviewInvalidCenter(error.message);
    }
    if (error.statusCode == 400 || error.statusCode == 403) {
      // Matched against the backend's own wording in `queueService.joinQueue`,
      // not a loose substring: `not currently available` also appears in
      // phrasings that have nothing to do with the service, and turning a
      // "queue paused" refusal into "you picked the wrong service" would send
      // the customer back to the service list for no reason.
      final message = error.message.toLowerCase();
      if (message.contains('service is not currently available') ||
          message.contains('does not belong to this service center')) {
        return JoinPreviewInvalidService(error.message);
      }
      // Anything else the backend refuses — a closed centre, a paused queue, a
      // Document Gate block — is reported in its own words. The preview load
      // already decides those cases from `center.isOpen`, `queue.status` and
      // the gate verdict, so a refusal arriving here has no state of its own to
      // render and must not be paraphrased into one.
      return JoinPreviewUnexpectedError(error.message);
    }
    if (error.statusCode == null) {
      return JoinPreviewNetworkError(error.message);
    }
    return JoinPreviewUnexpectedError(error.message);
  }

  if (error is SocketException) {
    return JoinPreviewNetworkError(
      'QueueFlow could not reach the service center. Check your connection and try again.',
      isSocketIssue: true,
    );
  }
  if (error is TimeoutException) {
    return JoinPreviewNetworkError(
      'The service center took too long to respond. Please try again.',
    );
  }
  return JoinPreviewUnexpectedError(ApiException.getUserMessage(error));
}

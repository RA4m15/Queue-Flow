import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/constants/api_constants.dart';
import '../models/join_preview_data.dart';
import '../models/queue_status.dart';
import '../models/service.dart';
import '../models/service_center.dart';
import '../services/api_service.dart';
import 'app_providers.dart';

/// Identifies one join-preview load: a center, and optionally one of its
/// services.
///
/// Value-equal so Riverpod's family cache treats two equal requests as one.
@immutable
class JoinPreviewRequest {
  const JoinPreviewRequest({required this.centerId, this.serviceId});

  final String centerId;
  final String? serviceId;

  bool get hasService => serviceId != null && serviceId!.isNotEmpty;

  @override
  bool operator ==(Object other) =>
      other is JoinPreviewRequest &&
      other.centerId == centerId &&
      other.serviceId == serviceId;

  @override
  int get hashCode => Object.hash(centerId, serviceId);

  @override
  String toString() =>
      'JoinPreviewRequest(centerId: $centerId, serviceId: $serviceId)';
}

// ─── Live queue / crowd refresh signal ───────────────────────────────────────

/// Turns the app's existing Socket.IO `queue.updated`, `crowd.updated` and
/// `counter.updated` events into a signal that open join previews should re-read
/// the backend.
///
/// It deliberately adds no new socket, no new room protocol and no second
/// transport: this wraps the same [SocketService] instance every other live
/// screen already uses. And it deliberately re-fetches rather than patching
/// values out of the event payload — the event says *something* changed, the
/// REST snapshot remains the single source of truth.
class JoinQueueLiveRefresh extends ChangeNotifier {
  JoinQueueLiveRefresh(this._socket);

  final dynamic _socket;

  /// Which centers currently have an open join screen, with ref counts, so a
  /// second screen on the same center is not torn down by the first closing.
  final Map<String, int> _watchedCenters = <String, int>{};

  final List<({String event, dynamic Function(dynamic) handler})> _handlers =
      <({String event, dynamic Function(dynamic) handler})>[];
  VoidCallback? _onConnect;
  bool _attached = false;

  /// Centers currently being watched. Exposed for tests.
  @visibleForTesting
  Set<String> get watchedCenters => _watchedCenters.keys.toSet();

  /// How many times live previews have been asked to refresh.
  @visibleForTesting
  int refreshCount = 0;

  void _attach() {
    if (_attached) return;
    _attached = true;

    for (final event in const [
      ApiConstants.eventQueueUpdated,
      ApiConstants.eventCrowdUpdated,
      ApiConstants.eventCounterUpdated,
    ]) {
      void handler(dynamic _) => tick();
      _socket.on(event, handler);
      _handlers.add((event: event, handler: handler));
    }

    // A reconnect means the snapshot on screen may be arbitrarily old.
    _onConnect = tick;
    _socket.addConnectListener(_onConnect!);
  }

  /// Watch [centerId] for live updates; run the returned function to stop.
  VoidCallback watchCenter(String centerId) {
    _attach();
    _socket.joinCenter(centerId);
    _watchedCenters[centerId] = (_watchedCenters[centerId] ?? 0) + 1;
    var released = false;
    return () {
      if (released) return;
      released = true;
      final count = (_watchedCenters[centerId] ?? 1) - 1;
      if (count <= 0) {
        _watchedCenters.remove(centerId);
        _socket.leaveCenter(centerId);
      } else {
        _watchedCenters[centerId] = count;
      }
    };
  }

  /// Signal every open join screen to re-read the backend.
  void tick() {
    if (_watchedCenters.isEmpty) return;
    refreshCount++;
    notifyListeners();
  }

  @override
  void dispose() {
    for (final entry in _handlers) {
      _socket.off(entry.event, entry.handler);
    }
    _handlers.clear();
    final onConnect = _onConnect;
    if (onConnect != null) _socket.removeConnectListener(onConnect);
    _onConnect = null;
    super.dispose();
  }
}

/// App-lifetime, so it is never auto-disposed: the socket listeners it owns live
/// exactly as long as the [SocketService] they are registered on.
///
/// Note there is deliberately no `ref.onDispose(notifier.dispose)` here.
/// `ChangeNotifierProvider` already disposes the notifier it created, and calling
/// `dispose()` a second time throws
/// "A JoinQueueLiveRefresh was used after being disposed" — which only surfaces
/// when the whole provider container is torn down, so it is easy to miss.
final joinQueueLiveRefreshProvider =
    ChangeNotifierProvider<JoinQueueLiveRefresh>(
      (ref) => JoinQueueLiveRefresh(ref.watch(socketServiceProvider)),
    );

// ─── Service selection (center-only QR) ──────────────────────────────────────

/// A service plus the live queue numbers the backend reports for it.
class JoinServiceOption {
  const JoinServiceOption({
    required this.service,
    this.waitingCount,
    this.estimatedWaitMinutes,
  });

  final Service service;

  /// `queues[].waitingCount` from `GET /api/queue/:centerId`, or null when the
  /// backend has no Queue document for this service yet.
  final int? waitingCount;

  /// `queues[].estimatedWaitMinutes` — the same backend EWT engine the preview
  /// uses. Never recomputed here.
  final int? estimatedWaitMinutes;
}

/// Center + its active services + each service's live queue numbers.
class JoinServiceSelection {
  const JoinServiceSelection({
    required this.center,
    required this.options,
    required this.fetchedAt,
  });

  final ServiceCenter center;
  final List<JoinServiceOption> options;
  final DateTime fetchedAt;
}

final joinServiceSelectionProvider =
    FutureProvider.autoDispose.family<JoinServiceSelection, String>((
  ref,
  centerId,
) async {
  // Same live signal: a queue update must refresh the selection list too.
  ref.watch(joinQueueLiveRefreshProvider);
  final notifier = ref.watch(joinQueueLiveRefreshProvider.notifier);
  final release = notifier.watchCenter(centerId);
  ref.onDispose(release);

  final api = ref.watch(apiServiceProvider);
  return loadJoinServiceSelection(api, centerId);
});

/// Loads the service list for a center-only QR.
Future<JoinServiceSelection> loadJoinServiceSelection(
  ApiService api,
  String centerId,
) async {
  final centerDetail = await api.getServiceCenterDetail(centerId);
  final center = centerDetail['center'] as ServiceCenter;
  final services = await api.getServices(centerId);

  // Queue numbers for the whole center in one call, then indexed by service.
  Map<String, QueueStatus> byService = <String, QueueStatus>{};
  try {
    final queues = await api.getQueueStatus(centerId);
    for (final q in queues) {
      byService[q.serviceId] = q;
    }
  } catch (_) {
    // Queue numbers are supplementary. A center whose queue feed is
    // unavailable must still let the customer pick a service, with the
    // unavailable state shown honestly rather than as "0 waiting".
  }

  final options = services
      .map(
        (s) => JoinServiceOption(
          service: s,
          waitingCount: byService[s.id]?.waitingCount,
          estimatedWaitMinutes: byService[s.id]?.estimatedWaitMinutes,
        ),
      )
      .toList(growable: false);

  return JoinServiceSelection(
    center: center,
    options: options,
    fetchedAt: DateTime.now(),
  );
}

// ─── Service preview (center + service QR) ───────────────────────────────────

final joinPreviewProvider =
    FutureProvider.autoDispose.family<JoinPreviewData, JoinPreviewRequest>((
  ref,
  request,
) async {
  ref.watch(joinQueueLiveRefreshProvider);
  final notifier = ref.watch(joinQueueLiveRefreshProvider.notifier);
  final release = notifier.watchCenter(request.centerId);
  ref.onDispose(release);

  final api = ref.watch(apiServiceProvider);
  return loadJoinPreview(api, request);
});

/// Resolves one service preview from the backend.
///
/// The order matters and is deliberate:
///
///   1. the center, so a QR naming a center that does not exist fails here;
///   2. the center's active service list, so a QR naming a service that does not
///      belong to this center — or one that has been deactivated — fails here;
///   3. only then the live queue snapshot.
///
/// Every value that reaches the screen came from one of those three responses.
Future<JoinPreviewData> loadJoinPreview(
  ApiService api,
  JoinPreviewRequest request,
) async {
  if (!request.hasService) {
    throw const JoinPreviewNoServiceSelected();
  }

  final centerDetail = await api.getServiceCenterDetail(request.centerId);
  final center = centerDetail['center'] as ServiceCenter;

  // `GET /api/service-centers/:id` returns the center alone. The service list
  // lives behind `GET /api/services?centerId=…`, which the backend filters to
  // `isActive: true` — so an inactive service is reported as unavailable rather
  // than being silently joined.
  final services = await api.getServices(request.centerId);

  final matched = _findService(services, request.serviceId!);
  if (matched == null) {
    throw JoinPreviewInvalidService(
      'This service is not available at ${center.name}. '
      'It may have been removed or transferred.',
    );
  }
  if (!matched.isActive) {
    throw JoinPreviewServiceInactive(matched);
  }
  if (!center.isOpen) {
    throw JoinPreviewCenterClosed(center);
  }

  final queuePayload = await api.getServiceQueue(center.id, matched.id);
  return JoinPreviewData.fromApi(
    center: center,
    service: matched,
    queuePayload: queuePayload,
  );
}

/// The service named by [serviceId] in the backend's own list for this centre.
Service? _findService(List<Service> services, String serviceId) {
  for (final s in services) {
    if (s.id == serviceId) return s;
  }
  return null;
}

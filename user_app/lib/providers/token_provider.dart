import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/constants/api_constants.dart';
import '../core/network/api_exception.dart';
import '../models/token.dart';
import '../services/api_service.dart';
import '../services/location_service.dart';
import '../services/proximity_heartbeat.dart';
import '../services/socket_service.dart';
import '../services/storage_service.dart';
import 'app_providers.dart';

class TokenState {
  const TokenState({
    this.activeToken,
    this.isLoading = false,
    this.isRefreshing = false,
    this.error,
    this.isCached = false,
    this.cachedAt,
    this.connectionStatus = 'NO_DATA',
    this.turnAlert,
    this.geofenceAlert,
    this.skipNotice,
    this.locationVerdict,
  });

  final TokenModel? activeToken;
  final bool isLoading;
  final bool isRefreshing;
  final String? error;
  final bool isCached;
  final DateTime? cachedAt;
  final String connectionStatus; // 'LIVE', 'RECONNECTING', 'OFFLINE_LAST_KNOWN', 'STALE', 'NO_DATA'
  final String? turnAlert;

  /// Phase 2: the backend's "your turn is approaching, stay in the service
  /// area" warning, delivered through the existing notification path.
  final String? geofenceAlert;

  /// Phase 2: the truthful explanation shown when this token was auto-skipped
  /// for leaving the service area. Never auto-cleared into a live token.
  final String? skipNotice;

  /// Phase 2: the most recent backend location verdict for the live token.
  /// Null means "not known yet", which is never the same as "in range".
  final ProximityVerdict? locationVerdict;

  bool get isLive => connectionStatus == 'LIVE';
  bool get isOffline => connectionStatus == 'OFFLINE_LAST_KNOWN';
  bool get isReconnecting => connectionStatus == 'RECONNECTING';

  TokenState copyWith({
    TokenModel? activeToken,
    bool clearActiveToken = false,
    bool? isLoading,
    bool? isRefreshing,
    String? error,
    bool? isCached,
    DateTime? cachedAt,
    bool clearCachedAt = false,
    String? connectionStatus,
    String? turnAlert,
    bool clearTurnAlert = false,
    String? geofenceAlert,
    bool clearGeofenceAlert = false,
    String? skipNotice,
    bool clearSkipNotice = false,
    ProximityVerdict? locationVerdict,
    bool clearLocationVerdict = false,
  }) {
    return TokenState(
      activeToken: clearActiveToken ? null : (activeToken ?? this.activeToken),
      isLoading: isLoading ?? this.isLoading,
      isRefreshing: isRefreshing ?? this.isRefreshing,
      error: error,
      isCached: isCached ?? this.isCached,
      cachedAt: clearCachedAt ? null : (cachedAt ?? this.cachedAt),
      connectionStatus: connectionStatus ?? this.connectionStatus,
      turnAlert: clearTurnAlert ? null : (turnAlert ?? this.turnAlert),
      geofenceAlert: clearGeofenceAlert ? null : (geofenceAlert ?? this.geofenceAlert),
      skipNotice: clearSkipNotice ? null : (skipNotice ?? this.skipNotice),
      locationVerdict: clearLocationVerdict ? null : (locationVerdict ?? this.locationVerdict),
    );
  }
}

class TokenNotifier extends StateNotifier<TokenState> {
  TokenNotifier({
    required this.apiService,
    required this.socketService,
    this.storageService,
    LocationService? locationService,
  }) : super(const TokenState()) {
    // Phase 2 location heartbeat. Built in the body (not a field initializer)
    // so it can close over this notifier's own API calls. It is null when no
    // location service is injected, which is how unit tests opt out of GPS.
    if (locationService != null) {
      _heartbeat = ProximityHeartbeat(
        locationService: locationService,
        upload: _shareLocation,
        onVerdict: _applyVerdict,
      );
    }
    _initSocketListeners();
    _initNetworkListener();
  }

  final ApiService apiService;
  final SocketService socketService;
  final StorageService? storageService;

  /// Phase 2 heartbeat. Null in tests that inject no location service, which
  /// is why every call site is null-guarded.
  ProximityHeartbeat? _heartbeat;

  /// True only while a widget that needs live location is mounted. See
  /// [claimHeartbeat].
  bool _heartbeatClaimed = false;

  StreamSubscription<bool>? _networkSub;

  /// Handlers registered on the shared [SocketService], so they can be
  /// detached on dispose instead of outliving this notifier.
  final List<({String event, dynamic Function(dynamic) handler})> _socketHandlers = [];
  VoidCallback? _onConnect;
  VoidCallback? _onDisconnect;

  /// Registers a socket event handler and remembers it for cleanup.
  void _onSocket(String event, dynamic Function(dynamic) handler) {
    socketService.on(event, handler);
    _socketHandlers.add((event: event, handler: handler));
  }

  /// Detaches every handler this notifier registered, so no callback can
  /// touch state after [dispose].
  void _detachSocket() {
    for (final entry in _socketHandlers) {
      socketService.off(entry.event, entry.handler);
    }
    _socketHandlers.clear();
    final onConnect = _onConnect;
    if (onConnect != null) socketService.removeConnectListener(onConnect);
    final onDisconnect = _onDisconnect;
    if (onDisconnect != null) socketService.removeDisconnectListener(onDisconnect);
    _onConnect = null;
    _onDisconnect = null;
  }

  /// Reflect real backend reachability into the connection status so the UI
  /// never claims to be live while the backend is unreachable.
  void _initNetworkListener() {
    _networkSub = apiService.networkStatus.onStatusChange.listen((online) {
      if (state.activeToken == null && !state.isCached) return;
      if (online) {
        // Reachability restored: never assume cached state is still correct.
        state = state.copyWith(connectionStatus: 'RECONNECTING');
        fetchActiveToken(silent: true);
      } else {
        state = state.copyWith(
          connectionStatus: 'OFFLINE_LAST_KNOWN',
          isCached: true,
        );
      }
    });
  }

  @override
  void dispose() {
    // Phase 2: stop sharing location before the notifier goes away, so a
    // disposed provider can never fire another GPS or network call.
    _heartbeatClaimed = false;
    _heartbeat?.stop();
    _networkSub?.cancel();
    _detachSocket();
    super.dispose();
  }

  // ── Phase 2 geofence heartbeat ───────────────────────────────────────────

  /// Uploads one reading through the existing Phase 1 geofence endpoint.
  ///
  /// Returns the backend's verdict verbatim. Never throws: a failed share
  /// leaves the previous reading in place, which the backend ages into
  /// LOCATION_STALE and then blocks on, rather than skipping anyone.
  Future<Map<String, dynamic>?> _shareLocation(UserLocation location) async {
    final token = state.activeToken;
    if (token == null || !token.isActive) return null;
    return apiService.shareTokenLocation(
      tokenId: token.id,
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy,
      timestamp: location.timestamp,
    );
  }

  /// Adopts a backend verdict. The client never derives in-range status; it
  /// only relays what the server said, and never reports "in range" for a
  /// stale or unavailable location.
  void _applyVerdict(ProximityVerdict verdict) {
    final token = state.activeToken;
    if (token == null || !token.isActive) return;

    state = state.copyWith(locationVerdict: verdict);
    if (verdict.isOutOfRange) {
      // Set the model field too, so every surface that reads the token (rather
      // than this notifier's state) shows the same authoritative status.
      state = state.copyWith(activeToken: token.copyWith(locationStatus: verdict.locationStatus));
    }
  }

  /// Arms or disarms the heartbeat to match the authoritative token state.
  ///
  /// Only ever acts while the live-token screen has claimed the heartbeat (see
  /// [claimHeartbeat]). Two reasons for that split:
  ///
  ///  - Correctness: a token being active is not a reason to drain the GPS for
  ///    a customer who is browsing the home screen. Location is only needed
  ///    while someone is looking at their queue position.
  ///  - Lifecycle: the timer is then owned by a widget, so navigating away
  ///    cancels it deterministically instead of leaving a stray loop running.
  void _syncHeartbeat() {
    final heartbeat = _heartbeat;
    if (heartbeat == null || !_heartbeatClaimed) return;

    final token = state.activeToken;
    if (token == null || !token.isActive) {
      heartbeat.stop();
      if (state.locationVerdict != null) {
        Future.microtask(() {
          if (mounted) {
            state = state.copyWith(clearLocationVerdict: true);
          }
        });
      }
      return;
    }

    if (heartbeat.isRunning) {
      heartbeat.updatePosition(token.peopleAhead);
    } else {
      heartbeat.start(peopleAhead: token.peopleAhead);
    }
  }

  /// Called when the live-token screen mounts: this is where location sharing
  /// begins, and only if the customer actually holds an active token.
  void claimHeartbeat() {
    if (_heartbeat == null) return;
    _heartbeatClaimed = true;
    _syncHeartbeat();
  }

  /// Called when the live-token screen unmounts. Stops sharing location
  /// immediately, so a customer who leaves the screen stops being tracked.
  void releaseHeartbeat() {
    _heartbeatClaimed = false;
    _heartbeat?.stop();
    if (state.locationVerdict != null) {
      Future.microtask(() {
        if (mounted) {
          state = state.copyWith(clearLocationVerdict: true);
        }
      });
    }
  }

  /// The Phase 2 "your turn is approaching" warning.
  ///
  /// The copy is authored by the backend (so the warning, the push
  /// notification and the in-app banner can never disagree) and arrives on the
  /// existing notification stream. The backend only sends it to customers it
  /// has positively placed outside the joining radius, so a customer who is
  /// already in range is never warned.
  void showGeofenceAlert(String message) {
    final token = state.activeToken;
    if (token == null || !token.isActive) return;
    if (message.trim().isEmpty) return;
    state = state.copyWith(geofenceAlert: message.trim());
  }

  void dismissGeofenceAlert() {
    state = state.copyWith(clearGeofenceAlert: true);
  }

  void dismissSkipNotice() {
    state = state.copyWith(clearSkipNotice: true);
  }

  Future<String?> _getCurrentUserId() async {
    if (socketService.currentUserId != null && socketService.currentUserId!.isNotEmpty) {
      return socketService.currentUserId;
    }
    if (storageService != null) {
      final data = await storageService!.getUserData();
      return data['id'];
    }
    return null;
  }

  void _initSocketListeners() {
    // 0. Connection status listeners
    _onConnect = () {
      if (state.activeToken != null || state.isCached) {
        // ALWAYS revalidate authoritative backend state on reconnect
        fetchActiveToken(silent: true);
      } else {
        state = state.copyWith(connectionStatus: 'LIVE');
      }
    };
    socketService.addConnectListener(_onConnect!);

    _onDisconnect = () {
      if (state.activeToken != null) {
        state = state.copyWith(connectionStatus: 'RECONNECTING');
      }
    };
    socketService.addDisconnectListener(_onDisconnect!);

    // 1. Authoritative queue updates: when any queue change occurs, re-sync from server
    _onSocket(ApiConstants.eventQueueUpdated, (data) {
      if (state.activeToken != null) {
        fetchActiveToken(silent: true);
      }
    });

    // 2. Token created
    _onSocket(ApiConstants.eventTokenCreated, (data) async {
      if (data is Map && data.containsKey('token')) {
        final created = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        final myUserId = await _getCurrentUserId();
        if (myUserId == null || myUserId.isEmpty || created.userId.isEmpty || created.userId != myUserId) {
          return;
        }
        final now = DateTime.now();
        state = state.copyWith(
          activeToken: created,
          isCached: false,
          cachedAt: now,
          connectionStatus: 'LIVE',
        );
        final uid = await _getCurrentUserId();
        storageService?.setCachedToken(created, uid);
        _syncHeartbeat();
      }
    });

    // 3. Token called
    _onSocket(ApiConstants.eventTokenCalled, (data) async {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          final now = DateTime.now();
          final counterLabel = updated.counterName ?? 'the counter';
          state = state.copyWith(
            activeToken: updated,
            isCached: false,
            cachedAt: now,
            connectionStatus: 'LIVE',
            turnAlert: "It's your turn! Please proceed to $counterLabel.",
          );
          final uid = await _getCurrentUserId();
          storageService?.setCachedToken(updated, uid);
          _syncHeartbeat();
        }
      }
    });

    // 4. Token serving
    _onSocket(ApiConstants.eventTokenServing, (data) async {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          final now = DateTime.now();
          state = state.copyWith(
            activeToken: updated,
            isCached: false,
            cachedAt: now,
            connectionStatus: 'LIVE',
          );
          final uid = await _getCurrentUserId();
          storageService?.setCachedToken(updated, uid);
          _syncHeartbeat();
        }
      }
    });

    // 5. Token completed
    _onSocket(ApiConstants.eventTokenCompleted, (data) async {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(
            activeToken: updated,
            isCached: false,
            connectionStatus: 'LIVE',
          );
          final uid = await _getCurrentUserId();
          storageService?.clearCachedToken(uid);
          _syncHeartbeat();
        }
      }
    });

    // 6. Token skipped
    _onSocket(ApiConstants.eventTokenSkipped, (data) async {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          // Phase 2: a geofence auto-skip carries its own reason, so the
          // customer is told the truth about why. The token is never
          // auto-resurrected: it stays skipped until the customer deliberately
          // rejoins through the existing rejoin path.
          final reason = (data['skipReason'] ?? updated.skipReason)?.toString().toUpperCase();
          final isOutOfRangeSkip = reason == 'OUT_OF_RANGE' || updated.isSkippedOutOfRange;

          state = state.copyWith(
            activeToken: updated,
            isCached: false,
            connectionStatus: 'LIVE',
            clearTurnAlert: true,
            clearGeofenceAlert: true,
            skipNotice: isOutOfRangeSkip
                ? (updated.outOfRangeSkipMessage ??
                    'Your token was skipped because you were outside the service area. '
                        'You can rejoin the queue from the app.')
                : null,
            clearSkipNotice: !isOutOfRangeSkip,
          );
          final uid = await _getCurrentUserId();
          storageService?.clearCachedToken(uid);
          // A skipped token is not active, so this stops the heartbeat. No
          // further location is shared for a customer who is no longer queued.
          _syncHeartbeat();
        }
      }
    });

    // 7. Token cancelled
    _onSocket(ApiConstants.eventTokenCancelled, (data) async {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(
            activeToken: updated,
            isCached: false,
            connectionStatus: 'LIVE',
          );
          final uid = await _getCurrentUserId();
          storageService?.clearCachedToken(uid);
          _syncHeartbeat();
        }
      }
    });

    // 8. Token expired
    _onSocket(ApiConstants.eventTokenExpired, (data) async {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(
            activeToken: updated,
            isCached: false,
            connectionStatus: 'LIVE',
          );
          final uid = await _getCurrentUserId();
          storageService?.clearCachedToken(uid);
          _syncHeartbeat();
        }
      }
    });

    // 9. Token live position/wait re-estimation
    _onSocket(ApiConstants.eventTokenPositionUpdated, (data) async {
      if (data is Map) {
        final tokenId = (data['tokenId'] ?? '').toString();
        final position = (data['currentPosition'] as num?)?.toInt();
        final wait = data['waitEstimateMinutes'] != null
            ? (data['waitEstimateMinutes'] as num?)?.toInt()
            : null;
        final servingToken = data['servingToken']?.toString();
        final active = state.activeToken;
        if (tokenId.isEmpty || active == null || active.id != tokenId || position == null) {
          return;
        }
        final updated = active.copyWith(
          currentPosition: position,
          waitEstimateMinutes: wait,
          servingToken: servingToken ?? active.servingToken,
        );
        state = state.copyWith(
          activeToken: updated,
          isCached: false,
          cachedAt: DateTime.now(),
          connectionStatus: 'LIVE',
        );
        final uid = await _getCurrentUserId();
        storageService?.setCachedToken(updated, uid);
      }
    });

    // 10. Proximity update (Ghost Queue — backend-authoritative geofence state)
    _onSocket(ApiConstants.eventTokenProximity, (data) async {
      if (data is Map) {
        final tokenId = (data['tokenId'] ?? '').toString();
        final active = state.activeToken;
        if (tokenId.isEmpty || active == null || active.id != tokenId) {
          return;
        }
        // Phase 2: adopt the backend's own locationStatus too, so the app
        // never has to re-derive in-range from the older proximity band.
        final locationStatus = data['locationStatus']?.toString();
        final updated = active.copyWith(
          proximityState: data['proximityState']?.toString() ?? active.proximityState,
          proximityDistanceMeters: (data['distanceMeters'] as num?)?.toInt() ?? active.proximityDistanceMeters,
          proximityUpdatedAt: DateTime.now(),
          locationStatus: locationStatus ?? active.locationStatus,
        );
        state = state.copyWith(
          activeToken: updated,
          isCached: false,
          cachedAt: DateTime.now(),
          connectionStatus: 'LIVE',
          locationVerdict: locationStatus != null
              ? ProximityVerdict.fromJson({
                  'locationStatus': locationStatus,
                  'distanceMeters': updated.proximityDistanceMeters,
                })
              : null,
        );
        final uid = await _getCurrentUserId();
        storageService?.setCachedToken(updated, uid);
      }
    });

    // 11. Phase 2 approaching warning, carried on the existing notification
    // stream. The backend authors the copy and de-duplicates per token, and it
    // only warns customers it has positively placed outside the radius, so
    // this handler never has to guess whether a warning is warranted.
    _onSocket(ApiConstants.eventNotificationCreated, (data) {
      if (data is! Map) return;
      final type = (data['type'] ?? '').toString().toUpperCase();
      if (type != 'TURN_APPROACHING_RETURN' && type != 'TURN_IMMINENT_RETURN') return;
      final body = (data['body'] ?? '').toString();
      if (body.trim().isNotEmpty) showGeofenceAlert(body);
    });
  }

  Future<void> fetchActiveToken({bool silent = false}) async {
    if (state.isLoading) return;
    if (!silent) {
      state = state.copyWith(isLoading: true, error: null);
    } else {
      state = state.copyWith(isRefreshing: true, error: null);
    }

    final userId = await _getCurrentUserId();

    try {
      final token = await apiService.getActiveToken();
      if (token != null) {
        socketService.joinCenter(token.centerId);
        final now = DateTime.now();
        await storageService?.setCachedToken(token, userId);
        state = state.copyWith(
          activeToken: token,
          clearActiveToken: false,
          isCached: false,
          cachedAt: now,
          connectionStatus: 'LIVE',
          isLoading: false,
          isRefreshing: false,
        );
      } else {
        await storageService?.clearCachedToken(userId);
        state = state.copyWith(
          clearActiveToken: true,
          isCached: false,
          clearCachedAt: true,
          connectionStatus: 'NO_DATA',
          isLoading: false,
          isRefreshing: false,
        );
      }
    } catch (e) {
      // Transport failure: present the last server-confirmed state, clearly
      // marked as offline rather than live.
      if (apiService.isOffline) {
        final cachedEnv = await storageService?.getCachedTokenEnvelope(userId);
        if (cachedEnv != null && !cachedEnv.isExpired) {
          state = state.copyWith(
            activeToken: cachedEnv.token,
            isCached: true,
            cachedAt: cachedEnv.cachedAt,
            connectionStatus: 'OFFLINE_LAST_KNOWN',
            isLoading: false,
            isRefreshing: false,
            error: null,
          );
        } else {
          state = state.copyWith(
            clearActiveToken: true,
            isCached: false,
            clearCachedAt: true,
            connectionStatus: 'NO_DATA',
            isLoading: false,
            isRefreshing: false,
            error: ApiException.getUserMessage(e),
          );
        }
        return;
      }

      // The server answered but rejected the request (auth, server error...).
      // Never present cached data as if it were authoritative.
      state = state.copyWith(
        isLoading: false,
        isRefreshing: false,
        error: ApiException.getUserMessage(e),
      );
    }
  }

  Future<TokenModel> joinQueue({
    required String centerId,
    required String serviceId,
    bool notifyApp = true,
    bool notifySms = false,
    double? latitude,
    double? longitude,
    double? accuracy,
    DateTime? timestamp,
  }) async {
    // Authoritative mutations are refused while the backend is unreachable.
    // Never generate a local token and never fake a successful join.
    apiService.networkStatus.requireOnline();

    if (state.isLoading) {
      throw ApiException(message: 'A queue operation is already in progress.');
    }
    state = state.copyWith(isLoading: true, error: null);

    try {
      final token = await apiService.joinQueue(
        centerId: centerId,
        serviceId: serviceId,
        notifyApp: notifyApp,
        notifySms: notifySms,
        latitude: latitude,
        longitude: longitude,
        accuracy: accuracy,
        timestamp: timestamp,
      );
      socketService.joinCenter(centerId);
      final now = DateTime.now();
      final uid = await _getCurrentUserId();
      await storageService?.setCachedToken(token, uid);

      state = state.copyWith(
        activeToken: token,
        isCached: false,
        cachedAt: now,
        connectionStatus: 'LIVE',
        isLoading: false,
      );
      return token;
    } catch (e) {
      final msg = ApiException.getUserMessage(e);
      state = state.copyWith(isLoading: false, error: msg);
      rethrow;
    } finally {
      // Sync heartbeat state after fetch (and also on normal transitions).
      _syncHeartbeat();
    }
  }

  Future<void> cancelToken(String tokenId) async {
    // Offline cancellations are never simulated.
    apiService.networkStatus.requireOnline();

    if (state.isLoading) return;
    state = state.copyWith(isLoading: true, error: null);

    try {
      final updated = await apiService.cancelToken(tokenId);
      final uid = await _getCurrentUserId();
      await storageService?.clearCachedToken(uid);
      state = state.copyWith(
        activeToken: updated,
        isCached: false,
        connectionStatus: 'LIVE',
        isLoading: false,
      );
    } catch (e) {
      final msg = ApiException.getUserMessage(e);
      state = state.copyWith(isLoading: false, error: msg);
      rethrow;
    } finally {
      // Sync heartbeat state after fetch (and also on normal transitions).
      _syncHeartbeat();
    }
  }

  Future<void> submitFeedback({required String tokenId, required int rating, String? comment}) async {
    // Offline feedback is never queued for blind replay.
    apiService.networkStatus.requireOnline();

    try {
      final updated = await apiService.submitFeedback(
        tokenId: tokenId,
        rating: rating,
        comment: comment,
      );
      state = state.copyWith(activeToken: updated);
    } catch (e) {
      state = state.copyWith(error: ApiException.getUserMessage(e));
      rethrow;
    }
  }

  void dismissTurnAlert() {
    state = state.copyWith(clearTurnAlert: true);
  }

  void clearActiveToken() {
    state = state.copyWith(clearActiveToken: true, isCached: false, clearCachedAt: true, error: null);
  }

  void reset() {
    state = const TokenState();
  }
}

final tokenProvider = StateNotifierProvider<TokenNotifier, TokenState>((ref) {
  final apiService = ref.watch(apiServiceProvider);
  final socketService = ref.watch(socketServiceProvider);
  final storageService = ref.watch(storageServiceProvider);
  // The Phase 2 heartbeat reuses the same LocationService the join geofence
  // already uses, so there is exactly one place in the app that talks to the
  // device's GPS.
  final locationService = ref.watch(locationServiceProvider);

  return TokenNotifier(
    apiService: apiService,
    socketService: socketService,
    storageService: storageService,
    locationService: locationService,
  );
});

// History Provider
final tokenHistoryProvider = FutureProvider.autoDispose<List<TokenModel>>((ref) async {
  final apiService = ref.watch(apiServiceProvider);
  return await apiService.getMyTokens(page: 1, limit: 30);
});

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/constants/api_constants.dart';
import '../core/network/api_exception.dart';
import '../models/token.dart';
import '../services/api_service.dart';
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
  });

  final TokenModel? activeToken;
  final bool isLoading;
  final bool isRefreshing;
  final String? error;
  final bool isCached;
  final DateTime? cachedAt;
  final String connectionStatus; // 'LIVE', 'RECONNECTING', 'OFFLINE_LAST_KNOWN', 'STALE', 'NO_DATA'
  final String? turnAlert;

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
    );
  }
}

class TokenNotifier extends StateNotifier<TokenState> {
  TokenNotifier({
    required this.apiService,
    required this.socketService,
    this.storageService,
  }) : super(const TokenState()) {
    _initSocketListeners();
    _initNetworkListener();
  }

  final ApiService apiService;
  final SocketService socketService;
  final StorageService? storageService;

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
    _networkSub?.cancel();
    _detachSocket();
    super.dispose();
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
          state = state.copyWith(
            activeToken: updated,
            isCached: false,
            connectionStatus: 'LIVE',
          );
          final uid = await _getCurrentUserId();
          storageService?.clearCachedToken(uid);
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
        final updated = active.copyWith(
          proximityState: data['proximityState']?.toString() ?? active.proximityState,
          proximityDistanceMeters: (data['distanceMeters'] as num?)?.toInt() ?? active.proximityDistanceMeters,
          proximityUpdatedAt: DateTime.now(),
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

  return TokenNotifier(
    apiService: apiService,
    socketService: socketService,
    storageService: storageService,
  );
});

// History Provider
final tokenHistoryProvider = FutureProvider.autoDispose<List<TokenModel>>((ref) async {
  final apiService = ref.watch(apiServiceProvider);
  return await apiService.getMyTokens(page: 1, limit: 30);
});

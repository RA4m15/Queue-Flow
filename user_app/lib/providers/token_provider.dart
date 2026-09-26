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
    this.error,
  });

  final TokenModel? activeToken;
  final bool isLoading;
  final String? error;

  TokenState copyWith({
    TokenModel? activeToken,
    bool clearActiveToken = false,
    bool? isLoading,
    String? error,
  }) {
    return TokenState(
      activeToken: clearActiveToken ? null : (activeToken ?? this.activeToken),
      isLoading: isLoading ?? this.isLoading,
      error: error,
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
  }

  final ApiService apiService;
  final SocketService socketService;
  final StorageService? storageService;

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
    // 1. Authoritative queue updates: when any queue change occurs, re-sync from server
    socketService.on(ApiConstants.eventQueueUpdated, (data) {
      if (state.activeToken != null) {
        // Re-sync with authoritative server state rather than calculating client-side
        fetchActiveToken();
      }
    });

    // 2. Token created
    socketService.on(ApiConstants.eventTokenCreated, (data) async {
      if (data is Map && data.containsKey('token')) {
        final created = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        final myUserId = await _getCurrentUserId();
        if (myUserId == null || myUserId.isEmpty || created.userId.isEmpty || created.userId != myUserId) {
          return;
        }
        state = state.copyWith(activeToken: created);
      }
    });

    // 3. Token called
    socketService.on(ApiConstants.eventTokenCalled, (data) {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(activeToken: updated);
        }
      }
    });

    // 4. Token serving
    socketService.on(ApiConstants.eventTokenServing, (data) {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(activeToken: updated);
        }
      }
    });

    // 5. Token completed
    socketService.on(ApiConstants.eventTokenCompleted, (data) {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(activeToken: updated);
        }
      }
    });

    // 6. Token skipped
    socketService.on(ApiConstants.eventTokenSkipped, (data) {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(activeToken: updated);
        }
      }
    });

    // 7. Token cancelled
    socketService.on(ApiConstants.eventTokenCancelled, (data) {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(activeToken: updated);
        }
      }
    });

    // 8. Token expired
    socketService.on(ApiConstants.eventTokenExpired, (data) {
      if (data is Map && data.containsKey('token')) {
        final updated = TokenModel.fromJson(data['token'] as Map<String, dynamic>);
        if (state.activeToken != null &&
            state.activeToken!.id == updated.id &&
            (updated.userId.isEmpty || updated.userId == state.activeToken!.userId)) {
          state = state.copyWith(activeToken: updated);
        }
      }
    });

    // 9. Token live position/wait re-estimation for a waiting token.
    // Backend payload (private user room): { tokenId, currentPosition, waitEstimateMinutes }
    socketService.on(ApiConstants.eventTokenPositionUpdated, (data) {
      if (data is Map) {
        final tokenId = (data['tokenId'] ?? '').toString();
        final position = (data['currentPosition'] as num?)?.toInt();
        final wait = data['waitEstimateMinutes'] != null
            ? (data['waitEstimateMinutes'] as num?)?.toInt()
            : null;
        final active = state.activeToken;
        if (tokenId.isEmpty || active == null || active.id != tokenId || position == null) {
          return;
        }
        state = state.copyWith(
          activeToken: active.copyWith(
            currentPosition: position,
            waitEstimateMinutes: wait,
          ),
        );
      }
    });
  }

  Future<void> fetchActiveToken() async {
    if (state.isLoading) return;
    state = state.copyWith(isLoading: true, error: null);
    try {
      final token = await apiService.getActiveToken();
      if (token != null) {
        socketService.joinCenter(token.centerId);
      }
      state = state.copyWith(
        activeToken: token,
        clearActiveToken: token == null,
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
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
      state = state.copyWith(
        activeToken: token,
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
    if (state.isLoading) return;
    state = state.copyWith(isLoading: true, error: null);

    try {
      final updated = await apiService.cancelToken(tokenId);
      state = state.copyWith(
        activeToken: updated,
        isLoading: false,
      );
    } catch (e) {
      final msg = ApiException.getUserMessage(e);
      state = state.copyWith(isLoading: false, error: msg);
      rethrow;
    }
  }

  Future<void> submitFeedback({required String tokenId, required int rating, String? comment}) async {
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

  void clearActiveToken() {
    state = state.copyWith(clearActiveToken: true, error: null);
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

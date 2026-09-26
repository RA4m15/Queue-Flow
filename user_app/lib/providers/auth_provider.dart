import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/network/api_exception.dart';
import '../models/user.dart';
import '../services/api_service.dart';
import '../services/storage_service.dart';
import '../services/socket_service.dart';
import 'app_providers.dart';
import 'token_provider.dart';
import 'notification_provider.dart';

class AuthState {
  const AuthState({
    this.isLoading = false,
    this.isAuthenticated = false,
    this.user,
    this.errorMessage,
  });

  final bool isLoading;
  final bool isAuthenticated;
  final AppUser? user;
  final String? errorMessage;

  AuthState copyWith({
    bool? isLoading,
    bool? isAuthenticated,
    AppUser? user,
    String? errorMessage,
  }) {
    return AuthState(
      isLoading: isLoading ?? this.isLoading,
      isAuthenticated: isAuthenticated ?? this.isAuthenticated,
      user: user ?? this.user,
      errorMessage: errorMessage,
    );
  }
}

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier({
    required this.apiService,
    required this.storageService,
    required this.socketService,
    this.onLogout,
  }) : super(const AuthState(isLoading: true)) {
    checkAuthStatus();
  }

  final ApiService apiService;
  final StorageService storageService;
  final SocketService socketService;
  final void Function()? onLogout;

  Future<void> checkAuthStatus() async {
    debugPrint('[Startup] AUTH_INIT_START');
    state = state.copyWith(isLoading: true, errorMessage: null);

    try {
      debugPrint('[Startup] STORAGE_READ_START');
      final hasToken = await storageService.hasToken();
      debugPrint('[Startup] STORAGE_READ_COMPLETE: hasToken=$hasToken');

      if (!hasToken) {
        debugPrint('[Startup] TOKEN_ABSENT');
        state = const AuthState(isLoading: false, isAuthenticated: false);
        debugPrint('[Startup] AUTH_INIT_COMPLETE (unauthenticated, no token)');
        return;
      }

      debugPrint('[Startup] TOKEN_PRESENT');
      final cachedData = await storageService.getUserData();
      final cachedToken = await storageService.getAuthToken();

      try {
        debugPrint('[Startup] AUTH_ME_REQUEST_START');
        final user = await apiService.getCurrentUser();
        debugPrint('[Startup] AUTH_ME_RESPONSE: user_role=${user.role}');

        if (!user.isCustomer) {
          debugPrint('[Startup] AUTH_ME_NON_CUSTOMER');
          await storageService.clearAuth();
          socketService.disconnect(clearListeners: true);
          onLogout?.call();
          state = const AuthState(
            isLoading: false,
            isAuthenticated: false,
            errorMessage: 'This app is for customers only. Please use the Admin Panel.',
          );
          debugPrint('[Startup] AUTH_INIT_COMPLETE (non-customer rejected)');
          return;
        }

        await storageService.saveUserData(
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        );

        socketService.connect(userId: user.id, token: cachedToken);

        state = AuthState(
          isLoading: false,
          isAuthenticated: true,
          user: user,
        );
        debugPrint('[Startup] AUTH_INIT_COMPLETE (authenticated)');
      } catch (e) {
        final isExplicitAuthRejection = (e is ApiException && (e.statusCode == 401 || e.statusCode == 403));
        if (isExplicitAuthRejection) {
          debugPrint('[Startup] AUTH_ME_401 (statusCode=${e.statusCode})');
          await storageService.clearAuth();
          socketService.disconnect(clearListeners: true);
          onLogout?.call();
          state = const AuthState(
            isLoading: false,
            isAuthenticated: false,
            errorMessage: 'Your session has expired. Please sign in again.',
          );
        } else {
          debugPrint('[Startup] AUTH_ME_NETWORK_ERROR: ${e.runtimeType}');
          if (cachedData['id'] != null && cachedData['email'] != null) {
            final cachedUser = AppUser(
              id: cachedData['id']!,
              name: cachedData['name'] ?? '',
              email: cachedData['email']!,
              role: cachedData['role'] ?? 'customer',
            );
            socketService.connect(userId: cachedUser.id, token: cachedToken);
            state = AuthState(
              isLoading: false,
              isAuthenticated: true,
              user: cachedUser,
              errorMessage: 'Working offline: unable to reach QueueFlow server.',
            );
          } else {
            state = AuthState(
              isLoading: false,
              isAuthenticated: false,
              errorMessage: ApiException.getUserMessage(e),
            );
          }
        }
        debugPrint('[Startup] AUTH_INIT_COMPLETE (after error recovery)');
      }
    } catch (outerError) {
      debugPrint('[Startup] AUTH_INIT_ERROR: ${outerError.runtimeType} -> $outerError');
      state = AuthState(
        isLoading: false,
        isAuthenticated: false,
        errorMessage: ApiException.getUserMessage(outerError),
      );
      debugPrint('[Startup] AUTH_INIT_COMPLETE (after outer crash)');
    } finally {
      if (state.isLoading) {
        state = state.copyWith(isLoading: false);
      }
      debugPrint('[Startup] AUTH_STATE = isLoading=${state.isLoading}, isAuth=${state.isAuthenticated}');
    }
  }

  Future<bool> login({required String email, required String password}) async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final result = await apiService.login(email: email, password: password);
      final user = result['user'] as AppUser;
      final token = result['token'] as String;

      if (!user.isCustomer) {
        try {
          await storageService.clearAuth();
        } catch (_) {}
        state = state.copyWith(
          isLoading: false,
          errorMessage: 'This application is restricted to customer accounts only.',
        );
        return false;
      }

      try {
        await storageService.saveAuthToken(token);
        await storageService.saveUserData(
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        );
      } catch (_) {}

      try {
        socketService.connect(userId: user.id, token: token);
      } catch (_) {}

      state = AuthState(
        isLoading: false,
        isAuthenticated: true,
        user: user,
      );
      return true;
    } catch (e) {
      final msg = ApiException.getUserMessage(e);
      state = state.copyWith(isLoading: false, errorMessage: msg);
      return false;
    } finally {
      if (state.isLoading) {
        state = state.copyWith(isLoading: false);
      }
    }
  }

  Future<bool> register({
    required String name,
    required String email,
    required String password,
    String? phone,
  }) async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final result = await apiService.register(
        name: name,
        email: email,
        password: password,
        phone: phone,
      );
      final user = result['user'] as AppUser;
      final token = result['token'] as String;

      if (!user.isCustomer) {
        try {
          await storageService.clearAuth();
        } catch (_) {}
        state = state.copyWith(
          isLoading: false,
          isAuthenticated: false,
          errorMessage: 'This application is restricted to customer accounts only.',
        );
        return false;
      }

      try {
        await storageService.saveAuthToken(token);
        await storageService.saveUserData(
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        );
      } catch (_) {}

      try {
        socketService.connect(userId: user.id, token: token);
      } catch (_) {}

      state = AuthState(
        isLoading: false,
        isAuthenticated: true,
        user: user,
      );
      return true;
    } catch (e) {
      try {
        await storageService.clearAuth();
      } catch (_) {}
      final msg = ApiException.getUserMessage(e);
      state = state.copyWith(
        isLoading: false,
        isAuthenticated: false,
        errorMessage: msg,
      );
      return false;
    } finally {
      if (state.isLoading) {
        state = state.copyWith(isLoading: false);
      }
    }
  }

  Future<void> updateProfile({String? name, String? phone}) async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final updated = await apiService.updateProfile(name: name, phone: phone);
      state = state.copyWith(isLoading: false, user: updated);
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        errorMessage: ApiException.getUserMessage(e),
      );
    }
  }

  void handleUnauthorized() {
    storageService.clearAuth();
    socketService.disconnect(clearListeners: true);
    onLogout?.call();
    state = const AuthState(
      isLoading: false,
      isAuthenticated: false,
      user: null,
      errorMessage: 'Your session has expired. Please sign in again.',
    );
  }

  Future<void> logout() async {
    state = state.copyWith(isLoading: true);
    try {
      await apiService.logout();
    } catch (_) {
      // Best-effort remote revocation; local session MUST be cleared regardless
    } finally {
      await storageService.clearAuth();
      socketService.disconnect(clearListeners: true);
      onLogout?.call();
      state = const AuthState(
        isLoading: false,
        isAuthenticated: false,
        user: null,
      );
    }
  }
}

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  final apiService = ref.watch(apiServiceProvider);
  final storageService = ref.watch(storageServiceProvider);
  final socketService = ref.watch(socketServiceProvider);
  final dioClient = ref.watch(dioClientProvider);

  final notifier = AuthNotifier(
    apiService: apiService,
    storageService: storageService,
    socketService: socketService,
    onLogout: () {
      ref.read(tokenProvider.notifier).reset();
      ref.read(notificationsProvider.notifier).reset();
    },
  );

  dioClient.onUnauthorized = () {
    notifier.handleUnauthorized();
  };

  return notifier;
});

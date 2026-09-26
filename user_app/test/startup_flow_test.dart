import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/models/user.dart';
import 'package:user_app/services/api_service.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/services/storage_service.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:dio/dio.dart';

class _FakeStartupStorageService extends StorageService {
  final Map<String, String> _data = {};
  bool throwOnRead = false;
  Duration readDelay = Duration.zero;

  @override
  Future<void> saveAuthToken(String token) async {
    _data['auth_token'] = token;
  }

  @override
  Future<String?> getAuthToken() async {
    if (throwOnRead) throw Exception('Simulated storage failure');
    if (readDelay > Duration.zero) await Future<void>.delayed(readDelay);
    return _data['auth_token'];
  }

  @override
  Future<void> saveUserData({
    required String id,
    required String name,
    required String email,
    required String role,
  }) async {
    _data['user_id'] = id;
    _data['user_name'] = name;
    _data['user_email'] = email;
    _data['user_role'] = role;
  }

  @override
  Future<Map<String, String?>> getUserData() async => {
        'id': _data['user_id'],
        'name': _data['user_name'],
        'email': _data['user_email'],
        'role': _data['user_role'],
      };

  @override
  Future<void> clearAuth() async => _data.clear();

  @override
  Future<bool> hasToken() async {
    if (throwOnRead) throw Exception('Simulated storage failure');
    if (readDelay > Duration.zero) await Future<void>.delayed(readDelay);
    return _data.containsKey('auth_token') && _data['auth_token']!.isNotEmpty;
  }
}

class _MockStartupApiService extends ApiService {
  _MockStartupApiService(super.dio, {this.onGetCurrentUser});

  final Future<AppUser> Function()? onGetCurrentUser;

  @override
  Future<AppUser> getCurrentUser() async {
    if (onGetCurrentUser != null) {
      return onGetCurrentUser!();
    }
    return super.getCurrentUser();
  }
}

void main() {
  group('Startup Flow & Splash Resilience Unit Tests', () {
    late _FakeStartupStorageService storage;
    late SocketService socket;

    setUp(() {
      storage = _FakeStartupStorageService();
      socket = SocketService();
    });

    test('1. No token -> reaches terminal unauthenticated state (not loading)', () async {
      final mockApi = _MockStartupApiService(Dio());
      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );

      // Constructor triggers checkAuthStatus()
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.user, isNull);
    });

    test('2. Valid stored token -> reaches terminal authenticated state with user profile', () async {
      await storage.saveAuthToken('valid-persisted-jwt-123');
      final mockApi = _MockStartupApiService(
        Dio(),
        onGetCurrentUser: () async => const AppUser(
          id: '507f1f77bcf86cd799439011',
          name: 'Jane Customer',
          email: 'jane@example.com',
          role: 'CUSTOMER',
        ),
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isTrue);
      expect(notifier.state.user?.name, 'Jane Customer');
      expect(notifier.state.user?.isCustomer, isTrue);
    });

    test('3. Expired/revoked token (401) -> clears local auth and terminates in unauthenticated state', () async {
      await storage.saveAuthToken('expired-revoked-token');
      final mockApi = _MockStartupApiService(
        Dio(),
        onGetCurrentUser: () async => throw ApiException(
          message: 'Your session has expired or is invalid. Please sign in again.',
          statusCode: 401,
        ),
      );

      bool loggedOut = false;
      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
        onLogout: () => loggedOut = true,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(await storage.hasToken(), isFalse);
      expect(loggedOut, isTrue);
    });

    test('4. Non-customer role on /auth/me -> rejected, cleared, terminates in unauthenticated state', () async {
      await storage.saveAuthToken('admin-token-xyz');
      final mockApi = _MockStartupApiService(
        Dio(),
        onGetCurrentUser: () async => const AppUser(
          id: '507f1f77bcf86cd799439099',
          name: 'Admin Boss',
          email: 'admin@example.com',
          role: 'ADMIN',
        ),
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.errorMessage, contains('customers only'));
      expect(await storage.hasToken(), isFalse);
    });

    test('5. Network failure with cached profile -> terminates in working offline state (preserves session)', () async {
      await storage.saveAuthToken('offline-user-token');
      await storage.saveUserData(
        id: '507f1f77bcf86cd799439001',
        name: 'Offline Jane',
        email: 'offline@example.com',
        role: 'CUSTOMER',
      );

      final mockApi = _MockStartupApiService(
        Dio(),
        onGetCurrentUser: () async => throw ApiException(
          message: 'Unable to connect to QueueFlow server.',
          statusCode: null,
        ),
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isTrue);
      expect(notifier.state.user?.name, 'Offline Jane');
      expect(notifier.state.errorMessage, contains('Working offline'));
      expect(await storage.hasToken(), isTrue);
    });

    test('6. Storage read exception on startup -> handled gracefully without hanging in loading', () async {
      storage.throwOnRead = true; // Simulates storage failure / permission error
      final mockApi = _MockStartupApiService(Dio());

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.errorMessage, isNotNull);
    });

    test('7. Malformed /auth/me response -> handled safely with terminal unauthenticated state', () async {
      await storage.saveAuthToken('token-with-bad-response');
      final mockApi = _MockStartupApiService(
        Dio(),
        onGetCurrentUser: () async => throw const FormatException('Corrupted backend JSON'),
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
    });

    test('8. Guaranteed termination: isLoading is NEVER permanently true', () async {
      final mockApi = _MockStartupApiService(Dio());
      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );

      expect(notifier.state.isLoading, isTrue);
      await notifier.checkAuthStatus();
      expect(notifier.state.isLoading, isFalse);
    });
  });
}

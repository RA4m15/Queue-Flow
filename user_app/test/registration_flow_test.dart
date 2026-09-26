import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/models/user.dart';
import 'package:user_app/services/api_service.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/services/storage_service.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:dio/dio.dart';

class _FakeStorageService extends StorageService {
  final Map<String, String> _data = {};
  bool throwOnWrite = false;

  @override
  Future<void> saveAuthToken(String token) async {
    if (throwOnWrite) throw Exception('Simulated SecureStorage write failure');
    _data['auth_token'] = token;
  }

  @override
  Future<String?> getAuthToken() async => _data['auth_token'];

  @override
  Future<void> saveUserData({
    required String id,
    required String name,
    required String email,
    required String role,
  }) async {
    if (throwOnWrite) throw Exception('Simulated SecureStorage write failure');
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
  Future<bool> hasToken() async => _data.containsKey('auth_token') && _data['auth_token']!.isNotEmpty;
}

class _MockRegistrationApiService extends ApiService {
  _MockRegistrationApiService(
    super.dio, {
    this.onRegister,
  });

  final Future<Map<String, dynamic>> Function({
    required String name,
    required String email,
    required String password,
    String? phone,
  })? onRegister;

  @override
  Future<Map<String, dynamic>> register({
    required String name,
    required String email,
    required String password,
    String? phone,
  }) async {
    if (onRegister != null) {
      return onRegister!(
        name: name,
        email: email,
        password: password,
        phone: phone,
      );
    }
    return super.register(
      name: name,
      email: email,
      password: password,
      phone: phone,
    );
  }
}

void main() {
  group('Registration Flow & Resilience Unit Tests', () {
    late _FakeStorageService storage;
    late SocketService socket;

    setUp(() {
      storage = _FakeStorageService();
      socket = SocketService();
    });

    test('1. Successful registration: loading starts and stops, state authenticated', () async {
      final mockApi = _MockRegistrationApiService(
        Dio(),
        onRegister: ({required name, required email, required password, phone}) async {
          return {
            'user': const AppUser(
              id: '507f1f77bcf86cd799439011',
              name: 'John Doe',
              email: 'john@example.com',
              role: 'CUSTOMER',
            ),
            'token': 'mock-jwt-token-12345',
          };
        },
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );

      expect(notifier.state.isLoading, isTrue); // Initial checkAuthStatus
      await Future<void>.delayed(Duration.zero);
      expect(notifier.state.isLoading, isFalse);

      final success = await notifier.register(
        name: 'John Doe',
        email: 'john@example.com',
        password: 'ValidPassword1',
      );

      expect(success, isTrue);
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isTrue);
      expect(notifier.state.user?.name, 'John Doe');
      expect(notifier.state.errorMessage, isNull);
      expect(await storage.getAuthToken(), 'mock-jwt-token-12345');
    });

    test('2. Duplicate email (HTTP 409): loading stops, error visible, not authenticated', () async {
      final mockApi = _MockRegistrationApiService(
        Dio(),
        onRegister: ({required name, required email, required password, phone}) async {
          throw ApiException(
            message: 'An account with this email already exists',
            statusCode: 409,
          );
        },
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );
      await Future<void>.delayed(Duration.zero);

      final success = await notifier.register(
        name: 'Existing User',
        email: 'existing@example.com',
        password: 'ValidPassword1',
      );

      expect(success, isFalse);
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.user, isNull);
      expect(notifier.state.errorMessage, contains('already exists'));
    });

    test('3. Invalid email (HTTP 400): loading stops, validation error visible', () async {
      final mockApi = _MockRegistrationApiService(
        Dio(),
        onRegister: ({required name, required email, required password, phone}) async {
          throw ApiException(
            message: 'Valid email is required',
            statusCode: 400,
          );
        },
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );
      await Future<void>.delayed(Duration.zero);

      final success = await notifier.register(
        name: 'User',
        email: 'notanemail',
        password: 'ValidPassword1',
      );

      expect(success, isFalse);
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.errorMessage, contains('email is required'));
    });

    test('4. Weak/invalid password: client-side pre-validation rejects before network call', () async {
      final apiService = ApiService(Dio());

      expect(
        () => apiService.register(
          name: 'Jane Doe',
          email: 'jane@example.com',
          password: 'short',
        ),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('at least 8 characters'))),
      );

      expect(
        () => apiService.register(
          name: 'Jane Doe',
          email: 'jane@example.com',
          password: 'alllowercase123',
        ),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('uppercase, lowercase, and a number'))),
      );
    });

    test('5. Network failure (connection error): loading stops, friendly network error shown', () async {
      final mockApi = _MockRegistrationApiService(
        Dio(),
        onRegister: ({required name, required email, required password, phone}) async {
          throw ApiException(
            message: 'Unable to connect to QueueFlow server. Please check your internet connection.',
          );
        },
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );
      await Future<void>.delayed(Duration.zero);

      final success = await notifier.register(
        name: 'Offline User',
        email: 'offline@example.com',
        password: 'ValidPassword1',
      );

      expect(success, isFalse);
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.errorMessage, contains('internet connection'));
    });

    test('6. Network timeout (Render cold-start or slow connection): loading stops, timeout error shown', () async {
      final mockApi = _MockRegistrationApiService(
        Dio(),
        onRegister: ({required name, required email, required password, phone}) async {
          throw ApiException(
            message: 'Unable to connect to QueueFlow server. Please check your internet connection.',
            statusCode: null,
          );
        },
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );
      await Future<void>.delayed(Duration.zero);

      final success = await notifier.register(
        name: 'Slow User',
        email: 'slow@example.com',
        password: 'ValidPassword1',
      );

      expect(success, isFalse);
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.errorMessage, isNotNull);
    });

    test('7. Malformed backend response: loading stops gracefully with visible error', () async {
      final mockApi = _MockRegistrationApiService(
        Dio(),
        onRegister: ({required name, required email, required password, phone}) async {
          throw const FormatException('Unexpected character in JSON');
        },
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );
      await Future<void>.delayed(Duration.zero);

      final success = await notifier.register(
        name: 'Malformed Test',
        email: 'malformed@example.com',
        password: 'ValidPassword1',
      );

      expect(success, isFalse);
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.errorMessage, isNotNull);
    });

    test('8. Backend 500 server error: loading stops and shows safe server error message', () async {
      final mockApi = _MockRegistrationApiService(
        Dio(),
        onRegister: ({required name, required email, required password, phone}) async {
          throw ApiException(
            message: 'The QueueFlow server is temporarily unavailable. Please try again in a moment.',
            statusCode: 500,
          );
        },
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );
      await Future<void>.delayed(Duration.zero);

      final success = await notifier.register(
        name: 'Server Error User',
        email: 'error500@example.com',
        password: 'ValidPassword1',
      );

      expect(success, isFalse);
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.errorMessage, contains('temporarily unavailable'));
    });

    test('9. Storage exception during token save: loading stops and state is recovered', () async {
      storage.throwOnWrite = true; // Simulates storage failure
      final mockApi = _MockRegistrationApiService(
        Dio(),
        onRegister: ({required name, required email, required password, phone}) async {
          return {
            'user': const AppUser(
              id: '507f1f77bcf86cd799439011',
              name: 'Storage Fail User',
              email: 'storagefail@example.com',
              role: 'CUSTOMER',
            ),
            'token': 'mock-jwt-token-12345',
          };
        },
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socket,
      );
      await Future<void>.delayed(Duration.zero);

      final success = await notifier.register(
        name: 'Storage Fail User',
        email: 'storagefail@example.com',
        password: 'ValidPassword1',
      );

      // Even if storage fails on writing, loading must complete!
      expect(notifier.state.isLoading, isFalse);
      expect(success, isTrue);
    });
  });
}

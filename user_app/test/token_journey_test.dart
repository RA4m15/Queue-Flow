import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/constants/api_constants.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/models/user.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/services/api_service.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/services/storage_service.dart';

void main() {
  group('Token journey — live queue operations', () {
    const centerId = '507f1f77bcf86cd799439011';
    const serviceId = '507f1f77bcf86cd799439022';
    const customerA = '507f1f77bcf86cd799439001';

    test('joinQueue success stores server-issued token and clears loading', () async {
      final api = _FakeApiService(Dio());
      final socket = SocketService();
      final notifier = TokenNotifier(apiService: api, socketService: socket);

      final token = await notifier.joinQueue(centerId: centerId, serviceId: serviceId);

      expect(api.joinQueueCalls, 1);
      expect(token.tokenNumber, greaterThan(0));
      expect(notifier.state.activeToken?.id, equals(token.id));
      expect(notifier.state.activeToken?.status, equals('WAITING'));
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.error, isNull);
    });

    test('joinQueue 409 ACTIVE_TOKEN_EXISTS surfaces user-safe error with code intact', () async {
      final api = _FakeApiService(Dio())..failJoinWithActiveExists = true;
      final socket = SocketService();
      final notifier = TokenNotifier(apiService: api, socketService: socket);

      await expectLater(
        notifier.joinQueue(centerId: centerId, serviceId: serviceId),
        throwsA(
          isA<ApiException>()
              .having((e) => e.code, 'code', 'ACTIVE_TOKEN_EXISTS')
              .having((e) => e.statusCode, 'statusCode', 409),
        ),
      );

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.error, contains('active token'));
      expect(notifier.state.activeToken, isNull);
    });

    test('fetchActiveToken with no active token clears stale server state', () async {
      final api = _FakeApiService(Dio());
      final socket = SocketService();
      final notifier = TokenNotifier(apiService: api, socketService: socket);

      // First fetch populates an active token from the authoritative server
      await notifier.fetchActiveToken();
      expect(notifier.state.activeToken, isNotNull);
      expect(api.fetchActiveCalls, 1);

      // Server later reports no active token -> stale state must be cleared
      api.activeTokenNull = true;
      await notifier.fetchActiveToken();
      expect(notifier.state.activeToken, isNull);
      expect(api.fetchActiveCalls, 2);
    });

    test('token.position_updated updates live position/wait for matching token only', () async {
      final api = _FakeApiService(Dio());
      final socket = SocketService();
      final notifier = TokenNotifier(apiService: api, socketService: socket);

      await notifier.fetchActiveToken();
      final myTokenId = notifier.state.activeToken!.id;
      expect(notifier.state.activeToken?.currentPosition, isNull);

      // Valid position update for our token is applied live
      socket.handleEventForTesting(ApiConstants.eventTokenPositionUpdated, {
        'tokenId': myTokenId,
        'currentPosition': 2,
        'waitEstimateMinutes': 10,
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(notifier.state.activeToken?.currentPosition, 2);
      expect(notifier.state.activeToken?.waitEstimateMinutes, 10);

      // Position update for a DIFFERENT token must be ignored entirely
      socket.handleEventForTesting(ApiConstants.eventTokenPositionUpdated, {
        'tokenId': '507f1f77bcf86cd799439999',
        'currentPosition': 99,
        'waitEstimateMinutes': 999,
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(notifier.state.activeToken?.currentPosition, 2);
      expect(notifier.state.activeToken?.waitEstimateMinutes, 10);

      // Update without a position value must not jump-clamp to zero
      socket.handleEventForTesting(ApiConstants.eventTokenPositionUpdated, {
        'tokenId': myTokenId,
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(notifier.state.activeToken?.currentPosition, 2);
      expect(notifier.state.activeToken?.waitEstimateMinutes, 10);
    });

    test('queue.updated triggers authoritative re-sync from server', () async {
      final api = _FakeApiService(Dio());
      final socket = SocketService();
      final notifier = TokenNotifier(apiService: api, socketService: socket);

      await notifier.fetchActiveToken();
      final callsBefore = api.fetchActiveCalls;

      socket.handleEventForTesting(ApiConstants.eventQueueUpdated, {'queue': {}});
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(api.fetchActiveCalls, callsBefore + 1);
    });

    test('cancelToken applies server-issued cancelled state', () async {
      final api = _FakeApiService(Dio());
      final socket = SocketService();
      final notifier = TokenNotifier(apiService: api, socketService: socket);

      await notifier.fetchActiveToken();
      await notifier.cancelToken(notifier.state.activeToken!.id);

      expect(notifier.state.activeToken?.status, equals('CANCELLED'));
      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.error, isNull);
    });

    test('AuthNotifier.logout clears storage session, socket and auth state', () async {
      final storage = _TestStorageService();
      await storage.saveAuthToken('test-token');
      await storage.saveUserData(
        id: customerA,
        name: 'Customer A',
        email: 'a@example.com',
        role: 'CUSTOMER',
      );

      final socket = SocketService();
      bool loggedOut = false;
      final api = _AuthApiService(Dio());
      final notifier = AuthNotifier(
        apiService: api,
        storageService: storage,
        socketService: socket,
        onLogout: () => loggedOut = true,
      );

      await notifier.checkAuthStatus();
      expect(notifier.state.isAuthenticated, isTrue);
      expect(notifier.state.user?.name, 'Customer A');
      expect(socket.currentUserId, equals(customerA));

      await notifier.logout();

      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.user, isNull);
      expect(await storage.hasToken(), isFalse);
      expect(socket.currentUserId, isNull);
      expect(loggedOut, isTrue);
      expect(api.logoutCalled, isTrue);
    });
  });
}

// ── Test Doubles ──────────────────────────────────────────────────────────────

const _tokenId = '507f1f77bcf86cd799439111';

TokenModel _waitingToken({String status = 'WAITING'}) {
  return TokenModel(
    id: _tokenId,
    tokenCode: 'A-007',
    tokenNumber: 7,
    userId: '507f1f77bcf86cd799439001',
    centerId: '507f1f77bcf86cd799439011',
    serviceId: '507f1f77bcf86cd799439022',
    status: status,
  );
}

class _FakeApiService extends ApiService {
  _FakeApiService(super.dio);

  int joinQueueCalls = 0;
  int fetchActiveCalls = 0;
  bool failJoinWithActiveExists = false;
  bool activeTokenNull = false;

  @override
  Future<TokenModel> joinQueue({
    required String centerId,
    required String serviceId,
    bool notifyApp = true,
    bool notifySms = false,
  }) async {
    joinQueueCalls++;
    if (failJoinWithActiveExists) {
      throw ApiException(
        message: 'You already have an active token for this queue.',
        statusCode: 409,
        code: 'ACTIVE_TOKEN_EXISTS',
      );
    }
    return _waitingToken();
  }

  @override
  Future<TokenModel?> getActiveToken() async {
    fetchActiveCalls++;
    if (activeTokenNull) return null;
    return _waitingToken();
  }

  @override
  Future<TokenModel> cancelToken(String tokenId) async {
    return _waitingToken(status: 'CANCELLED');
  }
}

class _AuthApiService extends ApiService {
  _AuthApiService(super.dio);

  bool logoutCalled = false;

  @override
  Future<AppUser> getCurrentUser() async {
    return const AppUser(
      id: '507f1f77bcf86cd799439001',
      name: 'Customer A',
      email: 'a@example.com',
      role: 'CUSTOMER',
    );
  }

  @override
  Future<void> logout() async {
    logoutCalled = true;
  }
}

class _TestStorageService extends StorageService {
  final Map<String, String> _data = {};

  @override
  Future<void> saveAuthToken(String token) async => _data['auth_token'] = token;

  @override
  Future<String?> getAuthToken() async => _data['auth_token'];

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
  Future<bool> hasToken() async => _data.containsKey('auth_token') && _data['auth_token']!.isNotEmpty;
}
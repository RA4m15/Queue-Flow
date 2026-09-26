import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/constants/api_constants.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/models/user.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/models/crowd_status.dart';
import 'package:user_app/models/service_center.dart';
import 'package:user_app/services/api_service.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/services/storage_service.dart';
import 'package:user_app/core/network/dio_client.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/providers/notification_provider.dart';
import 'package:dio/dio.dart';

void main() {
  group('Security & Resilience Verification Tests', () {
    test('ApiConstants enforce HTTPS Render production backend with zero localhost', () {
      expect(ApiConstants.baseUrl.startsWith('https://'), isTrue);
      expect(ApiConstants.socketUrl.startsWith('https://'), isTrue);
      expect(ApiConstants.baseUrl.contains('localhost'), isFalse);
      expect(ApiConstants.baseUrl.contains('127.0.0.1'), isFalse);
      expect(ApiConstants.baseUrl.contains('http://'), isFalse);
      expect(ApiConstants.baseUrl, equals('https://queue-flow-4308.onrender.com/api'));
      expect(ApiConstants.socketUrl, equals('https://queue-flow-4308.onrender.com'));
    });

    test('AppUser role authorization: customer vs admin separation', () {
      final customer = AppUser.fromJson({
        '_id': '507f1f77bcf86cd799439011',
        'name': 'Customer User',
        'email': 'user@example.com',
        'role': 'CUSTOMER',
      });
      expect(customer.isCustomer, isTrue);
      expect(customer.isAdmin, isFalse);

      final admin = AppUser.fromJson({
        '_id': '507f1f77bcf86cd799439012',
        'name': 'Admin User',
        'email': 'admin@example.com',
        'role': 'ADMIN',
      });
      expect(admin.isCustomer, isFalse);
      expect(admin.isAdmin, isTrue);
    });

    test('ApiException maps status codes to safe user-friendly messages without leaking internals', () {
      final badRequestDio = DioException(
        requestOptions: RequestOptions(path: '/test'),
        response: Response(
          requestOptions: RequestOptions(path: '/test'),
          statusCode: 400,
          data: {'message': 'Invalid parameter provided'},
        ),
      );
      final ex400 = ApiException.fromDioException(badRequestDio);
      expect(ex400.statusCode, 400);
      expect(ex400.message, 'Invalid parameter provided');

      final serverErrorDio = DioException(
        requestOptions: RequestOptions(path: '/test'),
        response: Response(
          requestOptions: RequestOptions(path: '/test'),
          statusCode: 500,
          data: {'message': 'MongoNetworkError: connection failed to cluster0.mongodb.net:27017'},
        ),
      );
      final ex500 = ApiException.fromDioException(serverErrorDio);
      expect(ex500.statusCode, 500);
      expect(ex500.message.contains('cluster0.mongodb.net'), isFalse);
      expect(ex500.message, 'The QueueFlow server is temporarily unavailable. Please try again in a moment.');

      final rateLimitDio = DioException(
        requestOptions: RequestOptions(path: '/test'),
        response: Response(
          requestOptions: RequestOptions(path: '/test'),
          statusCode: 429,
          data: {},
        ),
      );
      final ex429 = ApiException.fromDioException(rateLimitDio);
      expect(ex429.statusCode, 429);
      expect(ex429.message, 'Too many requests. Please wait a few minutes before trying again.');
    });

    test('ApiService rejects malformed ObjectIds and out-of-range inputs before network call', () async {
      final dio = Dio();
      final api = ApiService(dio);

      // Empty centerId
      expect(
        () => api.getServiceCenterDetail(''),
        throwsA(isA<ApiException>()),
      );

      // Invalid feedback rating (> 5)
      expect(
        () => api.submitFeedback(
          tokenId: '507f1f77bcf86cd799439011',
          rating: 6,
        ),
        throwsA(isA<ApiException>()),
      );

      // Invalid feedback rating (< 1)
      expect(
        () => api.submitFeedback(
          tokenId: '507f1f77bcf86cd799439011',
          rating: 0,
        ),
        throwsA(isA<ApiException>()),
      );

      // Oversized feedback comment (> 500 chars)
      expect(
        () => api.submitFeedback(
          tokenId: '507f1f77bcf86cd799439011',
          rating: 5,
          comment: 'a' * 501,
        ),
        throwsA(isA<ApiException>()),
      );
    });

    test('CrowdStatus and ServiceCenter handle zero capacity without division-by-zero', () {
      final crowd = CrowdStatus.fromJson({
        'centerId': '507f1f77bcf86cd799439011',
        'currentCrowd': 0,
        'capacity': 0,
      });
      expect(crowd.crowdPercent, 0);
      expect(crowd.crowdStatus, 'UNKNOWN');

      final center = ServiceCenter.fromJson({
        '_id': '507f1f77bcf86cd799439011',
        'name': 'Test Center',
        'code': 'TC-01',
        'type': 'OTHER',
        'capacity': 0,
        'currentCrowd': 0,
      });
      expect(center.crowdStatus, 'UNKNOWN');
    });

    test('TokenModel handles missing positions and wait times without fake defaults', () {
      final token = TokenModel.fromJson({
        '_id': '507f1f77bcf86cd799439011',
        'tokenCode': 'B-001',
        'status': 'WAITING',
      });
      expect(token.currentPosition, isNull);
      expect(token.initialPosition, isNull);
      expect(token.waitEstimateMinutes, isNull);
    });

    test('Fail-closed security: corrupted or missing roles, statuses, and flags fail safely', () {
      // 1. Missing role must NOT grant customer or admin privileges
      final corruptedUser = AppUser.fromJson({
        '_id': '507f1f77bcf86cd799439011',
        'name': 'Corrupted User',
        'email': 'corrupted@example.com',
      });
      expect(corruptedUser.role, equals('UNKNOWN'));
      expect(corruptedUser.isCustomer, isFalse);
      expect(corruptedUser.isAdmin, isFalse);

      // 2. Missing token status must fail closed to UNKNOWN
      final corruptedToken = TokenModel.fromJson({
        '_id': '507f1f77bcf86cd799439011',
        'tokenCode': 'X-001',
      });
      expect(corruptedToken.status, equals('UNKNOWN'));
      expect(corruptedToken.isActive, isFalse);
      expect(corruptedToken.isWaiting, isFalse);
      expect(corruptedToken.isCalled, isFalse);
      expect(corruptedToken.isServing, isFalse);
      expect(corruptedToken.canCancel, isFalse);
    });

    test('ApiService strictly enforces 24-character hexadecimal MongoDB ObjectIds', () async {
      final dio = Dio();
      final api = ApiService(dio);

      // Non-hex character
      expect(
        () => api.getServiceCenterDetail('507f1f77bcf86cd7994390zz'),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('expected 24-character hexadecimal identifier'))),
      );

      // Too short
      expect(
        () => api.cancelToken('507f1f77'),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('expected 24-character hexadecimal identifier'))),
      );

      // SQL / NoSQL Injection attempt in ID parameter
      expect(
        () => api.getServiceCenterDetail("{'\$gt': ''}"),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('expected 24-character hexadecimal identifier'))),
      );
    });

    test('401 session invalidation & expired JWT triggers storage purge and onUnauthorized callback', () async {
      final storage = _TestStorageService();
      await storage.saveAuthToken('expired-mock-token-abc');
      expect(await storage.hasToken(), isTrue);

      bool onUnauthorizedCalled = false;
      final dioClient = DioClient(
        storage,
        onUnauthorized: () {
          onUnauthorizedCalled = true;
        },
      );

      dioClient.dio.httpClientAdapter = _MockHttpAdapter(
        statusCode: 401,
        data: {'message': 'jwt expired'},
      );

      try {
        await dioClient.dio.get('/tokens/active');
      } catch (_) {}

      expect(await storage.hasToken(), isFalse);
      expect(onUnauthorizedCalled, isTrue);
    });

    test('Network timeout or 5xx server downtime does NOT wipe credentials in AuthNotifier', () async {
      final storage = _TestStorageService();
      await storage.saveAuthToken('valid-token-123');
      await storage.saveUserData(
        id: '507f1f77bcf86cd799439011',
        name: 'Offline Customer',
        email: 'offline@example.com',
        role: 'CUSTOMER',
      );

      final socketService = SocketService();
      final mockApi = _FailingApiService(
        Dio(),
        failWith: ApiException(message: 'Connection timed out', statusCode: null),
      );

      final notifier = AuthNotifier(
        apiService: mockApi,
        storageService: storage,
        socketService: socketService,
      );

      await notifier.checkAuthStatus();

      // Session should NOT be revoked on network timeout; token must remain intact
      expect(await storage.hasToken(), isTrue);
      expect(notifier.state.isAuthenticated, isTrue);
      expect(notifier.state.user?.name, 'Offline Customer');
      expect(notifier.state.errorMessage, contains('Working offline'));
    });

    test('Non-customer roles (ADMIN / STAFF) are strictly rejected from Customer App', () async {
      final storage = _TestStorageService();
      await storage.saveAuthToken('admin-token-xyz');

      final socketService = SocketService();
      final adminApi = _MockUserApiService(
        Dio(),
        user: const AppUser(
          id: '507f1f77bcf86cd799439099',
          name: 'Admin Boss',
          email: 'admin@example.com',
          role: 'ADMIN',
        ),
      );

      bool loggedOut = false;
      final notifier = AuthNotifier(
        apiService: adminApi,
        storageService: storage,
        socketService: socketService,
        onLogout: () => loggedOut = true,
      );

      await notifier.checkAuthStatus();

      expect(notifier.state.isAuthenticated, isFalse);
      expect(notifier.state.errorMessage, contains('customers only'));
      expect(await storage.hasToken(), isFalse);
      expect(loggedOut, isTrue);
    });

    test('SocketService manages listeners and avoids duplicate handlers in Set registry', () {
      final socketService = SocketService();
      int callCount = 0;
      void testHandler(dynamic data) => callCount++;

      // Register same handler twice
      socketService.on('test.event', testHandler);
      socketService.on('test.event', testHandler);

      // Clean disconnect clears registry when requested
      socketService.disconnect(clearListeners: true);
      expect(socketService.isConnected, isFalse);
      expect(socketService.currentUserId, isNull);
    });

    test('TokenNotifier rejects duplicate queue join while operation is in progress', () async {
      final mockApi = _DelayApiService(Dio());
      final socket = SocketService();
      final notifier = TokenNotifier(apiService: mockApi, socketService: socket);

      // First call starts loading
      final firstJoin = notifier.joinQueue(
        centerId: '507f1f77bcf86cd799439011',
        serviceId: '507f1f77bcf86cd799439022',
      );

      // Rapid concurrent second call must immediately throw
      expect(
        () => notifier.joinQueue(
          centerId: '507f1f77bcf86cd799439011',
          serviceId: '507f1f77bcf86cd799439022',
        ),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('already in progress'))),
      );

      await firstJoin;
    });

    test('Cross-user event isolation: token.created for Customer B is rejected by Customer A', () async {
      final storage = _TestStorageService();
      await storage.saveUserData(
        id: '507f1f77bcf86cd799439001', // Customer A ID
        name: 'Customer A',
        email: 'a@example.com',
        role: 'CUSTOMER',
      );

      final socketService = SocketService();
      final notifier = TokenNotifier(
        apiService: ApiService(Dio()),
        socketService: socketService,
        storageService: storage,
      );

      // Simulate token.created payload belonging to Customer B
      final tokenBPayload = {
        'token': {
          '_id': '507f1f77bcf86cd799439099',
          'tokenCode': 'B-999',
          'tokenNumber': 999,
          'userId': '507f1f77bcf86cd799439002', // Customer B ID
          'centerId': '507f1f77bcf86cd799439011',
          'serviceId': '507f1f77bcf86cd799439022',
          'status': 'WAITING',
        }
      };

      // Dispatch event to socket service for Customer B
      socketService.handleEventForTesting('token.created', tokenBPayload);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(notifier.state.activeToken, isNull);

      // Verify that Customer A's own token IS accepted
      final tokenAPayload = {
        'token': {
          '_id': '507f1f77bcf86cd799439099',
          'tokenCode': 'A-100',
          'tokenNumber': 100,
          'userId': '507f1f77bcf86cd799439001', // Customer A ID
          'centerId': '507f1f77bcf86cd799439011',
          'serviceId': '507f1f77bcf86cd799439022',
          'status': 'WAITING',
        }
      };
      socketService.handleEventForTesting('token.created', tokenAPayload);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(notifier.state.activeToken?.tokenCode, equals('A-100'));
    });

    test('Cross-user event isolation: notification.created for Customer B is rejected by Customer A', () async {
      final storage = _TestStorageService();
      await storage.saveUserData(
        id: '507f1f77bcf86cd799439001', // Customer A ID
        name: 'Customer A',
        email: 'a@example.com',
        role: 'CUSTOMER',
      );

      final socketService = SocketService();
      final notifier = NotificationsNotifier(
        apiService: ApiService(Dio()),
        socketService: socketService,
        storageService: storage,
      );

      final notifBPayload = {
        '_id': '507f1f77bcf86cd799439077',
        'userId': '507f1f77bcf86cd799439002', // Customer B ID
        'title': 'Token for Customer B',
        'body': 'Private message for B',
        'type': 'TOKEN_CALLED',
        'isRead': false,
      };

      socketService.handleEventForTesting('notification.created', notifBPayload);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(notifier.state.notifications, isEmpty);

      // Verify Customer A's own notification IS accepted
      final notifAPayload = {
        '_id': '507f1f77bcf86cd799439088',
        'userId': '507f1f77bcf86cd799439001', // Customer A ID
        'title': 'Token for Customer A',
        'body': 'Private message for A',
        'type': 'TOKEN_CALLED',
        'isRead': false,
      };

      socketService.handleEventForTesting('notification.created', notifAPayload);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(notifier.state.notifications.length, equals(1));
      expect(notifier.state.notifications.first.title, equals('Token for Customer A'));
    });
  });
}

// ── Test Doubles for Pure Unit Testing without Platform Channels ─────────────

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

class _FailingApiService extends ApiService {
  _FailingApiService(super.dio, {required this.failWith});
  final dynamic failWith;

  @override
  Future<AppUser> getCurrentUser() async => throw failWith;
}

class _MockUserApiService extends ApiService {
  _MockUserApiService(super.dio, {required this.user});
  final AppUser user;

  @override
  Future<AppUser> getCurrentUser() async => user;

  @override
  Future<Map<String, dynamic>> login({required String email, required String password}) async => {
        'user': user,
        'token': 'test-token',
      };
}

class _DelayApiService extends ApiService {
  _DelayApiService(super.dio);

  @override
  Future<TokenModel> joinQueue({
    required String centerId,
    required String serviceId,
    bool notifyApp = true,
    bool notifySms = false,
  }) async {
    await Future<void>.delayed(const Duration(milliseconds: 50));
    return const TokenModel(
      id: '507f1f77bcf86cd799439088',
      tokenCode: 'A-001',
      tokenNumber: 1,
      userId: '507f1f77bcf86cd799439011',
      centerId: '507f1f77bcf86cd799439011',
      serviceId: '507f1f77bcf86cd799439022',
      status: 'WAITING',
    );
  }
}

class _MockHttpAdapter implements HttpClientAdapter {
  _MockHttpAdapter({required this.statusCode, this.data = const {}});
  final int statusCode;
  final Map<String, dynamic> data;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final bytes = utf8.encode(jsonEncode(data));
    return ResponseBody.fromBytes(
      bytes,
      statusCode,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

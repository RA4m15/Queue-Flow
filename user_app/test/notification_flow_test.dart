import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/constants/api_constants.dart';
import 'package:user_app/models/notification.dart';
import 'package:user_app/providers/notification_provider.dart';
import 'package:user_app/services/api_service.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/services/storage_service.dart';

void main() {
  group('Notification flow — socket envelope handling', () {
    const customerA = '507f1f77bcf86cd799439001';
    const customerB = '507f1f77bcf86cd799439002';

    test('backend envelope {notification:{...}} without userId is accepted (private room is authoritative)', () async {
      final storage = _TestStorageService();
      await storage.saveUserData(
        id: customerA,
        name: 'Customer A',
        email: 'a@example.com',
        role: 'CUSTOMER',
      );

      final socket = SocketService();
      final notifier = NotificationsNotifier(
        apiService: ApiService(Dio()),
        socketService: socket,
        storageService: storage,
      );

      // Exact shape emitted by backend/src/services/notificationService.js:
      // { notification: { _id, type, title, body, tokenId?, isRead, createdAt } }
      socket.handleEventForTesting(ApiConstants.eventNotificationCreated, {
        'notification': {
          '_id': '507f1f77bcf86cd799439077',
          'type': 'TOKEN_CALLED',
          'title': 'You are next!',
          'body': 'Proceed to counter 3',
          'isRead': false,
          'createdAt': '2026-09-25T10:00:00.000Z',
        },
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.notifications.length, equals(1));
      expect(notifier.state.notifications.first.title, equals('You are next!'));
      expect(notifier.state.notifications.first.userId, isEmpty);
      expect(notifier.state.unreadCount, equals(1));
    });

    test('flat payload with foreign userId is still rejected', () async {
      final storage = _TestStorageService();
      await storage.saveUserData(
        id: customerA,
        name: 'Customer A',
        email: 'a@example.com',
        role: 'CUSTOMER',
      );

      final socket = SocketService();
      final notifier = NotificationsNotifier(
        apiService: ApiService(Dio()),
        socketService: socket,
        storageService: storage,
      );

      socket.handleEventForTesting(ApiConstants.eventNotificationCreated, {
        '_id': '507f1f77bcf86cd799439088',
        'userId': customerB,
        'type': 'TOKEN_CALLED',
        'title': 'Token for Customer B',
        'body': 'Private message for B',
        'isRead': false,
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.notifications, isEmpty);
      expect(notifier.state.unreadCount, equals(0));
    });

    test('flat payload with own userId is accepted', () async {
      final storage = _TestStorageService();
      await storage.saveUserData(
        id: customerA,
        name: 'Customer A',
        email: 'a@example.com',
        role: 'CUSTOMER',
      );

      final socket = SocketService();
      final notifier = NotificationsNotifier(
        apiService: ApiService(Dio()),
        socketService: socket,
        storageService: storage,
      );

      socket.handleEventForTesting(ApiConstants.eventNotificationCreated, {
        '_id': '507f1f77bcf86cd799439089',
        'userId': customerA,
        'type': 'BROADCAST',
        'title': 'Center update',
        'body': 'Queues open now',
        'isRead': false,
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(notifier.state.notifications.length, equals(1));
      expect(notifier.state.notifications.first.body, equals('Queues open now'));
      expect(notifier.state.unreadCount, equals(1));
    });

    test('loadNotifications populates list and unread count from server', () async {
      final api = _NotificationsApiService(Dio());
      final notifier = NotificationsNotifier(
        apiService: api,
        socketService: SocketService(),
      );

      await notifier.loadNotifications();

      expect(notifier.state.isLoading, isFalse);
      expect(notifier.state.error, isNull);
      expect(notifier.state.notifications.length, equals(1));
      expect(notifier.state.notifications.first.title, equals('You are next!'));
      expect(notifier.state.unreadCount, equals(1));
    });
  });
}

// ── Test Doubles ──────────────────────────────────────────────────────────────

class _NotificationsApiService extends ApiService {
  _NotificationsApiService(super.dio);

  @override
  Future<Map<String, dynamic>> getNotifications({int page = 1, int limit = 30}) async {
    return {
      'notifications': [
        NotificationModel.fromJson({
          '_id': '507f1f77bcf86cd799439077',
          'type': 'TOKEN_CALLED',
          'title': 'You are next!',
          'body': 'Proceed to counter 3',
          'isRead': false,
        }),
      ],
      'unreadCount': 1,
    };
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
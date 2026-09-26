import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/constants/api_constants.dart';
import '../core/network/api_exception.dart';
import '../models/notification.dart';
import '../services/api_service.dart';
import '../services/socket_service.dart';
import '../services/storage_service.dart';
import 'app_providers.dart';

class NotificationsState {
  const NotificationsState({
    this.notifications = const [],
    this.unreadCount = 0,
    this.isLoading = false,
    this.error,
  });

  final List<NotificationModel> notifications;
  final int unreadCount;
  final bool isLoading;
  final String? error;

  NotificationsState copyWith({
    List<NotificationModel>? notifications,
    int? unreadCount,
    bool? isLoading,
    String? error,
  }) {
    return NotificationsState(
      notifications: notifications ?? this.notifications,
      unreadCount: unreadCount ?? this.unreadCount,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

class NotificationsNotifier extends StateNotifier<NotificationsState> {
  NotificationsNotifier({
    required this.apiService,
    required this.socketService,
    this.storageService,
  }) : super(const NotificationsState()) {
    _initSocket();
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

  void _initSocket() {
    // Backend emits notification.created as { notification: {...} } and omits the
    // userId from the payload — the private user room is the authority for routing.
    // Fall back to a flat payload for robustness.
    socketService.on(ApiConstants.eventNotificationCreated, (data) async {
      if (data is Map) {
        final raw = (data['notification'] is Map)
            ? Map<String, dynamic>.from(data['notification'] as Map)
            : Map<String, dynamic>.from(data);
        final newNotification = NotificationModel.fromJson(raw);
        final myUserId = await _getCurrentUserId();
        // Payload without userId: the socket room already scoped it to this user.
        // If a userId is present it must match; otherwise reject the notification.
        if (newNotification.userId.isNotEmpty &&
            myUserId != null &&
            myUserId.isNotEmpty &&
            newNotification.userId != myUserId) {
          return;
        }
        state = state.copyWith(
          notifications: [newNotification, ...state.notifications],
          unreadCount: state.unreadCount + 1,
        );
      }
    });
  }

  Future<void> loadNotifications() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final res = await apiService.getNotifications();
      state = state.copyWith(
        notifications: res['notifications'] as List<NotificationModel>,
        unreadCount: res['unreadCount'] as int,
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(isLoading: false, error: ApiException.getUserMessage(e));
    }
  }

  Future<void> markAsRead(String id) async {
    try {
      await apiService.markNotificationRead(id);
      final updatedList = state.notifications.map((n) {
        if (n.id == id) {
          return n.copyWith(isRead: true);
        }
        return n;
      }).toList();
      final newUnread = (state.unreadCount > 0) ? state.unreadCount - 1 : 0;
      state = state.copyWith(notifications: updatedList, unreadCount: newUnread);
    } catch (_) {}
  }

  Future<void> markAllAsRead() async {
    try {
      await apiService.markAllNotificationsRead();
      final updatedList = state.notifications.map((n) => n.copyWith(isRead: true)).toList();
      state = state.copyWith(notifications: updatedList, unreadCount: 0);
    } catch (_) {}
  }

  void reset() {
    state = const NotificationsState();
  }
}

final notificationsProvider = StateNotifierProvider<NotificationsNotifier, NotificationsState>((ref) {
  final apiService = ref.watch(apiServiceProvider);
  final socketService = ref.watch(socketServiceProvider);
  final storageService = ref.watch(storageServiceProvider);

  return NotificationsNotifier(
    apiService: apiService,
    socketService: socketService,
    storageService: storageService,
  );
});

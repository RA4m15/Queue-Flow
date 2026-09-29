import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';

import '../core/router/app_router.dart';
import 'api_service.dart';
import 'notification_service.dart';

/// Handles Firebase Cloud Messaging for QueueFlow.
///
/// Responsibilities:
/// - Request notification permission
/// - Register the device FCM token with the backend
/// - Re-register when the token refreshes
/// - Display foreground FCM notifications
class FcmService {
  FcmService(this._apiService);

  final ApiService _apiService;

  StreamSubscription<String>? _refreshSubscription;
  StreamSubscription<RemoteMessage>? _messageSubscription;
  StreamSubscription<RemoteMessage>? _messageOpenedSubscription;

  /// Requests permission and registers the current device FCM token.
  Future<void> registerDeviceToken() async {
    try {
      final messaging = FirebaseMessaging.instance;

      await _requestPermission(messaging);

      final token = await messaging.getToken();

      if (token == null || token.isEmpty) {
        debugPrint(
          '[FCM] No device token available; skipping registration',
        );
        return;
      }

      await _pushTokenToBackend(token);
    } catch (e) {
      debugPrint(
        '[FCM] Device token registration skipped: ${e.runtimeType}',
      );
    }
  }

  /// Listens for FCM messages received while the app is in the foreground.
  ///
  /// Foreground FCM notification messages are not automatically displayed
  /// by Firebase Messaging, so we show them through our local notification
  /// service.
  void listenForMessages() {
    if (_messageSubscription != null) return;

    try {
      _messageSubscription =
          FirebaseMessaging.onMessage.listen((RemoteMessage message) {
        debugPrint(
          '[FCM] Foreground message received: ${message.messageId}',
        );

        final notification = message.notification;

        if (notification == null) {
          debugPrint('[FCM] Message has no notification payload');
          return;
        }

        NotificationService.instance.showTokenApproaching(
          title: notification.title ?? 'QueueFlow',
          body: notification.body ?? '',
          payload: message.data['tokenId'] ?? '',
        );
      });

      _messageOpenedSubscription =
          FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
        debugPrint(
          '[FCM] Background message opened: ${message.messageId}',
        );
        final context = rootNavigatorKey.currentContext;
        if (context != null && context.mounted) {
          context.go('/token/live');
        }
      });

      unawaited(
        FirebaseMessaging.instance.getInitialMessage().then((message) {
          if (message != null) {
            debugPrint(
              '[FCM] Cold-start message opened: ${message.messageId}',
            );
            final context = rootNavigatorKey.currentContext;
            if (context != null && context.mounted) {
              context.go('/token/live');
            }
          }
        }),
      );
    } catch (e) {
      debugPrint(
        '[FCM] Foreground message listener unavailable: ${e.runtimeType}',
      );
    }
  }

  /// Re-registers the device token whenever Firebase rotates it.
  void listenForTokenRefresh() {
    if (_refreshSubscription != null) return;

    try {
      _refreshSubscription =
          FirebaseMessaging.instance.onTokenRefresh.listen(
        (token) async {
          try {
            await _pushTokenToBackend(token);
          } catch (e) {
            debugPrint(
              '[FCM] Token refresh re-registration failed: ${e.runtimeType}',
            );
          }
        },
        onError: (Object error) {
          debugPrint(
            '[FCM] Token refresh stream error: ${error.runtimeType}',
          );
        },
      );
    } catch (e) {
      debugPrint(
        '[FCM] Token refresh listener unavailable: ${e.runtimeType}',
      );
    }
  }

  /// Stops all FCM listeners when the session ends.
  void stopListeningForTokenRefresh() {
    _refreshSubscription?.cancel();
    _refreshSubscription = null;
  }

  /// Stops the foreground message listener.
  void stopListeningForMessages() {
    _messageSubscription?.cancel();
    _messageSubscription = null;
    _messageOpenedSubscription?.cancel();
    _messageOpenedSubscription = null;
  }

  Future<void> _requestPermission(
    FirebaseMessaging messaging,
  ) async {
    try {
      final settings = await messaging.requestPermission();

      debugPrint(
        '[FCM] Permission status: ${settings.authorizationStatus}',
      );
    } catch (_) {
      // Permission prompts are unavailable on some platforms.
      // Token acquisition below is still attempted.
    }
  }

  Future<void> _pushTokenToBackend(String token) async {
    debugPrint(
      '[FCM] Registering device token ${_maskToken(token)}',
    );

    await _apiService.updateProfile(fcmToken: token);

    debugPrint('[FCM] Device token registered');
  }

  /// Keeps the complete FCM token out of logs.
  static String _maskToken(String token) {
    if (token.length <= 12) {
      return '*' * token.length;
    }

    return '${token.substring(0, 6)}...'
        '${token.substring(token.length - 4)}';
  }
}
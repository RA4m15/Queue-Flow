import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:go_router/go_router.dart';
import '../core/router/app_router.dart';

class NotificationService {
  NotificationService._();

  static final NotificationService instance = NotificationService._();

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  static const String channelId = 'queueflow_alerts';
  static const String channelName = 'QueueFlow Alerts';

  /// Name of the small-icon drawable used for every QueueFlow notification.
  ///
  /// This MUST name a resource in `res/drawable/`, not `res/mipmap/`. The
  /// plugin resolves it with
  /// `getResources().getIdentifier(name, "drawable", packageName)`. When the
  /// name does not resolve, the plugin does not report a useful error: it
  /// falls back to a legacy `iconResourceId` field that is null, and
  /// `setSmallIcon` then throws a NullPointerException. That exception is
  /// raised on the platform channel, so the notification is dropped and never
  /// appears on the device. Keeping the name in one constant and shipping the
  /// matching drawable is what prevents that silent failure.
  static const String smallIcon = 'ic_launcher';

  /// Route opened when the user taps a QueueFlow notification.
  static const String tapRoute = '/token/live';

  Future<void> initialize() async {
    const androidSettings =
        AndroidInitializationSettings(smallIcon);

    const settings = InitializationSettings(
      android: androidSettings,
    );

    await _plugin.initialize(
      settings: settings,
      onDidReceiveNotificationResponse: (NotificationResponse response) {
        _openFromNotificationTap();
      },
    );

    const channel = AndroidNotificationChannel(
      channelId,
      channelName,
      description: 'Notifications for approaching queue tokens',
      importance: Importance.high,
      playSound: true,
      sound: RawResourceAndroidNotificationSound('token_approaching'),
    );

    final androidPlugin = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();

    await androidPlugin?.createNotificationChannel(channel);
  }

  Future<void> showTokenApproaching({
    required String title,
    required String body,
    String? payload,
  }) async {
    const androidDetails = AndroidNotificationDetails(
      channelId,
      channelName,
      channelDescription: 'Notifications for approaching queue tokens',
      importance: Importance.high,
      priority: Priority.high,
      playSound: true,
      sound: RawResourceAndroidNotificationSound('token_approaching'),
      icon: smallIcon,
    );

    const details = NotificationDetails(
      android: androidDetails,
    );

    // Posting a notification is best-effort presentation, never a reason to
    // raise an unhandled async error. The plugin surfaces a rejected
    // notification (an unresolvable small icon, a payload the platform
    // refuses) as a PlatformException on this method channel. Letting that
    // escape as an unhandled async error would leave the customer with no
    // alert and no trace in logs, so a failure is reported explicitly rather
    // than silently vanishing.
    try {
      await _plugin.show(
        id: 1001,
        title: title,
        body: body,
        notificationDetails: details,
        payload: payload,
      );
      debugPrint('[Notification] Posted local notification: $title');
    } catch (e) {
      debugPrint('[Notification] Failed to post local notification: $e');
    }
  }

  /// Routes the user to their live token screen when a notification is tapped.
  ///
  /// A tap can arrive before the router is mounted (cold start), in which case
  /// there is no context to navigate with yet, so it is reported rather than
  /// silently doing nothing. Cold starts are already covered by
  /// `FirebaseMessaging.getInitialMessage()` in FcmService, which replays the
  /// same route once the router is up.
  void _openFromNotificationTap() {
    final context = rootNavigatorKey.currentContext;
    if (context != null && context.mounted) {
      context.go(tapRoute);
      return;
    }
    debugPrint('[Notification] Tap received before the router was mounted');
  }
}

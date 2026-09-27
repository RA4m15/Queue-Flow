import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class NotificationService {
  NotificationService._();

  static final NotificationService instance = NotificationService._();

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  static const String channelId = 'queueflow_alerts';
  static const String channelName = 'QueueFlow Alerts';

  Future<void> initialize() async {
    const androidSettings =
        AndroidInitializationSettings('@mipmap/ic_launcher');

    const settings = InitializationSettings(
      android: androidSettings,
    );

    await _plugin.initialize(
      settings: settings,
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
  }) async {
    const androidDetails = AndroidNotificationDetails(
      channelId,
      channelName,
      channelDescription: 'Notifications for approaching queue tokens',
      importance: Importance.high,
      priority: Priority.high,
      playSound: true,
      sound: RawResourceAndroidNotificationSound('token_approaching'),
    );

    const details = NotificationDetails(
      android: androidDetails,
    );

    await _plugin.show(
      id: 1001,
      title: title,
      body: body,
      notificationDetails: details,
    );
  }
}
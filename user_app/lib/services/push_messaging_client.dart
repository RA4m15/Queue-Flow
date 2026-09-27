import 'dart:async';

/// Truthful permission state for device push delivery.
///
/// [unavailable] is distinct from [denied]: it means no push transport is
/// compiled/configured in this build, so the app must not claim that push
/// notifications are active.
enum PushPermissionStatus {
  /// No platform interaction has happened yet.
  notDetermined,

  /// The platform granted notification permission.
  granted,

  /// The user declined notification permission.
  denied,

  /// No push transport is available in this build (e.g. Firebase Messaging
  /// is not configured). Push delivery cannot be claimed.
  unavailable,
}

extension PushPermissionStatusX on PushPermissionStatus {
  bool get isGranted => this == PushPermissionStatus.granted;

  /// True only when push can actually be delivered right now.
  bool get canReceivePush => this == PushPermissionStatus.granted;

  /// A truthful label for customer-facing UI.
  String get label {
    switch (this) {
      case PushPermissionStatus.granted:
        return 'On';
      case PushPermissionStatus.denied:
        return 'Blocked';
      case PushPermissionStatus.notDetermined:
        return 'Not Set';
      case PushPermissionStatus.unavailable:
        return 'Not Available';
    }
  }
}

/// A push payload as delivered by the platform transport.
class PushMessage {
  const PushMessage({
    required this.messageId,
    this.data = const {},
    this.title,
    this.body,
    this.type,
    this.tokenId,
  });

  final String messageId;
  final Map<String, dynamic> data;
  final String? title;
  final String? body;
  final String? type;
  final String? tokenId;

  /// The backend notification type carried in the payload, if any.
  /// The payload is a *routing hint only* — authoritative state is always
  /// re-fetched from the backend before it is displayed.
  static PushMessage fromPlatform(Map<String, dynamic> raw) {
    final data = raw['data'] is Map
        ? Map<String, dynamic>.from(raw['data'] as Map)
        : <String, dynamic>{};
    return PushMessage(
      messageId: (raw['messageId'] ?? data['notificationId'] ?? data['id'] ?? '').toString(),
      data: data,
      title: raw['title']?.toString() ?? data['title']?.toString(),
      body: raw['body']?.toString() ?? data['body']?.toString(),
      type: (data['type'] ?? raw['type'])?.toString(),
      tokenId: (data['tokenId'] ?? raw['tokenId'])?.toString(),
    );
  }
}

/// Platform binding for device push.
///
/// Implementations wrap a real push SDK (e.g. Firebase Messaging). The
/// app must never simulate a successful registration: if no transport is
/// compiled in, [UnavailablePushMessagingClient] is used and every call
/// reports [PushPermissionStatus.unavailable] with a null device token.
abstract class PushMessagingClient {
  /// Whether a real push transport is compiled and configured.
  bool get isAvailable;

  /// Current permission state without prompting the user.
  Future<PushPermissionStatus> currentPermission();

  /// Prompt the platform for notification permission.
  Future<PushPermissionStatus> requestPermission();

  /// The current device push registration token, or null when unavailable.
  Future<String?> deviceToken();

  /// Emits whenever the platform rotates the device token.
  Stream<String> get onTokenRefresh;

  /// Emits messages delivered while the app is in the foreground.
  Stream<PushMessage> get onForegroundMessage;

  /// Emits the payload of a notification the user tapped, which may happen
  /// while the app was terminated. Delivered once at next launch.
  Stream<PushMessage> get onMessageOpened;

  void dispose();
}

/// The default, honest client used when no push SDK is configured.
///
/// It never claims a token or a granted permission, so the UI can state
/// truthfully that push alerts are unavailable while realtime Socket.IO
/// updates and the in-app notification list continue to work.
class UnavailablePushMessagingClient implements PushMessagingClient {
  const UnavailablePushMessagingClient([
    this.reason = 'Push transport is not configured for this build.',
  ]);

  final String reason;

  @override
  bool get isAvailable => false;

  @override
  Future<PushPermissionStatus> currentPermission() async =>
      PushPermissionStatus.unavailable;

  @override
  Future<PushPermissionStatus> requestPermission() async =>
      PushPermissionStatus.unavailable;

  @override
  Future<String?> deviceToken() async => null;

  @override
  Stream<String> get onTokenRefresh => const Stream<String>.empty();

  @override
  Stream<PushMessage> get onForegroundMessage => const Stream<PushMessage>.empty();

  @override
  Stream<PushMessage> get onMessageOpened => const Stream<PushMessage>.empty();

  @override
  void dispose() {}
}

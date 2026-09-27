import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'push_messaging_client.dart';

/// Top-level handler for messages delivered while the app is in the
/// background or has been terminated by the platform.
///
/// It runs in its own isolate *before* the main isolate is ready, so it must
/// not touch Riverpod, storage, or any singleton. It only acknowledges the
/// message; the real work (authoritative state fetch, navigation) happens in
/// the main isolate once the app is up. The payload is treated purely as a
/// routing hint — never as authoritative queue state.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  // Intentionally empty beyond acknowledgement. The backend sends a
  // `notification` block alongside the data, so FCM has already rendered the
  // system tray entry by the time this isolate runs. Displaying anything here
  // would produce a second, duplicate alert. QueueFlow's single source of truth
  // is the dedupe key in `data`, enforced in the main isolate.
  debugPrint('[Push] background message ${message.messageId ?? '(no id)'}');
}

/// A real [PushMessagingClient] backed by Firebase Cloud Messaging.
///
/// This client is only ever constructed after a successful
/// `Firebase.initializeApp()` plus a positive `isSupported()` check. It
/// reports [PushPermissionStatus.unavailable] rather than a grant whenever the
/// platform has not authorised notifications, and it never mints a token of
/// its own — the token always comes from the platform SDK.
class FirebasePushMessagingClient implements PushMessagingClient {
  FirebasePushMessagingClient._(this._messaging);

  final FirebaseMessaging _messaging;

  final _tokenRefresh = StreamController<String>.broadcast();
  final _foreground = StreamController<PushMessage>.broadcast();
  final _opened = StreamController<PushMessage>.broadcast();

  final List<StreamSubscription<dynamic>> _subs = [];
  bool _disposed = false;

  /// Boots Firebase and binds the messaging transport.
  ///
  /// Returns `null` — never throws — when a Firebase project is not
  /// configured for this build (no `google-services.json`, no
  /// `GoogleService-Info.plist`, or no Google Play Services on the device).
  /// The caller is expected to fall back to
  /// [UnavailablePushMessagingClient] so the UI can state the truth.
  static Future<FirebasePushMessagingClient?> initialize() async {
    try {
      // Idempotent: safe when the platform already auto-initialised the app
      // (e.g. from google-services.json during process start).
      final app = Firebase.apps.isEmpty
          ? await Firebase.initializeApp()
          : Firebase.app();

      // firebase_core 4.x types projectId as non-nullable, but an app booted
      // from a partial/absent config reports an empty string. Either way an
      // empty project id means no real project is bound to this build.
      if (app.options.projectId.isEmpty) {
        debugPrint('[Push] Firebase initialised without a project id');
        return null;
      }

      final messaging = FirebaseMessaging.instance;
      if (!await messaging.isSupported()) {
        debugPrint('[Push] FCM unsupported on this device');
        return null;
      }

      final client = FirebasePushMessagingClient._(messaging);
      client._bind();
      return client;
    } catch (error) {
      // The overwhelmingly common cause in a real build is a missing
      // google-services.json / GoogleService-Info.plist. Log the type only —
      // never the payload, which can echo config contents.
      debugPrint('[Push] Firebase unavailable: ${error.runtimeType}');
      return null;
    }
  }

  void _bind() {
    // `onMessageOpenedApp` covers a tap while the app was backgrounded;
    // `getInitialMessage` below covers a tap that cold-started the app.
    // Both are static streams on FirebaseMessaging.
    _subs.add(FirebaseMessaging.onMessageOpenedApp.listen(_emitOpened));
    _subs.add(FirebaseMessaging.onMessage.listen(_emitForeground));
    _subs.add(
      _messaging.onTokenRefresh.listen((token) {
        if (!_disposed) _tokenRefresh.add(token);
      }),
    );

    unawaited(_drainInitialMessage());
  }

  Future<void> _drainInitialMessage() async {
    try {
      final initial = await _messaging.getInitialMessage();
      if (initial != null) _emitOpened(initial);
    } catch (error) {
      debugPrint('[Push] initial message unavailable: ${error.runtimeType}');
    }
  }

  void _emitForeground(RemoteMessage message) {
    if (_disposed) return;
    _foreground.add(PushMessage.fromPlatform(normalizeRemoteMessage(message)));
  }

  void _emitOpened(RemoteMessage message) {
    if (_disposed) return;
    _opened.add(PushMessage.fromPlatform(normalizeRemoteMessage(message)));
  }

  @override
  bool get isAvailable => true;

  @override
  Future<PushPermissionStatus> currentPermission() async {
    try {
      return mapAuthorizationStatus(
        (await _messaging.getNotificationSettings()).authorizationStatus,
      );
    } catch (error) {
      debugPrint('[Push] permission read failed: ${error.runtimeType}');
      return PushPermissionStatus.unavailable;
    }
  }

  @override
  Future<PushPermissionStatus> requestPermission() async {
    try {
      final settings = await _messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
        provisional: false,
      );
      return mapAuthorizationStatus(settings.authorizationStatus);
    } catch (error) {
      debugPrint('[Push] permission request failed: ${error.runtimeType}');
      return PushPermissionStatus.unavailable;
    }
  }

  @override
  Future<String?> deviceToken() async {
    try {
      // firebase_messaging resolves the APNs token internally on iOS, so no
      // apnsToken argument is needed. An empty token is reported as absent
      // rather than registered, so the backend never stores a blank value.
      final token = await _messaging.getToken();
      return (token != null && token.isNotEmpty) ? token : null;
    } catch (error) {
      debugPrint('[Push] device token unavailable: ${error.runtimeType}');
      return null;
    }
  }

  @override
  Stream<String> get onTokenRefresh => _tokenRefresh.stream;

  @override
  Stream<PushMessage> get onForegroundMessage => _foreground.stream;

  @override
  Stream<PushMessage> get onMessageOpened => _opened.stream;

  @override
  void dispose() {
    _disposed = true;
    for (final sub in _subs) {
      sub.cancel();
    }
    _subs.clear();
    _tokenRefresh.close();
    _foreground.close();
    _opened.close();
  }
}

/// Flattens a platform [RemoteMessage] into the transport-neutral map shape
/// [PushMessage.fromPlatform] and [PushNotificationService.handleNotificationTap]
/// both read.
///
/// The custom `data` block is preserved verbatim under a `data` key, because
/// that is where the backend's notification type, token id and dedupe key live
/// (`RemoteMessage.messageType` is only the transport name — `gcm` or `apns` —
/// and must never be mistaken for a QueueFlow notification type). Nothing here
/// is trusted as authoritative queue state.
@visibleForTesting
Map<String, dynamic> normalizeRemoteMessage(RemoteMessage message) {
  return <String, dynamic>{
    'messageId': message.messageId,
    'sentTime': message.sentTime?.toIso8601String(),
    'title': message.notification?.title,
    'body': message.notification?.body,
    'data': <String, dynamic>{...message.data},
  };
}

/// Maps a platform authorisation status onto QueueFlow's four-state model.
///
/// `deniedPermanently` is deliberately surfaced as [PushPermissionStatus.denied]
/// rather than a separate state: the customer-visible outcome is identical
/// (no alerts until they change OS settings), and inventing a fifth state
/// would only complicate the UI.
@visibleForTesting
PushPermissionStatus mapAuthorizationStatus(AuthorizationStatus status) {
  switch (status) {
    case AuthorizationStatus.authorized:
    case AuthorizationStatus.provisional:
      return PushPermissionStatus.granted;
    case AuthorizationStatus.denied:
    case AuthorizationStatus.deniedPermanently:
      return PushPermissionStatus.denied;
    case AuthorizationStatus.notDetermined:
      return PushPermissionStatus.notDetermined;
  }
}

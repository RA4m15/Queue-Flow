import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../models/notification.dart';
import '../providers/auth_provider.dart';
import '../providers/token_provider.dart';
import '../providers/app_providers.dart';
import 'api_service.dart';
import 'push_messaging_client.dart';
import 'push_transport.dart';
import 'storage_service.dart';

class PushNotificationState {
  const PushNotificationState({
    this.permission = PushPermissionStatus.notDetermined,
    this.isRegistered = false,
    this.registeredToken,
    this.lastRegisteredAt,
    this.unavailableReason,
    this.lastBackgroundMessage,
  });

  final PushPermissionStatus permission;

  /// True only when the backend has acknowledged this device token.
  final bool isRegistered;
  final String? registeredToken;
  final DateTime? lastRegisteredAt;

  /// Why push is unavailable, when it is.
  final String? unavailableReason;

  /// A notification tapped while the app was terminated/backgrounded, awaiting
  /// routing once the session is restored.
  final PushMessage? lastBackgroundMessage;

  bool get canReceivePush => permission.canReceivePush;

  PushNotificationState copyWith({
    PushPermissionStatus? permission,
    bool? isRegistered,
    String? registeredToken,
    bool clearRegisteredToken = false,
    DateTime? lastRegisteredAt,
    String? unavailableReason,
    bool clearUnavailableReason = false,
    PushMessage? lastBackgroundMessage,
    bool clearBackgroundMessage = false,
  }) {
    return PushNotificationState(
      permission: permission ?? this.permission,
      isRegistered: isRegistered ?? this.isRegistered,
      registeredToken:
          clearRegisteredToken ? null : (registeredToken ?? this.registeredToken),
      lastRegisteredAt: lastRegisteredAt ?? this.lastRegisteredAt,
      unavailableReason: clearUnavailableReason
          ? null
          : (unavailableReason ?? this.unavailableReason),
      lastBackgroundMessage: clearBackgroundMessage
          ? null
          : (lastBackgroundMessage ?? this.lastBackgroundMessage),
    );
  }
}

/// Owns the client-side half of the notification architecture:
/// Flutter obtains a device push token and registers it with the backend.
/// The backend remains the sole authority on *whether* and *when* to notify.
class PushNotificationService extends StateNotifier<PushNotificationState> {
  PushNotificationService({
    required this.apiService,
    required this.storageService,
    PushMessagingClient? messagingClient,
  })  : _client = messagingClient ?? const UnavailablePushMessagingClient(),
        super(const PushNotificationState()) {
    _bindClient();
  }

  final ApiService apiService;
  final StorageService storageService;

  /// The active transport. Bootstrapping Firebase is asynchronous, so this
  /// starts as [UnavailablePushMessagingClient] and is replaced by
  /// [useTransport] once (and if) a real transport boots.
  PushMessagingClient _client;

  /// Anti-duplication cache: keyed on the backend dedupeKey (or notification
  /// id) so the same logical alert is never presented twice when Socket.IO
  /// and push both carry it.
  final Set<String> _seenDedupeKeys = <String>{};

  final _foregroundNotificationController =
      StreamController<NotificationModel>.broadcast();

  /// Backend-authoritative notifications (Socket.IO `notification.created`)
  /// that should be surfaced to the customer while the app is open.
  Stream<NotificationModel> get onForegroundNotification =>
      _foregroundNotificationController.stream;

  String? _fcmToken;

  /// The device push token currently known to the app, if any.
  String? get fcmToken => _fcmToken;

  /// The reason the transport cannot deliver, when it cannot.
  String get _unavailableMessage {
    final client = _client;
    if (client is UnavailablePushMessagingClient) return client.reason;
    return PushUnavailableReason.notConfigured.message;
  }

  /// Read the platform permission state without prompting.
  Future<PushPermissionStatus> checkPermission() async {
    if (!_client.isAvailable) {
      state = state.copyWith(
        permission: PushPermissionStatus.unavailable,
        unavailableReason: _unavailableMessage,
      );
      return state.permission;
    }
    final result = await _client.currentPermission();
    state = state.copyWith(permission: result);
    return result;
  }

  /// Prompt the platform for notification permission.
  ///
  /// Delegates to the real platform transport. When no transport is compiled
  /// in, this reports [PushPermissionStatus.unavailable] instead of claiming
  /// a grant.
  Future<PushPermissionStatus> requestPermission() async {
    if (!_client.isAvailable) {
      state = state.copyWith(
        permission: PushPermissionStatus.unavailable,
        unavailableReason: _unavailableMessage,
      );
      return state.permission;
    }

    final result = await _client.requestPermission();
    state = state.copyWith(
      permission: result,
      clearUnavailableReason: true,
    );

    if (result == PushPermissionStatus.granted) {
      await _syncDeviceToken();
    }
    return result;
  }

  /// Attempt to obtain a device token and register it with the backend.
  ///
  /// Returns true only when the backend acknowledged the registration.
  Future<bool> initialize({bool promptForPermission = true}) async {
    if (!_client.isAvailable) {
      state = state.copyWith(
        permission: PushPermissionStatus.unavailable,
        unavailableReason: _unavailableMessage,
        isRegistered: false,
        clearRegisteredToken: true,
      );
      return false;
    }

    var permission = await _client.currentPermission();
    if (permission == PushPermissionStatus.notDetermined && promptForPermission) {
      permission = await _client.requestPermission();
    }
    state = state.copyWith(permission: permission, clearUnavailableReason: true);

    if (permission != PushPermissionStatus.granted) {
      // Denied: do not pretend notifications are active. Queue tracking
      // continues to work through Socket.IO and the in-app notification list.
      state = state.copyWith(isRegistered: false, clearRegisteredToken: true);
      return false;
    }

    return _syncDeviceToken();
  }

  Future<bool> _syncDeviceToken() async {
    final token = await _client.deviceToken();
    return registerDeviceToken(token);
  }

  /// Register a device push token with the backend (`PATCH /auth/me`,
  /// the existing device-registration mechanism).
  Future<bool> registerDeviceToken(String? token) async {
    if (token == null) {
      state = state.copyWith(isRegistered: false, clearRegisteredToken: true);
      return false;
    }

    final clean = token.trim();
    // Reject obviously invalid values rather than storing or sending them.
    if (clean.length < 20 || clean.length > 500) {
      return false;
    }
    if (state.registeredToken == clean && state.isRegistered) {
      return true;
    }

    _fcmToken = clean;
    await storageService.saveFcmToken(clean);

    try {
      await apiService.registerDeviceToken(clean);
      state = state.copyWith(
        isRegistered: true,
        registeredToken: clean,
        lastRegisteredAt: DateTime.now(),
      );
      return true;
    } catch (_) {
      state = state.copyWith(isRegistered: false);
      return false;
    }
  }

  /// Handle a platform token rotation.
  Future<void> onTokenRefresh(String newToken) async {
    await registerDeviceToken(newToken);
  }

  /// Detach this device from push delivery for the current account.
  Future<void> unregisterOnLogout() async {
    _fcmToken = null;
    await storageService.clearFcmToken();
    // The cross-channel dedupe cache belongs to the account that built it.
    // Keeping it would let the previous account's alerts suppress a new
    // account's identically keyed notification.
    _seenDedupeKeys.clear();
    state = const PushNotificationState();
    try {
      await apiService.unregisterDeviceToken();
    } catch (_) {
      // Best-effort: the backend also clears fcmToken on POST /auth/logout.
    }
  }

  /// Present an incoming backend notification, respecting deduplication.
  ///
  /// Returns true when the notification was newly presented.
  bool processIncomingNotification(NotificationModel notification) {
    final key = notification.dedupeKey ?? notification.id;
    if (key.isNotEmpty && _seenDedupeKeys.contains(key)) {
      return false;
    }
    if (key.isNotEmpty) {
      _seenDedupeKeys.add(key);
      if (_seenDedupeKeys.length > 500) {
        _seenDedupeKeys.remove(_seenDedupeKeys.first);
      }
    }

    if (!_foregroundNotificationController.isClosed) {
      _foregroundNotificationController.add(notification);
    }
    return true;
  }

  /// Whether a notification with this identity has already been presented.
  @visibleForTesting
  bool hasPresented(String dedupeKeyOrId) =>
      _seenDedupeKeys.contains(dedupeKeyOrId);

  /// Queue a notification tapped while the app was terminated/backgrounded.
  void onMessageOpenedFromPlatform(PushMessage message) {
    state = state.copyWith(lastBackgroundMessage: message);
  }

  /// Route a notification tap.
  ///
  /// Never trusts the status inside the payload: the authoritative token
  /// state is re-fetched from the backend before the live token screen opens.
  Future<void> handleNotificationTap({
    required Map<String, dynamic> payload,
    required BuildContext context,
    required WidgetRef ref,
  }) async {
    // If the session expired, route through the normal authentication flow
    // and return. The pending notification is preserved so it can be routed
    // immediately after sign-in.
    if (!ref.read(authProvider).isAuthenticated) {
      if (context.mounted) {
        context.go('/login');
      }
      return;
    }

    // Authenticated: replace payload state with authoritative backend state.
    await ref.read(tokenProvider.notifier).fetchActiveToken();

    if (context.mounted) {
      context.go('/token/live');
    }
  }

  /// Adopt a transport that finished booting after this service was built.
  ///
  /// Firebase initialisation is asynchronous, so a real
  /// [FirebasePushMessagingClient] can arrive after construction. Subscriptions
  /// are rebound, but accumulated dedupe state is deliberately preserved so
  /// an alert already seen over Socket.IO is not re-presented when the same
  /// alert arrives over push.
  Future<void> useTransport(PushMessagingClient client) async {
    if (identical(_client, client)) return;
    _unbindClient();
    _client = client;
    _bindClient();
    state = state.copyWith(clearUnavailableReason: true);
    // Re-run registration so a token that rotated (or only became obtainable)
    // during the boot window reaches the backend.
    if (client.isAvailable) {
      await initialize(promptForPermission: false);
    }
  }

  /// Record that push genuinely cannot be delivered, and why.
  void markUnavailable(String? reason) {
    state = state.copyWith(
      permission: PushPermissionStatus.unavailable,
      unavailableReason: reason ?? _unavailableMessage,
      isRegistered: false,
      clearRegisteredToken: true,
    );
  }

  void _bindClient() {
    final client = _client;
    _tokenRefreshSub = client.onTokenRefresh.listen(onTokenRefresh);
    _foregroundSub = client.onForegroundMessage.listen(_onForegroundMessage);
    _openedSub = client.onMessageOpened.listen(onMessageOpenedFromPlatform);
  }

  void _unbindClient() {
    _tokenRefreshSub?.cancel();
    _foregroundSub?.cancel();
    _openedSub?.cancel();
    _tokenRefreshSub = null;
    _foregroundSub = null;
    _openedSub = null;
  }

  void _onForegroundMessage(PushMessage message) {
    if (message.title == null && message.body == null) {
      // A data-only message carries nothing to display.
      return;
    }
    // Deduplication is owned solely by processIncomingNotification so a
    // push and a socket alert that share a dedupeKey are shown once, while
    // the *first* occurrence of an alert is still presented.
    processIncomingNotification(
      NotificationModel(
        id: message.messageId,
        type: message.type ?? 'TOKEN_APPROACHING',
        title: message.title ?? 'QueueFlow',
        body: message.body ?? '',
        isRead: false,
        userId: '',
        tokenId: message.tokenId,
        dedupeKey: message.data['dedupeKey']?.toString(),
      ),
    );
  }

  StreamSubscription<String>? _tokenRefreshSub;
  StreamSubscription<PushMessage>? _foregroundSub;
  StreamSubscription<PushMessage>? _openedSub;

  @override
  void dispose() {
    _tokenRefreshSub?.cancel();
    _foregroundSub?.cancel();
    _openedSub?.cancel();
    _client.dispose();
    _foregroundNotificationController.close();
    super.dispose();
  }
}

/// Boots the real push transport for this build.
///
/// Resolves to a [FirebasePushMessagingClient] when a Firebase project is
/// configured, and to an [UnavailablePushMessagingClient] when it is not. It
/// never resolves to a client that pretends to be able to deliver.
final pushTransportProvider = FutureProvider<PushTransportResolution>((ref) {
  final resolution = bootPushTransport();
  ref.onDispose(() => resolution.then((r) => r.client?.dispose()));
  return resolution;
});

/// Test seam: when non-null this client is used verbatim and no Firebase boot
/// is attempted. Production never overrides it.
final pushMessagingClientOverrideProvider = Provider<PushMessagingClient?>((ref) {
  return null;
});

final pushNotificationServiceProvider =
    StateNotifierProvider<PushNotificationService, PushNotificationState>((ref) {
  final api = ref.watch(apiServiceProvider);
  final storage = ref.watch(storageServiceProvider);
  final override = ref.watch(pushMessagingClientOverrideProvider);

  final service = PushNotificationService(
    apiService: api,
    storageService: storage,
    messagingClient: override ?? const UnavailablePushMessagingClient(),
  );

  if (override == null) {
    // Adopt the real transport whenever (and only if) it boots. The service
    // instance is kept alive so accumulated cross-channel dedupe state is not
    // thrown away mid-session.
    ref.listen<AsyncValue<PushTransportResolution>>(pushTransportProvider, (_, next) {
      final resolution = next.valueOrNull;
      if (resolution == null) return;
      if (resolution.isAvailable) {
        service.useTransport(resolution.client!);
      } else {
        service.markUnavailable(resolution.unavailableReason);
      }
    }, fireImmediately: true);
  }

  return service;
});

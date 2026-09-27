import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/notification.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/services/push_messaging_client.dart';
import 'package:user_app/services/push_notification_service.dart';
import 'package:user_app/services/socket_service.dart';

import 'harness.dart';

/// Push notification architecture.
///
/// The backend is the sole authority on *whether* and *when* to notify. The
/// Flutter app only (a) obtains a device token, (b) registers it, and
/// (c) re-fetches authoritative token state before showing anything.
///
/// IMPORTANT: this build ships `UnavailablePushMessagingClient` as the wired
/// default because no push transport (Firebase Messaging / APNs) is compiled
/// or configured in — there is no `google-services.json` /
/// `GoogleService-Info.plist` anywhere in the repository. Push delivery
/// therefore cannot be production-verified. The tests below cover both the
/// honest default and the client contract via a scripted transport double.
void main() {
  late FakeApiService api;
  late FakeStorageService storage;
  late SocketService socket;
  late NetworkStatus network;

  setUp(() {
    network = NetworkStatus();
    api = FakeApiService(Dio(), networkStatus: network);
    storage = FakeStorageService();
    socket = SocketService();
  });

  tearDown(() => network.dispose());

  PushNotificationService build(PushMessagingClient client) => PushNotificationService(
        apiService: api,
        storageService: storage,
        messagingClient: client,
      );

  group('Push — the shipped default is honest, not simulated', () {
    test('the wired provider default client reports push as unavailable', () {
      const client = UnavailablePushMessagingClient();
      expect(client.isAvailable, isFalse);
    });

    test('initialize() refuses to claim a registration and explains why', () async {
      final push = build(const UnavailablePushMessagingClient());

      final registered = await push.initialize();

      expect(registered, isFalse);
      expect(push.state.permission, PushPermissionStatus.unavailable);
      expect(push.state.isRegistered, isFalse);
      expect(push.state.registeredToken, isNull);
      expect(push.state.unavailableReason, isNotNull);
      expect(push.state.canReceivePush, isFalse);
      // Absolutely no device token is invented or sent to the backend.
      expect(api.deviceTokenCalls, 0);
      expect(api.registeredDeviceTokens, isEmpty);
      expect(await storage.getFcmToken(), isNull);
    });

    test('requestPermission() reports unavailable instead of a fake grant', () async {
      final push = build(const UnavailablePushMessagingClient());

      final status = await push.requestPermission();

      expect(status, PushPermissionStatus.unavailable);
      expect(status.isGranted, isFalse);
      expect(status.canReceivePush, isFalse);
      expect(status.label, 'Not Available');
      expect(push.state.isRegistered, isFalse);
      expect(api.deviceTokenCalls, 0);
    });

    test('checkPermission() reports unavailable', () async {
      final push = build(const UnavailablePushMessagingClient());
      expect(await push.checkPermission(), PushPermissionStatus.unavailable);
      expect(push.state.permission, PushPermissionStatus.unavailable);
    });

    test('the unavailable client emits no messages on any channel', () async {
      const client = UnavailablePushMessagingClient();
      expect(await client.deviceToken(), isNull);
      expect(await client.onTokenRefresh.isEmpty, isTrue);
      expect(await client.onForegroundMessage.isEmpty, isTrue);
      expect(await client.onMessageOpened.isEmpty, isTrue);
    });

    test('permission status labels are distinct and truthful', () {
      expect(PushPermissionStatus.granted.label, 'On');
      expect(PushPermissionStatus.denied.label, 'Blocked');
      expect(PushPermissionStatus.notDetermined.label, 'Not Set');
      expect(PushPermissionStatus.unavailable.label, 'Not Available');
      // Only an actual platform grant permits claiming push works.
      expect(PushPermissionStatus.granted.canReceivePush, isTrue);
      expect(PushPermissionStatus.unavailable.canReceivePush, isFalse);
      expect(PushPermissionStatus.denied.canReceivePush, isFalse);
      expect(PushPermissionStatus.notDetermined.canReceivePush, isFalse);
    });
  });

  group('Push — permission is delegated to the real transport', () {
    test('a granted permission registers the device token with the backend', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.notDetermined,
        grantedOnRequest: true,
        token: 'device-push-token-abcdefghijklmnop',
      );
      final push = build(client);

      final registered = await push.initialize();

      expect(client.permissionRequestCount, 1, reason: 'the user was actually prompted');
      expect(push.state.permission, PushPermissionStatus.granted);
      expect(registered, isTrue);
      expect(push.state.isRegistered, isTrue);
      expect(push.state.registeredToken, 'device-push-token-abcdefghijklmnop');
      expect(push.state.lastRegisteredAt, isNotNull);
      expect(api.registeredDeviceTokens, ['device-push-token-abcdefghijklmnop']);
      // The token is persisted for the next app launch.
      expect(await storage.getFcmToken(), 'device-push-token-abcdefghijklmnop');
    });

    test('a denied permission never registers a token and never claims push', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.notDetermined,
        grantedOnRequest: false,
      );
      final push = build(client);

      final registered = await push.initialize();

      expect(client.permissionRequestCount, 1);
      expect(push.state.permission, PushPermissionStatus.denied);
      expect(push.state.permission.label, 'Blocked');
      expect(push.state.canReceivePush, isFalse);
      expect(registered, isFalse);
      expect(push.state.isRegistered, isFalse);
      expect(api.deviceTokenCalls, 0);
      expect(api.registeredDeviceTokens, isEmpty);
      expect(await storage.getFcmToken(), isNull);
    });

    test('an already-denied permission is not re-prompted on initialize', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.denied);
      final push = build(client);

      final registered = await push.initialize();

      expect(client.permissionRequestCount, 0);
      expect(push.state.permission, PushPermissionStatus.denied);
      expect(registered, isFalse);
    });

    test('an existing grant is reused without prompting again', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);

      final registered = await push.initialize();

      expect(client.permissionRequestCount, 0);
      expect(registered, isTrue);
      expect(push.state.isRegistered, isTrue);
    });

    test('initialize(promptForPermission: false) does not prompt', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.notDetermined);
      final push = build(client);

      final registered = await push.initialize(promptForPermission: false);

      expect(client.permissionRequestCount, 0);
      expect(push.state.permission, PushPermissionStatus.notDetermined);
      expect(registered, isFalse);
    });

    test('requesting permission after a denial retries the platform prompt', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.denied,
        grantedOnRequest: true,
        token: 'device-push-token-abcdefghijklmnop',
      );
      final push = build(client);

      final status = await push.requestPermission();

      expect(status, PushPermissionStatus.granted);
      expect(client.permissionRequestCount, 1);
      expect(push.state.isRegistered, isTrue);
      expect(api.registeredDeviceTokens, hasLength(1));
    });
  });

  group('Push — device token registration is backend acknowledged', () {
    test('a null device token is never registered', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: null,
      );
      final push = build(client);

      final registered = await push.initialize();

      expect(registered, isFalse);
      expect(push.state.isRegistered, isFalse);
      expect(api.registeredDeviceTokens, isEmpty);
    });

    test('an implausibly short token is rejected before it is sent', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'short-token',
      );
      final push = build(client);

      final registered = await push.initialize();

      expect(registered, isFalse);
      expect(push.state.isRegistered, isFalse);
      expect(push.state.registeredToken, isNull);
      expect(api.registeredDeviceTokens, isEmpty);
    });

    test('a backend failure is not reported as a successful registration', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'device-push-token-abcdefghijklmnop',
      );
      api.deviceTokenError = ApiException(message: 'Registration failed');
      final push = build(client);

      final registered = await push.initialize();

      expect(registered, isFalse);
      expect(push.state.isRegistered, isFalse);
      expect(push.state.registeredToken, isNull);
    });

    test('re-registering the same token is idempotent', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'device-push-token-abcdefghijklmnop',
      );
      final push = build(client);
      await push.initialize();
      expect(api.deviceTokenCalls, 1);

      final again = await push.registerDeviceToken('device-push-token-abcdefghijklmnop');

      expect(again, isTrue);
      expect(api.deviceTokenCalls, 1, reason: 'no duplicate registration request');
    });

    test('registering while offline is refused and nothing is stored as registered',
        () async {
      final push = build(const UnavailablePushMessagingClient());
      network.markUnreachable();

      // The service reports failure rather than a successful registration.
      final result = await push.registerDeviceToken('device-push-token-abcdefghijklmnop');

      expect(result, isFalse);
      expect(push.state.isRegistered, isFalse);
      expect(push.state.registeredToken, isNull);
      expect(api.registeredDeviceTokens, isEmpty);
    });
  });

  group('Push — token rotation', () {
    test('a rotated device token is re-registered with the backend', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'device-push-token-abcdefghijklmnop',
      );
      final push = build(client);
      await push.initialize();
      expect(api.registeredDeviceTokens, hasLength(1));

      client.emitTokenRefresh('rotated-device-push-token-zyxwvu987654');
      await pumpEventQueue();

      expect(api.registeredDeviceTokens, hasLength(2));
      expect(
        api.registeredDeviceTokens.last,
        'rotated-device-push-token-zyxwvu987654',
      );
      expect(
        push.state.registeredToken,
        'rotated-device-push-token-zyxwvu987654',
      );
      expect(push.state.isRegistered, isTrue);
      expect(await storage.getFcmToken(), 'rotated-device-push-token-zyxwvu987654');
    });

    test('a failed rotation does not leave a stale "registered" claim', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'device-push-token-abcdefghijklmnop',
      );
      final push = build(client);
      await push.initialize();

      api.deviceTokenError = ApiException(message: 'Registration failed');
      await push.onTokenRefresh('rotated-device-push-token-zyxwvu987654');

      expect(push.state.isRegistered, isFalse);
    });
  });

  group('Push — foreground delivery', () {
    test('a foreground push is surfaced as a backend notification', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);

      client.emitForeground(
        PushMessage(
          messageId: '507f1f77bcf86cd7994390e1',
          data: {
            'type': 'TOKEN_APPROACHING',
            'tokenId': kTokenId,
            'dedupeKey': '${kTokenId}_5_TOKENS_AWAY',
          },
          title: 'You are next',
          body: 'Please head to the counter.',
          type: 'TOKEN_APPROACHING',
          tokenId: kTokenId,
        ),
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(received, hasLength(1));
      expect(received.single.type, 'TOKEN_APPROACHING');
      expect(received.single.tokenId, kTokenId);
      expect(received.single.dedupeKey, '${kTokenId}_5_TOKENS_AWAY');
      expect(received.single.isRead, isFalse);
    });

    test('a push without a title or body is not presented as an empty alert', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);

      client.emitForeground(
        PushMessage(messageId: '507f1f77bcf86cd7994390e2', data: const {'type': 'TOKEN_CALLED'}),
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(received, isEmpty);
    });
  });

  group('Push — the same alert is never shown twice', () {
    test('a push and a socket alert sharing a dedupeKey are presented once', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);

      // The backend uses the same dedupeKey for the socket emit and the push.
      const dedupeKey = '${kTokenId}_NEXT_IN_LINE';
      client.emitForeground(
        PushMessage(
          messageId: '507f1f77bcf86cd7994390e3',
          data: {'dedupeKey': dedupeKey, 'type': 'TOKEN_APPROACHING'},
          title: 'You are next in line',
          body: 'Stay nearby.',
        ),
      );
      await pumpEventQueue();

      // The identical alert arriving over Socket.IO afterwards.
      final viaSocket = push.processIncomingNotification(
        NotificationModel(
          id: '507f1f77bcf86cd7994390e4',
          userId: kUserA,
          type: 'TOKEN_APPROACHING',
          title: 'You are next in line',
          body: 'Stay nearby.',
          isRead: false,
          dedupeKey: dedupeKey,
        ),
      );
      await sub.cancel();

      expect(viaSocket, isFalse, reason: 'already presented via push');
      expect(received, hasLength(1));
      expect(push.hasPresented(dedupeKey), isTrue);
    });

    test('a socket alert arriving first suppresses the duplicate push', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);

      const dedupeKey = '${kTokenId}_5_TOKENS_AWAY';
      final viaSocket = push.processIncomingNotification(
        NotificationModel(
          id: '507f1f77bcf86cd7994390e5',
          userId: kUserA,
          type: 'TOKEN_APPROACHING',
          title: '5 away',
          body: 'Approaching.',
          isRead: false,
          dedupeKey: dedupeKey,
        ),
      );
      expect(viaSocket, isTrue);

      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);
      client.emitForeground(
        PushMessage(
          messageId: '507f1f77bcf86cd7994390e6',
          data: {'dedupeKey': dedupeKey, 'type': 'TOKEN_APPROACHING'},
          title: '5 away',
          body: 'Approaching.',
        ),
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(received, isEmpty);
    });

    test('a genuinely different alert is still presented', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);

      client.emitForeground(
        PushMessage(
          messageId: '507f1f77bcf86cd7994390e7',
          data: {'dedupeKey': '${kTokenId}_NEXT_IN_LINE', 'type': 'TOKEN_APPROACHING'},
          title: 'Next in line',
          body: 'Stay nearby.',
        ),
      );
      await pumpEventQueue();
      client.emitForeground(
        PushMessage(
          messageId: '507f1f77bcf86cd7994390e8',
          data: const {'dedupeKey': '${kTokenId}_TOKEN_CALLED_1'},
          type: 'TOKEN_CALLED',
          title: 'It is your turn',
          body: 'Please proceed to Counter 2.',
        ),
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(received, hasLength(2));
      expect(received.last.type, 'TOKEN_CALLED');
    });

    test('a notification with no dedupe key still de-duplicates by id', () {
      final push = build(const UnavailablePushMessagingClient());
      NotificationModel n(String id) => NotificationModel(
            id: id,
            userId: kUserA,
            type: 'BROADCAST',
            title: 't',
            body: 'b',
            isRead: false,
          );

      expect(push.processIncomingNotification(n('n1')), isTrue);
      expect(push.processIncomingNotification(n('n1')), isFalse);
      expect(push.processIncomingNotification(n('n2')), isTrue);
    });
  });

  group('Push — a tap is resolved against the backend, not the payload', () {
    late BuildContext homeContext;
    late WidgetRef capturedRef;

    /// Minimal router with the same paths the production app uses.
    ///
    /// The tap handler needs a [BuildContext] that sits *below* the
    /// [GoRouter], so the trigger lives inside the `/home` page rather than in
    /// `MaterialApp.router.builder` (which wraps the Router).
    GoRouter testRouter(List<String> visited) {
      return GoRouter(
        initialLocation: '/home',
        routes: [
          GoRoute(
            path: '/home',
            builder: (_, _) => Builder(
              builder: (pageContext) {
                homeContext = pageContext;
                return const Scaffold(body: Text('home'));
              },
            ),
          ),
          GoRoute(
            path: '/login',
            builder: (_, _) {
              visited.add('/login');
              return const Scaffold(body: Text('login'));
            },
          ),
          GoRoute(
            path: '/token/live',
            builder: (_, _) {
              visited.add('/token/live');
              return const Scaffold(body: Text('live'));
            },
          ),
        ],
      );
    }

    /// Pumps a tree whose `/home` page sits *below* the [GoRouter] (so the
    /// tap handler can call `context.go`), and returns a driver that runs the
    /// handler to completion.
    ///
    /// [overrides] are passed to the [ProviderScope] itself, which is the
    /// container the handler's `ref` actually reads from.
    Future<Future<void> Function()> pumpTap(
      WidgetTester tester,
      PushNotificationService push,
      GoRouter router,
      Map<String, dynamic> payload,
      List<Override> overrides,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: overrides,
          child: Consumer(
            builder: (context, ref, _) {
              capturedRef = ref;
              return MaterialApp.router(routerConfig: router);
            },
          ),
        ),
      );
      expect(homeContext, isNotNull, reason: 'the /home page must be built');
      return () => push.handleNotificationTap(
            payload: payload,
            context: homeContext,
            ref: capturedRef,
          );
    }

    testWidgets('an authenticated tap re-fetches the token then routes to live tracking',
        (tester) async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);

      // The payload claims a position, but only the backend is trusted.
      api.activeToken = TokenModel.fromJson(
        tokenJson(tokenCode: 'A-014', currentPosition: 2, servingToken: 'A-012'),
      );

      final capturedAuth = TestAuthNotifier(
        apiService: api,
        storageService: storage,
        socketService: socket,
      );
      final capturedToken = TokenNotifier(
        apiService: api,
        socketService: socket,
        storageService: storage,
      );
      await capturedAuth.signInForTest();
      expect(capturedAuth.state.isAuthenticated, isTrue);

      final visited = <String>[];
      final router = testRouter(visited);
      addTearDown(router.dispose);

      final tap = await pumpTap(
        tester,
        push,
        router,
        const {
          'data': {
            'tokenId': kTokenId,
            'status': 'SERVING',
            'currentPosition': 9,
          },
        },
        [
          authProvider.overrideWith((ref) => capturedAuth),
          tokenProvider.overrideWith((ref) => capturedToken),
        ],
      );

      await tester.runAsync(tap);
      await tester.pumpAndSettle();

      expect(capturedToken.state.activeToken, isNotNull);
      // The authoritative value from the backend replaced the payload claim.
      expect(capturedToken.state.activeToken!.currentPosition, 2);
      expect(capturedToken.state.activeToken!.servingToken, 'A-012');
      expect(capturedToken.state.isLive, isTrue);
      expect(visited, contains('/token/live'));
    });

    testWidgets('a tap with an expired session routes through sign-in', (tester) async {
      final push = build(const UnavailablePushMessagingClient());

      final capturedAuth = TestAuthNotifier(
        apiService: api,
        storageService: storage,
        socketService: socket,
      );
      final capturedToken = TokenNotifier(
        apiService: api,
        socketService: socket,
        storageService: storage,
      );

      final visited = <String>[];
      final router = testRouter(visited);
      addTearDown(router.dispose);

      final tap = await pumpTap(
        tester,
        push,
        router,
        const {
          'data': {'tokenId': kTokenId},
        },
        [
          authProvider.overrideWith((ref) => capturedAuth),
          tokenProvider.overrideWith((ref) => capturedToken),
        ],
      );

      await tester.runAsync(tap);
      await tester.pumpAndSettle();

      // Unauthenticated: no token state is invented and the live screen is
      // not opened — the customer is sent through sign-in instead.
      expect(capturedToken.state.activeToken, isNull);
      expect(capturedAuth.state.isAuthenticated, isFalse);
      expect(visited, contains('/login'));
      expect(visited, isNot(contains('/token/live')));
    });
  });

  group('Push — a tap on a terminated/backgrounded app', () {
    test('a notification tapped at next launch is held for post-auth routing', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);

      client.emitOpened(
        PushMessage(
          messageId: '507f1f77bcf86cd7994390e9',
          data: const {'type': 'TOKEN_CALLED'},
          title: 'It is your turn',
          tokenId: kTokenId,
        ),
      );
      await pumpEventQueue();

      expect(push.state.lastBackgroundMessage, isNotNull);
      expect(push.state.lastBackgroundMessage!.messageId, '507f1f77bcf86cd7994390e9');
      expect(push.state.lastBackgroundMessage!.tokenId, kTokenId);
    });

    test('onMessageOpenedFromPlatform stores the payload without acting on it', () {
      final push = build(const UnavailablePushMessagingClient());

      push.onMessageOpenedFromPlatform(
        const PushMessage(
          messageId: '507f1f77bcf86cd7994390ea',
          data: {},
          tokenId: kTokenId,
        ),
      );

      expect(push.state.lastBackgroundMessage!.tokenId, kTokenId);
      // Merely recording the tap must not mark the token as anything.
      expect(push.state.isRegistered, isFalse);
    });

    test('PushMessage.fromPlatform tolerates both nested and flat payloads', () {
      final nested = PushMessage.fromPlatform({
        'messageId': 'm1',
        'data': {'type': 'TOKEN_CALLED', 'tokenId': kTokenId, 'notificationId': 'n1'},
        'title': 'Called',
      });
      expect(nested.type, 'TOKEN_CALLED');
      expect(nested.tokenId, kTokenId);
      expect(nested.title, 'Called');

      final flat = PushMessage.fromPlatform({
        'messageId': 'm2',
        'type': 'NO_SHOW_WARNING',
        'body': 'You may be shown out of turn',
      });
      expect(flat.type, 'NO_SHOW_WARNING');
      expect(flat.body, 'You may be shown out of turn');
    });
  });

  group('Push — logout detaches the device', () {
    test('logging out clears the stored token and the registration claim', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'device-push-token-abcdefghijklmnop',
      );
      final push = build(client);
      await push.initialize();
      expect(push.state.isRegistered, isTrue);
      expect(await storage.getFcmToken(), isNotNull);

      await push.unregisterOnLogout();

      expect(push.state.isRegistered, isFalse);
      expect(push.state.registeredToken, isNull);
      expect(push.state.permission, PushPermissionStatus.notDetermined);
      expect(push.fcmToken, isNull);
      expect(await storage.getFcmToken(), isNull);
    });

    test('a second account on the same device starts unregistered', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'device-push-token-abcdefghijklmnop',
      );
      final push = build(client);
      await push.initialize();
      await push.unregisterOnLogout();

      final nextSession = build(client);
      expect(nextSession.state.isRegistered, isFalse);
      expect(nextSession.state.registeredToken, isNull);
    });
  });
}

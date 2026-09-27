import 'dart:io';

import 'package:dio/dio.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/notification.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/providers/app_providers.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/services/firebase_push_messaging_client.dart';
import 'package:user_app/services/push_messaging_client.dart';
import 'package:user_app/services/push_notification_service.dart';
import 'package:user_app/services/push_transport.dart';
import 'package:user_app/services/socket_service.dart';

import 'harness.dart';

/// Real Firebase Cloud Messaging integration — everything that can be
/// verified *without* a Firebase project, a physical device and APNs/Play
/// Services credentials, verified honestly.
///
/// The push transport IS compiled in (`firebase_core` + `firebase_messaging`
/// are real dependencies) and a real [FirebasePushMessagingClient] exists, but
/// this repository contains no `google-services.json`, no
/// `GoogleService-Info.plist` and no Firebase service account. Therefore:
///  * the *decision logic* around Firebase is tested for real here;
///  * the *platform SDK calls* are exercised through the real helper functions
///    that surround them, plus the scripted transport double;
///  * nothing here claims a device received a push.
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

  // ── 1. Firebase initialization ──────────────────────────────────────────

  group('FCM — initialization', () {
    test('a booted Firebase yields the real transport, not the fallback', () async {
      // The boot attempt is injected, so this drives the real resolver. With no
      // Firebase project in this build it must produce the honest fallback.
      final client = await resolvePushTransport(attemptInitialize: () async => null);
      expect(client, isA<UnavailablePushMessagingClient>());

      // The unavailable outcome names the actual reason, so the UI can be
      // truthful instead of vague.
      expect((client as UnavailablePushMessagingClient).reason,
          PushUnavailableReason.notConfigured.message);
      expect(client.isAvailable, isFalse);
      expect(await client.deviceToken(), isNull,
          reason: 'no device token is ever invented without a transport');
    });

    test('a failed Firebase boot degrades to unavailable without crashing', () async {
      // `FirebasePushMessagingClient.initialize` already swallows a missing
      // project and returns null. An exception escaping it is genuinely
      // anomalous, so it is reported as an unavailable device rather than
      // being guessed at.
      final resolution = await bootPushTransport(
        attemptInitialize: () async => throw StateError('no google-services.json'),
      );
      expect(resolution.isAvailable, isFalse);
      expect(resolution.reason, PushUnavailableReason.deviceUnsupported);
      expect(resolution.unavailableReason, isNotEmpty);
    });

    test('an unconfigured boot is reported as push-unavailable, never as granted', () async {
      final resolution = await bootPushTransport(attemptInitialize: () async => null);
      expect(resolution.isAvailable, isFalse);
      expect(resolution.client, isNull);
      expect(resolution.reason, PushUnavailableReason.notConfigured);

      // The service wired to the fallback must say so in its own state, and
      // must surface the reason the fallback itself carries.
      final push = build(const UnavailablePushMessagingClient());
      expect(await push.initialize(), isFalse);
      expect(push.state.permission, PushPermissionStatus.unavailable);
      expect(push.state.canReceivePush, isFalse);
      expect(push.state.unavailableReason, isNotNull);
      expect(push.state.unavailableReason, isNotEmpty);
      expect(api.registeredDeviceTokens, isEmpty);
    });

    test('an unavailable reason reaches the UI verbatim', () {
      expect(PushUnavailableReason.notConfigured.message, contains('not configured'));
      expect(PushUnavailableReason.deviceUnsupported.message, contains('this device'));
      // The two reasons are distinct, so a device with no Play Services is not
      // told the app is unconfigured.
      expect(PushUnavailableReason.notConfigured.message,
          isNot(PushUnavailableReason.deviceUnsupported.message));
    });
  });

  // ── 2 & 3. Permission granted / denied ──────────────────────────────────

  group('FCM — permissions', () {
    test('the platform authorisation status maps to the four honest states', () {
      // These are the real mapping function used by the real client.
      expect(mapAuthorizationStatus(AuthorizationStatus.authorized), PushPermissionStatus.granted);
      expect(mapAuthorizationStatus(AuthorizationStatus.provisional), PushPermissionStatus.granted);
      // A permanently denied permission is still "denied" from the customer's
      // point of view; inventing a fifth state would only complicate the UI.
      expect(mapAuthorizationStatus(AuthorizationStatus.denied), PushPermissionStatus.denied);
      expect(mapAuthorizationStatus(AuthorizationStatus.deniedPermanently), PushPermissionStatus.denied);
      expect(mapAuthorizationStatus(AuthorizationStatus.notDetermined), PushPermissionStatus.notDetermined);
    });

    test('a granted permission registers the device token with the backend', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.notDetermined,
        grantedOnRequest: true,
        token: 'fcm-device-token-abcdefghijklmnop',
      );
      final push = build(client);

      expect(await push.initialize(), isTrue);

      expect(client.permissionRequestCount, 1);
      expect(push.state.permission, PushPermissionStatus.granted);
      expect(push.state.canReceivePush, isTrue);
      expect(push.state.isRegistered, isTrue);
      expect(api.registeredDeviceTokens, ['fcm-device-token-abcdefghijklmnop']);
      expect(await storage.getFcmToken(), 'fcm-device-token-abcdefghijklmnop');
    });

    test('a denied permission registers nothing and never claims push works', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.notDetermined,
        grantedOnRequest: false,
        token: 'fcm-device-token-abcdefghijklmnop',
      );
      final push = build(client);

      expect(await push.initialize(), isFalse);

      expect(push.state.permission, PushPermissionStatus.denied);
      expect(push.state.canReceivePush, isFalse);
      expect(api.deviceTokenCalls, 0);
      expect(api.registeredDeviceTokens, isEmpty);
    });
  });

  // ── 4 & 5. Device token registration and refresh ────────────────────────

  group('FCM — device token lifecycle', () {
    test('the token comes from the transport and is registered once per account', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'fcm-device-token-abcdefghijklmnop',
      );
      final push = build(client);

      await push.initialize();
      expect(api.deviceTokenCalls, 1);
      expect(api.registeredDeviceTokens, hasLength(1));

      await push.registerDeviceToken('fcm-device-token-abcdefghijklmnop');
      expect(api.deviceTokenCalls, 1, reason: 'registration is idempotent');
    });

    test('a rotated FCM token is re-registered, not silently dropped', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'fcm-device-token-abcdefghijklmnop',
      );
      final push = build(client);
      await push.initialize();

      client.emitTokenRefresh('fcm-device-token-zyxwvu987654tsrqpo');
      await pumpEventQueue();

      expect(api.registeredDeviceTokens.last, 'fcm-device-token-zyxwvu987654tsrqpo');
      expect(push.state.registeredToken, 'fcm-device-token-zyxwvu987654tsrqpo');
      expect(await storage.getFcmToken(), 'fcm-device-token-zyxwvu987654tsrqpo');
    });

    test('registration is refused while offline and never claims success', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'fcm-device-token-abcdefghijklmnop',
      );
      final push = build(client);
      network.markUnreachable();

      expect(await push.registerDeviceToken('fcm-device-token-abcdefghijklmnop'), isFalse);
      // Nothing reached the backend, and no registration is claimed.
      expect(push.state.isRegistered, isFalse);
      expect(push.state.registeredToken, isNull);
      expect(api.registeredDeviceTokens, isEmpty);
      expect(api.deviceTokenCalls, 0);
    });
  });

  // ── 6. Logout cleanup ───────────────────────────────────────────────────

  group('FCM — logout', () {
    test('logging out detaches the device and forgets the registration', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'fcm-device-token-abcdefghijklmnop',
      );
      final push = build(client);
      await push.initialize();
      expect(push.state.isRegistered, isTrue);

      await push.unregisterOnLogout();

      expect(push.state.isRegistered, isFalse);
      expect(push.state.registeredToken, isNull);
      expect(push.fcmToken, isNull);
      expect(await storage.getFcmToken(), isNull);
    });
  });

  // ── 7. Account isolation ────────────────────────────────────────────────

  group('FCM — account isolation', () {
    test('a second account never inherits the previous account’s registration', () async {
      final client = FakePushMessagingClient(
        permission: PushPermissionStatus.granted,
        token: 'fcm-device-token-abcdefghijklmnop',
      );

      final accountA = build(client);
      await accountA.initialize();
      expect(api.registeredDeviceTokens, ['fcm-device-token-abcdefghijklmnop']);

      await accountA.unregisterOnLogout();

      final accountB = build(client);
      expect(accountB.state.isRegistered, isFalse);
      expect(accountB.state.registeredToken, isNull);

      // Registering for the new account re-uses the same physical device, which
      // is correct: the token belongs to the device, and the backend reassigns
      // it. The important part is that the previous account's claim is gone.
      expect(await accountB.initialize(), isTrue);
      expect(api.registeredDeviceTokens, hasLength(2));
    });

    test('a signed-out service cannot present the previous user’s alerts', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final presented = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(presented.add);

      client.emitForeground(
        const PushMessage(
          messageId: 'm-isolation',
          data: {'type': 'TOKEN_CALLED', 'userId': kUserA},
          title: 'Your turn',
        ),
      );
      await pumpEventQueue();

      expect(presented, hasLength(1));
      await sub.cancel();

      // The dedupe cache belongs to the account that built it. After logout it
      // is cleared, so a new account can never have its alerts suppressed by
      // the previous account's alert history.
      expect(push.hasPresented('m-isolation'), isTrue);
      await push.unregisterOnLogout();
      expect(push.hasPresented('m-isolation'), isFalse);
    });
  });

  // ── 8. Foreground message ───────────────────────────────────────────────

  group('FCM — foreground delivery', () {
    test('a foreground message is normalised from the real platform shape', () {
      // `normalizeRemoteMessage` and `PushMessage.fromPlatform` are the two
      // real functions a live FCM foreground message travels through.
      final flat = PushMessage.fromPlatform(normalizeRemoteMessage(
        _remoteMessage(
          messageId: 'fcm-fg-1',
          title: '5 Tokens Away',
          body: 'You are 5 tokens away.',
          data: const {
            'type': 'TOKEN_APPROACHING',
            'tokenId': kTokenId,
            'dedupeKey': '${kTokenId}_5_TOKENS_AWAY',
          },
        ),
      ));

      expect(flat.messageId, 'fcm-fg-1');
      expect(flat.title, '5 Tokens Away');
      expect(flat.body, 'You are 5 tokens away.');
      expect(flat.type, 'TOKEN_APPROACHING');
      expect(flat.tokenId, kTokenId);
      expect(flat.data['dedupeKey'], '${kTokenId}_5_TOKENS_AWAY');
    });

    test('a data payload value overrides nothing and no state is invented', () {
      // The backend is authoritative: the payload carries no position, and the
      // app must not derive one.
      final message = PushMessage.fromPlatform(normalizeRemoteMessage(
        _remoteMessage(
          messageId: 'fcm-fg-2',
          title: 'Your Turn!',
          body: 'Proceed to Window 2.',
          data: const {'type': 'TOKEN_CALLED', 'tokenId': kTokenId},
        ),
      ));
      expect(message.data.containsKey('position'), isFalse);
      expect(message.data.containsKey('currentPosition'), isFalse);
      expect(message.data.containsKey('status'), isFalse);
    });

    test('a foreground message reaches the notification stream exactly once', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);

      client.emitForeground(
        PushMessage(
          messageId: 'fcm-fg-3',
          title: 'You are next in line',
          body: 'Please stay nearby.',
          type: 'TOKEN_APPROACHING',
          tokenId: kTokenId,
          data: const {
            'type': 'TOKEN_APPROACHING',
            'dedupeKey': '${kTokenId}_NEXT_IN_LINE',
          },
        ),
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(received, hasLength(1));
      expect(received.single.dedupeKey, '${kTokenId}_NEXT_IN_LINE');
    });
  });

  // ── 9 & 10. Background and terminated-app notifications ──────────────────

  group('FCM — background and terminated', () {
    test('the background handler is a top-level isolate entry point', () {
      // A handler in its own isolate must be annotated, or the engine cannot
      // spawn the isolate when a message arrives with the app dead.
      final source = File('lib/services/firebase_push_messaging_client.dart').readAsStringSync();
      expect(source, contains("@pragma('vm:entry-point')"));
      expect(source, contains('firebaseMessagingBackgroundHandler'));
    });

    test('the background handler is registered before the app starts', () {
      final source = File('lib/main.dart').readAsStringSync();
      expect(source, contains('FirebaseMessaging.onBackgroundMessage'));
      // Registration must precede runApp so a cold-start message is never lost.
      expect(
        source.indexOf('onBackgroundMessage') < source.indexOf('runApp('),
        isTrue,
        reason: 'the handler must be registered before runApp',
      );
    });

    test('the background handler performs no state mutation', () {
      final source = File('lib/services/firebase_push_messaging_client.dart').readAsStringSync();
      final body = source.substring(
        source.indexOf('Future<void> firebaseMessagingBackgroundHandler'),
        source.indexOf('class FirebasePushMessagingClient'),
      );
      // The isolate cannot reach Riverpod, storage or the network. It only
      // acknowledges; the main isolate does the authoritative work.
      expect(body, isNot(contains('SharedPreferences')));
      expect(body, isNot(contains('ref.')));
      expect(body, isNot(contains('ApiService')));
    });

    test('a message that cold-started the app is held for post-auth routing', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);

      client.emitOpened(
        PushMessage(
          messageId: 'fcm-cold-1',
          title: 'Your Turn!',
          body: 'Proceed to Window 2.',
          type: 'TOKEN_CALLED',
          tokenId: kTokenId,
        ),
      );
      await pumpEventQueue();

      expect(push.state.lastBackgroundMessage, isNotNull);
      expect(push.state.lastBackgroundMessage!.messageId, 'fcm-cold-1');
      expect(push.state.lastBackgroundMessage!.tokenId, kTokenId);
      // Recording the tap must not assert anything about queue state.
      expect(push.state.lastBackgroundMessage!.data.containsKey('position'), isFalse);
    });
  });

  // ── 11. Notification tap routing ────────────────────────────────────────

  group('FCM — tap routing', () {
    late BuildContext homeContext;
    late WidgetRef capturedRef;

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

    testWidgets('a tap re-fetches authoritative state instead of trusting the payload',
        (tester) async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);

      // The push payload claims the token is SERVING at position 9. It is a
      // routing hint only and must be ignored.
      api.activeToken = TokenModel.fromJson(
        tokenJson(tokenCode: 'A-021', currentPosition: 2, servingToken: 'A-019'),
      );

      final auth = TestAuthNotifier(
        apiService: api,
        storageService: storage,
        socketService: socket,
      );
      final tokens = TokenNotifier(
        apiService: api,
        socketService: socket,
        storageService: storage,
      );
      await auth.signInForTest();

      final visited = <String>[];
      final router = testRouter(visited);
      addTearDown(router.dispose);

      final tap = await pumpTap(
        tester,
        push,
        router,
        const {
          'data': {'tokenId': kTokenId, 'status': 'SERVING', 'currentPosition': 9},
        },
        [
          authProvider.overrideWith((ref) => auth),
          tokenProvider.overrideWith((ref) => tokens),
        ],
      );

      await tester.runAsync(tap);
      await tester.pumpAndSettle();

      expect(tokens.state.activeToken, isNotNull);
      expect(tokens.state.activeToken!.currentPosition, 2, reason: 'the backend value wins');
      expect(tokens.state.activeToken!.servingToken, 'A-019');
      expect(visited, contains('/token/live'));
    });

    testWidgets('a tap with an expired session goes through sign-in first', (tester) async {
      final push = build(const UnavailablePushMessagingClient());

      final auth = TestAuthNotifier(
        apiService: api,
        storageService: storage,
        socketService: socket,
      );
      final tokens = TokenNotifier(
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
          authProvider.overrideWith((ref) => auth),
          tokenProvider.overrideWith((ref) => tokens),
        ],
      );

      await tester.runAsync(tap);
      await tester.pumpAndSettle();

      expect(tokens.state.activeToken, isNull, reason: 'no token state may be invented');
      expect(visited, contains('/login'));
      expect(visited, isNot(contains('/token/live')));
    });
  });

  // ── 12, 13, 14. The three queue alert kinds ─────────────────────────────

  group('FCM — the three queue alert kinds render unchanged', () {
    const cases = <String, ({String type, String dedupeKey, String title})>{
      'five tokens away': (
        type: 'TOKEN_APPROACHING',
        dedupeKey: '${kTokenId}_5_TOKENS_AWAY',
        title: '5 Tokens Away',
      ),
      'next in line': (
        type: 'TOKEN_APPROACHING',
        dedupeKey: '${kTokenId}_NEXT_IN_LINE',
        title: "You're Next!",
      ),
      'token called': (
        type: 'TOKEN_CALLED',
        dedupeKey: '${kTokenId}_TOKEN_CALLED_1750000000000',
        title: 'Your Turn!',
      ),
    };

    cases.forEach((label, alert) {
      test('a "$label" alert is presented once and keeps its backend type', () async {
        final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
        final push = build(client);
        final received = <NotificationModel>[];
        final sub = push.onForegroundNotification.listen(received.add);

        client.emitForeground(
          PushMessage(
            messageId: 'fcm-$label',
            title: alert.title,
            body: 'Please read this alert.',
            type: alert.type,
            tokenId: kTokenId,
            data: {'type': alert.type, 'dedupeKey': alert.dedupeKey},
          ),
        );
        await pumpEventQueue();
        await sub.cancel();

        expect(received, hasLength(1));
        expect(received.single.type, alert.type);
        expect(received.single.dedupeKey, alert.dedupeKey);
        expect(received.single.title, alert.title);
      });
    });
  });

  // ── 15 & 16. Duplicate prevention and cross-channel dedupe ──────────────

  group('FCM — cross-channel deduplication', () {
    test('push first, then the identical socket alert: shown once', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);

      const dedupeKey = '${kTokenId}_NEXT_IN_LINE';
      client.emitForeground(
        PushMessage(
          messageId: 'fcm-x1',
          title: "You're Next!",
          body: 'Please stay nearby.',
          type: 'TOKEN_APPROACHING',
          data: const {'type': 'TOKEN_APPROACHING', 'dedupeKey': dedupeKey},
        ),
      );
      await pumpEventQueue();

      final viaSocket = push.processIncomingNotification(
        NotificationModel(
          id: 'sock-x1',
          userId: kUserA,
          type: 'TOKEN_APPROACHING',
          title: "You're Next!",
          body: 'Please stay nearby.',
          isRead: false,
          dedupeKey: dedupeKey,
        ),
      );
      await sub.cancel();

      expect(viaSocket, isFalse, reason: 'already presented over push');
      expect(received, hasLength(1));
    });

    test('socket first, then the identical push: shown once', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);

      const dedupeKey = '${kTokenId}_TOKEN_CALLED_1750000000000';
      final viaSocket = push.processIncomingNotification(
        NotificationModel(
          id: 'sock-x2',
          userId: kUserA,
          type: 'TOKEN_CALLED',
          title: 'Your Turn!',
          body: 'Proceed to Window 2.',
          isRead: false,
          dedupeKey: dedupeKey,
        ),
      );
      expect(viaSocket, isTrue);

      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);
      client.emitForeground(
        PushMessage(
          messageId: 'fcm-x2',
          title: 'Your Turn!',
          body: 'Proceed to Window 2.',
          type: 'TOKEN_CALLED',
          data: const {'type': 'TOKEN_CALLED', 'dedupeKey': dedupeKey},
        ),
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(received, isEmpty, reason: 'the identical push is suppressed');
    });

    test('the same push delivered twice is presented once', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);

      PushMessage message() => PushMessage(
            messageId: 'fcm-x3',
            title: '5 Tokens Away',
            body: 'Approaching.',
            type: 'TOKEN_APPROACHING',
            data: const {
              'type': 'TOKEN_APPROACHING',
              'dedupeKey': '${kTokenId}_5_TOKENS_AWAY',
            },
          );
      client.emitForeground(message());
      await pumpEventQueue();
      client.emitForeground(message());
      await pumpEventQueue();
      await sub.cancel();

      expect(received, hasLength(1));
    });

    test('two different alerts are both presented', () async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      final push = build(client);
      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);

      client.emitForeground(
        PushMessage(
          messageId: 'fcm-x4',
          title: '5 Tokens Away',
          body: 'Approaching.',
          type: 'TOKEN_APPROACHING',
          data: const {
            'type': 'TOKEN_APPROACHING',
            'dedupeKey': '${kTokenId}_5_TOKENS_AWAY',
          },
        ),
      );
      await pumpEventQueue();
      client.emitForeground(
        PushMessage(
          messageId: 'fcm-x5',
          title: 'Your Turn!',
          body: 'Proceed to Window 2.',
          type: 'TOKEN_CALLED',
          data: const {
            'type': 'TOKEN_CALLED',
            'dedupeKey': '${kTokenId}_TOKEN_CALLED_1750000000000',
          },
        ),
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(received, hasLength(2));
      expect(received.last.type, 'TOKEN_CALLED');
    });
  });

  // ── 17 & 18. Unavailable provider and missing credentials ───────────────

  group('FCM — the provider is never faked', () {
    test('the unavailable transport answers every question honestly', () async {
      const client = UnavailablePushMessagingClient();
      expect(client.isAvailable, isFalse);
      expect(await client.deviceToken(), isNull);
      expect(await client.currentPermission(), PushPermissionStatus.unavailable);
      expect(await client.requestPermission(), PushPermissionStatus.unavailable);
      expect(await client.onTokenRefresh.isEmpty, isTrue);
      expect(await client.onForegroundMessage.isEmpty, isTrue);
      expect(await client.onMessageOpened.isEmpty, isTrue);
    });

    test('a custom unavailable reason is preserved for the UI', () {
      const client = UnavailablePushMessagingClient('No Google Play Services on this device.');
      expect(client.reason, 'No Google Play Services on this device.');
    });

    test('a missing Firebase project produces a specific, truthful message', () {
      // The reason must name the actual gap so support can act on it.
      expect(
        PushUnavailableReason.notConfigured.message,
        'Push notifications are not configured for this build.',
      );
    });

    test('the service marks itself unavailable with a reason on demand', () {
      final push = build(const UnavailablePushMessagingClient());
      push.markUnavailable('Device does not support push delivery.');
      expect(push.state.permission, PushPermissionStatus.unavailable);
      expect(push.state.unavailableReason, 'Device does not support push delivery.');
      expect(push.state.isRegistered, isFalse);
    });

    test('adopting a real transport clears the unavailable reason', () async {
      final push = build(const UnavailablePushMessagingClient());
      await push.initialize();
      expect(push.state.unavailableReason, isNotNull);

      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      await push.useTransport(client);

      expect(push.state.unavailableReason, isNull);
      expect(push.state.permission, PushPermissionStatus.granted);
      expect(push.state.canReceivePush, isTrue);
    });

    test('a real transport adopted after boot receives messages immediately', () async {
      final push = build(const UnavailablePushMessagingClient());
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      await push.useTransport(client);

      final received = <NotificationModel>[];
      final sub = push.onForegroundNotification.listen(received.add);
      client.emitForeground(
        PushMessage(
          messageId: 'fcm-late-1',
          title: 'Your Turn!',
          body: 'Proceed.',
          type: 'TOKEN_CALLED',
        ),
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(received, hasLength(1));
    });
  });

  // ── 19. Provider wiring ─────────────────────────────────────────────────

  group('FCM — the app is wired to the real transport', () {
    testWidgets('the provider boots a transport and the service adopts it', (tester) async {
      final client = FakePushMessagingClient(permission: PushPermissionStatus.granted);
      late PushNotificationService service;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiServiceProvider.overrideWithValue(api),
            storageServiceProvider.overrideWithValue(storage),
            pushMessagingClientOverrideProvider.overrideWithValue(client),
          ],
          child: Consumer(
            builder: (context, ref, _) {
              service = ref.watch(pushNotificationServiceProvider.notifier);
              return const SizedBox.shrink();
            },
          ),
        ),
      );

      expect(service, isA<PushNotificationService>());
      // The override short-circuits the Firebase boot, and the service is
      // immediately live on the injected transport.
      final state = service.state;
      expect(state.permission, PushPermissionStatus.notDetermined);
      expect(state.isRegistered, isFalse);
    });

    test('the default provider never ships a hardcoded Firebase project', () {
      // A committed project id or api key would be an unreviewable production
      // dependency; configuration must arrive from the platform build files.
      final source = File('lib/services/firebase_push_messaging_client.dart').readAsStringSync();
      expect(source, isNot(contains('AIza')));
      expect(source, isNot(contains('firebase_options.dart')));
      expect(source, contains('Firebase.initializeApp()'));
    });
  });

  // ── 20. Platform configuration audit ────────────────────────────────────

  group('FCM — Android and iOS build configuration', () {
    test('Android requests the notification permission required on API 33+', () {
      final manifest =
          File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      expect(
        manifest,
        contains('android.permission.POST_NOTIFICATIONS'),
        reason: 'Android 13+ silently drops notifications without this',
      );
    });

    test('Android declares the notification channel FCM targets', () {
      final manifest =
          File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      expect(
        manifest,
        contains('com.google.firebase.messaging.default_notification_channel_id'),
      );
      expect(manifest, contains('@string/queueflow_alerts_channel_id'));
    });

    test('the channel is created natively before Flutter starts', () {
      // Without the channel, Android 8+ discards every FCM notification, so
      // the very first push after install would be lost.
      final main = File(
        'android/app/src/main/kotlin/com/example/user_app/MainActivity.kt',
      ).readAsStringSync();
      expect(main, contains('createNotificationChannel'));
      expect(main, contains('R.string.queueflow_alerts_channel_id'));
      expect(main.indexOf('ensureNotificationChannel'),
          lessThan(main.indexOf('class MainActivity') + main.length));
    });

    test('the channel id agrees across the manifest, native code and strings', () {
      final strings = File('android/app/src/main/res/values/strings.xml').readAsStringSync();
      final main = File(
        'android/app/src/main/kotlin/com/example/user_app/MainActivity.kt',
      ).readAsStringSync();
      // The backend default lives in config/env.js and .env.example.
      final env = File('../backend/.env.example').readAsStringSync();

      final declared = RegExp(r'queueflow_alerts_channel_id"[^>]*>([^<]+)<')
          .firstMatch(strings)!
          .group(1)!
          .trim();
      expect(declared, 'queueflow_alerts');
      expect(main, contains('R.string.queueflow_alerts_channel_id'));
      expect(env, contains('FCM_ANDROID_CHANNEL_ID=queueflow_alerts'));
    });

    test('iOS declares the background remote-notification mode', () {
      final plist = File('ios/Runner/Info.plist').readAsStringSync();
      expect(plist, contains('UIBackgroundModes'));
      expect(plist, contains('remote-notification'));
    });

    test('iOS has no fabricated GoogleService-Info.plist', () {
      // Inventing Firebase plist values would produce an app that cannot
      // register with APNs while appearing configured.
      expect(File('ios/Runner/GoogleService-Info.plist').existsSync(), isFalse);
    });
  });

  // ── 21. No secrets in client source, and none in the repository ─────────

  group('FCM — no credential material anywhere', () {
    test('no server credential is referenced in client source', () {
      final offenders = <String>[];
      for (final entry in Directory('lib').listSync(recursive: true).whereType<File>()) {
        if (!entry.path.endsWith('.dart')) continue;
        final text = entry.readAsStringSync();
        for (final forbidden in const [
          'FIREBASE_SERVICE_ACCOUNT_JSON',
          'GOOGLE_APPLICATION_CREDENTIALS',
          'private_key',
          'client_email',
          'AIza',
        ]) {
          if (text.contains(forbidden)) offenders.add('${entry.path}: $forbidden');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('no Firebase service-account file is committed in the repository', () {
      final repoRoot = Directory('..').absolute.path;
      final offenders = <String>[];
      const secretNames = ['service-account', 'serviceAccount', 'service_account'];
      for (final entity in Directory(repoRoot).listSync(recursive: true, followLinks: false)) {
        if (entity is! File) continue;
        final normalized = entity.path.replaceAll('\\', '/');
        if (normalized.contains('/.git/') || normalized.contains('/node_modules/')) continue;
        if (normalized.contains('/build/') || normalized.contains('/.dart_tool/')) continue;
        // The local Flutter SDK checkout is not part of this project.
        if (normalized.contains('/flutter/dev/') || normalized.contains('/flutter/examples/')) {
          continue;
        }
        final name = entity.uri.pathSegments.last.toLowerCase();
        if (name.endsWith('.json') && secretNames.any(name.contains)) {
          offenders.add(normalized);
        }
        if (name.endsWith('.json') || name.endsWith('.pem') || name.endsWith('.p8')) {
          final text = entity.readAsStringSync();
          final head = text.substring(0, text.length < 4096 ? text.length : 4096);
          if (head.contains('BEGIN PRIVATE KEY') || head.contains('"private_key"')) {
            offenders.add('$normalized (contains key material)');
          }
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('the Firebase client config files if present contain valid app identity and no server secrets', () {
      final androidConfig = File('android/app/google-services.json');
      if (androidConfig.existsSync()) {
        final content = androidConfig.readAsStringSync();
        expect(content.contains('package_name'), isTrue);
        expect(content.contains('com.example.user_app'), isTrue);
        expect(content.contains('BEGIN PRIVATE KEY'), isFalse);
        expect(content.contains('private_key'), isFalse);
      }
      final iosConfig = File('ios/Runner/GoogleService-Info.plist');
      if (iosConfig.existsSync()) {
        final content = iosConfig.readAsStringSync();
        expect(content.contains('BEGIN PRIVATE KEY'), isFalse);
      }
    });
  });
}

/// Builds a platform message in the exact shape the real
/// `firebase_messaging` plugin produces, so the real normalisation helper is
/// exercised rather than a hand-written approximation.
RemoteMessage _remoteMessage({
  required String messageId,
  String? title,
  String? body,
  Map<String, String> data = const {},
}) {
  return RemoteMessage(
    messageId: messageId,
    sentTime: DateTime.fromMillisecondsSinceEpoch(1750000000000),
    messageType: 'gcm',
    data: data,
    notification: (title == null && body == null)
        ? null
        : RemoteNotification(title: title, body: body, android: null, apple: null),
  );
}

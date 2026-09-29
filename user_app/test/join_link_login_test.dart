import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/core/router/app_router.dart';
import 'package:user_app/main.dart';
import 'package:user_app/models/queue_status.dart';
import 'package:user_app/models/service.dart';
import 'package:user_app/models/service_center.dart';
import 'package:user_app/providers/app_providers.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:user_app/screens/queue/queue_preview_screen.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/utils/join_link_service.dart';
import 'package:user_app/utils/qr_payload_parser.dart';

import 'harness.dart';

/// Step 9 — a scanned queue-join link survives authentication.
///
/// This is the case the whole deep-link design exists for. A customer opens the
/// canonical HTTPS QR at the service desk, gets bounced to `/login` because
/// they have no session yet, signs up or signs in — and must arrive at the same
/// centre, and the same service, they were trying to join. Landing on the home
/// screen and making them find the screen and scan again is the bug.
///
/// The test drives the real composition from `main.dart`: the real router, its
/// real `redirect`, and the real `JoinLinkListener` mounted in
/// `MaterialApp.router.builder`. Only the network and secure storage are
/// replaced.
void main() {
  late FakeApiService api;
  late FakeStorageService storage;
  late SocketService socket;
  late NetworkStatus network;
  late TestAuthNotifier auth;
  late ProviderContainer container;

  /// The centre the fixtures describe.
  final center = ServiceCenter.fromJson(
    serviceCenterJson(operatingHours: [
      operatingHoursDay(day: 'MON', open: '00:00', close: '23:59'),
      operatingHoursDay(day: 'TUE', open: '00:00', close: '23:59'),
      operatingHoursDay(day: 'WED', open: '00:00', close: '23:59'),
      operatingHoursDay(day: 'THU', open: '00:00', close: '23:59'),
      operatingHoursDay(day: 'FRI', open: '00:00', close: '23:59'),
      operatingHoursDay(day: 'SAT', open: '00:00', close: '23:59'),
      operatingHoursDay(day: 'SUN', open: '00:00', close: '23:59'),
    ]),
  );
  final service = Service.fromJson(const {
    '_id': kServiceId,
    'name': 'Passport Services',
    'code': 'PASS',
    'centerId': kCenterId,
    'isActive': true,
    'tokenPrefix': 'P',
    'avgServiceTimeMinutes': 12,
  });

  void seed() {
    api.centerDetails[kCenterId] = center;
    api.services = [service];
    api.queueStatuses = [
      QueueStatus.fromJson(
        queueSummaryJson(
          serviceId: kServiceId,
          serviceName: 'Passport Services',
          waitingCount: 4,
          estimatedWaitMinutes: 18,
        ),
      ),
    ];
    api.queueDetails = serviceQueueJson(
      queueStatus: 'OPEN',
      waitingCount: 4,
      activeCount: 2,
      estimatedWaitMinutes: 18,
      waitingTokens: [queueTokenJson(tokenCode: 'P-021', tokenNumber: 21)],
      servingToken: queueTokenJson(
        id: '507f1f77bcf86cd7994390e1',
        tokenCode: 'P-018',
        tokenNumber: 18,
        status: 'SERVING',
      ),
      activeCounters: [activeCounterJson(currentToken: 'P-018')],
    );
  }

  setUp(() {
    network = NetworkStatus();
    api = FakeApiService(Dio(), networkStatus: network);
    storage = FakeStorageService();
    socket = SocketService();
    auth = TestAuthNotifier(
      apiService: api,
      storageService: storage,
      socketService: socket,
    );
    seed();

    container = ProviderContainer(
      overrides: [
        storageServiceProvider.overrideWithValue(storage),
        apiServiceProvider.overrideWithValue(api),
        socketServiceProvider.overrideWithValue(socket),
        authProvider.overrideWith((ref) => auth),
      ],
    );
    addTearDown(() async {
      container.dispose();
      network.dispose();
    });
  });

  String? location() =>
      container.read(routerProvider).routerDelegate.currentConfiguration.uri.toString();

  /// Unmounts the app so the container is not disposed while a live tree is
  /// still reading from it.
  ///
  /// The container is owned by this test rather than by a [ProviderScope], so it
  /// has to be torn down after the tree, not before — otherwise disposal races
  /// the final frame and the failure surfaces as a stray GlobalKey clash
  /// instead of the real cause.
  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  }

  /// Mounts the real app and settles it, on a surface tall enough to build the
  /// whole join screen.
  ///
  /// The 800x600 default leaves the metric tiles below the fold, and the screen
  /// is a `ListView` — which does not build what is off screen. Asserting
  /// `find.text('4')` there would be asserting on a widget that legitimately
  /// does not exist yet. Handset width is kept at 400 logical pixels so the
  /// layout under test is the real two-column one.
  Future<void> pumpApp(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 3600);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: const QueueFlowApp(),
    ));
    await tester.pumpAndSettle();
  }

  const scanCenter = QrJoinPayload(
    centerId: kCenterId,
    serviceId: kServiceId,
    format: QrJoinFormat.httpsWeb,
  );

  group('Step 9 — the destination a link resolves to', () {
    test('a centre + service link resolves to that exact queue preview', () {
      expect(
        joinRouteFor(scanCenter),
        '/join/preview?centerId=$kCenterId&serviceId=$kServiceId',
      );
    });

    test('a centre-only link resolves to the service chooser for that centre', () {
      // Naming a service the QR did not name would mean showing a queue the
      // customer never asked to join.
      expect(
        joinRouteFor(const QrJoinPayload(centerId: kCenterId)),
        '/join/services?centerId=$kCenterId',
      );
    });

    test('the route is the only thing that identifies the destination', () {
      // Ids only, no resolved models: a route that cannot be rebuilt from a
      // string cannot survive a login redirect or a process restart.
      expect(joinRouteFor(scanCenter), isNot(contains('extra')));
      expect(Uri.parse(joinRouteFor(scanCenter)).queryParameters['centerId'], kCenterId);
      expect(Uri.parse(joinRouteFor(scanCenter)).queryParameters['serviceId'], kServiceId);
    });

    test('two payloads for the same queue are the same link, whatever the format', () {
      // A freshly printed HTTPS code and an old custom-scheme one name the same
      // queue. Callers use this to recognise "still the link we parked".
      expect(
        const QrJoinPayload(centerId: kCenterId, serviceId: kServiceId),
        const QrJoinPayload(
          centerId: kCenterId,
          serviceId: kServiceId,
          format: QrJoinFormat.httpsWeb,
        ),
      );
      expect(
        const QrJoinPayload(centerId: kCenterId, serviceId: kServiceId),
        isNot(const QrJoinPayload(centerId: kCenterId)),
      );
    });
  });

  group('Step 9 — scan, then sign in', () {
    testWidgets('a link parked while signed out survives the login redirect', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester);

      // Signed out: the app is on the sign-in screen, as it must be.
      expect(auth.state.isAuthenticated, isFalse);
      expect(location(), '/login');

      // The customer scans the QR. Nothing can be looked up yet — the payload
      // is parked instead of being acted on.
      container.read(pendingJoinLinkProvider.notifier).set(scanCenter);
      await tester.pumpAndSettle();

      expect(location(), '/login', reason: 'a signed-out scan must not navigate');
      expect(api.centerDetailCalls, 0, reason: 'and must not call the backend');
      expect(
        container.read(pendingJoinLinkProvider),
        scanCenter,
        reason: 'the link is held, not lost',
      );

      // Now they sign in — the normal order for a first-time customer.
      await auth.signInForTest();
      await tester.pumpAndSettle();

      expect(
        location(),
        '/join/preview?centerId=$kCenterId&serviceId=$kServiceId',
        reason: 'the same queue, not the home screen and a second scan',
      );
      expect(find.byType(QueuePreviewScreen), findsOneWidget);

      // The preview reads the backend itself for this centre and service.
      expect(api.centerDetailCalls, greaterThan(0));
      expect(api.serviceListCalls, greaterThan(0));
      expect(find.text('Passport Services'), findsWidgets);

      await unmount(tester);

      // The link is spent: it must not hijack the next sign-in.
      expect(container.read(pendingJoinLinkProvider), isNull);
    });

    testWidgets('the redirected preview shows the real queue, not a placeholder', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester);

      container.read(pendingJoinLinkProvider.notifier).set(scanCenter);
      await auth.signInForTest();
      await tester.pumpAndSettle();

      // Every figure came from the backend response.
      expect(find.text('4'), findsWidgets, reason: 'queue.waitingCount');
      expect(find.text('~18 min'), findsWidgets, reason: 'estimatedWaitMinutes');
      expect(find.text('P-018'), findsWidgets, reason: 'servingToken');
      expect(find.text('P-021'), findsWidgets, reason: 'waitingTokens[0]');
      expect(find.text('JOIN QUEUE'), findsOneWidget);
      // No token exists until the customer asks for one.
      expect(api.joinCalls, 0);

      await unmount(tester);
    });

    testWidgets('a centre-only link lands on the chooser, not a fabricated queue', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester);

      container.read(pendingJoinLinkProvider.notifier)
          .set(const QrJoinPayload(centerId: kCenterId));
      await auth.signInForTest();
      await tester.pumpAndSettle();

      expect(location(), '/join/services?centerId=$kCenterId');
      expect(find.byType(QueuePreviewScreen), findsNothing);
      expect(find.text('Passport Services'), findsWidgets);
      expect(api.joinCalls, 0);

      await unmount(tester);
    });

    testWidgets('a link already spent does not hijack a later sign-in', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester);

      container.read(pendingJoinLinkProvider.notifier).set(scanCenter);
      await auth.signInForTest();
      await tester.pumpAndSettle();
      expect(location(), '/join/preview?centerId=$kCenterId&serviceId=$kServiceId');

      // Sign out and back in without scanning anything new.
      await auth.logout();
      await tester.pumpAndSettle();
      expect(location(), '/login');

      await auth.signInForTest();
      await tester.pumpAndSettle();

      expect(
        location(),
        '/home',
        reason: 'a consumed link is not a bookmark',
      );

      await unmount(tester);
    });
  });

  group('Step 9 — a warm deep link while already signed in', () {
    testWidgets('the transit screen hands the parked link to the queue preview', (
      WidgetTester tester,
    ) async {
      await auth.signInForTest();
      await pumpApp(tester);
      expect(location(), '/home');

      // The phone camera opened the canonical link while the app was running:
      // the engine pushes it as a route, which matches the `/join` route.
      container.read(pendingJoinLinkProvider.notifier).set(scanCenter);
      final router = container.read(routerProvider);
      router.go(joinLinkLocation());
      await tester.pumpAndSettle();

      expect(
        location(),
        '/join/preview?centerId=$kCenterId&serviceId=$kServiceId',
        reason: 'a warm link must reach the same queue as a cold one',
      );
      expect(container.read(pendingJoinLinkProvider), isNull);

      await unmount(tester);
    });

    testWidgets('a /join route with nothing to join returns the customer to the app', (
      WidgetTester tester,
    ) async {
      await auth.signInForTest();
      await pumpApp(tester);

      // A /join URL this build cannot act on must not leave a spinner on screen.
      container.read(routerProvider).go(joinLinkLocation());
      await tester.pumpAndSettle();

      expect(location(), '/home');

      await unmount(tester);
    });

    testWidgets('an inbound link while signed out is not navigated before sign-in', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester);

      container.read(pendingJoinLinkProvider.notifier).set(scanCenter);
      final router = container.read(routerProvider);
      router.go(joinLinkLocation());
      await tester.pumpAndSettle();

      expect(
        location(),
        '/login',
        reason: 'there is no session to load a queue with yet',
      );
      expect(find.byType(QueuePreviewScreen), findsNothing);
      expect(container.read(pendingJoinLinkProvider), scanCenter);

      await unmount(tester);
    });
  });

  group('The parked link is cleared safely', () {
    test('take() only clears the link it was given', () {
      final notifier = container.read(pendingJoinLinkProvider.notifier);
      final first = const QrJoinPayload(centerId: kCenterId, serviceId: kServiceId);
      final second = const QrJoinPayload(
        centerId: kCenterId,
        serviceId: kNextServiceId,
        format: QrJoinFormat.httpsWeb,
      );

      notifier.set(first);
      expect(notifier.take(second), isFalse, reason: 'a newer scan must survive');
      expect(container.read(pendingJoinLinkProvider), first);

      expect(notifier.take(first), isTrue);
      expect(container.read(pendingJoinLinkProvider), isNull);

      expect(notifier.take(first), isFalse, reason: 'clearing twice is not an error');
    });

    test('nothing parked is a no-op, not a crash', () {
      expect(container.read(pendingJoinLinkProvider), isNull);
      expect(
        container.read(pendingJoinLinkProvider.notifier).take(
              const QrJoinPayload(centerId: kCenterId),
            ),
        isFalse,
      );
    });
  });

  group('The inbound listener holds state without navigating', () {
    testWidgets('the builder context has no router, which is why it does not push', (
      WidgetTester tester,
    ) async {
      // Recorded, not asserted by exception: this is the constraint the whole
      // inbound design is built around. A `MaterialApp.router.builder` context
      // sits above the Navigator, so `GoRouter.of` and `Overlay.of` are both
      // null there. If that ever changes, the listener could navigate directly
      // and this whole file would be asserting a limitation that no longer
      // exists.
      BuildContext? builderContext;
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(
          routerConfig: container.read(routerProvider),
          builder: (context, child) {
            builderContext = context;
            return child ?? const SizedBox.shrink();
          },
        ),
      ));
      await tester.pumpAndSettle();

      expect(builderContext, isNotNull);
      expect(GoRouter.maybeOf(builderContext!), isNull);

      await unmount(tester);
    });
  });
}

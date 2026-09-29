import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/core/theme/app_theme.dart';
import 'package:user_app/models/queue_status.dart';
import 'package:user_app/models/service.dart';
import 'package:user_app/models/service_center.dart';
import 'package:user_app/providers/app_providers.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:user_app/providers/join_preview_provider.dart';
import 'package:user_app/screens/queue/queue_preview_screen.dart';
import 'package:user_app/services/location_service.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/widgets/service_center_card.dart';

import 'harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeApiService api;
  late NetworkStatus network;
  late TestAuthNotifier auth;
  late FakeStorageService storage;
  late SocketService socket;
  late FakeLocationService locationService;
  late ProviderContainer container;

  Service testService() => Service.fromJson(const {
        '_id': kServiceId,
        'name': 'Admissions',
        'code': 'ADM',
        'centerId': kCenterId,
        'isActive': true,
        'tokenPrefix': 'A',
        'avgServiceTimeMinutes': 10,
      });

  setUp(() {
    network = NetworkStatus();
    api = FakeApiService(Dio(), networkStatus: network);
    storage = FakeStorageService();
    socket = SocketService();
    locationService = FakeLocationService();
    auth = TestAuthNotifier(
      apiService: api,
      storageService: storage,
      socketService: socket,
    );
    api.services = [testService()];
    api.queueStatuses = [
      QueueStatus.fromJson(
        queueSummaryJson(
          serviceId: kServiceId,
          serviceName: 'Admissions',
          waitingCount: 2,
          estimatedWaitMinutes: 10,
        ),
      ),
    ];
    api.queueDetails = serviceQueueJson(
      queueStatus: 'OPEN',
      waitingCount: 2,
      activeCount: 1,
      estimatedWaitMinutes: 10,
      waitingTokens: [queueTokenJson(tokenCode: 'A-010', tokenNumber: 10)],
      activeCounters: [activeCounterJson(currentToken: 'A-009')],
    );

    container = ProviderContainer(
      overrides: [
        storageServiceProvider.overrideWithValue(storage),
        apiServiceProvider.overrideWithValue(api),
        socketServiceProvider.overrideWithValue(socket),
        authProvider.overrideWith((ref) => auth),
        locationServiceProvider.overrideWithValue(locationService),
      ],
    );
  });

  tearDown(() {
    container.dispose();
    network.dispose();
  });

  Future<void> pumpPreview(WidgetTester tester, {required ServiceCenter center}) async {
    tester.view.physicalSize = const Size(800, 6000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();

    api.centerDetails[kCenterId] = center;
    container.invalidate(joinPreviewProvider(const JoinPreviewRequest(centerId: kCenterId, serviceId: kServiceId)));

    final router = GoRouter(
      initialLocation: '/join/preview',
      routes: [
        GoRoute(
          path: '/join/preview',
          builder: (context, state) => const QueuePreviewScreen(
            centerId: kCenterId,
            serviceId: kServiceId,
          ),
        ),
        GoRoute(
          path: '/join/services',
          builder: (context, state) => const Scaffold(body: Text('CHOOSER')),
        ),
        GoRoute(
          path: '/token/live',
          builder: (context, state) => const Scaffold(body: Text('LIVE TOKEN')),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(
          theme: AppTheme.darkTheme,
          routerConfig: router,
        ),
      ),
    );
    await tester.pump();
    await tester.pumpAndSettle();
  }

  group('Haversine distance calculation and formatting', () {
    test('calculateHaversineDistanceMeters calculates accurate geodesic distance', () {
      const collegeLat = 12.9716;
      const collegeLng = 77.5946;

      // Same point = 0 meters
      final zero = calculateHaversineDistanceMeters(collegeLat, collegeLng, collegeLat, collegeLng);
      expect(zero.round(), 0);

      // Points offset along latitude
      final pt50Lat = collegeLat + (50.0 / 6371000.0) * (180.0 / 3.141592653589793);
      final dist50 = calculateHaversineDistanceMeters(collegeLat, collegeLng, pt50Lat, collegeLng);
      expect(dist50.round(), 50);

      final pt100Lat = collegeLat + (100.0 / 6371000.0) * (180.0 / 3.141592653589793);
      final dist100 = calculateHaversineDistanceMeters(collegeLat, collegeLng, pt100Lat, collegeLng);
      expect(dist100.round(), 100);

      final pt101Lat = collegeLat + (101.0 / 6371000.0) * (180.0 / 3.141592653589793);
      final dist101 = calculateHaversineDistanceMeters(collegeLat, collegeLng, pt101Lat, collegeLng);
      expect(dist101.round(), 101);
    });

    test('formatDistance formats meters and kilometers accurately', () {
      expect(formatDistance(42), '42 m');
      expect(formatDistance(100), '100 m');
      expect(formatDistance(999), '999 m');
      expect(formatDistance(1000), '1.0 km');
      expect(formatDistance(1800), '1.8 km');
      expect(formatDistance(12500), '12.5 km');
    });
  });

  group('ServiceCenterCard location badge', () {
    testWidgets('displays within range badge when user is within center radius', (tester) async {
      final center = ServiceCenter.fromJson(serviceCenterJson(
        id: kCenterId,
        name: 'College Account',
        location: {'latitude': 12.9716, 'longitude': 77.5946},
        geofence: {'enabled': true, 'radiusMeters': 100},
      ));

      const userLoc = UserLocation(latitude: 12.971977, longitude: 77.5946);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.darkTheme,
          home: Scaffold(
            body: ServiceCenterCard(
              center: center,
              userLocation: userLoc,
              onTap: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Within range'), findsOneWidget);
    });

    testWidgets('displays out of range badge when user is far away', (tester) async {
      final center = ServiceCenter.fromJson(serviceCenterJson(
        id: kCenterId,
        name: 'College Account',
        location: {'latitude': 12.9716, 'longitude': 77.5946},
        geofence: {'enabled': true, 'radiusMeters': 100},
      ));

      const userLoc = UserLocation(latitude: 23.0225, longitude: 72.5714);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.darkTheme,
          home: Scaffold(
            body: ServiceCenterCard(
              center: center,
              userLocation: userLoc,
              onTap: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Out of range'), findsOneWidget);
    });
  });

  group('QueuePreviewScreen location geofencing UX', () {
    testWidgets('shows IN RANGE, WITHIN SERVICE AREA and enables JOIN QUEUE when within 100m', (tester) async {
      final collegeCenter = ServiceCenter.fromJson(serviceCenterJson(
        id: kCenterId,
        name: 'College Account',
        location: {'latitude': 12.9716, 'longitude': 77.5946},
        geofence: {'enabled': true, 'radiusMeters': 100},
      ));

      // Fake location service reports user at 42m away with fresh timestamp
      locationService.enabled = true;
      locationService.currentLocation = UserLocation(
        latitude: 12.971977,
        longitude: 77.5946,
        accuracy: 10,
        timestamp: DateTime.now(),
      );

      await pumpPreview(tester, center: collegeCenter);

      // Check card contents
      expect(find.text('IN RANGE'), findsOneWidget);
      expect(find.text('WITHIN SERVICE AREA'), findsOneWidget);
      expect(find.text('You are 42 m from this center.'), findsOneWidget);

      // Check CTA is enabled with 'JOIN QUEUE'
      final joinButton = tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      expect(joinButton.onPressed, isNotNull, reason: 'CTA must be enabled when within range');
    });

    testWidgets('shows OUT OF RANGE and disables JOIN QUEUE when beyond 100m', (tester) async {
      final collegeCenter = ServiceCenter.fromJson(serviceCenterJson(
        id: kCenterId,
        name: 'College Account',
        location: {'latitude': 12.9716, 'longitude': 77.5946},
        geofence: {'enabled': true, 'radiusMeters': 100},
      ));

      // Fake location service reports user 1.8 km away
      final pt1800Lat = 12.9716 + (1800.0 / 6371000.0) * (180.0 / 3.141592653589793);
      locationService.enabled = true;
      locationService.currentLocation = UserLocation(
        latitude: pt1800Lat,
        longitude: 77.5946,
        accuracy: 15,
        timestamp: DateTime.now(),
      );

      await pumpPreview(tester, center: collegeCenter);

      // Check card contents
      expect(find.text('OUT OF RANGE'), findsOneWidget);
      expect(find.text('You are 1.8 km from this center.'), findsOneWidget);
      expect(find.text('You must be within 100 m to join.'), findsOneWidget);

      // Check CTA is disabled
      final joinButton = tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      expect(joinButton.onPressed, isNull, reason: 'CTA must be disabled when out of range');
    });

    testWidgets('shows LOCATION REFRESHING and disables JOIN QUEUE when location is stale (>90s)', (tester) async {
      final collegeCenter = ServiceCenter.fromJson(serviceCenterJson(
        id: kCenterId,
        name: 'College Account',
        location: {'latitude': 12.9716, 'longitude': 77.5946},
        geofence: {'enabled': true, 'radiusMeters': 100},
      ));

      // Fake location service reports position older than 90 seconds
      locationService.enabled = true;
      locationService.currentLocation = UserLocation(
        latitude: 12.971977,
        longitude: 77.5946,
        accuracy: 10,
        timestamp: DateTime.now().subtract(const Duration(seconds: 120)),
      );

      await pumpPreview(tester, center: collegeCenter);

      // Verify that stale location does NOT show IN RANGE and does NOT enable JOIN QUEUE
      expect(find.text('LOCATION REFRESHING'), findsOneWidget);
      expect(find.text('Waiting for a fresh GPS position…'), findsOneWidget);
      expect(find.text('IN RANGE'), findsNothing);

      final joinButton = tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      expect(joinButton.onPressed, isNull, reason: 'CTA must be disabled when location reading is stale');
    });

    testWidgets('shows Unable to verify your location and disables JOIN QUEUE when location is unavailable', (tester) async {
      final collegeCenter = ServiceCenter.fromJson(serviceCenterJson(
        id: kCenterId,
        name: 'College Account',
        location: {'latitude': 12.9716, 'longitude': 77.5946},
        geofence: {'enabled': true, 'radiusMeters': 100},
      ));

      // Fake location service disabled/unavailable
      locationService.enabled = false;
      locationService.currentLocation = null;

      await pumpPreview(tester, center: collegeCenter);

      // Check error and retry button
      expect(find.text('Unable to verify your location'), findsWidgets);
      expect(find.text('RETRY LOCATION'), findsOneWidget);

      // Check CTA is disabled
      final joinButton = tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      expect(joinButton.onPressed, isNull, reason: 'CTA must be disabled when location is unverified');
    });

    testWidgets('live stream updates distance: IN_RANGE -> OUT_OF_RANGE -> IN_RANGE transitions', (tester) async {
      final collegeCenter = ServiceCenter.fromJson(serviceCenterJson(
        id: kCenterId,
        name: 'College Account',
        location: {'latitude': 12.9716, 'longitude': 77.5946},
        geofence: {'enabled': true, 'radiusMeters': 100},
      ));

      // Start inside (37 m away)
      final pt37Lat = 12.9716 + (37.0 / 6371000.0) * (180.0 / 3.141592653589793);
      locationService.enabled = true;
      locationService.currentLocation = UserLocation(
        latitude: pt37Lat,
        longitude: 77.5946,
        timestamp: DateTime.now(),
      );

      await pumpPreview(tester, center: collegeCenter);

      expect(find.text('IN RANGE'), findsOneWidget);
      expect(find.text('You are 37 m from this center.'), findsOneWidget);
      ElevatedButton joinBtn = tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      expect(joinBtn.onPressed, isNotNull);

      // User moves outside the radius (1.4 km away)
      final pt1400Lat = 12.9716 + (1400.0 / 6371000.0) * (180.0 / 3.141592653589793);
      final outLocation = UserLocation(
        latitude: pt1400Lat,
        longitude: 77.5946,
        timestamp: DateTime.now(),
      );
      locationService.emitLocation(outLocation);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pumpAndSettle();

      // UI immediately flips to OUT OF RANGE and button disables
      expect(find.text('OUT OF RANGE'), findsOneWidget);
      expect(find.text('You are 1.4 km from this center.'), findsOneWidget);
      expect(find.text('You must be within 100 m to join.'), findsOneWidget);
      joinBtn = tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      expect(joinBtn.onPressed, isNull, reason: 'CTA must be disabled when moved out of range');

      // User moves back inside (37 m away)
      locationService.emitLocation(UserLocation(
        latitude: pt37Lat,
        longitude: 77.5946,
        timestamp: DateTime.now(),
      ));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pumpAndSettle();

      // UI immediately flips back to IN RANGE and button enables
      expect(find.text('IN RANGE'), findsOneWidget);
      expect(find.text('You are 37 m from this center.'), findsOneWidget);
      joinBtn = tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      expect(joinBtn.onPressed, isNotNull, reason: 'CTA must be re-enabled when returned in range');
    });

    testWidgets('fresh GPS verification before join blocks join if user moved out-of-range since preview', (tester) async {
      final collegeCenter = ServiceCenter.fromJson(serviceCenterJson(
        id: kCenterId,
        name: 'College Account',
        location: {'latitude': 12.9716, 'longitude': 77.5946},
        geofence: {'enabled': true, 'radiusMeters': 100},
      ));

      // Initial state inside
      final pt50Lat = 12.9716 + (50.0 / 6371000.0) * (180.0 / 3.141592653589793);
      locationService.enabled = true;
      locationService.currentLocation = UserLocation(
        latitude: pt50Lat,
        longitude: 77.5946,
        timestamp: DateTime.now(),
      );

      await pumpPreview(tester, center: collegeCenter);
      expect(find.text('IN RANGE'), findsOneWidget);

      // Now simulated GPS position updates to 500m away right before join is tapped
      final pt500Lat = 12.9716 + (500.0 / 6371000.0) * (180.0 / 3.141592653589793);
      locationService.currentLocation = UserLocation(
        latitude: pt500Lat,
        longitude: 77.5946,
        timestamp: DateTime.now(),
      );

      // Tap JOIN QUEUE to open confirmation sheet
      await tester.tap(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      await tester.pumpAndSettle();

      // Tap JOIN QUEUE inside the bottom sheet to attempt join
      await tester.tap(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').last);
      await tester.pumpAndSettle();

      // No token must have been created because fresh GPS check caught the out-of-range position
      expect(api.joinCalls, 0, reason: 'No token must be created if fresh GPS reading is out of range');
      expect(find.textContaining('OUT OF RANGE'), findsWidgets);
    });
  });
}

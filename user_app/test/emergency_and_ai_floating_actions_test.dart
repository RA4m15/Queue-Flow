import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:user_app/core/router/app_router.dart';
import 'package:user_app/core/theme/app_theme.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/widgets/emergency_assistance_sheet.dart';
import 'package:user_app/widgets/global_floating_actions.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('EmergencyAssistanceSheet', () {
    testWidgets('renders emergency services, hotlines, and active token details',
        (WidgetTester tester) async {
      const mockToken = TokenModel(
        id: 'token-123',
        tokenCode: 'A-102',
        tokenNumber: 102,
        userId: 'user-1',
        centerId: 'center-1',
        serviceId: 'service-1',
        status: 'WAITING',
        centerName: 'Metro General Health Center',
        counterName: 'Counter 3',
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.darkTheme,
          home: const Scaffold(
            body: EmergencyAssistanceSheet(activeToken: mockToken),
          ),
        ),
      );
      await tester.pump();

      // Check header and SOS indicators
      expect(find.text('EMERGENCY SOS'), findsOneWidget);
      expect(find.text('IMMEDIATE'), findsOneWidget);

      // Check active token information
      expect(find.text('YOUR CURRENT ON-SITE DETAILS'), findsOneWidget);
      expect(
        find.text('Metro General Health Center • Ticket #A-102 (Counter Counter 3)'),
        findsOneWidget,
      );

      // Check emergency call options
      expect(find.text('Call National Emergency (112)'), findsOneWidget);
      expect(find.text('Dial 911 (US / International SOS)'), findsOneWidget);
      expect(find.text('QueueFlow 24/7 Emergency Line'), findsOneWidget);
      expect(find.text('+1 (800) 555-7838 (Toll Free)'), findsOneWidget);
    });

    testWidgets('renders without active token when user has no active queue',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.darkTheme,
          home: const Scaffold(
            body: EmergencyAssistanceSheet(activeToken: null),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('EMERGENCY SOS'), findsOneWidget);
      expect(find.text('YOUR CURRENT ON-SITE DETAILS'), findsNothing);
      expect(find.text('Call National Emergency (112)'), findsOneWidget);
    });
  });

  group('GlobalFloatingActions Overlay', () {
    testWidgets('renders both Emergency SOS and AI Chat buttons on general pages',
        (WidgetTester tester) async {
      final testRouter = GoRouter(
        initialLocation: '/home',
        routes: [
          GoRoute(
            path: '/home',
            builder: (context, state) => const Scaffold(
              body: Center(child: Text('Home Screen Content')),
            ),
          ),
          GoRoute(
            path: '/support-chat',
            builder: (context, state) => const Scaffold(
              body: Center(child: Text('Support Chat Screen')),
            ),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            routerProvider.overrideWithValue(testRouter),
          ],
          child: MaterialApp.router(
            theme: AppTheme.darkTheme,
            routerConfig: testRouter,
            builder: (context, child) => GlobalFloatingActions(
              child: child ?? const SizedBox.shrink(),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Verify page content is present
      expect(find.text('Home Screen Content'), findsOneWidget);

      // Verify Emergency button is rendered
      expect(find.byIcon(Icons.phone_in_talk_rounded), findsOneWidget);
      expect(find.text('SOS'), findsOneWidget);

      // Verify AI Chat button is rendered
      expect(find.byIcon(Icons.auto_awesome), findsOneWidget);
    });

    testWidgets('tapping emergency button opens emergency assistance modal',
        (WidgetTester tester) async {
      final testRouter = GoRouter(
        navigatorKey: rootNavigatorKey,
        initialLocation: '/test-page',
        routes: [
          GoRoute(
            path: '/test-page',
            builder: (context, state) => const Scaffold(
              body: Center(child: Text('Sample Page')),
            ),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            routerProvider.overrideWithValue(testRouter),
          ],
          child: MaterialApp.router(
            theme: AppTheme.darkTheme,
            routerConfig: testRouter,
            builder: (context, child) => GlobalFloatingActions(
              child: child ?? const SizedBox.shrink(),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Tap the emergency button
      await tester.tap(find.byIcon(Icons.phone_in_talk_rounded));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Verify Emergency Assistance Sheet is shown
      expect(find.text('EMERGENCY SOS'), findsOneWidget);
      expect(find.text('Call National Emergency (112)'), findsOneWidget);
    });

    testWidgets('hides AI chat button when on /support-chat but keeps Emergency SOS',
        (WidgetTester tester) async {
      final testRouter = GoRouter(
        initialLocation: '/support-chat',
        routes: [
          GoRoute(
            path: '/support-chat',
            builder: (context, state) => const Scaffold(
              body: Center(child: Text('Support Chat Screen')),
            ),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            routerProvider.overrideWithValue(testRouter),
          ],
          child: MaterialApp.router(
            theme: AppTheme.darkTheme,
            routerConfig: testRouter,
            builder: (context, child) => GlobalFloatingActions(
              child: child ?? const SizedBox.shrink(),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Emergency button is still present
      expect(find.byIcon(Icons.phone_in_talk_rounded), findsOneWidget);

      // AI Chat button is hidden because user is already on the support chat screen
      expect(find.byIcon(Icons.auto_awesome), findsNothing);
    });

    testWidgets('hides floating actions entirely during /splash',
        (WidgetTester tester) async {
      final testRouter = GoRouter(
        initialLocation: '/splash',
        routes: [
          GoRoute(
            path: '/splash',
            builder: (context, state) => const Scaffold(
              body: Center(child: Text('Splash Loading')),
            ),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            routerProvider.overrideWithValue(testRouter),
          ],
          child: MaterialApp.router(
            theme: AppTheme.darkTheme,
            routerConfig: testRouter,
            builder: (context, child) => GlobalFloatingActions(
              child: child ?? const SizedBox.shrink(),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Splash Loading'), findsOneWidget);
      expect(find.byIcon(Icons.phone_in_talk_rounded), findsNothing);
      expect(find.byIcon(Icons.auto_awesome), findsNothing);
    });
  });
}

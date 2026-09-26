import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/theme/app_theme.dart';
import '../../models/token.dart';
import '../../models/service_center.dart';
import '../../models/service.dart';
import '../../providers/auth_provider.dart';
import '../../screens/splash/splash_screen.dart';
import '../../screens/auth/login_screen.dart';
import '../../screens/auth/register_screen.dart';
import '../../screens/main_shell.dart';
import '../../screens/home/home_screen.dart';
import '../../screens/service_center/service_center_detail_screen.dart';
import '../../screens/queue/queue_preview_screen.dart';
import '../../screens/token/live_token_screen.dart';
import '../../screens/token/token_qr_screen.dart';
import '../../screens/history/history_screen.dart';
import '../../screens/notifications/notifications_screen.dart';
import '../../screens/scan/scan_screen.dart';
import '../../screens/profile/profile_screen.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

final routerProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authProvider);

  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/splash',
    redirect: (context, state) {
      final isAuth = authState.isAuthenticated;
      final isLoggingIn = state.matchedLocation == '/login';
      final isRegistering = state.matchedLocation == '/register';
      final isSplashing = state.matchedLocation == '/splash';

      String? target;
      if (authState.isLoading) {
        // While auth is initializing, stay on /splash
        target = isSplashing ? null : '/splash';
      } else if (!isAuth) {
        // Not authenticated: unauthenticated users on splash or protected routes must go to /login
        if (!isLoggingIn && !isRegistering) {
          target = '/login';
        }
      } else {
        // Authenticated: authenticated users on splash, login, or register must go to /home
        if (isSplashing || isLoggingIn || isRegistering) {
          target = '/home';
        }
      }

      debugPrint('[Startup] ROUTER_REDIRECT: location=${state.matchedLocation}, isLoading=${authState.isLoading}, isAuth=$isAuth -> target=$target');
      return target;
    },
    routes: [
      GoRoute(
        path: '/splash',
        builder: (context, state) => const SplashScreen(),
      ),
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: '/register',
        builder: (context, state) => const RegisterScreen(),
      ),

      // ─── BOTTOM NAV SHELL ─────────────────────────────────────────
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) {
          return MainShell(navigationShell: navigationShell);
        },
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/home',
                builder: (context, state) => const HomeScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/token/live',
                builder: (context, state) => const LiveTokenScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/history',
                builder: (context, state) => const HistoryScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/notifications',
                builder: (context, state) => const NotificationsScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/profile',
                builder: (context, state) => const ProfileScreen(),
              ),
            ],
          ),
        ],
      ),

      // ─── DETAIL & MODAL ROUTES ────────────────────────────────────
      GoRoute(
        path: '/center/:id',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) {
          final centerId = state.pathParameters['id'] ?? '';
          if (centerId.isEmpty) {
            return const Scaffold(
              body: Center(child: Text('Invalid Center ID')),
            );
          }
          return ServiceCenterDetailScreen(centerId: centerId);
        },
      ),
      GoRoute(
        path: '/queue/preview',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) {
          if (state.extra is! Map<String, dynamic>) {
            return Scaffold(
              appBar: AppBar(title: const Text('Queue Preview')),
              body: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('Missing required parameters for queue preview.'),
                    const SizedBox(height: 16),
                    ElevatedButton(
                      onPressed: () => context.go('/home'),
                      child: const Text('Return Home'),
                    ),
                  ],
                ),
              ),
            );
          }
          final extra = state.extra as Map<String, dynamic>;
          final center = extra['center'] as ServiceCenter?;
          final service = extra['service'] as Service?;
          if (center == null || service == null) {
            return Scaffold(
              appBar: AppBar(title: const Text('Queue Preview')),
              body: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('Invalid service or center specified.'),
                    const SizedBox(height: 16),
                    ElevatedButton(
                      onPressed: () => context.go('/home'),
                      child: const Text('Return Home'),
                    ),
                  ],
                ),
              ),
            );
          }
          return QueuePreviewScreen(center: center, service: service);
        },
      ),
      GoRoute(
        path: '/token/qr',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) {
          if (state.extra is! TokenModel) {
            return Scaffold(
              appBar: AppBar(title: const Text('Token QR')),
              body: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('No token provided to display QR.'),
                    const SizedBox(height: 16),
                    ElevatedButton(
                      onPressed: () => context.go('/home'),
                      child: const Text('Return Home'),
                    ),
                  ],
                ),
              ),
            );
          }
          final token = state.extra as TokenModel;
          return TokenQrScreen(token: token);
        },
      ),
      GoRoute(
        path: '/scan',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) => const ScanScreen(),
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      appBar: AppBar(title: const Text('Not Found')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline_rounded, size: 48, color: AppColors.warning),
            const SizedBox(height: 16),
            const Text('Page Not Found', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () => context.go('/home'),
              child: const Text('Return Home'),
            ),
          ],
        ),
      ),
    ),
  );
});

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
import '../../screens/support/support_chat_screen.dart';
import '../../utils/join_link_service.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

/// Transient screen for the inbound customer queue-join route.
///
/// It does no work itself, and that is the point. The link is already being
/// handled by [JoinLinkService], which reads the platform route with its real
/// host intact and parks the validated payload for `JoinLinkListener` to run
/// through the one shared join flow.
///
/// This screen exists only so the router has somewhere to land: without a
/// matching route, go_router would render "Page Not Found" while the join flow
/// was still running behind it. It steps aside on its own if nothing takes over,
/// so a link that cannot be resolved never leaves the customer staring at a
/// spinner.
class JoinLinkTransitScreen extends ConsumerStatefulWidget {
  const JoinLinkTransitScreen({super.key});

  /// How long to wait for the join flow to take over before giving up.
  static const Duration fallbackDelay = Duration(seconds: 8);

  @override
  ConsumerState<JoinLinkTransitScreen> createState() =>
      _JoinLinkTransitScreenState();
}

class _JoinLinkTransitScreenState extends ConsumerState<JoinLinkTransitScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // A join payload already parked means the flow is running; leave it be.
      if (ref.read(pendingJoinLinkProvider) != null) return;
      // Otherwise the link was not a join link this build can serve. Say
      // nothing and get the customer back to a working app.
      if (!mounted) return;
      GoRouter.of(context).go('/home');
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(color: AppColors.primary),
              const SizedBox(height: 20),
              Text(
                'Opening your queue…',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ],
          ),
        ),
      );
}

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
      GoRoute(
        path: '/support-chat',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) => const SupportChatScreen(),
      ),
      // ─── CANONICAL CUSTOMER QUEUE-JOIN LINK ───────────────────────
      //
      // The single target of the QR printed on the Live Counter display and of
      // every inbound App Link / Universal Link. The OS hands Flutter the
      // absolute URL, so what matches here is its path. Parsing and validation
      // happen in JoinLinkService against the engine's own copy of the route,
      // which still has the host; this route only stops go_router from showing
      // a 404 while that happens.
      GoRoute(
        path: joinLinkLocation(),
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) => const JoinLinkTransitScreen(),
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

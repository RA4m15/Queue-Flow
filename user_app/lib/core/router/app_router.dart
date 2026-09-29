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
import '../../screens/join/join_service_selection_screen.dart';
import '../../screens/queue/queue_preview_screen.dart';
import '../../screens/token/live_token_screen.dart';
import '../../screens/token/token_qr_screen.dart';
import '../../screens/history/history_screen.dart';
import '../../screens/notifications/notifications_screen.dart';
import '../../screens/scan/scan_screen.dart';
import '../../screens/profile/profile_screen.dart';
import '../../screens/support/support_chat_screen.dart';
import '../../utils/join_link_service.dart';
import '../../utils/qr_payload_parser.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

/// Shown when a join route is opened without the id it needs.
///
/// This is a genuine dead end rather than a recoverable one: without a center
/// there is nothing to ask the backend about, so guessing would be worse than
/// stopping. The two offered actions are the only two honest options — go back
/// to the app, or scan a code that actually carries an id.
class _MissingJoinTarget extends StatelessWidget {
  const _MissingJoinTarget(this.missing);

  final String missing;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => context.canPop() ? context.pop() : context.go('/home'),
        ),
        title: const Text('Scan to Join'),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.qr_code_2_rounded,
                size: 48,
                color: AppColors.warning,
              ),
              const SizedBox(height: 16),
              Text(
                'MISSING $missing',
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1,
                ),
              ),
              const SizedBox(height: 10),
              const Text(
                'This link does not identify a service center, so there is '
                'nothing to look up. Scan the QueueFlow QR code at the '
                'service desk, or open the app and scan it from there.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 13,
                  height: 1.5,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 28),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton(
                  onPressed: () => context.pushReplacement('/scan'),
                  child: const Text('SCAN A QR CODE'),
                ),
              ),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: OutlinedButton(
                  onPressed: () => context.go('/home'),
                  child: const Text('RETURN HOME'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Transient screen for the inbound customer queue-join route.
///
/// It does no work itself, and that is the point. The link is already being
/// handled by [JoinLinkService], which reads the platform route with its real
/// host intact and parks the validated payload for the join flow to run.
///
/// This screen exists only so the router has somewhere to land: without a
/// matching route, go_router would render "Page Not Found" while the join flow
/// was still running behind it. Because a route's builder context *does* have a
/// [GoRouter] in scope — unlike the `MaterialApp.router.builder` context above
/// it — this is the one place on the inbound path that can navigate, so it is
/// where a warm link is handed over to the queue flow.
///
/// It steps aside on its own if there is nothing to join, so a link that cannot
/// be resolved never leaves the customer staring at a spinner.
class JoinLinkTransitScreen extends ConsumerStatefulWidget {
  const JoinLinkTransitScreen({super.key});

  @override
  ConsumerState<JoinLinkTransitScreen> createState() =>
      _JoinLinkTransitScreenState();
}

class _JoinLinkTransitScreenState extends ConsumerState<JoinLinkTransitScreen> {
  /// Set once this screen has either handed the link over or given up, so a
  /// rebuild cannot start a second navigation.
  bool _settled = false;

  /// Set while a takeover is already queued, so a rebuild in the same frame
  /// cannot queue a second one.
  bool _scheduled = false;

  @override
  void initState() {
    super.initState();
    _armTakeOver();
  }

  @override
  Widget build(BuildContext context) {
    // Watched so a payload that parks a frame after this screen appeared is
    // still picked up. The post-frame callback is re-armed only while
    // unsettled, and `_takeOver` settles on its first successful attempt, so
    // this cannot loop.
    ref.watch(pendingJoinLinkProvider);
    ref.watch(authProvider);
    _armTakeOver();

    return Scaffold(
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

  /// Queues [\_takeOver] one frame *after* the next one.
  ///
  /// The extra frame is not cosmetic. `go_router` adds this page to the root
  /// navigator in the frame it is routed to, and calling `go` in that same
  /// post-frame phase makes it re-parent the [StatefulShellRoute]'s
  /// `StatefulNavigationShell` out of the parent that still expects it. The
  /// tree then holds two shells at once and Flutter throws
  /// "Duplicate GlobalKey detected in widget tree", which truncates the screen.
  /// Waiting until the page is fully committed avoids that; re-arming from
  /// [build] keeps a payload that parks a frame later from being missed.
  void _armTakeOver() {
    if (_settled || _scheduled) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scheduled = false;
        _takeOver();
      });
    });
  }

  /// Hands a parked join link to the queue flow, or leaves if there is nothing
  /// to hand over.
  ///
  /// An unauthenticated customer never reaches this method: the router redirect
  /// sends `/join` to `/login` and turns the parked link back into a
  /// destination after sign-in. So bailing out while signed out is not a dead
  /// end — it is handing the link to whoever owns that case.
  void _takeOver() {
    if (!mounted || _settled) return;
    final router = GoRouter.maybeOf(context);
    if (router == null) return;
    if (!ref.read(authProvider).isAuthenticated) return;

    _settled = true;
    final payload = ref.read(pendingJoinLinkProvider);
    if (payload == null) {
      // A `/join` URL this build cannot act on. Say nothing and get the
      // customer back to a working app rather than on a permanent spinner.
      router.go('/home');
      return;
    }
    if (ref.read(pendingJoinLinkProvider.notifier).take(payload)) {
      router.go(joinRouteFor(payload));
    }
  }
}

/// Forgets a parked join link once the redirect has turned it into a
/// destination.
///
/// The clear is deferred to after the frame, and never runs against a newer
/// link, because [PendingJoinLink.take] is the only thing that writes provider
/// state here — and it refuses if a different payload is parked in the
/// meantime. Deferring is not optional: `redirect` is evaluated while the
/// router is building, and writing provider state mid-build throws. The
/// notifier is resolved eagerly so the deferred callback does not need the
/// provider's [Ref] to still be alive by the time it runs.
void _consumeParkedJoinLink(Ref ref, QrJoinPayload payload) {
  final notifier = ref.read(pendingJoinLinkProvider.notifier);
  WidgetsBinding.instance.addPostFrameCallback((_) => notifier.take(payload));
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
          // …unless a customer queue-join link is still parked from before they
          // signed in. Scanning the QR at the service desk is what most
          // first-time customers do, and the normal order is scan → log in, so
          // this is the case that has to work: the same centre, and the same
          // service, not the home screen and a second scan.
          final parked = ref.read(pendingJoinLinkProvider);
          if (parked != null) {
            _consumeParkedJoinLink(ref, parked);
            target = joinRouteFor(parked);
          } else {
            target = '/home';
          }
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
        path: '/join/preview',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) {
          // Addressed by id, not by `state.extra`. A query-string route survives
          // the login redirect and a process restart, which is what lets a
          // customer scan a QR, get bounced to /login, and land back on the same
          // queue instead of on the home screen.
          final centerId = state.uri.queryParameters['centerId'] ?? '';
          final serviceId = state.uri.queryParameters['serviceId'];
          if (centerId.isEmpty) return const _MissingJoinTarget('center');
          return QueuePreviewScreen(
            centerId: centerId,
            serviceId: (serviceId == null || serviceId.isEmpty) ? null : serviceId,
          );
        },
      ),
      GoRoute(
        path: '/join/services',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) {
          final centerId = state.uri.queryParameters['centerId'] ?? '';
          if (centerId.isEmpty) return const _MissingJoinTarget('center');
          return JoinServiceSelectionScreen(centerId: centerId);
        },
      ),
      // Legacy in-app entry point. The service-center detail screen still hands
      // resolved objects over, and they are reduced to ids here so there is one
      // screen and one resolution path — not two previews.
      GoRoute(
        path: '/queue/preview',
        parentNavigatorKey: rootNavigatorKey,
        builder: (context, state) {
          final extra = state.extra;
          ServiceCenter? center;
          Service? service;
          if (extra is Map<String, dynamic>) {
            center = extra['center'] as ServiceCenter?;
            service = extra['service'] as Service?;
          }
          // Fall back to the query string so an old deep link that carried ids
          // still lands somewhere real.
          final centerId =
              center?.id ?? state.uri.queryParameters['centerId'] ?? '';
          final serviceId = service?.id ?? state.uri.queryParameters['serviceId'];
          if (centerId.isEmpty) return const _MissingJoinTarget('center');
          return QueuePreviewScreen(
            centerId: centerId,
            serviceId: (serviceId == null || serviceId.isEmpty) ? null : serviceId,
          );
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
        pageBuilder: (context, state) => NoTransitionPage(
          child: const JoinLinkTransitScreen(),
        ),
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

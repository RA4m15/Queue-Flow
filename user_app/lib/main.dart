import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/theme/app_theme.dart';
import 'core/router/app_router.dart';
import 'core/config/join_config.dart';
import 'services/firebase_push_messaging_client.dart';
import 'utils/join_link_service.dart';
import 'utils/widgets/join_link_listener.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // An Android App Link / iOS Universal Link that launched the app is only
  // available as the platform's initial route at this point. Capture it before
  // runApp, because go_router is given an explicit `initialLocation` and would
  // otherwise never see it.
  captureInitialJoinLink();

  // Must be registered before runApp. The handler runs in a separate isolate
  // when a message arrives while the app is backgrounded or terminated, so it
  // cannot rely on anything set up after startup. It only acknowledges the
  // message; authoritative state is fetched in the main isolate on open.
  // Registration is guarded because a build without Firebase configured must
  // still start normally.
  try {
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
  } catch (_) {
    // Firebase is not available in this build. push_transport.dart reports the
    // app as push-unavailable rather than pretending delivery works.
  }

  runApp(
    const ProviderScope(
      child: QueueFlowApp(),
    ),
  );
}

class QueueFlowApp extends ConsumerWidget {
  const QueueFlowApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);

    if (!hasConfiguredProductionJoinHost) {
      // Fail visibly rather than silently. Without a configured join host this
      // build only trusts local dev hosts, so a production QR would be rejected.
      debugPrint(
        '[JoinLink] WARNING: no production join host configured. Build with '
        '--dart-define=QUEUEFLOW_JOIN_HOSTS=<customer-web-host> so the canonical '
        'HTTPS /join QR codes are recognised. Trusted hosts right now: '
        '${queueflowJoinHosts.join(', ')}',
      );
    }

    return MaterialApp.router(
      title: 'QueueFlow',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.darkTheme,
      routerConfig: router,
      // Inbound App Link / Universal Link handling. The link arrives as a route
      // (cold start: the initial route, caught by captureInitialJoinLink above;
      // warm start: pushed onto the navigation channel, matched by the `/join`
      // route in app_router.dart). This widget parks the payload until the user
      // is signed in, then runs the one shared join flow.
      builder: (context, child) => JoinLinkListener(
        child: child ?? const SizedBox.shrink(),
      ),
    );
  }
}

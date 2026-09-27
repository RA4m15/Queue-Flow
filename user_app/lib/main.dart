import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_core/firebase_core.dart';

import 'firebase_options.dart';
import 'core/theme/app_theme.dart';
import 'core/router/app_router.dart';
import 'core/config/join_config.dart';
import 'providers/theme_provider.dart';
import 'services/firebase_push_messaging_client.dart';
import 'services/notification_service.dart';
import 'utils/join_link_service.dart';
import 'utils/widgets/join_link_listener.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );

  await NotificationService.instance.initialize();

  captureInitialJoinLink();

  try {
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
  } catch (_) {
    // Firebase is not available in this build.
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
    final themeMode = ref.watch(themeModeProvider);

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
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: themeMode,
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

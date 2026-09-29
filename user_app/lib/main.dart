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

import 'widgets/global_floating_actions.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  try {
    if (DefaultFirebaseOptions.currentPlatform.apiKey.isNotEmpty) {
      await Firebase.initializeApp(
        options: DefaultFirebaseOptions.currentPlatform,
      );
    } else {
      await Firebase.initializeApp();
    }
    await NotificationService.instance.initialize();
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
  } catch (e) {
    debugPrint('[Firebase/Notification] Initialization skipped: $e');
  }

  captureInitialJoinLink();

  ErrorWidget.builder = (FlutterErrorDetails details) {
    return Material(
      color: Colors.transparent,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline_rounded, size: 40, color: AppColors.textSecondary),
              const SizedBox(height: 12),
              const Text(
                'Something went wrong displaying this view.',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textPrimary),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 4),
              const Text(
                'Please pull to refresh or navigate back.',
                style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  };

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
      // route in app_router.dart). This widget parks the validated payload; the
      // router redirect (after sign-in) and the `/join` transit screen (while
      // already signed in) are what turn it into a destination, because a
      // `builder` context here has no router or overlay in scope.
      builder: (context, child) => JoinLinkListener(
        child: GlobalFloatingActions(
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    );
  }
}

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../core/theme/app_theme.dart';
import '../models/notification.dart';
import '../providers/token_provider.dart';
import '../providers/notification_provider.dart';
import '../services/push_notification_service.dart';

class MainShell extends ConsumerStatefulWidget {
  const MainShell({
    super.key,
    required this.navigationShell,
  });

  final StatefulNavigationShell navigationShell;

  @override
  ConsumerState<MainShell> createState() => _MainShellState();
}

class _MainShellState extends ConsumerState<MainShell> {
  StreamSubscription<NotificationModel>? _sub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final pushService = ref.read(pushNotificationServiceProvider.notifier);
      // Obtain the platform push token and register it with the backend.
      // Truthful when no push transport is configured: the state reports
      // "unavailable" instead of pretending notifications are active.
      pushService.initialize();
      _sub = pushService.onForegroundNotification.listen(_showInAppNotification);
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  void _showInAppNotification(NotificationModel notification) {
    if (!mounted) return;

    final isCalled = notification.type == 'TOKEN_CALLED';
    final isApproaching = notification.type == 'TOKEN_APPROACHING';

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        backgroundColor: isCalled
            ? AppColors.secondary
            : (isApproaching ? AppColors.warning : AppColors.surfaceElevated),
        duration: const Duration(seconds: 5),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  isCalled
                      ? Icons.campaign_rounded
                      : (isApproaching ? Icons.access_time_filled : Icons.notifications_active_rounded),
                  color: isCalled ? Colors.black : Colors.white,
                  size: 20,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    notification.title,
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 14,
                      color: isCalled ? Colors.black : Colors.white,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              notification.body,
              style: TextStyle(
                fontSize: 12,
                color: isCalled ? Colors.black87 : Colors.white70,
              ),
            ),
          ],
        ),
        action: SnackBarAction(
          label: 'View Token',
          textColor: isCalled ? Colors.black : AppColors.primary,
          onPressed: () {
            ref.read(pushNotificationServiceProvider.notifier).handleNotificationTap(
                  payload: {'tokenId': notification.tokenId},
                  context: context,
                  ref: ref,
                );
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokenState = ref.watch(tokenProvider);
    final notifState = ref.watch(notificationsProvider);
    final hasActiveToken = tokenState.activeToken != null && tokenState.activeToken!.isActive;

    return Scaffold(
      body: widget.navigationShell,
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: AppColors.border, width: 1),
          ),
        ),
        child: BottomNavigationBar(
          currentIndex: widget.navigationShell.currentIndex,
          onTap: (index) {
            widget.navigationShell.goBranch(
              index,
              initialLocation: index == widget.navigationShell.currentIndex,
            );
          },
          items: [
            const BottomNavigationBarItem(
              icon: Icon(Icons.home_outlined),
              activeIcon: Icon(Icons.home_rounded),
              label: 'Home',
            ),
            BottomNavigationBarItem(
              icon: Stack(
                clipBehavior: Clip.none,
                children: [
                  const Icon(Icons.confirmation_number_outlined),
                  if (hasActiveToken)
                    Positioned(
                      top: -2,
                      right: -2,
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: const BoxDecoration(
                          color: AppColors.primary,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                ],
              ),
              activeIcon: const Icon(Icons.confirmation_number_rounded),
              label: 'Live Token',
            ),
            const BottomNavigationBarItem(
              icon: Icon(Icons.history_rounded),
              label: 'History',
            ),
            BottomNavigationBarItem(
              icon: Stack(
                clipBehavior: Clip.none,
                children: [
                  const Icon(Icons.notifications_none_rounded),
                  if (notifState.unreadCount > 0)
                    Positioned(
                      top: -4,
                      right: -6,
                      child: Container(
                        padding: const EdgeInsets.all(3),
                        decoration: const BoxDecoration(
                          color: AppColors.primary,
                          shape: BoxShape.circle,
                        ),
                        constraints: const BoxConstraints(minWidth: 14, minHeight: 14),
                        child: Text(
                          '${notifState.unreadCount}',
                          style: const TextStyle(
                            color: Colors.black,
                            fontSize: 9,
                            fontWeight: FontWeight.bold,
                          ),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                ],
              ),
              activeIcon: const Icon(Icons.notifications_rounded),
              label: 'Alerts',
            ),
            const BottomNavigationBarItem(
              icon: Icon(Icons.person_outline_rounded),
              activeIcon: Icon(Icons.person_rounded),
              label: 'Profile',
            ),
          ],
        ),
      ),
    );
  }
}

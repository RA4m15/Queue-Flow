import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/theme/app_theme.dart';
import '../../providers/notification_provider.dart';
import '../../widgets/notification_tile.dart';
import '../../widgets/loading_state.dart';
import '../../widgets/error_state.dart';
import '../../widgets/empty_state.dart';

class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(notificationsProvider.notifier).loadNotifications();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(notificationsProvider);

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          if (state.unreadCount > 0)
            TextButton(
              onPressed: () {
                ref.read(notificationsProvider.notifier).markAllAsRead();
              },
              child: const Text('Mark all read'),
            ),
        ],
      ),
      body: state.isLoading && state.notifications.isEmpty
          ? const LoadingState(message: 'Loading notifications...')
          : state.error != null && state.notifications.isEmpty
              ? ErrorState(
                  message: 'Unable to load notifications.',
                  onRetry: () => ref.read(notificationsProvider.notifier).loadNotifications(),
                )
              : state.notifications.isEmpty
                  ? const EmptyState(
                      title: 'All caught up',
                      message: 'You have no notifications at this time. Live queue alerts will appear here.',
                      icon: Icons.notifications_none_rounded,
                    )
                  : RefreshIndicator(
                      color: AppColors.primary,
                      backgroundColor: AppColors.surface,
                      onRefresh: () => ref.read(notificationsProvider.notifier).loadNotifications(),
                      child: ListView.builder(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        itemCount: state.notifications.length,
                        itemBuilder: (context, index) {
                          final notification = state.notifications[index];
                          return NotificationTile(
                            notification: notification,
                            onTap: () {
                              if (!notification.isRead) {
                                ref.read(notificationsProvider.notifier).markAsRead(notification.id);
                              }
                              if (notification.tokenId != null) {
                                context.push('/token/live');
                              }
                            },
                          );
                        },
                      ),
                    ),
    );
  }
}

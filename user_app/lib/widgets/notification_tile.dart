import 'package:flutter/material.dart';
import '../core/theme/app_theme.dart';
import '../core/utils/date_formatter.dart';
import '../models/notification.dart';

class NotificationTile extends StatelessWidget {
  const NotificationTile({
    super.key,
    required this.notification,
    required this.onTap,
  });

  final NotificationModel notification;
  final VoidCallback onTap;

  IconData get _icon {
    switch (notification.type) {
      case 'TOKEN_CALLED':
        return Icons.campaign_rounded;
      case 'TOKEN_SERVING':
        return Icons.check_circle_outline_rounded;
      case 'TOKEN_COMPLETED':
        return Icons.task_alt_rounded;
      case 'TOKEN_SKIPPED':
      case 'TOKEN_CANCELLED':
        return Icons.cancel_outlined;
      case 'TOKEN_CREATED':
        return Icons.confirmation_number_outlined;
      default:
        return Icons.notifications_none_rounded;
    }
  }

  Color get _iconColor {
    switch (notification.type) {
      case 'TOKEN_CALLED':
        return AppColors.secondary;
      case 'TOKEN_SERVING':
      case 'TOKEN_COMPLETED':
        return AppColors.primary;
      case 'TOKEN_SKIPPED':
      case 'TOKEN_CANCELLED':
        return AppColors.danger;
      default:
        return AppColors.textSecondary;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      decoration: BoxDecoration(
        color: notification.isRead ? AppColors.surface : AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: notification.isRead ? AppColors.border : AppColors.primary.withValues(alpha: 0.3),
        ),
      ),
      child: ListTile(
        onTap: onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: _iconColor.withValues(alpha: 0.12),
            shape: BoxShape.circle,
          ),
          child: Icon(_icon, color: _iconColor, size: 20),
        ),
        title: Row(
          children: [
            Expanded(
              child: Text(
                notification.title,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: notification.isRead ? FontWeight.w500 : FontWeight.bold,
                    ),
              ),
            ),
            if (!notification.isRead)
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(left: 8),
                decoration: const BoxDecoration(
                  color: AppColors.primary,
                  shape: BoxShape.circle,
                ),
              ),
          ],
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 4),
            Text(
              notification.body,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: AppColors.textSecondary,
                  ),
            ),
            const SizedBox(height: 6),
            Text(
              DateFormatter.formatRelative(notification.createdAt),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: AppColors.textMuted,
                    fontSize: 10,
                  ),
            ),
          ],
        ),
      ),
    );
  }
}

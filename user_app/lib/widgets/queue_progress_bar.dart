import 'package:flutter/material.dart';
import '../core/theme/app_theme.dart';

class QueueProgressBar extends StatelessWidget {
  const QueueProgressBar({
    super.key,
    this.initialPosition,
    this.currentPosition,
    required this.status,
  });

  final int? initialPosition;
  final int? currentPosition;
  final String status;

  double get _progress {
    final s = status.toUpperCase();
    if (s == 'SERVING' || s == 'COMPLETED') return 1.0;
    if (s == 'CALLED') return 0.95;
    if (s == 'CANCELLED' || s == 'EXPIRED' || s == 'SKIPPED') return 0.0;

    final initial = initialPosition;
    final current = currentPosition;

    if (initial == null || current == null || initial <= 1) return 0.5;

    // Calculate progress ratio based on movement towards front of queue
    final totalSteps = initial - 1;
    final completedSteps = initial - current;
    final ratio = (completedSteps / totalSteps).clamp(0.05, 0.90);
    return ratio;
  }

  @override
  Widget build(BuildContext context) {
    final color = AppColors.statusColor(status);
    final value = _progress;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'Queue Progress',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            Text(
              '${(value * 100).toInt()}%',
              style: AppTheme.monoStyle(fontSize: 12, color: color),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: SizedBox(
            height: 8,
            child: LinearProgressIndicator(
              value: value,
              backgroundColor: AppColors.surfaceElevated,
              valueColor: AlwaysStoppedAnimation<Color>(color),
            ),
          ),
        ),
      ],
    );
  }
}

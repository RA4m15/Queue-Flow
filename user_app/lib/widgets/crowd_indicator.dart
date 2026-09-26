import 'package:flutter/material.dart';
import '../core/theme/app_theme.dart';

class CrowdIndicator extends StatelessWidget {
  const CrowdIndicator({
    super.key,
    required this.crowdStatus,
    this.currentCrowd,
    this.capacity,
    this.showDetails = true,
  });

  final String crowdStatus;
  final int? currentCrowd;
  final int? capacity;
  final bool showDetails;

  Color get _color {
    switch (crowdStatus.toUpperCase()) {
      case 'HIGH':
      case 'CRITICAL':
        return AppColors.danger;
      case 'MODERATE':
        return AppColors.warning;
      case 'LOW':
        return AppColors.success;
      case 'UNKNOWN':
      default:
        return AppColors.textSecondary;
    }
  }

  String get _label {
    switch (crowdStatus.toUpperCase()) {
      case 'HIGH':
      case 'CRITICAL':
        return 'Busy';
      case 'MODERATE':
        return 'Moderate';
      case 'LOW':
        return 'Quiet';
      case 'UNKNOWN':
      default:
        return 'Normal';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: _color.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: _color.withValues(alpha: 0.3)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: _color,
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(
                      color: _color.withValues(alpha: 0.5),
                      blurRadius: 4,
                      spreadRadius: 1,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              Text(
                _label,
                style: TextStyle(
                  color: _color,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
        if (showDetails && currentCrowd != null && capacity != null && capacity! > 0) ...[
          const SizedBox(width: 8),
          Text(
            '$currentCrowd / $capacity',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ],
    );
  }
}

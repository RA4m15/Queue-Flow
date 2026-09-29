import 'package:flutter/material.dart';
import '../core/theme/app_theme.dart';

class TokenStatusBadge extends StatelessWidget {
  const TokenStatusBadge({
    super.key,
    required this.status,
    this.fontSize = 12,
  });

  final String status;
  final double fontSize;

  /// Customer-facing wording, for statuses whose raw enum is not something a
  /// customer should be shown.
  ///
  /// Deliberately narrow. Every pre-existing status renders exactly as it did
  /// before (see widget_test.dart), because those labels are already the
  /// product's voice and changing them would be cosmetic churn. The one status
  /// that genuinely cannot be shown raw is `SKIPPED_OUT_OF_RANGE`: it is a
  /// Phase 2 geofence identifier that tells a customer nothing about what
  /// happened to their ticket.
  static String labelFor(String status) {
    switch (status.toUpperCase()) {
      case 'SKIPPED_OUT_OF_RANGE':
        return 'SKIPPED — OUTSIDE SERVICE AREA';
      default:
        return status.toUpperCase();
    }
  }

  @override
  Widget build(BuildContext context) {
    final color = AppColors.statusColor(status);
    final upper = labelFor(status);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.4), width: 1),
      ),
      child: Text(
        upper,
        style: TextStyle(
          color: color,
          fontSize: fontSize,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}

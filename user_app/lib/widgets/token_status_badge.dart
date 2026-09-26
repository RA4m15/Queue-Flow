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

  @override
  Widget build(BuildContext context) {
    final color = AppColors.statusColor(status);
    final upper = status.toUpperCase();

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

import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../models/join_preview_data.dart';

/// The last stop before the backend is asked for a token.
///
/// It exists so the customer can see the three things that decide whether they
/// want to commit — which service, which center, and how long it will be — and
/// change their mind cheaply, without having gone through any extra screens
/// first. It is a single sheet, not a wizard.
///
/// Nothing here creates a token. The only way forward is tapping JOIN QUEUE,
/// which calls the existing `POST /api/tokens` through the existing token
/// provider.
class JoinConfirmationSheet extends StatelessWidget {
  const JoinConfirmationSheet({
    super.key,
    required this.preview,
    required this.onJoin,
    this.onChangeService,
    this.busy = false,
  });

  final JoinPreviewData preview;

  /// Invoked only on an explicit tap. Must be guarded by the caller against
  /// double taps.
  final VoidCallback onJoin;

  /// Optional: only offered when there is somewhere else to go.
  final VoidCallback? onChangeService;

  /// True once the join request is in flight; disables both buttons.
  final bool busy;

  /// Shows the sheet and resolves to `true` when the customer confirmed.
  static Future<bool> show(
    BuildContext context, {
    required JoinPreviewData preview,
    required VoidCallback onJoin,
    VoidCallback? onChangeService,
  }) async {
    final result = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      barrierColor: AppColors.background.withValues(alpha: 0.8),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => JoinConfirmationSheet(
        preview: preview,
        onJoin: onJoin,
        onChangeService: onChangeService == null
            ? null
            : () {
                Navigator.of(ctx).pop(false);
                onChangeService();
              },
      ),
    );
    return result ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final center = preview.center;
    final service = preview.service;
    final ewt = preview.estimatedWaitMinutes;
    final ahead = preview.peopleAhead;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: AppColors.borderLight,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 18),
            Text(
              "You're joining:",
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 6),
            Text(
              service.name,
              style: Theme.of(context)
                  .textTheme
                  .headlineMedium
                  ?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                const Icon(
                  Icons.apartment_rounded,
                  size: 14,
                  color: AppColors.textMuted,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    center.code.isEmpty ? center.name : center.name,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                ),
                if (center.code.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.surfaceElevated,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Text(
                      center.code,
                      style: AppTheme.monoStyle(
                        fontSize: 11,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: _SummaryTile(
                    label: 'Estimated wait',
                    value: ewt == null ? '--' : '~$ewt min',
                    caption: ewt == null ? 'Not reported' : 'Backend estimate',
                    accent: AppColors.secondary,
                    icon: Icons.schedule_rounded,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _SummaryTile(
                    label: 'People ahead',
                    value: ahead == null ? '--' : '$ahead',
                    caption: ahead == null
                        ? 'Not reported'
                        : 'Right now',
                    accent: AppColors.primary,
                    icon: Icons.groups_rounded,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            // Minimum 56dp: comfortably above the 48dp tap-target floor.
            SizedBox(
              height: 56,
              child: ElevatedButton(
                onPressed: busy ? null : onJoin,
                child: busy
                    ? const SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(
                          strokeWidth: 2.5,
                          valueColor: AlwaysStoppedAnimation<Color>(Colors.black),
                        ),
                      )
                    : const Text('JOIN QUEUE'),
              ),
            ),
            if (onChangeService != null) ...[
              const SizedBox(height: 10),
              SizedBox(
                height: 48,
                child: OutlinedButton(
                  onPressed: busy ? null : onChangeService,
                  child: const Text('CHANGE SERVICE'),
                ),
              ),
            ],
            const SizedBox(height: 12),
            Text(
              'You will receive a digital token after joining. '
              'The service center checks your documents before issuing it.',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 11,
                height: 1.4,
                color: AppColors.textMuted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SummaryTile extends StatelessWidget {
  const _SummaryTile({
    required this.label,
    required this.value,
    required this.caption,
    required this.accent,
    required this.icon,
  });

  final String label;
  final String value;
  final String caption;
  final Color accent;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      value: value,
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.surfaceElevated,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(icon, size: 12, color: AppColors.textMuted),
                  const SizedBox(width: 5),
                  Expanded(
                    child: Text(
                      label.toUpperCase(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 9.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(value, style: AppTheme.monoStyle(fontSize: 19, color: accent)),
              const SizedBox(height: 2),
              Text(
                caption,
                style: const TextStyle(fontSize: 9.5, color: AppColors.textMuted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

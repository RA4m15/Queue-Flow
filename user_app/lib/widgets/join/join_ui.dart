import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

/// A titled block on the join screens.
///
/// The heading is always real text, so a section's purpose is never carried by
/// its border or background colour.
class JoinSection extends StatelessWidget {
  const JoinSection({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
  });

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 10),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  title.toUpperCase(),
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.4,
                    color: AppColors.textMuted,
                  ),
                ),
              ),
              ?trailing,
            ],
          ),
        ),
        child,
      ],
    );
  }
}

/// A bordered surface used by every card on the join screens.
class JoinCard extends StatelessWidget {
  const JoinCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.borderColor,
    this.background,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? borderColor;
  final Color? background;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: background ?? AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: borderColor ?? AppColors.border),
      ),
      child: child,
    );
  }
}

/// Two-column metric grid.
class JoinMetricGrid extends StatelessWidget {
  const JoinMetricGrid({super.key, required this.children, this.columns = 2});

  final List<Widget> children;
  final int columns;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        const spacing = 12.0;
        final width =
            (constraints.maxWidth - spacing * (columns - 1)) / columns;
        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: [
            for (final child in children) SizedBox(width: width, child: child),
          ],
        );
      },
    );
  }
}

/// A shimmering placeholder block.
///
/// Present purely as a loading affordance — it never implies a value. Once
/// loaded, every real number arrives from the backend in the same slot.
class JoinSkeleton extends StatefulWidget {
  const JoinSkeleton({
    super.key,
    this.height = 16,
    this.width,
    this.borderRadius = 8,
  });

  final double height;
  final double? width;
  final double borderRadius;

  @override
  State<JoinSkeleton> createState() => _JoinSkeletonState();
}

class _JoinSkeletonState extends State<JoinSkeleton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1250),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: FadeTransition(
        opacity: Tween<double>(begin: 0.35, end: 0.7).animate(
          CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
        ),
        child: Container(
          height: widget.height,
          width: widget.width,
          decoration: BoxDecoration(
            color: AppColors.surfaceElevated,
            borderRadius: BorderRadius.circular(widget.borderRadius),
            border: Border.all(color: AppColors.border),
          ),
        ),
      ),
    );
  }
}

/// The full-screen loading shape for a join screen: header block, metric grid
/// and a disabled CTA, so the layout does not jump when data lands.
class JoinPreviewSkeleton extends StatelessWidget {
  const JoinPreviewSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
      children: [
        const JoinSkeleton(height: 26, width: 220, borderRadius: 8),
        const SizedBox(height: 10),
        const JoinSkeleton(height: 14, width: 140),
        const SizedBox(height: 28),
        const JoinSkeleton(height: 108, borderRadius: 20),
        const SizedBox(height: 24),
        const JoinSection(
          title: 'Current queue',
          child: JoinMetricGrid(
            children: [
              JoinSkeleton(height: 76, borderRadius: 14),
              JoinSkeleton(height: 76, borderRadius: 14),
              JoinSkeleton(height: 76, borderRadius: 14),
              JoinSkeleton(height: 76, borderRadius: 14),
            ],
          ),
        ),
        const SizedBox(height: 24),
        const JoinSkeleton(height: 84, borderRadius: 16),
        const SizedBox(height: 24),
        const JoinSkeleton(height: 64, borderRadius: 12),
      ],
    );
  }
}

/// A secondary recovery action on a [JoinFailureView].
class JoinFailureAction {
  const JoinFailureAction({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;
}

/// Full-bleed terminal state for a join screen that cannot load.
///
/// Every Step 16 failure gets its own title, its own explanation, and exactly
/// the recovery actions that make sense for it. Nothing is silently swallowed.
class JoinFailureView extends StatelessWidget {
  const JoinFailureView({
    super.key,
    required this.icon,
    required this.accent,
    required this.title,
    required this.message,
    this.onRetry,
    this.retryLabel = 'RETRY',
    this.actions = const <JoinFailureAction>[],
  });

  final IconData icon;
  final Color accent;
  final String title;
  final String message;
  final VoidCallback? onRetry;
  final String retryLabel;
  final List<JoinFailureAction> actions;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(28, 40, 28, 40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              width: 72,
              height: 72,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.12),
                shape: BoxShape.circle,
                border: Border.all(color: accent.withValues(alpha: 0.4)),
              ),
              child: Icon(icon, size: 34, color: accent),
            ),
            const SizedBox(height: 20),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context)
                  .textTheme
                  .titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800, letterSpacing: 0.4),
            ),
            const SizedBox(height: 10),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 13,
                height: 1.5,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 28),
            if (onRetry != null) ...[
              SizedBox(
                height: 54,
                child: ElevatedButton(
                  onPressed: onRetry,
                  child: Text(retryLabel),
                ),
              ),
              const SizedBox(height: 10),
            ],
            for (final action in actions)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: SizedBox(
                  height: 50,
                  child: OutlinedButton(
                    onPressed: action.onPressed,
                    child: Text(action.label),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Small labelled key/value row used for center, service and operation facts.
class JoinFactRow extends StatelessWidget {
  const JoinFactRow({
    super.key,
    required this.icon,
    required this.label,
    required this.value,
    this.valueColor,
    this.valueStyle,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color? valueColor;
  final TextStyle? valueStyle;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      value: value,
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 15, color: AppColors.textMuted),
              const SizedBox(width: 10),
              SizedBox(
                width: 108,
                child: Text(
                  label,
                  style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.textMuted,
                  ),
                ),
              ),
              Expanded(
                child: Text(
                  value,
                  style: valueStyle ??
                      TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: valueColor ?? AppColors.textPrimary,
                      ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

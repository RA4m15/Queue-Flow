import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

/// The confirmation shown for a moment after the backend issues a token.
///
/// Every value on this screen is read off the token the server returned. The
/// overlay does not compute a position or a wait: if the backend did not send
/// one, the row says so rather than showing a plausible number.
class JoinSuccessOverlay {
  JoinSuccessOverlay._();

  /// How long the confirmation holds before the live-token screen takes over.
  static const Duration displayDuration = Duration(seconds: 2);

  /// Shows the confirmation, then navigates to the existing live token screen.
  ///
  /// [onContinue] is the app's own navigation into `/token/live`; the overlay
  /// never pushes a route itself, so the flow stays in one place.
  static void show(
    BuildContext context, {
    required String tokenCode,
    required String serviceName,
    int? position,
    int? estimatedWaitMinutes,
    required VoidCallback onContinue,
    Duration displayDuration = JoinSuccessOverlay.displayDuration,
  }) {
    final navigator = Navigator.of(context, rootNavigator: true);
    showGeneralDialog<void>(
      context: context,
      barrierDismissible: false,
      barrierLabel: 'You are in the queue',
      barrierColor: Colors.black.withValues(alpha: 0.92),
      transitionDuration: const Duration(milliseconds: 260),
      pageBuilder: (ctx, _, _) => _SuccessBody(
        tokenCode: tokenCode,
        serviceName: serviceName,
        position: position,
        estimatedWaitMinutes: estimatedWaitMinutes,
      ),
      transitionBuilder: (ctx, anim, _, child) => FadeTransition(
        opacity: anim,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.92, end: 1.0).animate(
            CurvedAnimation(parent: anim, curve: Curves.easeOutBack),
          ),
          child: child,
        ),
      ),
    ).then((_) {
      if (navigator.mounted) onContinue();
      // A tap-through should move on immediately rather than waiting out the
      // remainder of the timer.
    }).timeout(displayDuration, onTimeout: () {
      if (navigator.mounted) onContinue();
    });
  }
}

class _SuccessBody extends StatelessWidget {
  const _SuccessBody({
    required this.tokenCode,
    required this.serviceName,
    this.position,
    this.estimatedWaitMinutes,
  });

  final String tokenCode;
  final String serviceName;
  final int? position;
  final int? estimatedWaitMinutes;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 28),
          child: Semantics(
            liveRegion: true,
            label: 'You are in the queue. Token $tokenCode'
                '${position == null ? '' : ', position $position'}'
                '${estimatedWaitMinutes == null ? '' : ', about $estimatedWaitMinutes minutes wait'}.',
            child: ExcludeSemantics(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TweenAnimationBuilder<double>(
                    tween: Tween<double>(begin: 0, end: 1),
                    duration: const Duration(milliseconds: 620),
                    curve: Curves.elasticOut,
                    builder: (_, v, _) => Transform.scale(
                      scale: v,
                      child: Container(
                        width: 96,
                        height: 96,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: AppColors.success.withValues(alpha: 0.14),
                          border: Border.all(
                            color: AppColors.success,
                            width: 2.5,
                          ),
                        ),
                        child: const Icon(
                          Icons.check_rounded,
                          size: 52,
                          color: AppColors.success,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 22),
                  const Text(
                    "YOU'RE IN THE QUEUE",
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.4,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    serviceName,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColors.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 26),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 28,
                      vertical: 20,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: AppColors.borderLight),
                    ),
                    child: Column(
                      children: [
                        const Text(
                          'TOKEN',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 1.6,
                            color: AppColors.textMuted,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          tokenCode,
                          style: AppTheme.monoStyle(
                            fontSize: 40,
                            color: AppColors.primary,
                            letterSpacing: 2,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  Row(
                    children: [
                      Expanded(
                        child: _SuccessStat(
                          label: 'POSITION',
                          value: position?.toString(),
                          fallback: 'Being assigned',
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _SuccessStat(
                          label: 'ESTIMATED WAIT',
                          value: estimatedWaitMinutes == null
                              ? null
                              : '~$estimatedWaitMinutes min',
                          fallback: 'Not reported yet',
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 26),
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: AppColors.secondary,
                    ),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    'Opening your live token…',
                    style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SuccessStat extends StatelessWidget {
  const _SuccessStat({
    required this.label,
    required this.value,
    required this.fallback,
  });

  final String label;
  final String? value;
  final String fallback;

  @override
  Widget build(BuildContext context) {
    final has = value != null;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        children: [
          Text(
            label,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.8,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: 6),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              has ? value! : '--',
              style: AppTheme.monoStyle(
                fontSize: 16,
                color: has ? AppColors.secondary : AppColors.textMuted,
              ),
            ),
          ),
          const SizedBox(height: 2),
          Text(
            has ? '' : fallback,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 9.5, color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }
}

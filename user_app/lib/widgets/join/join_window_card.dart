import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_theme.dart';
import '../../models/operating_hours.dart';
import '../../models/service_center.dart';

/// The joining-window card.
///
/// ## Truth contract
///
/// This widget shows a countdown **only** when the service center has
/// configured operating hours for today and they have not yet passed. Those
/// hours come from `ServiceCenter.operatingHours` and are the only time-bound
/// data in the backend's service-center schema.
///
/// When no window is configured — which is the schema default, since
/// `operatingHours` is an optional array — this renders a plain, truthful
/// `CENTER OPEN` / `CENTER CLOSED` status and **no timer**. It never substitutes
/// a default, a QR age, or a made-up deadline.
///
/// The countdown is also not presented as an admission guarantee: the backend's
/// `queueService.joinQueue` does not enforce operating hours, so the note under
/// the timer says so. The server has the final say on every join.
class JoinWindowCard extends ConsumerStatefulWidget {
  const JoinWindowCard({
    super.key,
    required this.center,
    required this.isAdmitting,
  });

  final ServiceCenter center;

  /// Whether joining is currently permitted, from backend-authoritative checks
  /// (center open, service active, queue status).
  final bool isAdmitting;

  /// Formats a duration as `MM:SS`, or `HH:MM:SS` past an hour.
  static String formatRemaining(Duration d) {
    final total = d.isNegative ? Duration.zero : d;
    final h = total.inHours;
    final m = total.inMinutes.remainder(60);
    final s = total.inSeconds.remainder(60);
    final mm = m.toString().padLeft(2, '0');
    final ss = s.toString().padLeft(2, '0');
    return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
  }

  /// Formats a duration the way a person reads it: `9 min 42 sec`.
  static String formatVerbose(Duration d) {
    final total = d.isNegative ? Duration.zero : d;
    if (total.inHours > 0) {
      return '${total.inHours} hr ${total.inMinutes.remainder(60)} min';
    }
    return '${total.inMinutes} min ${total.inSeconds.remainder(60)} sec';
  }

  @override
  ConsumerState<JoinWindowCard> createState() => _JoinWindowCardState();
}

class _JoinWindowCardState extends ConsumerState<JoinWindowCard> {
  Timer? _ticker;

  /// Re-resolved on every tick so the countdown, the expiry and the closed
  /// state all come from one code path against the live clock.
  late OperatingHoursWindow _window;

  @override
  void initState() {
    super.initState();
    _window = _resolve();
    // One tick a second is enough for a `MM:SS` readout, and cheap.
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      final next = _resolve();
      if (next.runtimeType != _window.runtimeType) {
        setState(() => _window = next);
      } else {
        setState(() {});
      }
    });
  }

  @override
  void didUpdateWidget(JoinWindowCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.center.id != widget.center.id) {
      setState(() => _window = _resolve());
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  OperatingHoursWindow _resolve() =>
      widget.center.resolveJoiningWindow(DateTime.now());

  @override
  Widget build(BuildContext context) {
    final window = _window;
    final admitting = widget.isAdmitting;

    // ── Closed for the day: no timer, honest status. ────────────────────────
    if (window is JoiningWindowClosedAfterClose) {
      return _JoinWindowShell(
        label: 'CENTER HOURS',
        icon: Icons.event_busy_rounded,
        accent: AppColors.danger,
        headline: 'QUEUE JOINING CLOSED',
        detail: 'Configured closing time '
            '${_hhmm(window.closedAt)} has passed. '
            'The service desk can still accept you in person.',
        footnote: 'Tap “Refresh Status” to re-check with the service center.',
      );
    }
    if (window is JoiningWindowNotScheduled) {
      return _JoinWindowShell(
        label: 'CENTER HOURS',
        icon: Icons.weekend_outlined,
        accent: AppColors.textSecondary,
        headline: 'CENTER NOT SCHEDULED TODAY',
        detail: window.reason,
      );
    }

    // ── No authoritative window: truthful status, zero timers. ──────────────
    if (window is JoiningWindowUnconfigured) {
      return _JoinWindowShell(
        label: 'CENTER STATUS',
        icon: admitting
            ? Icons.check_circle_outline_rounded
            : Icons.do_not_disturb_on_outlined,
        accent: admitting ? AppColors.success : AppColors.danger,
        headline: admitting ? 'CENTER OPEN' : 'CENTER CLOSED',
        detail: admitting
            ? 'This center has not published a closing time, so no joining '
                  'window is shown.'
            : 'This center is not currently accepting queue entries.',
        footnote: admitting
            ? 'No countdown is shown because the service center has no '
                  'configured closing time on record.'
            : null,
      );
    }

    // ── Inside the configured window: the real countdown. ──────────────────
    final open = window as JoiningWindowOpen;
    final remaining = open.remaining;
    final closingSoon = remaining.inMinutes < 15;
    // A centre that is not admitting is called out in words even when the
    // configured hours still have time left, so the status line never implies
    // that an open clock equals an open door.
    final accent = !admitting
        ? AppColors.danger
        : (closingSoon ? AppColors.warning : AppColors.primary);

    return Semantics(
      liveRegion: true,
      label: !admitting
          ? 'Joining window. Center closes at ${_hhmm(open.closesAt)}, '
              '${JoinWindowCard.formatVerbose(remaining)} remaining. '
              'The center is not currently accepting queue entries.'
          : 'Joining window. Center closes at '
              '${_hhmm(open.closesAt)}, '
              '${JoinWindowCard.formatVerbose(remaining)} remaining.',
      child: _JoinWindowShell(
        label: 'JOINING WINDOW',
        icon: admitting ? Icons.schedule_rounded : Icons.pause_circle_outline,
        accent: accent,
        headline: admitting ? 'CLOSES IN' : 'CLOSES IN — CENTER NOT JOINING',
        headlineValue: JoinWindowCard.formatRemaining(remaining),
        detail: 'Center hours today: ${_hhmm(open.opensAt)} – '
            '${_hhmm(open.closesAt)}',
        footnote: admitting
            ? 'Configured center hours. The service desk has the final say '
                'on every queue entry.'
            : 'These are the center\'s configured hours, not an admission '
                'decision. It is not accepting queue entries right now.',
        trailing: LinearProgressIndicator(
          value: _fractionOfDayRemaining(open),
          minHeight: 4,
          backgroundColor: AppColors.surfaceElevated,
          valueColor: AlwaysStoppedAnimation<Color>(accent),
        ),
      ),
    );
  }

  /// Fraction of the configured window still ahead, for the thin progress rule.
  double _fractionOfDayRemaining(JoiningWindowOpen window) {
    final total = window.closesAt.difference(window.opensAt).inSeconds;
    if (total <= 0) return 0;
    final left = window.remaining.inSeconds.clamp(0, total);
    return (left / total).toDouble();
  }

  String _hhmm(DateTime t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

class _JoinWindowShell extends StatelessWidget {
  const _JoinWindowShell({
    required this.label,
    required this.icon,
    required this.accent,
    required this.headline,
    this.headlineValue,
    this.detail,
    this.footnote,
    this.trailing,
  });

  final String label;
  final IconData icon;
  final Color accent;
  final String headline;
  final String? headlineValue;
  final String? detail;
  final String? footnote;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: accent.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // The label is duplicated as text, so the state is never
              // conveyed by colour alone.
              Icon(icon, size: 16, color: accent),
              const SizedBox(width: 8),
              Text(
                label,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.2,
                  color: accent,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Flexible(
                child: Text(
                  headline,
                  style: TextStyle(
                    fontSize: headlineValue == null ? 15 : 12,
                    fontWeight: FontWeight.w800,
                    letterSpacing: headlineValue == null ? 0 : 1.2,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              if (headlineValue != null) ...[
                const SizedBox(width: 12),
                Flexible(
                  child: Text(
                    headlineValue!,
                    style: AppTheme.monoStyle(fontSize: 26, color: accent),
                  ),
                ),
              ],
            ],
          ),
          if (detail != null) ...[
            const SizedBox(height: 6),
            Text(detail!, style: Theme.of(context).textTheme.bodySmall),
          ],
          if (trailing != null) ...[
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: trailing!,
            ),
          ],
          if (footnote != null) ...[
            const SizedBox(height: 8),
            Text(
              footnote!,
              style: TextStyle(
                fontSize: 10,
                height: 1.35,
                color: AppColors.textMuted,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Reusable compact metric tile: a label over one authoritative value.
///
/// Renders `--` plus an explicit caption when the backend did not supply the
/// value, so a missing number is never mistaken for a real one.
class JoinMetricTile extends StatelessWidget {
  const JoinMetricTile({
    super.key,
    required this.label,
    required this.value,
    this.caption,
    this.accent,
    this.icon,
    this.semanticValue,
  });

  final String label;
  final String? value;
  final String? caption;
  final Color? accent;
  final IconData? icon;
  final String? semanticValue;

  @override
  Widget build(BuildContext context) {
    final hasValue = value != null && value!.isNotEmpty;
    final color = accent ?? AppColors.textPrimary;

    return Semantics(
      label: label,
      value: semanticValue ?? (hasValue ? value! : 'not reported'),
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
          decoration: BoxDecoration(
            color: AppColors.surfaceElevated,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 12, color: AppColors.textMuted),
                    const SizedBox(width: 5),
                  ],
                  Expanded(
                    child: Text(
                      label.toUpperCase(),
                      maxLines: 2,
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
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(
                  hasValue ? value! : '--',
                  style: AppTheme.monoStyle(
                    fontSize: 20,
                    color: hasValue ? color : AppColors.textMuted,
                  ),
                ),
              ),
              if (caption != null) ...[
                const SizedBox(height: 4),
                Text(
                  caption!,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 9.5,
                    height: 1.3,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

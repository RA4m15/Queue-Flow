import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/join_preview_data.dart';
import '../../providers/join_preview_provider.dart';
import '../../widgets/join/join_ui.dart';
import '../../widgets/join/join_window_card.dart';

/// SELECT A SERVICE — the destination for a center-only customer QR.
///
/// ## Why this screen exists
///
/// The canonical customer QR is the HTTPS `/join` link on the Customer Web
/// host, carrying a `centerId` and optionally a `serviceId`. A center-only QR
/// is valid, and it is what a Live Counter prints when it is not bound to one
/// service. Before this screen, that QR landed on the centre detail page, which
/// had no live queue figures and no way into the join flow other than a generic
/// "Join" button per service — so scanning the code a customer was actually
/// holding got them nowhere useful.
///
/// ## What it shows
///
/// One card per service the backend has published as active
/// (`GET /api/services?centerId=…` filters `isActive: true` server-side), with
/// the live numbers `GET /api/queue/:centerId` reports for it. Tapping a card
/// goes to the same `/join/preview` screen the service-bound QR opens, so there
/// is exactly one preview and one join path.
///
/// ## What it never does
///
/// It never creates a token, and it never displays a wait that the backend did
/// not return. A service with no Queue document shows "queue figures not
/// reported" rather than "0 waiting", because those are different truths.
class JoinServiceSelectionScreen extends ConsumerWidget {
  const JoinServiceSelectionScreen({
    super.key,
    required this.centerId,
  });

  final String centerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectionAsync = ref.watch(joinServiceSelectionProvider(centerId));

    return Scaffold(
      backgroundColor: context.themeBackground,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          tooltip: 'Back',
          onPressed: () => context.pop(),
        ),
        title: const Text('Select a Service'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: 'Refresh services',
            onPressed: () => ref.invalidate(joinServiceSelectionProvider(centerId)),
          ),
        ],
      ),
      body: selectionAsync.when(
        loading: () => const _SelectionSkeleton(),
        error: (error, _) => JoinFailureView(
          icon: switch (classifyJoinPreviewError(error)) {
            JoinPreviewInvalidCenter() => Icons.location_off_rounded,
            JoinPreviewNetworkError() => Icons.cloud_off_rounded,
            _ => Icons.error_outline_rounded,
          },
          accent: AppColors.danger,
          title: switch (classifyJoinPreviewError(error)) {
            JoinPreviewInvalidCenter() => 'INVALID CENTER',
            JoinPreviewNetworkError() => 'SERVICES UNAVAILABLE',
            _ => 'SERVICES UNAVAILABLE',
          },
          message: _failureMessage(error),
          onRetry: () => ref.invalidate(joinServiceSelectionProvider(centerId)),
          actions: [
            JoinFailureAction(
              label: 'SCAN ANOTHER QR',
              onPressed: () => context.pushReplacement('/scan'),
            ),
          ],
        ),
        data: (selection) => _SelectionBody(selection: selection, centerId: centerId),
      ),
    );
  }

  /// Explains a load failure using the backend's own wording where it sent one.
  static String _failureMessage(Object error) {
    final failure = classifyJoinPreviewError(error);
    return switch (failure) {
      JoinPreviewInvalidCenter(:final message) => '$message\n\n'
          'The QR code points at a service center QueueFlow cannot find. It '
          'may have been closed, or the code may be from an old setup.',
      JoinPreviewNetworkError(:final message) => '$message\n\n'
          'No service list is being shown from a previous load, because a stale '
          'service list is worse than none.',
      JoinPreviewCenterClosed(:final center) =>
        '${center.name} is not currently accepting queue entries.',
      JoinPreviewUnexpectedError(:final message) => message,
      _ => ApiException.getUserMessage(error),
    };
  }
}

class _SelectionBody extends StatelessWidget {
  const _SelectionBody({required this.selection, required this.centerId});

  final JoinServiceSelection selection;
  final String centerId;

  @override
  Widget build(BuildContext context) {
    final center = selection.center;
    final options = selection.options;

    if (options.isEmpty) {
      // Truthful empty state: the backend published no active services. It is
      // not the same as "the queue is empty".
      return Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(28, 40, 28, 40),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 72,
                height: 72,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AppColors.warning.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                  border: Border.all(color: AppColors.warning.withValues(alpha: 0.4)),
                ),
                child: const Icon(
                  Icons.design_services_outlined,
                  size: 34,
                  color: AppColors.warning,
                ),
              ),
              const SizedBox(height: 20),
              const Text(
                'NO SERVICES AVAILABLE',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.4,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                '${center.name} has not published any active queue services '
                'right now. Please check with the service desk.',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 13,
                  height: 1.5,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 28),
              SizedBox(
                height: 52,
                child: ElevatedButton(
                  onPressed: () => context.pushReplacement('/scan'),
                  child: const Text('SCAN ANOTHER QR'),
                ),
              ),
            ],
          ),
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
      children: [
        const Text(
          'QUEUEFLOW',
          style: TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w800,
            letterSpacing: 3,
            color: AppColors.primary,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          'SELECT A SERVICE',
          style: Theme.of(context)
              .textTheme
              .headlineLarge
              ?.copyWith(fontWeight: FontWeight.w800, height: 1.15),
        ),
        const SizedBox(height: 8),
        Text(
          center.name,
          style: const TextStyle(
            fontSize: 13,
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: 18),
        JoinWindowCard(center: center, isAdmitting: center.isOpen),
        const SizedBox(height: 18),
        Text(
          '${options.length} ${options.length == 1 ? 'service' : 'services'} · '
          'live queue figures from the service center',
          style: const TextStyle(
            fontSize: 11.5,
            color: AppColors.textMuted,
          ),
        ),
        const SizedBox(height: 14),
        for (final option in options) ...[
          _ServiceCard(
            option: option,
            // The same preview route the service-bound QR opens. There is no
            // second join screen, and the preview re-reads the backend itself.
            onTap: () => context.push(
              '/join/preview?centerId=$centerId&serviceId=${option.service.id}',
            ),
          ),
          const SizedBox(height: 12),
        ],
        const SizedBox(height: 4),
        const Text(
          'Choosing a service shows its current queue before anything is '
          'reserved. A digital token is only issued after you confirm.',
          style: TextStyle(
            fontSize: 11,
            height: 1.45,
            color: AppColors.textMuted,
          ),
        ),
      ],
    );
  }
}

class _ServiceCard extends StatelessWidget {
  const _ServiceCard({required this.option, required this.onTap});

  final JoinServiceOption option;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final service = option.service;
    final waiting = option.waitingCount;
    final ewt = option.estimatedWaitMinutes;

    return Semantics(
      button: true,
      label: '${service.name}. '
          '${waiting == null ? 'Queue figures not reported' : '$waiting waiting'}. '
          '${ewt == null ? 'Wait not reported' : 'About $ewt minutes wait'}.',
      child: ExcludeSemantics(
        child: Material(
          color: context.themeSurface,
          borderRadius: BorderRadius.circular(18),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(18),
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: context.themeBorder),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          service.name,
                          style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w700,
                            color: AppColors.textPrimary,
                          ),
                        ),
                        if ((service.description ?? '').isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(
                            service.description!,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 11.5,
                              height: 1.4,
                              color: AppColors.textMuted,
                            ),
                          ),
                        ],
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            _Chip(
                              label: waiting == null
                                  ? 'WAITING: n/a'
                                  : 'WAITING: $waiting',
                              accent: waiting == null
                                  ? AppColors.textMuted
                                  : AppColors.primary,
                              emphasised: waiting != null,
                            ),
                            _Chip(
                              label: ewt == null ? 'EWT: n/a' : 'EWT: ~$ewt min',
                              accent: ewt == null
                                  ? AppColors.textMuted
                                  : AppColors.secondary,
                              emphasised: ewt != null,
                            ),
                            if (service.avgServiceTimeMinutes != null)
                              _Chip(
                                label:
                                    'AVG: ~${service.avgServiceTimeMinutes} min',
                                accent: AppColors.textSecondary,
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  const Icon(
                    Icons.arrow_forward_ios_rounded,
                    size: 16,
                    color: AppColors.primary,
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

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    required this.accent,
    this.emphasised = false,
  });

  final String label;
  final Color accent;
  final bool emphasised;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: emphasised ? 0.12 : 0.06),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(
          color: accent.withValues(alpha: emphasised ? 0.35 : 0.2),
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 9.5,
          fontWeight: emphasised ? FontWeight.w800 : FontWeight.w500,
          letterSpacing: 0.5,
          color: emphasised ? accent : AppColors.textMuted,
        ),
      ),
    );
  }
}

class _SelectionSkeleton extends StatelessWidget {
  const _SelectionSkeleton();

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
      children: const [
        JoinSkeleton(height: 26, width: 200, borderRadius: 8),
        SizedBox(height: 10),
        JoinSkeleton(height: 14, width: 150),
        SizedBox(height: 22),
        JoinSkeleton(height: 84, borderRadius: 16),
        SizedBox(height: 14),
        JoinSkeleton(height: 108, borderRadius: 18),
        SizedBox(height: 12),
        JoinSkeleton(height: 108, borderRadius: 18),
        SizedBox(height: 12),
        JoinSkeleton(height: 108, borderRadius: 18),
      ],
    );
  }
}

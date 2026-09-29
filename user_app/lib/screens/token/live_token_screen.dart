import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/token.dart';
import '../../providers/service_graph_provider.dart';
import '../../providers/swap_provider.dart';
import '../../providers/token_provider.dart';
import '../../widgets/token_status_badge.dart';
import '../../widgets/queue_progress_bar.dart';
import '../../widgets/loading_state.dart';
import '../../widgets/empty_state.dart';
import '../../widgets/interactive_queue_graphic.dart';

class LiveTokenScreen extends ConsumerStatefulWidget {
  const LiveTokenScreen({super.key});

  @override
  ConsumerState<LiveTokenScreen> createState() => _LiveTokenScreenState();
}

class _LiveTokenScreenState extends ConsumerState<LiveTokenScreen> {
  bool _hasShownCompletedPrompt = false;
  String? _lastTrackedTokenId;
  TokenNotifier? _tokenNotifier;

  @override
  void initState() {
    super.initState();
    // Phase 2: this screen is the only place live location is shared, so
    // claiming the heartbeat here ties the GPS loop to a customer actually
    // watching their queue position. Navigating away releases it.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _tokenNotifier = ref.read(tokenProvider.notifier);
      _tokenNotifier?.claimHeartbeat();
      _tokenNotifier?.fetchActiveToken();
    });
  }

  @override
  void dispose() {
    // Stops location sharing before the widget tree goes away, so no stray
    // timer or in-flight upload can outlive the screen.
    _tokenNotifier?.releaseHeartbeat();
    super.dispose();
  }

  bool _isCancelling = false;
  bool _isSubmittingFeedback = false;

  void _showCancelDialog(TokenModel token) {
    final tokenState = ref.read(tokenProvider);
    if (tokenState.isOffline) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('This action requires an internet connection.'),
          backgroundColor: AppColors.danger,
        ),
      );
      return;
    }

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: context.themeSurface,
          title: const Text('Cancel Token?'),
          content: Text(
            'Are you sure you want to cancel token ${token.tokenCode}? You will lose your position in queue.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          actions: [
            TextButton(
              onPressed: _isCancelling ? null : () => Navigator.of(ctx).pop(),
              child: const Text('Keep Token', style: TextStyle(color: AppColors.textSecondary)),
            ),
            ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.danger,
                foregroundColor: Colors.white,
              ),
              onPressed: _isCancelling
                  ? null
                  : () async {
                      setDialogState(() => _isCancelling = true);
                      final messenger = ScaffoldMessenger.of(context);
                      final surfaceElevated = context.themeSurfaceElevated;
                      try {
                        await ref.read(tokenProvider.notifier).cancelToken(token.id);
                        if (ctx.mounted) {
                          Navigator.of(ctx).pop();
                        }
                        if (!mounted) return;
                        messenger.showSnackBar(
                          SnackBar(
                            content: const Text('Token cancelled successfully.'),
                            backgroundColor: surfaceElevated,
                          ),
                        );
                      } catch (e) {
                        setDialogState(() => _isCancelling = false);
                        if (!mounted) return;
                        messenger.showSnackBar(
                          SnackBar(
                            content: Text(ApiException.getUserMessage(e)),
                            backgroundColor: AppColors.danger,
                          ),
                        );
                      } finally {
                        _isCancelling = false;
                      }
                    },
              child: _isCancelling
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Text('Yes, Cancel'),
            ),
          ],
        ),
      ),
    );
  }

  void _showFeedbackDialog(TokenModel token) {
    final tokenState = ref.read(tokenProvider);
    if (tokenState.isOffline) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('This action requires an internet connection.'),
          backgroundColor: AppColors.danger,
        ),
      );
      return;
    }

    int rating = 5;
    final commentController = TextEditingController();

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: context.themeSurface,
          title: const Text('Service Feedback'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'How was your experience for token ${token.tokenCode}?',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(5, (index) {
                  final starIndex = index + 1;
                  return IconButton(
                    icon: Icon(
                      starIndex <= rating ? Icons.star_rounded : Icons.star_border_rounded,
                      color: AppColors.warning,
                      size: 32,
                    ),
                    onPressed: () {
                      setDialogState(() => rating = starIndex);
                    },
                  );
                }),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: commentController,
                maxLength: 500,
                maxLines: 3,
                style: const TextStyle(color: AppColors.textPrimary),
                decoration: const InputDecoration(
                  hintText: 'Add an optional comment (max 500 chars)...',
                  counterText: '',
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: _isSubmittingFeedback ? null : () => Navigator.of(ctx).pop(),
              child: const Text('Skip', style: TextStyle(color: AppColors.textSecondary)),
            ),
            ElevatedButton(
              onPressed: _isSubmittingFeedback
                  ? null
                  : () async {
                      setDialogState(() => _isSubmittingFeedback = true);
                      final messenger = ScaffoldMessenger.of(context);
                      try {
                        await ref.read(tokenProvider.notifier).submitFeedback(
                              tokenId: token.id,
                              rating: rating,
                              comment: commentController.text.trim(),
                            );
                        if (ctx.mounted) {
                          Navigator.of(ctx).pop();
                        }
                        if (!mounted) return;
                        messenger.showSnackBar(
                          const SnackBar(
                            content: Text('Thank you for your feedback!'),
                            backgroundColor: AppColors.success,
                          ),
                        );
                      } catch (e) {
                        setDialogState(() => _isSubmittingFeedback = false);
                        if (!mounted) return;
                        messenger.showSnackBar(
                          SnackBar(
                            content: Text(ApiException.getUserMessage(e)),
                            backgroundColor: AppColors.danger,
                          ),
                        );
                      } finally {
                        _isSubmittingFeedback = false;
                      }
                    },
              child: _isSubmittingFeedback
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black),
                    )
                  : const Text('Submit'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildConnectionBanner(TokenState tokenState) {
    if (tokenState.isOffline || tokenState.isCached) {
      final timeStr = tokenState.cachedAt != null
          ? DateFormat('HH:mm').format(tokenState.cachedAt!)
          : 'earlier';
      return Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.warning.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.warning.withValues(alpha: 0.4)),
        ),
        child: Row(
          children: [
            const Icon(Icons.cloud_off_rounded, color: AppColors.warning, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'OFFLINE / LAST KNOWN: Showing confirmed status from $timeStr. Updates paused until reconnected.',
                style: const TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      );
    } else if (tokenState.isReconnecting) {
      return Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.warning.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.warning.withValues(alpha: 0.3)),
        ),
        child: const Row(
          children: [
            SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.warning),
            ),
            SizedBox(width: 10),
            Expanded(
              child: Text(
                'Reconnecting to queue server... Preserving last known state.',
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ],
        ),
      );
    } else if (tokenState.isLive) {
      return Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: AppColors.success.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: AppColors.success.withValues(alpha: 0.3)),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.fiber_manual_record, color: AppColors.success, size: 10),
            SizedBox(width: 6),
            Text(
              'LIVE UPDATES ACTIVE',
              style: TextStyle(
                color: AppColors.success,
                fontSize: 11,
                fontWeight: FontWeight.bold,
                letterSpacing: 0.5,
              ),
            ),
          ],
        ),
      );
    }
    return const SizedBox.shrink();
  }

  @override
  Widget build(BuildContext context) {
    final tokenState = ref.watch(tokenProvider);
    final token = tokenState.activeToken;

    // Track the authoritative Service Graph and swap state for the active token.
    if (token != null && _lastTrackedTokenId != token.id) {
      _lastTrackedTokenId = token.id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ref.read(serviceGraphProvider.notifier).track(token);
        if (token.isActive) {
          ref.read(swapProvider.notifier).load(token.id);
        }
      });
    }

    // Check if token just completed
    if (token != null && token.isCompleted && !_hasShownCompletedPrompt && !token.hasFeedback) {
      _hasShownCompletedPrompt = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showFeedbackDialog(token);
      });
    }

    return Scaffold(
      backgroundColor: context.themeBackground,
      appBar: AppBar(
        title: const Text('Live Token'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: 'Refresh Token',
            onPressed: () => ref.read(tokenProvider.notifier).fetchActiveToken(),
          ),
        ],
      ),
      body: tokenState.isLoading && token == null
          ? const LoadingState(message: 'Checking for active token...')
          : token == null || (!token.isActive && !token.isCompleted)
              ? ListView(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
                  children: [
                    EmptyState(
                      title: 'No Active Token',
                      message: 'You do not have any active tokens in queue. Browse centers to join a line.',
                      icon: Icons.confirmation_number_outlined,
                      actionLabel: 'Browse Centers',
                      onAction: () => context.go('/home'),
                    ),
                    const SizedBox(height: 24),
                    const InteractiveQueueGraphic(
                      isDemo: true,
                      tokenCode: 'A-104',
                      position: 3,
                      peopleAhead: 2,
                      servingToken: 'A-102',
                      counterName: 'Counter 1',
                      waitMinutes: 6,
                      status: 'WAITING',
                    ),
                  ],
                )
              : RefreshIndicator(
                  color: context.themePrimary,
                  backgroundColor: context.themeSurface,
                  onRefresh: () => ref.read(tokenProvider.notifier).fetchActiveToken(),
                  child: ListView(
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                    children: [
                      // ─── CONNECTION / OFFLINE INDICATOR BANNER ──────────
                      _buildConnectionBanner(tokenState),

                      // ─── PHASE 2: SKIP NOTICE ──────────────────────────
                      // A customer who was auto-skipped for leaving the service
                      // area is told exactly that, in plain language, with a way
                      // back into the queue through the normal join flow. The
                      // token is never silently resurrected.
                      if (tokenState.skipNotice != null) ...[
                        _buildSkipNotice(tokenState),
                      ],

                      // ─── PHASE 2: OUT-OF-RANGE WARNING ─────────────────
                      // Only rendered when the backend has affirmatively placed
                      // this customer outside the radius. A stale or unknown
                      // location renders no warning at all, because "you might
                      // be out of range" is not a truthful thing to show.
                      if (token.isActive && token.isLocationOutOfRange) ...[
                        _buildOutOfRangeBanner(token),
                      ],

                      // ─── PHASE 2: APPROACHING-TURN WARNING ──────────────
                      // Copy authored by the backend so the in-app banner and
                      // the push notification can never disagree.
                      if (tokenState.geofenceAlert != null) ...[
                        _buildGeofenceAlert(tokenState),
                      ],

                      // ─── TURN ALERT BANNER ──────────────────────────────
                      if (tokenState.turnAlert != null) ...[
                        Container(
                          margin: const EdgeInsets.only(bottom: 16),
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: AppColors.secondary.withValues(alpha: 0.2),
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(color: AppColors.secondary, width: 2),
                          ),
                          child: Row(
                            children: [
                              const Icon(Icons.campaign_rounded, color: AppColors.secondary, size: 28),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  tokenState.turnAlert!,
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.bold,
                                    fontSize: 14,
                                  ),
                                ),
                              ),
                              IconButton(
                                icon: const Icon(Icons.close_rounded, size: 20, color: Colors.white70),
                                onPressed: () => ref.read(tokenProvider.notifier).dismissTurnAlert(),
                              ),
                            ],
                          ),
                        ),
                      ],

                      // ─── CALLED / SERVING BANNER ALERT ─────────────────
                      if (token.isCalled)
                        Container(
                          margin: const EdgeInsets.only(bottom: 20),
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: AppColors.secondary.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(color: AppColors.secondary, width: 2),
                          ),
                          child: Row(
                            children: [
                              Container(
                                padding: const EdgeInsets.all(10),
                                decoration: const BoxDecoration(
                                  color: AppColors.secondary,
                                  shape: BoxShape.circle,
                                ),
                                child: const Icon(Icons.campaign_rounded, color: Colors.black, size: 24),
                              ),
                              const SizedBox(width: 14),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    const Text(
                                      'YOUR TURN!',
                                      style: TextStyle(
                                        color: AppColors.secondary,
                                        fontWeight: FontWeight.w900,
                                        fontSize: 16,
                                        letterSpacing: 1,
                                      ),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      'Please proceed to ${token.counterName ?? "your assigned counter"}.',
                                      style: const TextStyle(color: Colors.white, fontSize: 13),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),

                      if (token.isServing)
                        Container(
                          margin: const EdgeInsets.only(bottom: 20),
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: AppColors.primary.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(color: AppColors.primary, width: 2),
                          ),
                          child: const Row(
                            children: [
                              Icon(Icons.check_circle_rounded, color: AppColors.primary, size: 28),
                              SizedBox(width: 14),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      'NOW SERVING',
                                      style: TextStyle(
                                        color: AppColors.primary,
                                        fontWeight: FontWeight.w900,
                                        fontSize: 16,
                                      ),
                                    ),
                                    SizedBox(height: 2),
                                    Text(
                                      'You are currently being served at the counter.',
                                      style: TextStyle(color: Colors.white, fontSize: 13),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),

                      // ─── MAIN HERO TOKEN CARD ──────────────────────────
                      Container(
                        padding: const EdgeInsets.all(24),
                        decoration: BoxDecoration(
                          color: context.themeSurface,
                          borderRadius: BorderRadius.circular(24),
                          border: Border.all(
                            color: token.isCalled
                                ? AppColors.secondary
                                : token.isServing
                                    ? AppColors.primary
                                    : context.themeBorder,
                            width: token.isCalled || token.isServing ? 2 : 1,
                          ),
                          boxShadow: [
                            BoxShadow(
                              color: (token.isCalled ? AppColors.secondary : AppColors.primary).withValues(alpha: 0.08),
                              blurRadius: 24,
                              spreadRadius: 2,
                            ),
                          ],
                        ),
                        child: Column(
                          children: [
                            // Center & Service Name
                            Text(
                              token.centerName ?? 'Service Center',
                              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                    color: AppColors.textSecondary,
                                  ),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              token.serviceName ?? 'General Queue',
                              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                                    fontWeight: FontWeight.bold,
                                  ),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 24),

                            // Large Token Code
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 16),
                              decoration: BoxDecoration(
                                color: context.themeSurfaceElevated,
                                borderRadius: BorderRadius.circular(16),
                                border: Border.all(
                                  color: token.isCalled
                                      ? AppColors.secondary
                                      : token.isServing
                                          ? AppColors.primary
                                          : context.themeBorder,
                                ),
                              ),
                              child: Text(
                                token.tokenCode,
                                style: AppTheme.monoStyle(
                                  fontSize: 48,
                                  fontWeight: FontWeight.w900,
                                  color: token.isCalled
                                      ? AppColors.secondary
                                      : token.isServing
                                          ? AppColors.primary
                                          : Colors.white,
                                  letterSpacing: 2,
                                ),
                              ),
                            ),
                            const SizedBox(height: 16),

                            // Status Badge
                            TokenStatusBadge(status: token.status, fontSize: 13),
                            const SizedBox(height: 24),

                            // Stats 4-Column Grid: Position, Ahead, Serving, Est. Wait
                            Row(
                              children: [
                                Expanded(
                                  child: _buildTokenStat(
                                    label: 'Position',
                                    value: token.isCalled || token.isServing
                                        ? 'NOW'
                                        : (token.currentPosition != null ? '#${token.currentPosition}' : '--'),
                                    color: AppColors.primary,
                                  ),
                                ),
                                Container(width: 1, height: 40, color: AppColors.border),
                                Expanded(
                                  child: _buildTokenStat(
                                    label: 'Ahead',
                                    value: token.isCalled || token.isServing
                                        ? '0'
                                        : '${token.peopleAhead}',
                                    color: AppColors.secondary,
                                  ),
                                ),
                                Container(width: 1, height: 40, color: AppColors.border),
                                Expanded(
                                  child: _buildTokenStat(
                                    label: 'Serving',
                                    value: token.servingToken ?? '--',
                                    color: const Color(0xFF00D2FF),
                                  ),
                                ),
                                Container(width: 1, height: 40, color: AppColors.border),
                                Expanded(
                                  child: _buildTokenStat(
                                    label: 'Est. Wait',
                                    value: token.isCalled || token.isServing
                                        ? '0m'
                                        : (token.waitEstimateMinutes != null ? '${token.waitEstimateMinutes}m' : '--'),
                                    color: AppColors.warning,
                                  ),
                                ),
                              ],
                            ),

                            if (token.counterName != null) ...[
                              const SizedBox(height: 20),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                                decoration: BoxDecoration(
                                  color: context.themeSurfaceElevated,
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: context.themeBorder),
                                ),
                                child: Row(
                                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                  children: [
                                    const Text('Assigned Counter:', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                                    Text(
                                      token.counterName!,
                                      style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.secondary, fontSize: 14),
                                    ),
                                  ],
                                ),
                              ),
                            ],

                            const SizedBox(height: 24),
                            // Queue Progress Bar
                            QueueProgressBar(
                              initialPosition: token.initialPosition,
                              currentPosition: token.currentPosition,
                              status: token.status,
                            ),

                            const SizedBox(height: 18),
                            // Interactive Queue Flow Graphic
                            InteractiveQueueGraphic(
                              tokenCode: token.tokenCode,
                              position: token.currentPosition ?? 1,
                              peopleAhead: token.peopleAhead,
                              servingToken: token.servingToken ?? (token.counterName ?? 'Counter 1'),
                              counterName: token.counterName ?? 'Counter 1',
                              waitMinutes: token.waitEstimateMinutes ?? 5,
                              status: token.status,
                            ),

                            const SizedBox(height: 18),
                            // Ghost Queue: backend-authoritative proximity
                            _buildGhostQueueProximity(token, tokenState),

                            // Service Graph: the next hop is whatever the
                            // backend reports, never inferred in Dart.
                            _buildServiceGraphHop(token),
                          ],
                        ),
                      ),
                      const SizedBox(height: 24),

                      // ─── ACTION BUTTONS ────────────────────────────────
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: () {
                                context.push('/token/qr', extra: token);
                              },
                              icon: const Icon(Icons.qr_code_rounded, size: 20),
                              label: const Text('Show QR'),
                            ),
                          ),
                          if (token.canCancel) ...[
                            const SizedBox(width: 12),
                            Expanded(
                              child: OutlinedButton.icon(
                                onPressed: () => _showCancelDialog(token),
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: tokenState.isOffline ? AppColors.textMuted : AppColors.danger,
                                  side: BorderSide(
                                    color: tokenState.isOffline ? AppColors.border : AppColors.danger,
                                    width: 1.5,
                                  ),
                                ),
                                icon: const Icon(Icons.close_rounded, size: 20),
                                label: Text(tokenState.isOffline ? 'Cancel (Offline)' : 'Cancel Token'),
                              ),
                            ),
                          ],
                        ],
                      ),

                      if (token.isCompleted && !token.hasFeedback) ...[
                        const SizedBox(height: 16),
                        ElevatedButton.icon(
                          onPressed: () => _showFeedbackDialog(token),
                          icon: const Icon(Icons.star_rate_rounded, size: 20),
                          label: const Text('Rate Your Experience'),
                        ),
                      ],
                    ],
                  ),
                ),
    );
  }

  Widget _buildTokenStat({
    required String label,
    required String value,
    required Color color,
  }) {
    return Column(
      children: [
        Text(
          label,
          style: const TextStyle(
            color: AppColors.textMuted,
            fontSize: 10,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          style: AppTheme.monoStyle(
            fontSize: 15,
            color: color,
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }

  /// Phase 2: the truthful explanation for an out-of-range auto-skip, with a
  /// route back into the queue via the normal join flow.
  Widget _buildSkipNotice(TokenState tokenState) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.danger.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.danger, width: 2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.report_gmailerrorred_rounded, color: AppColors.danger, size: 24),
              const SizedBox(width: 10),
              const Expanded(
                child: Text(
                  'Token skipped',
                  style: TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                    fontSize: 15,
                  ),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close_rounded, size: 20, color: Colors.white70),
                onPressed: () => ref.read(tokenProvider.notifier).dismissSkipNotice(),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            tokenState.skipNotice!,
            style: const TextStyle(color: Colors.white, fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: 12),
          // Rejoin uses the existing join path. There is no second queue-entry
          // system, and the app never quietly puts the customer back in line.
          Align(
            alignment: Alignment.centerLeft,
            child: FilledButton.icon(
              onPressed: () => context.go('/home'),
              icon: const Icon(Icons.replay_rounded, size: 18),
              label: const Text('Rejoin queue'),
            ),
          ),
        ],
      ),
    );
  }

  /// Phase 2: shown only when the backend says this customer is outside the
  /// radius while still holding an active token.
  Widget _buildOutOfRangeBanner(TokenModel token) {
    final meters = token.proximityDistanceMeters;
    final distance = meters == null
        ? ''
        : ' You are about $meters m from the service center.';

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.warning.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.warning, width: 2),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, color: AppColors.warning, size: 24),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              'You have left the service area. Return within 100 m of the service '
              'center to keep your place.$distance',
              style: const TextStyle(color: Colors.white, fontSize: 13, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }

  /// Phase 2: the approaching-turn warning, in the backend's own words.
  Widget _buildGeofenceAlert(TokenState tokenState) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.warning.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.warning.withValues(alpha: 0.6), width: 2),
      ),
      child: Row(
        children: [
          const Icon(Icons.directions_walk_rounded, color: AppColors.warning, size: 24),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              tokenState.geofenceAlert!,
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 13),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close_rounded, size: 20, color: Colors.white70),
            onPressed: () => ref.read(tokenProvider.notifier).dismissGeofenceAlert(),
          ),
        ],
      ),
    );
  }

  Widget _buildGhostQueueProximity(TokenModel token, TokenState tokenState) {
    if (!token.isActive) return const SizedBox.shrink();

    // Step 18: Offline location information must be clearly marked stale.
    // Do not infer INSIDE, NEAR, APPROACHING, OUTSIDE from old cached data.
    final isOffline = tokenState.isOffline || tokenState.isCached;

    final label = isOffline ? 'LOCATION STALE' : token.proximityDisplayLabel.toUpperCase();
    Color badgeColor = isOffline ? AppColors.warning : AppColors.textMuted;
    Color badgeBg = isOffline ? AppColors.warning.withValues(alpha: 0.15) : Colors.white.withValues(alpha: 0.05);
    IconData iconData = isOffline ? Icons.location_off_outlined : Icons.location_on_outlined;

    // Phase 2: the backend's location verdict outranks the older proximity
    // band. An unconfirmed location is shown as such, and is never collapsed
    // into "inside" just because no warning has arrived yet.
    final verdictLabel = token.locationStatus != null
        ? switch (token.locationStatus!.toUpperCase()) {
            'IN_RANGE' => 'IN SERVICE AREA',
            'OUT_OF_RANGE' => 'OUTSIDE SERVICE AREA',
            'LOCATION_STALE' => 'LOCATION STALE',
            'LOCATION_UNAVAILABLE' => 'LOCATION UNAVAILABLE',
            _ => null,
          }
        : null;

    if (!isOffline) {
      if (token.isLocationOutOfRange) {
        badgeColor = AppColors.danger;
        badgeBg = AppColors.danger.withValues(alpha: 0.15);
        iconData = Icons.public;
      } else if (token.isLocationUnconfirmed) {
        badgeColor = AppColors.warning;
        badgeBg = AppColors.warning.withValues(alpha: 0.15);
        iconData = Icons.location_off_outlined;
      } else if (token.isLocationInRange) {
        badgeColor = AppColors.primary;
        badgeBg = AppColors.primary.withValues(alpha: 0.15);
        iconData = Icons.check_circle_outline;
      } else if (token.isInsideGeofence) {
        badgeColor = AppColors.primary;
        badgeBg = AppColors.primary.withValues(alpha: 0.15);
        iconData = Icons.check_circle_outline;
      } else if (token.isNearGeofence) {
        badgeColor = const Color(0xFF00D2FF);
        badgeBg = const Color(0xFF00D2FF).withValues(alpha: 0.15);
        iconData = Icons.directions_walk;
      } else if (token.isApproachingGeofence) {
        badgeColor = AppColors.warning;
        badgeBg = AppColors.warning.withValues(alpha: 0.15);
        iconData = Icons.directions_car;
      } else if (token.isOutsideGeofence) {
        badgeColor = AppColors.textSecondary;
        badgeBg = Colors.white.withValues(alpha: 0.08);
        iconData = Icons.public;
      }
    }

    String? distanceStr;
    if (isOffline) {
      distanceStr = 'Location status unconfirmed while offline. Showing last recorded state.';
    } else if (token.proximityDistanceMeters != null) {
      final meters = token.proximityDistanceMeters!;
      if (meters <= 500) {
        distanceStr = 'Within 500m of center';
      } else if (meters < 1000) {
        distanceStr = '~$meters m from center';
      } else {
        distanceStr = '~${(meters / 1000).toStringAsFixed(1)} km from center';
      }
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: context.themeSurfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.themeBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Icon(iconData, size: 16, color: badgeColor),
                  const SizedBox(width: 8),
                  const Text(
                    'Ghost Queue',
                    style: TextStyle(
                      color: AppColors.textMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: badgeBg,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  verdictLabel ?? label,
                  style: TextStyle(
                    color: badgeColor,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
            ],
          ),
          if (distanceStr != null) ...[
            const SizedBox(height: 6),
            Text(
              distanceStr,
              style: TextStyle(
                color: isOffline ? AppColors.warning : AppColors.textSecondary,
                fontSize: 12,
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// Renders the Service Graph hop exactly as the backend reported it.
  ///
  /// Renders nothing when the backend has not opened a next hop, so no graph
  /// transition is ever invented on the client.
  Widget _buildServiceGraphHop(TokenModel token) {
    final graph = ref.watch(serviceGraphProvider);
    final nextHop = graph.nextHop;

    // Nothing authoritative to show yet, and no hop open.
    if (nextHop == null || (!nextHop.hasNextService && !nextHop.isJourney)) {
      return const SizedBox.shrink();
    }

    final stale = graph.isStale;

    return Container(
      margin: const EdgeInsets.only(top: 16),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: context.themeSurfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: stale ? AppColors.warning.withValues(alpha: 0.5) : AppColors.primary.withValues(alpha: 0.3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                stale ? Icons.sync_problem_rounded : Icons.alt_route_rounded,
                color: stale ? AppColors.warning : AppColors.primary,
                size: 20,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  nextHop.isJourney
                      ? 'Service Journey — Step ${nextHop.journeyHop} of ${nextHop.journeyTotal}'
                      : 'Service Journey',
                  style: TextStyle(
                    color: stale ? AppColors.warning : AppColors.primary,
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              if (nextHop.alreadyTransitioned)
                const Text(
                  'NEXT STEP CONFIRMED',
                  style: TextStyle(
                    color: AppColors.success,
                    fontSize: 9,
                    fontWeight: FontWeight.bold,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          if (stale)
            const Text(
              'Next service data could not be refreshed. Showing the last confirmed state from the service center.',
              style: TextStyle(color: AppColors.warning, fontSize: 11),
            )
          else if (nextHop.alreadyTransitioned)
            const Text(
              'The service center has already issued your next token for this journey.',
              style: TextStyle(color: AppColors.textSecondary, fontSize: 11),
            )
          else if (nextHop.hasNextService) ...[
            Text(
              nextHop.message ?? 'Choose the next service for this visit:',
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 11),
            ),
            const SizedBox(height: 8),
            for (final candidate in nextHop.nextServices)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  children: [
                    const Icon(Icons.subdirectory_arrow_right_rounded, size: 14, color: AppColors.textMuted),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        candidate.name,
                        style: const TextStyle(color: AppColors.textPrimary, fontSize: 12),
                      ),
                    ),
                    if (graph.canTransition)
                      TextButton(
                        onPressed: () => _confirmNextHop(token, candidate.serviceId, candidate.name),
                        style: TextButton.styleFrom(
                          foregroundColor: AppColors.primary,
                          visualDensity: VisualDensity.compact,
                        ),
                        child: const Text('Proceed', style: TextStyle(fontSize: 11)),
                      ),
                  ],
                ),
              ),
          ] else
            Text(
              nextHop.message ?? 'No further service is required for this visit.',
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 11),
            ),
        ],
      ),
    );
  }

  Future<void> _confirmNextHop(
    TokenModel token,
    String nextServiceId,
    String nextServiceName,
  ) async {
    final notifier = ref.read(serviceGraphProvider.notifier);
    try {
      // The backend creates the next token; the client never renames the
      // current one locally.
      await notifier.confirmNextHop(tokenId: token.id, nextServiceId: nextServiceId);
      await ref.read(tokenProvider.notifier).fetchActiveToken(silent: true);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$nextServiceName requested. Confirming your new token…')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(ApiException.getUserMessage(e)),
          backgroundColor: AppColors.danger,
        ),
      );
    }
  }
}

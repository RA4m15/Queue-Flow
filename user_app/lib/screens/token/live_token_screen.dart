import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/token.dart';
import '../../providers/token_provider.dart';
import '../../widgets/token_status_badge.dart';
import '../../widgets/queue_progress_bar.dart';
import '../../widgets/loading_state.dart';
import '../../widgets/empty_state.dart';

class LiveTokenScreen extends ConsumerStatefulWidget {
  const LiveTokenScreen({super.key});

  @override
  ConsumerState<LiveTokenScreen> createState() => _LiveTokenScreenState();
}

class _LiveTokenScreenState extends ConsumerState<LiveTokenScreen> {
  bool _hasShownCompletedPrompt = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(tokenProvider.notifier).fetchActiveToken();
    });
  }

  bool _isCancelling = false;
  bool _isSubmittingFeedback = false;

  void _showCancelDialog(TokenModel token) {
    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: AppColors.surface,
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
                      try {
                        await ref.read(tokenProvider.notifier).cancelToken(token.id);
                        if (ctx.mounted) {
                          Navigator.of(ctx).pop();
                        }
                        if (!mounted) return;
                        messenger.showSnackBar(
                          const SnackBar(
                            content: Text('Token cancelled successfully.'),
                            backgroundColor: AppColors.surfaceElevated,
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
    int rating = 5;
    final commentController = TextEditingController();

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: AppColors.surface,
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

  @override
  Widget build(BuildContext context) {
    final tokenState = ref.watch(tokenProvider);
    final token = tokenState.activeToken;

    // Check if token just completed
    if (token != null && token.isCompleted && !_hasShownCompletedPrompt && !token.hasFeedback) {
      _hasShownCompletedPrompt = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showFeedbackDialog(token);
      });
    }

    return Scaffold(
      backgroundColor: AppColors.background,
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
          : token == null || !token.isActive && !token.isCompleted
              ? EmptyState(
                  title: 'No Active Token',
                  message: 'You do not have any active tokens in queue. Browse centers to join a line.',
                  icon: Icons.confirmation_number_outlined,
                  actionLabel: 'Browse Centers',
                  onAction: () => context.go('/home'),
                )
              : RefreshIndicator(
                  color: AppColors.primary,
                  backgroundColor: AppColors.surface,
                  onRefresh: () => ref.read(tokenProvider.notifier).fetchActiveToken(),
                  child: ListView(
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                    children: [
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
                          color: AppColors.surface,
                          borderRadius: BorderRadius.circular(24),
                          border: Border.all(
                            color: token.isCalled
                                ? AppColors.secondary
                                : token.isServing
                                    ? AppColors.primary
                                    : AppColors.border,
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
                                color: AppColors.surfaceElevated,
                                borderRadius: BorderRadius.circular(16),
                                border: Border.all(
                                  color: token.isCalled
                                      ? AppColors.secondary
                                      : token.isServing
                                          ? AppColors.primary
                                          : AppColors.borderLight,
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

                            // Stats 3-Column Grid
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
                                        : (token.currentPosition != null
                                            ? '${token.currentPosition! > 1 ? token.currentPosition! - 1 : 0}'
                                            : '--'),
                                    color: AppColors.secondary,
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
                                  color: AppColors.surfaceElevated,
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: AppColors.border),
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
                                  foregroundColor: AppColors.danger,
                                  side: const BorderSide(color: AppColors.danger, width: 1.5),
                                ),
                                icon: const Icon(Icons.close_rounded, size: 20),
                                label: const Text('Cancel Token'),
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
            fontSize: 11,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          style: AppTheme.monoStyle(
            fontSize: 18,
            color: color,
          ),
        ),
      ],
    );
  }
}

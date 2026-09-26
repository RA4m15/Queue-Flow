import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../core/utils/date_formatter.dart';
import '../../models/token.dart';
import '../../providers/token_provider.dart';
import '../../widgets/token_status_badge.dart';
import '../../widgets/loading_state.dart';
import '../../widgets/error_state.dart';
import '../../widgets/empty_state.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  void _showFeedbackDialog(BuildContext context, WidgetRef ref, TokenModel token) {
    int rating = 5;
    final commentController = TextEditingController();

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: AppColors.surface,
          title: const Text('Rate Your Experience'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'How was your visit for token ${token.tokenCode}?',
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
                      size: 30,
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
                maxLines: 2,
                style: const TextStyle(color: AppColors.textPrimary),
                decoration: const InputDecoration(
                  hintText: 'Add a comment (optional)...',
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel', style: TextStyle(color: AppColors.textSecondary)),
            ),
            ElevatedButton(
              onPressed: () async {
                Navigator.of(ctx).pop();
                try {
                  await ref.read(tokenProvider.notifier).submitFeedback(
                        tokenId: token.id,
                        rating: rating,
                        comment: commentController.text,
                      );
                  ref.invalidate(tokenHistoryProvider);
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Feedback submitted. Thank you!'),
                        backgroundColor: AppColors.success,
                      ),
                    );
                  }
                } catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text('Unable to submit feedback: ${ApiException.getUserMessage(e)}'),
                        backgroundColor: AppColors.danger,
                      ),
                    );
                  }
                }
              },
              child: const Text('Submit'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final historyAsync = ref.watch(tokenHistoryProvider);

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('Token History'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            onPressed: () => ref.invalidate(tokenHistoryProvider),
          ),
        ],
      ),
      body: historyAsync.when(
        data: (tokens) {
          if (tokens.isEmpty) {
            return EmptyState(
              title: 'No token history yet',
              message: 'Your completed, cancelled, or past queue tokens will appear here.',
              icon: Icons.history_rounded,
              actionLabel: 'Join a Queue',
              onAction: () => context.go('/home'),
            );
          }

          return RefreshIndicator(
            color: AppColors.primary,
            backgroundColor: AppColors.surface,
            onRefresh: () async => ref.invalidate(tokenHistoryProvider),
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              itemCount: tokens.length,
              itemBuilder: (context, index) {
                final token = tokens[index];

                return Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            token.tokenCode,
                            style: AppTheme.monoStyle(
                              fontSize: 20,
                              color: AppColors.primary,
                            ),
                          ),
                          TokenStatusBadge(status: token.status),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Text(
                        token.serviceName ?? 'Service',
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.bold,
                            ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        token.centerName ?? 'Service Center',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: 12),
                      const Divider(color: AppColors.border, height: 1),
                      const SizedBox(height: 12),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            DateFormatter.formatDateTime(token.createdAt),
                            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                  fontSize: 11,
                                ),
                          ),
                          if (token.isCompleted && !token.hasFeedback)
                            GestureDetector(
                              onTap: () => _showFeedbackDialog(context, ref, token),
                              child: Row(
                                children: const [
                                  Icon(Icons.star_outline_rounded, size: 16, color: AppColors.warning),
                                  SizedBox(width: 4),
                                  Text(
                                    'Rate',
                                    style: TextStyle(
                                      color: AppColors.warning,
                                      fontWeight: FontWeight.bold,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ),
                            )
                          else if (token.hasFeedback)
                            Row(
                              children: [
                                const Icon(Icons.star_rounded, size: 16, color: AppColors.warning),
                                const SizedBox(width: 4),
                                Text(
                                  '${token.feedback!.rating}/5',
                                  style: const TextStyle(
                                    color: AppColors.warning,
                                    fontWeight: FontWeight.bold,
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
                        ],
                      ),
                    ],
                  ),
                );
              },
            ),
          );
        },
        loading: () => const LoadingState(message: 'Loading token history...'),
        error: (err, _) => ErrorState(
          message: 'Unable to load token history.',
          onRetry: () => ref.invalidate(tokenHistoryProvider),
        ),
      ),
    );
  }
}

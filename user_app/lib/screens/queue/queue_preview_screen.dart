import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/service_center.dart';
import '../../models/service.dart';
import '../../providers/app_providers.dart';
import '../../providers/token_provider.dart';
import '../../widgets/loading_state.dart';

class QueuePreviewScreen extends ConsumerStatefulWidget {
  const QueuePreviewScreen({
    super.key,
    required this.center,
    required this.service,
  });

  final ServiceCenter center;
  final Service service;

  @override
  ConsumerState<QueuePreviewScreen> createState() => _QueuePreviewScreenState();
}

class _QueuePreviewScreenState extends ConsumerState<QueuePreviewScreen> {
  bool _isLoading = true;
  bool _isJoining = false;
  String? _error;
  bool _isActiveTokenConflict = false;
  String? _loadError;
  bool _notifyApp = true;
  bool _notifySms = false;

  int _waitingCount = 0;
  int? _estWaitMinutes;
  String? _currentlyServingCode;

  @override
  void initState() {
    super.initState();
    _fetchQueueDetails();
  }

  Future<void> _fetchQueueDetails() async {
    setState(() {
      _isLoading = true;
      _loadError = null;
    });

    try {
      final api = ref.read(apiServiceProvider);
      final res = await api.getServiceQueue(widget.center.id, widget.service.id);
      final queueData = res['queue'] as Map<String, dynamic>?;
      final calledTokens = (res['calledTokens'] as List?) ?? [];

      final waitCount = (queueData?['waitingCount'] as num?)?.toInt() ?? 0;

      // Tier 3 / Feature 1: the backend context-aware EWT engine is the single
      // authority. Render its value; never derive a second estimate in Dart.
      final ewt = (res['estimatedWaitMinutes'] as num?)?.toInt();

      String? servingCode;
      if (calledTokens.isNotEmpty) {
        servingCode = calledTokens.first['tokenCode']?.toString();
      }

      if (!mounted) return;
      setState(() {
        _waitingCount = waitCount;
        _estWaitMinutes =
            ewt != null ? ewt.clamp(1, 240) : (waitCount > 0 ? widget.service.estimatedDuration : null);
        _currentlyServingCode = servingCode;
        _isLoading = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
          _loadError = ApiException.getUserMessage(e);
          _waitingCount = 0;
          _estWaitMinutes = null;
          _currentlyServingCode = null;
        });
      }
    }
  }

  Future<void> _handleJoinQueue() async {
    if (_isJoining) return;
    setState(() {
      _isJoining = true;
      _error = null;
    });

    try {
      await ref.read(tokenProvider.notifier).joinQueue(
            centerId: widget.center.id,
            serviceId: widget.service.id,
            notifyApp: _notifyApp,
            notifySms: _notifySms,
          );

      if (mounted) {
        context.go('/token/live');
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isJoining = false;
          _error = ApiException.getUserMessage(e);
          _isActiveTokenConflict = e is ApiException && e.code == 'ACTIVE_TOKEN_EXISTS';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => context.pop(),
        ),
        title: const Text('Queue Preview'),
      ),
      body: _isLoading
          ? const LoadingState(message: 'Checking queue status...')
          : SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // ─── QUEUE OVERVIEW CARD ───────────────────────────
                  Container(
                    padding: const EdgeInsets.all(24),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Column(
                      children: [
                        Text(
                          widget.center.name,
                          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                color: AppColors.textSecondary,
                              ),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 6),
                        Text(
                          widget.service.name,
                          style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 24),

                        // Stats Grid
                        Row(
                          children: [
                            Expanded(
                              child: _buildStatBox(
                                label: 'People Waiting',
                                value: '$_waitingCount',
                                color: AppColors.primary,
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: _buildStatBox(
                                label: 'Est. Wait Time',
                                value: _estWaitMinutes != null ? '$_estWaitMinutes min' : '--',
                                color: AppColors.secondary,
                              ),
                            ),
                          ],
                        ),

                        if (_currentlyServingCode != null) ...[
                          const SizedBox(height: 16),
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
                                Text(
                                  'Currently Serving',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                                Text(
                                  _currentlyServingCode!,
                                  style: AppTheme.monoStyle(
                                    fontSize: 16,
                                    color: AppColors.secondary,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),

                  // ─── LOAD ERROR BANNER ─────────────────────────────
                  if (_loadError != null) ...[
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: AppColors.danger.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.danger.withValues(alpha: 0.4)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(Icons.cloud_off_rounded, color: AppColors.danger, size: 20),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  'Unable to load live queue details. $_loadError',
                                  style: const TextStyle(color: AppColors.danger, fontSize: 13, fontWeight: FontWeight.w600),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 10),
                          TextButton.icon(
                            onPressed: _isLoading ? null : _fetchQueueDetails,
                            icon: const Icon(Icons.refresh_rounded, size: 18),
                            label: const Text('Retry'),
                            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
                          ),
                        ],
                      ),
                    ),
                  ],

                  // ─── ERROR BANNER ──────────────────────────────────
                  if (_error != null) ...[
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: AppColors.danger.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.danger.withValues(alpha: 0.4)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              const Icon(Icons.info_outline_rounded, color: AppColors.danger, size: 20),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  _error!,
                                  style: const TextStyle(color: AppColors.danger, fontSize: 13, fontWeight: FontWeight.w600),
                                ),
                              ),
                            ],
                          ),
                          if (_isActiveTokenConflict) ...[
                            const SizedBox(height: 10),
                            ElevatedButton(
                              onPressed: () => context.go('/token/live'),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: AppColors.danger,
                                foregroundColor: Colors.white,
                                minimumSize: const Size.fromHeight(40),
                              ),
                              child: const Text('View Active Token', style: TextStyle(fontSize: 13)),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 20),
                  ],

                  // ─── PREFERENCES ───────────────────────────────────
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Notification Preferences',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 12),
                        SwitchListTile(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('In-App & Push Notifications', style: TextStyle(fontSize: 14)),
                          subtitle: const Text('Get notified when called or your turn is approaching', style: TextStyle(fontSize: 12)),
                          value: _notifyApp,
                          activeThumbColor: AppColors.primary,
                          onChanged: (val) => setState(() => _notifyApp = val),
                        ),
                        SwitchListTile(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('SMS Notifications', style: TextStyle(fontSize: 14)),
                          subtitle: const Text('Receive token confirmation via SMS if phone is added', style: TextStyle(fontSize: 12)),
                          value: _notifySms,
                          activeThumbColor: AppColors.primary,
                          onChanged: (val) => setState(() => _notifySms = val),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 32),

                  // ─── CONFIRM & JOIN BUTTON ─────────────────────────
                  ElevatedButton(
                    onPressed: _isJoining ? null : _handleJoinQueue,
                    child: _isJoining
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.5,
                              valueColor: AlwaysStoppedAnimation<Color>(Colors.black),
                            ),
                          )
                        : const Text('Confirm & Join Queue'),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _buildStatBox({
    required String label,
    required String value,
    required Color color,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        children: [
          Text(
            label,
            style: Theme.of(context).textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: AppTheme.monoStyle(
              fontSize: 20,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/document_readiness.dart';
import '../../models/service_center.dart';
import '../../models/service.dart';
import '../../providers/app_providers.dart';
import '../../providers/document_gate_provider.dart';
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

    // Request the server-authoritative document gate verdict for this service.
    // Readiness is never computed locally; the backend re-checks it on join.
    unawaited(ref.read(documentGateProvider.notifier).check(widget.service.id));

    try {
      final api = ref.read(apiServiceProvider);

      // Fetch queue details
      final res = await api.getServiceQueue(widget.center.id, widget.service.id);
      final queueData = res['queue'] as Map<String, dynamic>?;
      final calledTokens = (res['calledTokens'] as List?) ?? [];

      final waitCount = (queueData?['waitingCount'] as num?)?.toInt() ?? 0;
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
    final tokenState = ref.read(tokenProvider);

    // Step 14: Offline mutations MUST be blocked immediately
    if (tokenState.isOffline) {
      setState(() {
        _error = 'This action requires an internet connection.';
      });
      return;
    }

    // Block the join unless the backend says the document gate is satisfied.
    // An unknown or stale verdict never permits a join.
    final gate = ref.read(documentGateProvider);
    if (!gate.canJoin) {
      setState(() {
        _error = gate.isStale
            ? 'This action requires an internet connection.'
            : gate.readiness.statusDescription;
      });
      return;
    }

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
    final tokenState = ref.watch(tokenProvider);
    final gate = ref.watch(documentGateProvider);
    final canJoin = !_isLoading && gate.canJoin && !tokenState.isOffline;

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
                  // ─── OFFLINE NOTICE ─────────────────────────────────
                  if (tokenState.isOffline) ...[
                    Container(
                      margin: const EdgeInsets.only(bottom: 16),
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: AppColors.warning.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.warning.withValues(alpha: 0.4)),
                      ),
                      child: const Row(
                        children: [
                          Icon(Icons.wifi_off_rounded, color: AppColors.warning, size: 20),
                          SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              'Offline mode: Joining queues requires an active internet connection.',
                              style: TextStyle(
                                color: AppColors.textPrimary,
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],

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
                  const SizedBox(height: 20),

                  // ─── DOCUMENT GATE (backend-authoritative readiness) ─
                  if (gate.readiness.hasRequirements || gate.isStale) ...[
                    _buildDocumentGateCard(gate),
                    const SizedBox(height: 20),
                  ],

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
                    const SizedBox(height: 16),
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
                    onPressed: (_isJoining || !canJoin) ? null : _handleJoinQueue,
                    child: _isJoining
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.5,
                              valueColor: AlwaysStoppedAnimation<Color>(Colors.black),
                            ),
                          )
                        : Text(
                            tokenState.isOffline
                                ? 'Unavailable Offline'
                                : (gate.canJoin
                                    ? 'Confirm & Join Queue'
                                    : 'Documentation Required'),
                          ),
                  ),
                ],
              ),
            ),
    );
  }

  /// Renders the backend's own document gate verdict. Nothing here is
  /// computed locally — status, message and the checklist all come from
  /// `GET /api/documents/services/:id/readiness`.
  Widget _buildDocumentGateCard(DocumentGateState gate) {
    final readiness = gate.readiness;
    final blocked = !gate.canJoin;
    final accent = gate.isStale
        ? AppColors.warning
        : (readiness.isReady ? AppColors.success : AppColors.danger);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: accent.withValues(alpha: 0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                readiness.isReady && !gate.isStale
                    ? Icons.verified_user_rounded
                    : Icons.gavel_rounded,
                color: accent,
                size: 20,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  gate.isStale
                      ? 'Document Gate: Unverified'
                      : readiness.statusLabel,
                  style: TextStyle(
                    color: accent,
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                  ),
                ),
              ),
              if (gate.isLoading)
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.warning),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            gate.isStale
                ? 'Document readiness could not be confirmed. Reconnect to check the requirements for this service.'
                : readiness.statusDescription,
            style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
          ),
          if (readiness.checklist.isNotEmpty) ...[
            const SizedBox(height: 12),
            for (final item in readiness.checklist)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      _documentStatusIcon(item),
                      size: 14,
                      color: _documentStatusColor(item),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        item.isRequired
                            ? '${item.name} (required)'
                            : '${item.name} (optional)',
                        style: TextStyle(
                          fontSize: 12,
                          color: item.isBlocking ? AppColors.textPrimary : AppColors.textSecondary,
                          fontWeight: item.isBlocking ? FontWeight.w600 : FontWeight.w400,
                        ),
                      ),
                    ),
                    Text(
                      _documentStatusLabel(item),
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: _documentStatusColor(item),
                      ),
                    ),
                  ],
                ),
              ),
          ],
          if (blocked) ...[
            const SizedBox(height: 8),
            Text(
              'The service center will verify these requirements again when you join.',
              style: TextStyle(
                fontSize: 11,
                fontStyle: FontStyle.italic,
                color: AppColors.textMuted.withValues(alpha: 1),
              ),
            ),
          ],
        ],
      ),
    );
  }

  static IconData _documentStatusIcon(DocumentRequirementItem item) {
    if (item.isVerified) return Icons.check_circle;
    if (item.isRejected) return Icons.cancel;
    if (item.isPending) return Icons.hourglass_top;
    return Icons.radio_button_unchecked;
  }

  static Color _documentStatusColor(DocumentRequirementItem item) {
    if (item.isVerified) return AppColors.success;
    if (item.isRejected) return AppColors.danger;
    if (item.isPending) return AppColors.warning;
    return AppColors.textMuted;
  }

  static String _documentStatusLabel(DocumentRequirementItem item) {
    if (item.isVerified) return 'Verified';
    if (item.isRejected) return 'Rejected';
    if (item.isPending) return 'Pending';
    return 'Not uploaded';
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

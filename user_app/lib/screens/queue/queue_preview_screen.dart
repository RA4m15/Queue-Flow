import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/document_readiness.dart';
import '../../models/join_preview_data.dart';
import '../../models/operating_hours.dart';
import '../../models/service_center.dart';
import '../../providers/app_providers.dart';
import '../../providers/document_gate_provider.dart';
import '../../providers/join_preview_provider.dart';
import '../../providers/token_provider.dart';
import '../../widgets/crowd_indicator.dart';
import '../../widgets/join/join_confirmation_sheet.dart';
import '../../widgets/join/join_ui.dart';
import '../../widgets/join/join_window_card.dart';
import '../../widgets/join/join_success_overlay.dart';
import '../../services/location_service.dart';

/// SCAN TO JOIN — the queue preview and confirmation screen.
///
/// ## What this screen is
///
/// The single destination for every customer queue QR, whether it was read by
/// the in-app scanner or delivered as an App Link / Universal Link. It is
/// addressed by `centerId` (+ optional `serviceId`) rather than by pre-resolved
/// objects, which is what lets the route be restored after a login redirect or
/// a process restart instead of dumping the customer on the home screen.
///
/// ## What this screen is not
///
/// It never invents a number. Every count, wait, token code, status and crowd
/// figure on screen came from a backend response, and the moment a value is
/// missing the slot says so instead of filling in. The wait estimate in
/// particular is the backend's own context-aware EWT — it is rendered as-is and
/// never re-derived from waiting count × service time.
///
/// It never creates a token. The only path to a token is an explicit tap on
/// JOIN QUEUE, which goes through the existing `tokenProvider.joinQueue` →
/// `POST /api/tokens`, and the Document Gate is checked on both sides of that
/// call.
class QueuePreviewScreen extends ConsumerStatefulWidget {
  const QueuePreviewScreen({
    super.key,
    required this.centerId,
    this.serviceId,
  });

  final String centerId;

  /// Null for a center-only QR, where the customer picks a service first.
  final String? serviceId;

  @override
  ConsumerState<QueuePreviewScreen> createState() => _QueuePreviewScreenState();
}

class _QueuePreviewScreenState extends ConsumerState<QueuePreviewScreen> {
  final ScrollController _scrollController = ScrollController();
  VoidCallback? _releaseLiveUpdates;

  /// True from the first tap until the request settles. Doubles as the
  /// double-tap guard: the button is disabled while it is set.
  bool _isJoining = false;

  /// Which action the customer picked, so the disabled CTA can say why.
  String? _ctaBlockedReason;

  UserLocation? _userLocation;
  bool _isCheckingLocation = false;
  String? _locationError;
  StreamSubscription<UserLocation>? _locationSubscription;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  @override
  void didUpdateWidget(QueuePreviewScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.centerId != widget.centerId ||
        oldWidget.serviceId != widget.serviceId) {
      _start();
    }
  }

  void _start() {
    if (!mounted) return;
    _releaseLiveUpdates?.call();
    _releaseLiveUpdates = ref
        .read(joinQueueLiveRefreshProvider.notifier)
        .watchCenter(widget.centerId);
    // The Document Gate is the backend's verdict, asked for the same service.
    // It is never computed on the client.
    unawaited(_checkDocumentGate());
    unawaited(_checkLocation());
    _startLocationStream();
  }

  void _startLocationStream() {
    _locationSubscription?.cancel();
    final locationService = ref.read(locationServiceProvider);
    _locationSubscription = locationService.getPositionStream().listen(
      (loc) {
        if (!mounted) return;
        setState(() {
          _userLocation = loc;
          _isCheckingLocation = false;
          _locationError = null;
          // Clear previous location-related CTA blocked reason if we are updated
          if (_ctaBlockedReason != null &&
              (_ctaBlockedReason!.contains('OUT OF RANGE') ||
               _ctaBlockedReason!.contains('LOCATION'))) {
            _ctaBlockedReason = null;
          }
        });
      },
      onError: (_) {},
    );
  }

  Future<void> _checkLocation({bool requestPermission = true}) async {
    if (!mounted) return;
    setState(() {
      _isCheckingLocation = true;
      _locationError = null;
    });

    try {
      final locationService = ref.read(locationServiceProvider);
      final loc = await locationService.getCurrentLocation(requestPermission: requestPermission);

      if (!mounted) return;

      if (loc == null) {
        setState(() {
          _isCheckingLocation = false;
          _userLocation = null;
          _locationError = 'Unable to verify your location';
        });
        return;
      }

      setState(() {
        _isCheckingLocation = false;
        _userLocation = loc;
        _locationError = null;
        if (_ctaBlockedReason != null &&
            (_ctaBlockedReason!.contains('OUT OF RANGE') ||
             _ctaBlockedReason!.contains('LOCATION'))) {
          _ctaBlockedReason = null;
        }
      });
      _startLocationStream();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isCheckingLocation = false;
        _userLocation = null;
        _locationError = 'Unable to verify your location';
      });
    }
  }

  Future<void> _checkDocumentGate() async {
    final serviceId = widget.serviceId;
    if (serviceId == null || serviceId.isEmpty) return;
    await ref.read(documentGateProvider.notifier).check(serviceId);
  }

  @override
  void dispose() {
    _locationSubscription?.cancel();
    _releaseLiveUpdates?.call();
    _scrollController.dispose();
    super.dispose();
  }

  // ─── Join ──────────────────────────────────────────────────────────────────

  /// Ask the customer to confirm, then call the authoritative join API.
  Future<void> _onJoinPressed(JoinPreviewData preview) async {
    if (_isJoining) return;
    _scrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
    await JoinConfirmationSheet.show(
      context,
      preview: preview,
      onJoin: () {
        Navigator.of(context, rootNavigator: true).pop();
        _performJoin(preview);
      },
      onChangeService: () => _changeService(),
    );
  }

  void _changeService() {
    // Same service-selection route the center-only QR uses; no second selector.
    context.push('/join/services?centerId=${widget.centerId}');
  }

  /// The only place a queue token is ever created.
  Future<void> _performJoin(JoinPreviewData preview) async {
    if (_isJoining) return;
    setState(() {
      _isJoining = true;
      _ctaBlockedReason = null;
    });

    try {
      UserLocation? freshLoc;
      // Step 1: If center has geofencing enabled, obtain a fresh GPS fix immediately before join
      if (preview.center.location?.isConfigured == true) {
        final locationService = ref.read(locationServiceProvider);
        freshLoc = await locationService.getCurrentLocation(requestPermission: true);

        if (!mounted) return;

        if (freshLoc == null) {
          setState(() {
            _isJoining = false;
            _userLocation = null;
            _locationError = 'Unable to verify your location';
            _ctaBlockedReason = 'LOCATION UNAVAILABLE — Unable to verify your location.';
          });
          return;
        }

        // Update local state with the newly acquired position
        setState(() {
          _userLocation = freshLoc;
          _locationError = null;
        });

        // Step 2: Freshness validation
        if (!freshLoc.isFresh()) {
          setState(() {
            _isJoining = false;
            _ctaBlockedReason = 'LOCATION REFRESHING — Waiting for a fresh GPS reading…';
          });
          return;
        }

        // Step 3: Client-side proximity check
        final dist = calculateHaversineDistanceMeters(
          preview.center.location!.latitude!,
          preview.center.location!.longitude!,
          freshLoc.latitude,
          freshLoc.longitude,
        );
        final radius = preview.center.geofence?.radiusMeters ?? 100;
        if (dist > radius) {
          setState(() {
            _isJoining = false;
            _ctaBlockedReason = 'OUT OF RANGE — You are ${formatDistance(dist)} from this center. You must be within $radius m to join.';
          });
          return;
        }
      }

      // Step 4: Authoritative backend join with fresh coordinates, accuracy, and timestamp
      final token = await ref.read(tokenProvider.notifier).joinQueue(
            centerId: preview.center.id,
            serviceId: preview.service.id,
            notifyApp: true,
            notifySms: false,
            latitude: freshLoc?.latitude ?? _userLocation?.latitude,
            longitude: freshLoc?.longitude ?? _userLocation?.longitude,
            accuracy: freshLoc?.accuracy ?? _userLocation?.accuracy,
            timestamp: freshLoc?.timestamp ?? _userLocation?.timestamp,
          );

      if (!mounted) return;
      // The token above is the one the backend issued. Nothing here is
      // synthesised: no local counter, no fallback code, no guess.
      JoinSuccessOverlay.show(
        context,
        tokenCode: token.tokenCode,
        position: token.currentPosition,
        estimatedWaitMinutes: token.waitEstimateMinutes,
        serviceName: preview.service.name,
        onContinue: _openActiveToken,
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _isJoining = false;
        _ctaBlockedReason = _describeJoinFailure(e);
      });
      // If rejected due to out of range or stale location, refresh the displayed state
      if (e.code == 'OUT_OF_RANGE' || e.code == 'LOCATION_STALE') {
        unawaited(_checkLocation(requestPermission: false));
      }
      // A 403 from the Document Gate means the backend re-checked and refused.
      // Re-read the authoritative checklist so the screen shows the real
      // requirements rather than a generic error.
      if (e.code == 'DOCUMENT_GATE_BLOCKED') {
        unawaited(_checkDocumentGate());
      }
      if (e.code == 'ACTIVE_TOKEN_EXISTS') {
        _openActiveToken();
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isJoining = false;
        _ctaBlockedReason = ApiException.getUserMessage(e);
      });
    }
  }

  /// Maps a join refusal to the sentence shown on the disabled CTA.
  ///
  /// Uses the backend's own message wherever it sent one.
  static String _describeJoinFailure(ApiException e) {
    final code = e.code?.toUpperCase();
    if (code == 'OUT_OF_RANGE') {
      return e.message.isNotEmpty
          ? e.message
          : 'OUT OF RANGE — You need to be within 100 m of this service center to join its queue.';
    }
    if (code == 'LOCATION_STALE') {
      return e.message.isNotEmpty
          ? e.message
          : 'LOCATION STALE — Your GPS position is outdated. Please wait for a fresh fix.';
    }
    if (code == 'LOCATION_UNCERTAIN') {
      return e.message.isNotEmpty
          ? e.message
          : 'LOCATION UNCERTAIN — Your device location is not accurate enough to verify the joining area.';
    }
    if (code == 'LOCATION_REQUIRED') {
      return 'LOCATION REQUIRED — You must share your location to join the queue at this service center.';
    }
    if (code == 'INVALID_COORDINATES') {
      return 'INVALID LOCATION — Unable to verify your coordinates.';
    }
    if (code == 'ACTIVE_TOKEN_EXISTS') {
      return 'ALREADY IN QUEUE — you already have an active token for this service.';
    }
    if (code == 'DOCUMENT_GATE_BLOCKED') {
      return 'DOCUMENTS REQUIRED before you can join this service.';
    }
    if (e.statusCode == 400 && e.message.toLowerCase().contains('closed')) {
      return 'CENTER CLOSED — the service center is not accepting entries.';
    }
    if (e.statusCode == 400 && e.message.toLowerCase().contains('not currently available')) {
      return 'SERVICE UNAVAILABLE — this service is not accepting new customers.';
    }
    return e.message;
  }

  void _openActiveToken() => context.go('/token/live');

  // ─── Build ────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final request = JoinPreviewRequest(
      centerId: widget.centerId,
      serviceId: widget.serviceId,
    );
    final async = ref.watch(joinPreviewProvider(request));
    final gate = ref.watch(documentGateProvider);
    // Read reachability directly from the transport layer, not from the token
    // state. `tokenProvider.isOffline` means "I have a cached token but can't
    // refresh it" — this screen needs to know whether the backend can issue a
    // *new* token, which is a plain transport question answered by NetworkStatus.
    final isOffline = ref.watch(networkOfflineProvider).valueOrNull ?? false;

    return Scaffold(
      backgroundColor: context.themeBackground,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          tooltip: 'Back',
          onPressed: () => context.pop(),
        ),
        title: const Text('Scan to Join'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: 'Refresh status',
            onPressed: () => ref.invalidate(joinPreviewProvider(request)),
          ),
        ],
      ),
      body: async.when(
        loading: () => const JoinPreviewSkeleton(),
        error: (error, _) => _FailureState(
          centerId: widget.centerId,
          error: error,
          onRetry: () => ref.invalidate(joinPreviewProvider(request)),
        ),
        data: (preview) => _Body(
          preview: preview,
          gate: gate,
          controller: _scrollController,
          isOffline: isOffline,
          ctaBlockedReason: _ctaBlockedReason,
          userLocation: _userLocation,
          isCheckingLocation: _isCheckingLocation,
          locationError: _locationError,
          onRetryLocation: () => _checkLocation(requestPermission: true),
          onChangeService: _changeService,
          onRetry: () => ref.invalidate(joinPreviewProvider(request)),
          onViewToken: _openActiveToken,
        ),
      ),
      bottomNavigationBar: async.maybeWhen(
        data: (preview) => _StickyJoinBar(
          preview: preview,
          gate: gate,
          isOffline: isOffline,
          isJoining: _isJoining,
          blockedReason: _ctaBlockedReason,
          userLocation: _userLocation,
          isCheckingLocation: _isCheckingLocation,
          locationError: _locationError,
          onJoin: () => _onJoinPressed(preview),
        ),
        orElse: () => null,
      ),
    );
  }
}

// ─── Failure routing (Step 16) ──────────────────────────────────────────────

class _FailureState extends StatelessWidget {
  const _FailureState({
    required this.centerId,
    required this.error,
    required this.onRetry,
  });

  /// The center the QR named. Recovery links must point back at *this* center,
  /// never at a guessed or empty id.
  final String centerId;

  final Object error;
  final VoidCallback onRetry;

  String get _servicesRoute => '/join/services?centerId=$centerId';

  @override
  Widget build(BuildContext context) {
    final failure = classifyJoinPreviewError(error);
    return switch (failure) {
      JoinPreviewInvalidCenter(:final message) => JoinFailureView(
          icon: Icons.location_off_rounded,
          accent: AppColors.danger,
          title: 'INVALID CENTER',
          message: '$message\n\nThe QR code points at a service center that '
              'QueueFlow cannot find. It may have been closed or the code '
              'printed from an old setup.',
          onRetry: onRetry,
          retryLabel: 'RETRY',
          actions: [
            JoinFailureAction(
              label: 'SCAN ANOTHER QR',
              onPressed: () => context.pushReplacement('/scan'),
            ),
          ],
        ),
      JoinPreviewInvalidService(:final message) => JoinFailureView(
          icon: Icons.design_services_outlined,
          accent: AppColors.danger,
          title: 'INVALID SERVICE',
          message: message,
          onRetry: onRetry,
          actions: [
            JoinFailureAction(
              label: 'CHOOSE ANOTHER SERVICE',
              onPressed: () => context.pushReplacement(_servicesRoute),
            ),
          ],
        ),
      JoinPreviewServiceInactive(:final service) => JoinFailureView(
          icon: Icons.pause_circle_outline_rounded,
          accent: AppColors.warning,
          title: 'SERVICE UNAVAILABLE',
          message: '"${service.name}" is not accepting new customers right now. '
              'Please choose another service, or check with the service desk.',
          onRetry: onRetry,
          retryLabel: 'REFRESH STATUS',
          actions: [
            JoinFailureAction(
              label: 'CHOOSE ANOTHER SERVICE',
              onPressed: () => context.pushReplacement(_servicesRoute),
            ),
          ],
        ),
      JoinPreviewCenterClosed(:final center) => JoinFailureView(
          icon: Icons.do_not_disturb_on_outlined,
          accent: AppColors.danger,
          title: 'CENTER CLOSED',
          message: '${center.name} is not currently accepting queue entries. '
              'Please check the opening hours posted at the center.',
          onRetry: onRetry,
          retryLabel: 'REFRESH STATUS',
        ),
      JoinPreviewNoServices(:final center) => JoinFailureView(
          icon: Icons.design_services_outlined,
          accent: AppColors.warning,
          title: 'NO SERVICES AVAILABLE',
          message: '${center.name} has not published any active queue services '
              'right now. Please check with the service desk.',
          onRetry: onRetry,
          retryLabel: 'REFRESH STATUS',
        ),
      JoinPreviewNoServiceSelected() => JoinFailureView(
          icon: Icons.design_services_outlined,
          accent: AppColors.primary,
          title: 'CHOOSE A SERVICE',
          message: 'This QR code points at ${centerId.isEmpty ? 'a service center' : 'the service center'} '
              'without naming a service. Pick one to see its live queue.',
          onRetry: null,
          actions: [
            JoinFailureAction(
              label: 'CHOOSE A SERVICE',
              onPressed: () => context.pushReplacement(_servicesRoute),
            ),
          ],
        ),
      JoinPreviewNetworkError(:final message) => JoinFailureView(
          icon: Icons.cloud_off_rounded,
          accent: AppColors.warning,
          title: 'QUEUE INFORMATION UNAVAILABLE',
          message: '$message\n\nNothing is being shown from a previous load, '
              'because a stale queue is worse than no queue.',
          onRetry: onRetry,
        ),
      JoinPreviewUnexpectedError(:final message) => JoinFailureView(
          icon: Icons.error_outline_rounded,
          accent: AppColors.danger,
          title: 'QUEUE UNAVAILABLE',
          message: message,
          onRetry: onRetry,
        ),
    };
  }
}

// ─── Loaded body ─────────────────────────────────────────────────────────────

class _Body extends StatelessWidget {
  const _Body({
    required this.preview,
    required this.gate,
    required this.controller,
    required this.isOffline,
    required this.ctaBlockedReason,
    required this.onChangeService,
    required this.onRetry,
    required this.onViewToken,
    this.userLocation,
    this.isCheckingLocation = false,
    this.locationError,
    this.onRetryLocation,
  });

  final JoinPreviewData preview;

  /// The backend's Document Gate verdict for this exact service.
  final DocumentGateState gate;

  final ScrollController controller;
  final bool isOffline;
  final String? ctaBlockedReason;
  final VoidCallback onChangeService;
  final VoidCallback onRetry;
  final VoidCallback onViewToken;
  final UserLocation? userLocation;
  final bool isCheckingLocation;
  final String? locationError;
  final VoidCallback? onRetryLocation;

  @override
  Widget build(BuildContext context) {
    final center = preview.center;
    final service = preview.service;
    final ewt = preview.estimatedWaitMinutes;

    return ListView(
      controller: controller,
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
      children: [
        // ── Header ───────────────────────────────────────────────────────────
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
          service.name,
          style: Theme.of(context)
              .textTheme
              .headlineLarge
              ?.copyWith(fontWeight: FontWeight.w800, height: 1.15),
        ),
        if ((service.description ?? '').isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            service.description!,
            style: const TextStyle(
              fontSize: 13,
              height: 1.45,
              color: AppColors.textSecondary,
            ),
          ),
        ],
        const SizedBox(height: 16),
        _CenterLine(center: center),
        const SizedBox(height: 18),
        _FreshnessStamp(fetchedAt: preview.fetchedAt, onRetry: onRetry),
        const SizedBox(height: 22),

        // ── Where am I / what am I joining ───────────────────────────────────
        JoinSection(
          title: 'Centre & service',
          trailing: TextButton.icon(
            onPressed: onChangeService,
            icon: const Icon(Icons.swap_horiz_rounded, size: 16),
            label: const Text('Change', style: TextStyle(fontSize: 12)),
            style: TextButton.styleFrom(
              foregroundColor: AppColors.secondary,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              minimumSize: const Size(0, 36),
            ),
          ),
          child: JoinCard(
            child: Column(
              children: [
                JoinFactRow(
                  icon: Icons.apartment_rounded,
                  label: 'Centre',
                  value: center.name,
                ),
                if (center.code.isNotEmpty)
                  JoinFactRow(
                    icon: Icons.tag_rounded,
                    label: 'Centre code',
                    value: center.code,
                    valueStyle: AppTheme.monoStyle(
                      fontSize: 13,
                      color: AppColors.textPrimary,
                      letterSpacing: 1.2,
                    ),
                  ),
                JoinFactRow(
                  icon: Icons.design_services_outlined,
                  label: 'Service',
                  value: service.name,
                ),
                if (service.tokenPrefix != null)
                  JoinFactRow(
                    icon: Icons.confirmation_number_outlined,
                    label: 'Token series',
                    value: '${service.tokenPrefix}-…',
                    valueStyle: AppTheme.monoStyle(
                      fontSize: 13,
                      color: AppColors.primary,
                    ),
                  ),
                if (service.avgServiceTimeMinutes != null)
                  JoinFactRow(
                    icon: Icons.timer_outlined,
                    label: 'Avg. service',
                    value: '~${service.avgServiceTimeMinutes} min per customer',
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 22),

        // ── Current queue ────────────────────────────────────────────────────
        JoinSection(
          title: 'Current queue',
          child: JoinCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                JoinMetricGrid(
                  children: [
                    JoinMetricTile(
                      label: 'People waiting',
                      value: preview.waitingCount?.toString(),
                      caption: 'Right now',
                      accent: AppColors.primary,
                      icon: Icons.groups_rounded,
                    ),
                    JoinMetricTile(
                      label: 'Estimated wait',
                      value: ewt == null ? null : '~$ewt min',
                      caption: ewt == null
                          ? 'Not reported'
                          : 'Service centre estimate',
                      accent: AppColors.secondary,
                      icon: Icons.schedule_rounded,
                    ),
                    JoinMetricTile(
                      label: 'Now serving',
                      value: preview.nowServingTokenCode,
                      caption: preview.nowServingTokenCode == null
                          ? 'Nothing called'
                          : 'At the counter',
                      accent: AppColors.warning,
                      icon: Icons.campaign_rounded,
                    ),
                    JoinMetricTile(
                      label: 'Next token',
                      value: preview.nextTokenCode,
                      caption: preview.nextTokenCode == null
                          ? 'Queue empty'
                          : 'Up next',
                      accent: AppColors.textPrimary,
                      icon: Icons.skip_next_rounded,
                    ),
                  ],
                ),
                if (preview.peopleAhead != null) ...[
                  const SizedBox(height: 14),
                  _PeopleAheadBar(
                    ahead: preview.peopleAhead!,
                    nowServing: preview.nowServingTokenCode,
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 22),

        // ── Joining window (real configured hours, or nothing) ───────────────
        JoinSection(
          title: 'Joining window',
          child: JoinWindowCard(center: center, isAdmitting: preview.isServiceJoinable),
        ),
        const SizedBox(height: 22),

        // ── Service area & geofence ──────────────────────────────────────────
        if (center.location?.isConfigured == true) ...[
          _GeofenceCard(
            center: center,
            userLocation: userLocation,
            isCheckingLocation: isCheckingLocation,
            locationError: locationError,
            onRetryLocation: onRetryLocation ?? () {},
          ),
          const SizedBox(height: 22),
        ],

        // ── Today's status ───────────────────────────────────────────────────
        JoinSection(
          title: "Today's status",
          child: JoinCard(
            child: Column(
              children: [
                JoinFactRow(
                  icon: center.isOpen
                      ? Icons.check_circle_outline_rounded
                      : Icons.do_not_disturb_on_outlined,
                  label: 'Centre status',
                  value: center.isOpen ? 'OPEN' : 'CLOSED',
                  valueColor: center.isOpen ? AppColors.success : AppColors.danger,
                ),
                JoinFactRow(
                  icon: Icons.playlist_play_rounded,
                  label: 'Queue status',
                  value: _queueStatusLabel(preview.queueStatus),
                  valueColor: _queueStatusColor(preview.queueStatus),
                ),
                JoinFactRow(
                  icon: Icons.countertops_rounded,
                  label: 'Counters live',
                  value: preview.liveCounterCount?.toString() ?? 'Not reported',
                ),
                if (isOffline)
                  const JoinFactRow(
                    icon: Icons.wifi_off_rounded,
                    label: 'Connection',
                    value: 'OFFLINE — figures may be out of date',
                    valueColor: AppColors.warning,
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 22),

        // ── Crowd (informational only) ───────────────────────────────────────
        JoinSection(
          title: 'Current crowd',
          child: _CrowdCard(center: center),
        ),
        const SizedBox(height: 22),

        // ── Document gate (backend verdict) ──────────────────────────────────
        JoinSection(
          title: 'Documents',
          child: _DocumentGateCard(
            gate: gate,
            onUpload: () => _openDocuments(context, preview),
          ),
        ),
        const SizedBox(height: 22),

        // ── What joining does ────────────────────────────────────────────────
        JoinSection(
          title: 'Your join',
          child: JoinCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'You are about to join:',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 4),
                Text(
                  service.name,
                  style: Theme.of(context)
                      .textTheme
                      .titleLarge
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 12),
                JoinFactRow(
                  icon: Icons.schedule_rounded,
                  label: 'Estimated wait',
                  value: ewt == null ? 'Not reported yet' : '~$ewt minutes',
                  valueColor: ewt == null ? AppColors.textMuted : AppColors.secondary,
                ),
                JoinFactRow(
                  icon: Icons.groups_rounded,
                  label: 'People ahead',
                  value: preview.peopleAhead?.toString() ?? 'Not reported yet',
                ),
                if (ctaBlockedReason != null) ...[
                  const SizedBox(height: 12),
                  _InlineError(
                    message: ctaBlockedReason!,
                    onViewToken: onViewToken,
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        const Text(
          'You will receive a digital token after joining. '
          'Do not leave the service area until your turn approaches.',
          style: TextStyle(
            fontSize: 11,
            height: 1.45,
            color: AppColors.textMuted,
          ),
        ),
      ],
    );
  }

  static String _queueStatusLabel(String? status) {
    if (status == null || status.isEmpty) return 'Not reported';
    return status;
  }

  static Color _queueStatusColor(String? status) {
    if (status == null) return AppColors.textMuted;
    switch (status.toUpperCase()) {
      case 'OPEN':
        return AppColors.success;
      case 'PAUSED':
        return AppColors.warning;
      case 'CLOSED':
        return AppColors.danger;
      default:
        return AppColors.textPrimary;
    }
  }

  static void _openDocuments(BuildContext context, JoinPreviewData preview) {
    // Document upload is owned by the existing live-token / profile surfaces.
    // This screen never takes over the Document Gate; it only reports the
    // backend's verdict about it.
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Upload documents from your token screen once you have joined '
          '(${preview.service.name}).',
        ),
      ),
    );
  }
}

// ─── Small blocks ────────────────────────────────────────────────────────────

class _CenterLine extends StatelessWidget {
  const _CenterLine({required this.center});

  final ServiceCenter center;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: AppColors.surfaceElevated,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: AppColors.border),
          ),
          child: Text(center.typeEmoji, style: const TextStyle(fontSize: 18)),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                center.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                ),
              ),
              Text(
                center.typeDisplayName,
                style: const TextStyle(
                  fontSize: 11,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          ),
        ),
        _StatusPill(
          label: center.isOpen ? 'OPEN' : 'CLOSED',
          color: center.isOpen ? AppColors.success : AppColors.danger,
          icon: center.isOpen
              ? Icons.check_circle_rounded
              : Icons.do_not_disturb_on_rounded,
        ),
      ],
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, required this.color, required this.icon});

  final String label;
  final Color color;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    // The word is always present, so status never depends on colour alone.
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 11, color: color),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.6,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

/// Says how old the numbers on screen are.
///
/// Step 10 requires that stale data is never shown as if it were current, so
/// the age is always on screen, and a refresh is one tap away.
class _FreshnessStamp extends StatelessWidget {
  const _FreshnessStamp({required this.fetchedAt, required this.onRetry});

  final DateTime fetchedAt;

  /// Tapping this line is the same action as the app bar's refresh button.
  final VoidCallback onRetry;

  static String _age(DateTime fetchedAt, DateTime now) {
    final d = now.difference(fetchedAt);
    if (d.inSeconds < 10) return 'just now';
    if (d.inSeconds < 60) return '${d.inSeconds}s ago';
    if (d.inMinutes < 60) return '${d.inMinutes} min ago';
    return '${d.inHours} hr ago';
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final age = _age(fetchedAt, now);
    final stale = now.difference(fetchedAt).inSeconds > 90;

    return Semantics(
      label: 'Queue figures updated $age',
      child: ExcludeSemantics(
        child: Row(
          children: [
            Icon(
              stale ? Icons.history_rounded : Icons.cloud_done_rounded,
              size: 13,
              color: stale ? AppColors.warning : AppColors.textMuted,
            ),
            const SizedBox(width: 6),
            Expanded(
              child: InkWell(
                onTap: onRetry,
                child: Text(
                  stale
                      ? 'Figures $age — tap to re-check'
                      : 'Figures from the centre $age · tap to refresh',
                  style: TextStyle(
                    fontSize: 11,
                    color: stale ? AppColors.warning : AppColors.textMuted,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// "N people ahead" as a proportion of a nominal 10-person reference.
///
/// Deliberately not presented as a progress bar toward a goal: it is a
/// magnitude, and the reference is labelled so it cannot be misread as a
/// completion percentage.
class _PeopleAheadBar extends StatelessWidget {
  const _PeopleAheadBar({required this.ahead, this.nowServing});

  final int ahead;
  final String? nowServing;

  /// Full-width reference point. A fixed, stated scale, not a promise.
  static const int referenceAhead = 20;

  @override
  Widget build(BuildContext context) {
    final fraction = (ahead / referenceAhead).clamp(0.0, 1.0);
    final busy = ahead >= 10;

    return Semantics(
      label: '$ahead people ahead of you',
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '$ahead ${ahead == 1 ? 'person' : 'people'} ahead of you',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
                Text(
                  'scale: 0 – $referenceAhead',
                  style: const TextStyle(fontSize: 9.5, color: AppColors.textMuted),
                ),
              ],
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: fraction,
                minHeight: 6,
                backgroundColor: AppColors.surfaceElevated,
                valueColor: AlwaysStoppedAnimation<Color>(
                  busy ? AppColors.warning : AppColors.primary,
                ),
              ),
            ),
            if (nowServing != null) ...[
              const SizedBox(height: 6),
              Text(
                'Currently being served: $nowServing',
                style: const TextStyle(fontSize: 10.5, color: AppColors.textMuted),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Crowd telemetry, informational only.
///
/// The backend restricts nothing based on crowd, so this block never disables
/// the join CTA. It reports the real occupancy and the backend's own status
/// word.
class _CrowdCard extends StatelessWidget {
  const _CrowdCard({required this.center});

  final ServiceCenter center;

  @override
  Widget build(BuildContext context) {
    final capacity = center.capacity;
    final current = center.currentCrowd;
    if (capacity <= 0) {
      return const JoinCard(
        child: Text(
          'This centre has not reported a capacity, so crowd level is not '
          'available. This does not affect joining.',
          style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.45),
        ),
      );
    }

    final status = center.crowdStatus;
    final percent = center.crowdPercent;

    return JoinCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                '$current / $capacity',
                style: AppTheme.monoStyle(
                  fontSize: 26,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                'inside',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const Spacer(),
              CrowdIndicator(crowdStatus: status),
            ],
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: (percent / 100).clamp(0.0, 1.0),
              minHeight: 6,
              backgroundColor: AppColors.surfaceElevated,
              valueColor: AlwaysStoppedAnimation<Color>(
                percent >= 80
                    ? AppColors.danger
                    : (percent >= 50 ? AppColors.warning : AppColors.success),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            '$percent% of capacity · $status. '
            'Crowd level is informational — the service centre decides who is '
            'admitted.',
            style: const TextStyle(
              fontSize: 10.5,
              height: 1.4,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }
}

/// The backend's own Document Gate verdict, rendered verbatim.
///
/// Nothing is computed here: status, message and every checklist row come from
/// `GET /api/documents/services/:id/readiness`, and the backend re-checks the
/// gate on `POST /tokens`.
class _DocumentGateCard extends StatelessWidget {
  const _DocumentGateCard({required this.gate, required this.onUpload});

  final DocumentGateState gate;
  final VoidCallback onUpload;

  @override
  Widget build(BuildContext context) {
    final state = gate;
    final DocumentReadiness readiness = state.readiness;
    final blocked = !state.canJoin;
    final accent = state.isStale
        ? AppColors.warning
        : (readiness.isReady ? AppColors.success : AppColors.danger);

    return JoinCard(
      borderColor: accent.withValues(alpha: 0.35),
      background: accent.withValues(alpha: 0.06),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                readiness.isReady && !state.isStale
                    ? Icons.verified_user_rounded
                    : Icons.gavel_rounded,
                size: 17,
                color: accent,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  state.isStale
                      ? 'DOCUMENT GATE — UNVERIFIED'
                      : readiness.statusLabel.toUpperCase(),
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1,
                    color: accent,
                  ),
                ),
              ),
              if (state.isLoading)
                const SizedBox(
                  width: 13,
                  height: 13,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: AppColors.warning,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            state.isStale
                ? 'Document readiness could not be confirmed. Reconnect to '
                      'check the requirements for this service.'
                : readiness.statusDescription,
            style: const TextStyle(
              fontSize: 12,
              height: 1.45,
              color: AppColors.textSecondary,
            ),
          ),
          if (readiness.checklist.isNotEmpty) ...[
            const SizedBox(height: 12),
            for (final item in readiness.checklist)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      _icon(item),
                      size: 14,
                      color: _color(item),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '${item.name} (${item.isRequired ? 'required' : 'optional'})',
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.35,
                          fontWeight:
                              item.isBlocking ? FontWeight.w600 : FontWeight.w400,
                          color: item.isBlocking
                              ? AppColors.textPrimary
                              : AppColors.textSecondary,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      _status(item),
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                        color: _color(item),
                      ),
                    ),
                  ],
                ),
              ),
          ],
          if (blocked && readiness.hasRequirements) ...[
            const SizedBox(height: 6),
            Text(
              'The service centre verifies these again when you join.',
              style: const TextStyle(
                fontSize: 10.5,
                fontStyle: FontStyle.italic,
                color: AppColors.textMuted,
              ),
            ),
            const SizedBox(height: 10),
            SizedBox(
              height: 44,
              child: OutlinedButton.icon(
                onPressed: onUpload,
                icon: const Icon(Icons.upload_file_rounded, size: 16),
                label: const Text('MANAGE DOCUMENTS', style: TextStyle(fontSize: 12)),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.primary,
                  side: const BorderSide(color: AppColors.primary, width: 1.4),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  static IconData _icon(DocumentRequirementItem item) {
    if (item.isVerified) return Icons.check_circle_rounded;
    if (item.isRejected) return Icons.cancel_rounded;
    if (item.isPending) return Icons.hourglass_top_rounded;
    return Icons.radio_button_unchecked_rounded;
  }

  static Color _color(DocumentRequirementItem item) {
    if (item.isVerified) return AppColors.success;
    if (item.isRejected) return AppColors.danger;
    if (item.isPending) return AppColors.warning;
    return AppColors.textMuted;
  }

  static String _status(DocumentRequirementItem item) {
    if (item.isVerified) return 'Verified';
    if (item.isRejected) return 'Rejected';
    if (item.isPending) return 'Pending';
    return 'Not uploaded';
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.message, required this.onViewToken});

  final String message;
  final VoidCallback onViewToken;

  @override
  Widget build(BuildContext context) {
    final duplicate = message.toUpperCase().contains('ALREADY IN QUEUE');
    return Container(
      padding: const EdgeInsets.all(12),
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
              const Icon(
                Icons.error_outline_rounded,
                size: 16,
                color: AppColors.danger,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  message,
                  style: const TextStyle(
                    fontSize: 12,
                    height: 1.4,
                    fontWeight: FontWeight.w600,
                    color: AppColors.danger,
                  ),
                ),
              ),
            ],
          ),
          if (duplicate) ...[
            const SizedBox(height: 10),
            SizedBox(
              height: 42,
              child: ElevatedButton(
                onPressed: onViewToken,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.danger,
                  foregroundColor: Colors.white,
                ),
                child: const Text('VIEW MY TOKEN', style: TextStyle(fontSize: 12)),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ─── Sticky CTA ──────────────────────────────────────────────────────────────

/// The dominant, always-reachable join action.
///
/// Disablement is only ever driven by an authoritative signal: the Document
/// Gate verdict, the backend's own open/active/queue-status checks, connectivity
/// for a mutation, an expired configured joining window, or a refusal the
/// backend already returned. Crowd level is never a reason.
class _StickyJoinBar extends StatelessWidget {
  const _StickyJoinBar({
    required this.preview,
    required this.gate,
    required this.isOffline,
    required this.isJoining,
    required this.blockedReason,
    required this.onJoin,
    this.userLocation,
    this.isCheckingLocation = false,
    this.locationError,
  });

  final JoinPreviewData preview;

  /// The backend's Document Gate verdict. The only client-side signal that can
  /// disable the CTA on document grounds, and the backend re-checks it anyway.
  final DocumentGateState gate;

  final bool isOffline;
  final bool isJoining;
  final String? blockedReason;
  final VoidCallback onJoin;
  final UserLocation? userLocation;
  final bool isCheckingLocation;
  final String? locationError;

  @override
  Widget build(BuildContext context) {
    final serviceJoinable = preview.isServiceJoinable;
    final windowClosed = _windowClosed(preview);

    final (bool enabled, String label, String? reason) = _resolve(
      serviceJoinable: serviceJoinable,
      windowClosed: windowClosed,
    );

    final ewt = preview.estimatedWaitMinutes;

    return Container(
      decoration: BoxDecoration(
        color: context.themeSurface,
        border: Border(top: BorderSide(color: context.themeBorder)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (reason != null) ...[
                Row(
                  children: [
                    const Icon(
                      Icons.info_outline_rounded,
                      size: 13,
                      color: AppColors.warning,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        reason,
                        style: const TextStyle(
                          fontSize: 10.5,
                          height: 1.35,
                          color: AppColors.warning,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
              ],
              Row(
                children: [
                  // Loose, so the metrics column can give up width rather than
                  // squeeze the primary action on a narrow phone.
                  Flexible(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          ewt == null ? 'Wait not reported' : '~$ewt min wait',
                          style: AppTheme.monoStyle(
                            fontSize: 15,
                            color: ewt == null
                                ? AppColors.textMuted
                                : AppColors.secondary,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          preview.peopleAhead == null
                              ? 'People ahead unknown'
                              : '${preview.peopleAhead} ahead',
                          style: const TextStyle(
                            fontSize: 10.5,
                            color: AppColors.textMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 14),
                  // 60dp tall: the primary action, comfortably tappable. Its
                  // width is whatever is left after the metrics column, and the
                  // label scales down inside that width — a refusal reason as
                  // long as `QUEUE JOINING CLOSED` must not push the button off
                  // the screen on a 360dp phone.
                  Expanded(
                    child: SizedBox(
                      height: 60,
                      child: ElevatedButton(
                        onPressed: (enabled && !isJoining) ? onJoin : null,
                        style: ElevatedButton.styleFrom(
                          minimumSize: const Size(0, 60),
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          backgroundColor: AppColors.primary,
                          foregroundColor: Colors.black,
                          disabledBackgroundColor: AppColors.surfaceElevated,
                          disabledForegroundColor: AppColors.textMuted,
                        ),
                        child: isJoining
                            ? const Row(
                                mainAxisSize: MainAxisSize.min,
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2.2,
                                      valueColor: AlwaysStoppedAnimation<Color>(
                                        Colors.white,
                                      ),
                                    ),
                                  ),
                                  SizedBox(width: 10),
                                  Flexible(
                                    child: FittedBox(
                                      fit: BoxFit.scaleDown,
                                      child: Text(
                                        'Joining queue…',
                                        maxLines: 1,
                                        style: TextStyle(
                                          fontSize: 15,
                                          fontWeight: FontWeight.w700,
                                          color: Colors.white,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              )
                            : FittedBox(
                                fit: BoxFit.scaleDown,
                                alignment: Alignment.center,
                                child: Text(
                                  label,
                                  maxLines: 1,
                                  style: const TextStyle(
                                    fontSize: 16,
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: 0.6,
                                  ),
                                ),
                              ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// True only when the center has configured hours for today and they have
  /// passed. A center with no configured hours is never treated as closed.
  static bool _windowClosed(JoinPreviewData preview) {
    final window = preview.resolveWindow(DateTime.now());
    return window is JoiningWindowClosedAfterClose;
  }

  (bool, String, String?) _resolve({
    required bool serviceJoinable,
    required bool windowClosed,
  }) {
    if (blockedReason != null && blockedReason!.isNotEmpty) {
      return (false, 'JOIN QUEUE', blockedReason);
    }
    if (isOffline) {
      return (
        false,
        'UNAVAILABLE OFFLINE',
        'Joining needs a live connection so the service centre can issue a real token.',
      );
    }
    if (!serviceJoinable) {
      final center = preview.center;
      if (!center.isOpen) {
        return (false, 'CENTER CLOSED', 'The service centre is not accepting queue entries.');
      }
      if (!preview.service.isActive) {
        return (false, 'SERVICE UNAVAILABLE', 'This service is not accepting new customers.');
      }
      return (
        false,
        'QUEUE PAUSED',
        'The service centre has paused this queue (${preview.queueStatus}).',
      );
    }
    if (windowClosed) {
      return (
        false,
        'QUEUE JOINING CLOSED',
        "Today's configured centre hours have ended. Pull down to refresh status.",
      );
    }
    if (preview.center.location?.isConfigured == true) {
      if (isCheckingLocation) {
        return (
          false,
          'JOIN QUEUE',
          'Verifying your GPS position…',
        );
      }
      if (locationError != null && locationError!.isNotEmpty) {
        return (
          false,
          'JOIN QUEUE',
          locationError,
        );
      }
      if (userLocation != null) {
        if (!userLocation!.isFresh()) {
          return (
            false,
            'JOIN QUEUE',
            'LOCATION REFRESHING — Waiting for a fresh GPS reading…',
          );
        }
        final dist = calculateHaversineDistanceMeters(
          preview.center.location!.latitude!,
          preview.center.location!.longitude!,
          userLocation!.latitude,
          userLocation!.longitude,
        );
        final radius = preview.center.geofence?.radiusMeters ?? 100;
        if (dist > radius) {
          return (
            false,
            'JOIN QUEUE',
            'OUT OF RANGE — You are ${formatDistance(dist)} from this center. You must be within $radius m to join.',
          );
        }
      } else {
        return (
          false,
          'JOIN QUEUE',
          'LOCATION UNAVAILABLE — Unable to verify your location.',
        );
      }
    }
    if (!gate.canJoin) {
      return (
        false,
        'DOCUMENTS REQUIRED',
        gate.isStale
            ? 'Document readiness is unconfirmed. Reconnect to check the requirements.'
            : gate.readiness.statusDescription,
      );
    }
    return (true, 'JOIN QUEUE', null);
  }
}

// ─── Geofence Card ───────────────────────────────────────────────────────────

class _GeofenceCard extends StatelessWidget {
  const _GeofenceCard({
    required this.center,
    required this.userLocation,
    required this.isCheckingLocation,
    required this.locationError,
    required this.onRetryLocation,
  });

  final ServiceCenter center;
  final UserLocation? userLocation;
  final bool isCheckingLocation;
  final String? locationError;
  final VoidCallback onRetryLocation;

  @override
  Widget build(BuildContext context) {
    final radiusMeters = center.geofence?.radiusMeters ?? 100;

    if (isCheckingLocation) {
      return JoinSection(
        title: 'Service area',
        child: JoinCard(
          child: Row(
            children: [
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  'Verifying your GPS location…',
                  style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                ),
              ),
            ],
          ),
        ),
      );
    }

    if (locationError != null && locationError!.isNotEmpty) {
      return JoinSection(
        title: 'Service area',
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: AppColors.danger.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.danger.withValues(alpha: 0.3)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.location_off_rounded, size: 18, color: AppColors.danger),
                  const SizedBox(width: 8),
                  Text(
                    locationError!,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: AppColors.danger,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              const Text(
                'You must share your GPS location to verify that you are within the 100 m joining area of this service center.',
                style: TextStyle(fontSize: 11.5, height: 1.4, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 12),
              ElevatedButton.icon(
                onPressed: onRetryLocation,
                icon: const Icon(Icons.refresh_rounded, size: 16),
                label: const Text('RETRY LOCATION', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold)),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.surfaceElevated,
                  foregroundColor: AppColors.textPrimary,
                  minimumSize: const Size(0, 36),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
              ),
            ],
          ),
        ),
      );
    }

    if (userLocation == null) {
      return const SizedBox.shrink();
    }

    if (!userLocation!.isFresh()) {
      return JoinSection(
        title: 'Service area',
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: AppColors.warning.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.warning.withValues(alpha: 0.35)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: AppColors.warning.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.access_time_rounded, size: 12, color: AppColors.warning),
                        SizedBox(width: 5),
                        Text(
                          'LOCATION REFRESHING',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.5,
                            color: AppColors.warning,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              const Text(
                'Waiting for a fresh GPS position…',
                style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Your previous location reading is older than 90 seconds. A fresh GPS fix is required to verify the 100 m joining area.',
                style: TextStyle(fontSize: 11.5, height: 1.4, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 12),
              ElevatedButton.icon(
                onPressed: onRetryLocation,
                icon: const Icon(Icons.refresh_rounded, size: 16),
                label: const Text('REFRESH LOCATION', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold)),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.surfaceElevated,
                  foregroundColor: AppColors.textPrimary,
                  minimumSize: const Size(0, 36),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
              ),
            ],
          ),
        ),
      );
    }

    final dist = calculateHaversineDistanceMeters(
      center.location!.latitude!,
      center.location!.longitude!,
      userLocation!.latitude,
      userLocation!.longitude,
    );
    final inRange = dist <= radiusMeters;
    final distFormatted = formatDistance(dist);

    if (inRange) {
      return JoinSection(
        title: 'Service area',
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: AppColors.success.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.success.withValues(alpha: 0.35)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: AppColors.success.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.check_circle_rounded, size: 12, color: AppColors.success),
                        SizedBox(width: 5),
                        Text(
                          'IN RANGE',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.5,
                            color: AppColors.success,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                "You are $distFormatted from this center.",
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'WITHIN SERVICE AREA',
                style: TextStyle(
                  fontSize: 12,
                  color: AppColors.success,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  const Text(
                    'Distance: ',
                    style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                  ),
                  Text(
                    distFormatted,
                    style: AppTheme.monoStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: AppColors.success,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Text(
                    '·  $radiusMeters m allowed radius',
                    style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    } else {
      return JoinSection(
        title: 'Service area',
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: AppColors.danger.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.danger.withValues(alpha: 0.35)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: AppColors.danger.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.cancel_rounded, size: 12, color: AppColors.danger),
                        SizedBox(width: 5),
                        Text(
                          'OUT OF RANGE',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.5,
                            color: AppColors.danger,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                "You are $distFormatted from this center.",
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'You must be within $radiusMeters m to join.',
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.danger,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'You need to be within $radiusMeters m of this service center to join its queue.',
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  const Text(
                    'Current distance: ',
                    style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                  ),
                  Text(
                    distFormatted,
                    style: AppTheme.monoStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: AppColors.danger,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                "You're outside the $radiusMeters m joining area",
                style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
              ),
            ],
          ),
        ),
      );
    }
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/network/api_exception.dart';
import '../core/theme/app_theme.dart';
import '../models/service.dart';
import '../models/service_center.dart';
import '../providers/app_providers.dart';
import '../widgets/join/qr_scanned_overlay.dart';
import 'join_link_service.dart';
import 'qr_payload_parser.dart';

/// Shared resolution + routing for a customer queue-join QR payload.
///
/// The in-app QR scanner (mobile_scanner) runs this before it routes, so a QR
/// that names a centre or service the backend does not recognise fails with a
/// precise, recoverable message instead of opening a preview that cannot load.
///
/// An inbound App Link / Universal Link does **not** come through here. That
/// context sits above the router and has no [Overlay] or router in scope, so it
/// cannot show the recognition overlay or push a route at all; it parks the
/// validated payload instead and the router sends the customer straight to the
/// same destination this controller produces. See [joinRouteFor] in
/// `join_link_service.dart` — one route, one screen, one resolution path.
///
/// ## What this does and does not resolve
///
/// It validates the centerId against the backend before routing. It does
/// **not** hand pre-resolved models to the preview: the destination is always
/// the id-bearing `/join/preview` or `/join/services` route, which re-reads the
/// backend itself. That is also what lets the route survive a login redirect or
/// a process restart.
///
/// This module NEVER creates a token. Token creation remains exclusively in the
/// existing QueuePreviewScreen → POST /api/tokens flow, which requires an
/// explicit user action.
class JoinFlowController {
  const JoinFlowController(this.api);

  final dynamic api;

  /// Resolve [payload] against the backend and route into the queue flow.
  ///
  /// - [showFeedback] renders the loading / error surfaces. It is only ever
  ///   true for the in-app scanner, which has a real screen behind it; a caller
  ///   with no overlay — an inbound link — must pass `false`.
  Future<void> handleJoinPayload(
    BuildContext context,
    QrJoinPayload payload, {
    bool showFeedback = true,
  }) async {
    QrScannedOverlay? scannedOverlay;
    if (showFeedback) {
      scannedOverlay = QrScannedOverlay.show(
        context,
        message: 'Confirming this service center with QueueFlow…',
      );
    }

    try {
      // Fetch center and services in parallel. Both calls validate the centerId
      // against the authoritative backend.
      final results = await Future.wait<Object>([
        api.getServiceCenterDetail(payload.centerId),
        api.getServices(payload.centerId),
      ]);

      final centerDetail = results[0] as Map<String, dynamic>;
      final center = centerDetail['center'] as ServiceCenter;
      final services = results[1] as List<Service>;

      // The backend answered, so the recognition overlay has done its job.
      scannedOverlay?.dismiss();
      if (!context.mounted) return;

      if (payload.hasService) {
        // Center + Service QR → validate the service belongs to this center,
        // then navigate directly into the one queue preview.
        await _routeToServicePreview(
          context,
          payload: payload,
          center: center,
          services: services,
          showFeedback: showFeedback,
        );
      } else {
        // Center-only QR → the service selector, which lists this center's
        // active services with their live queue figures. Exactly the route an
        // inbound centre-only link lands on.
        context.push(joinRouteFor(QrJoinPayload(centerId: payload.centerId)));
      }
    } on ApiException catch (e) {
      scannedOverlay?.dismiss();
      if (!context.mounted) return;
      if (showFeedback) {
        _showErrorSheet(
          context,
          icon: Icons.cloud_off_rounded,
          iconColor: AppColors.danger,
          title: 'Could Not Verify QR',
          message: e.message,
          allowRetry: true,
        );
      }
    } catch (_) {
      scannedOverlay?.dismiss();
      if (!context.mounted) return;
      if (showFeedback) {
        _showErrorSheet(
          context,
          icon: Icons.cloud_off_rounded,
          iconColor: AppColors.danger,
          title: 'Connection Error',
          message: 'Could not reach the server. Please check your connection and try again.',
          allowRetry: true,
        );
      }
    }
  }

  /// Route to the queue preview (center + service resolved).
  Future<void> _routeToServicePreview(
    BuildContext context, {
    required QrJoinPayload payload,
    required ServiceCenter center,
    required List<Service> services,
    required bool showFeedback,
  }) async {
    // Find the service in the list returned by the backend for this center.
    // This validates that the serviceId from the QR actually belongs here.
    final matches = services.where((s) => s.id == payload.serviceId);
    final matched = matches.isEmpty ? null : matches.first;

    // One derivation of the chooser route, shared with every other entry point,
    // so a recovery action cannot drift from the normal destination.
    final servicesRoute =
        joinRouteFor(QrJoinPayload(centerId: payload.centerId));

    if (matched == null) {
      if (showFeedback) {
        _showErrorSheet(
          context,
          icon: Icons.error_outline_rounded,
          iconColor: AppColors.danger,
          title: 'Service Not Found',
          message:
              'The service referenced in this QR code is not available at ${center.name}. '
              'It may have been removed or transferred.',
          allowRetry: false,
          actionLabel: 'View All Services',
          onAction: () => context.push(servicesRoute),
        );
      }
      return;
    }

    if (!matched.isActive) {
      if (showFeedback) {
        _showErrorSheet(
          context,
          icon: Icons.pause_circle_outlined,
          iconColor: AppColors.warning,
          title: 'Service Unavailable',
          message:
              '"${matched.name}" at ${center.name} is currently not accepting new queue entries. '
              'Please check with the service desk.',
          allowRetry: false,
          actionLabel: 'View Other Services',
          onAction: () => context.push(servicesRoute),
        );
      }
      return;
    }

    if (!context.mounted) return;

    // Enter the existing QueuePreviewScreen, which handles join loading,
    // duplicate-token error and confirmation before POSTing the token. The
    // route is the shared one, carrying ids only, so it is the same destination
    // an inbound link reaches and can be restored after a login redirect.
    unawaited(context.push(joinRouteFor(payload)));
  }

  void _showErrorSheet(
    BuildContext context, {
    required IconData icon,
    required Color iconColor,
    required String title,
    required String message,
    required bool allowRetry,
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 48, color: iconColor),
              const SizedBox(height: 16),
              Text(title, style: Theme.of(ctx).textTheme.titleLarge),
              const SizedBox(height: 8),
              Text(message, textAlign: TextAlign.center),
              if (allowRetry || actionLabel != null) ...[
                const SizedBox(height: 24),
                if (allowRetry)
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: () => Navigator.of(ctx).pop(),
                      child: const Text('Scan Again'),
                    ),
                  ),
                if (actionLabel != null)
                  SizedBox(
                    width: double.infinity,
                    child: TextButton(
                      onPressed: () {
                        Navigator.of(ctx).pop();
                        onAction?.call();
                      },
                      child: Text(actionLabel),
                    ),
                  ),              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Convenience accessor so callers do not need the raw provider type.
JoinFlowController joinFlowController(WidgetRef ref) =>
    JoinFlowController(ref.read(apiServiceProvider));

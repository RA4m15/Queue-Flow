import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/network/api_exception.dart';
import '../core/theme/app_theme.dart';
import '../models/service.dart';
import '../models/service_center.dart';
import '../providers/app_providers.dart';
import 'qr_payload_parser.dart';

/// Shared resolution + routing for a customer queue-join QR payload.
///
/// Both entry points use this one implementation:
///
///   1. The in-app QR scanner (mobile_scanner).
///   2. An inbound App Link / Universal Link / custom-scheme deep link.
///
/// Keeping this in one place is what guarantees there is a single queue join
/// flow rather than two parallel ones. The link handler only decides *whether*
/// an inbound link is a join link; everything after that is identical to
/// scanning the same QR inside the app.
///
/// This module NEVER creates a token. Token creation remains exclusively in the
/// existing QueuePreviewScreen → POST /api/tokens flow, which requires an
/// explicit user action.
class JoinFlowController {
  const JoinFlowController(this.api);

  final dynamic api;

  /// Resolve [payload] against the backend and route into the queue flow.
  ///
  /// - [showFeedback] renders the loading / error surfaces. Pass `false` for
  ///   headless inbound-link handling so the user is not interrupted by a sheet.
  Future<void> handleJoinPayload(
    BuildContext context,
    QrJoinPayload payload, {
    bool showFeedback = true,
  }) async {
    if (showFeedback) _showLoadingSheet(context);

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

      if (showFeedback && context.mounted) {
        Navigator.of(context).pop(); // Dismiss loading sheet.
      }
      if (!context.mounted) return;

      if (payload.hasService) {
        // Center + Service QR → validate the service belongs to this center,
        // then navigate directly into the existing QueuePreviewScreen.
        await _routeToServicePreview(
          context,
          center: center,
          services: services,
          targetServiceId: payload.serviceId!,
          showFeedback: showFeedback,
        );
      } else {
        // Center-only QR → existing ServiceCenterDetailScreen, so the customer
        // can choose their service.
        context.push('/center/${center.id}');
      }
    } on ApiException catch (e) {
      if (showFeedback && context.mounted) Navigator.of(context).pop();
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
      if (showFeedback && context.mounted) Navigator.of(context).pop();
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

  /// Route to the existing queue preview (center + service fully resolved).
  Future<void> _routeToServicePreview(
    BuildContext context, {
    required ServiceCenter center,
    required List<Service> services,
    required String targetServiceId,
    required bool showFeedback,
  }) async {
    // Find the service in the list returned by the backend for this center.
    // This validates that the serviceId from the QR actually belongs here.
    final matches = services.where((s) => s.id == targetServiceId);
    final matched = matches.isEmpty ? null : matches.first;

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
          onAction: () {
            Navigator.of(context).pop();
            context.push('/center/${center.id}');
          },
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
          onAction: () {
            Navigator.of(context).pop();
            context.push('/center/${center.id}');
          },
        );
      }
      return;
    }

    if (!context.mounted) return;

    // Enter the existing QueuePreviewScreen, which handles join loading,
    // duplicate-token error and confirmation before POSTing the token.
    context.push('/queue/preview', extra: {
      'center': center,
      'service': matched,
    });
  }

  void _showLoadingSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isDismissible: false,
      enableDrag: false,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(color: AppColors.primary),
            const SizedBox(height: 20),
            Text(
              'Verifying QR Code…',
              style: Theme.of(ctx).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Confirming service center details from server',
              textAlign: TextAlign.center,
              style: Theme.of(ctx).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
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
                  ),
              ],
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

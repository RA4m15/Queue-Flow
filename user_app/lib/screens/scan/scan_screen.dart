import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/service_center.dart';
import '../../models/service.dart';
import '../../providers/app_providers.dart';
import '../../utils/qr_payload_parser.dart';

/// ScanScreen — Customer QR scanner.
///
/// Handles two QR types:
///
///   1. QueueFlow join QR (queueflow://join?centerId=...&serviceId=...)
///      → resolves center + service from backend and routes into the existing
///        queue-preview / service-selection flow.
///
///   2. Everything else (unrecognized, malformed, staff check-in QRs)
///      → shown with a safe, descriptive error; no navigation into queue flow.
///
/// No token numbers are generated here. Token generation is exclusively done
/// by the existing QueuePreviewScreen → POST /api/tokens flow.
class ScanScreen extends ConsumerStatefulWidget {
  const ScanScreen({super.key});

  @override
  ConsumerState<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends ConsumerState<ScanScreen> {
  final MobileScannerController _controller = MobileScannerController();
  bool _hasScanned = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  // ─── Input sanitization ───────────────────────────────────────────────────

  String _sanitizeInput(String raw) {
    // Truncate to 512 chars to prevent memory/rendering abuse.
    final truncated = raw.length > 512 ? raw.substring(0, 512) : raw;
    // Strip control characters except normal whitespace.
    return truncated.replaceAll(RegExp(r'[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'), '');
  }

  // ─── Scan handler ─────────────────────────────────────────────────────────

  void _handleBarcode(BarcodeCapture capture) {
    if (_hasScanned || !mounted) return;

    final barcodes = capture.barcodes;
    if (barcodes.isEmpty) return;

    final rawValue = barcodes.first.rawValue;
    if (rawValue == null || rawValue.trim().isEmpty) return;

    final sanitized = _sanitizeInput(rawValue.trim());
    if (sanitized.isEmpty) return;

    setState(() => _hasScanned = true);
    _controller.stop();

    // Parse the QR payload (pure, no I/O).
    final parsed = parseQrPayload(sanitized);

    switch (parsed) {
      case QrJoinPayload():
        _handleJoinQr(parsed);
      case QrInvalid():
        _showErrorSheet(
          icon: Icons.qr_code_rounded,
          iconColor: AppColors.warning,
          title: 'Invalid QR Code',
          message: parsed.reason,
          allowRetry: true,
        );
      case QrUnrecognized():
        _showUnrecognizedSheet(sanitized);
    }
  }

  // ─── Join QR handler ──────────────────────────────────────────────────────

  Future<void> _handleJoinQr(QrJoinPayload payload) async {
    // Show a loading indicator while we verify IDs against the backend.
    _showLoadingSheet();

    try {
      final api = ref.read(apiServiceProvider);

      // Fetch center and services in parallel.
      // GET /api/service-centers/:id  → center metadata
      // GET /api/services?centerId=   → services for this center
      // Both calls validate the centerId against the authoritative backend.
      final results = await Future.wait([
        api.getServiceCenterDetail(payload.centerId),
        api.getServices(payload.centerId),
      ]);

      final centerDetail = results[0] as Map<String, dynamic>;
      final center = centerDetail['center'] as ServiceCenter;
      final services = results[1] as List<Service>;

      if (!mounted) return;

      // Pop the loading sheet.
      Navigator.of(context).pop();

      if (payload.hasService) {
        // Center + Service QR → validate service belongs to this center, then
        // navigate directly into the existing QueuePreviewScreen.
        await _routeToServicePreview(
          center: center,
          services: services,
          targetServiceId: payload.serviceId!,
        );
      } else {
        // Center-only QR → navigate to existing ServiceCenterDetailScreen
        // so the customer can choose their service.
        _routeToCenterDetail(center.id);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      Navigator.of(context).pop(); // Dismiss loading sheet.
      _showErrorSheet(
        icon: Icons.cloud_off_rounded,
        iconColor: AppColors.danger,
        title: 'Could Not Verify QR',
        message: e.message,
        allowRetry: true,
      );
    } catch (_) {
      if (!mounted) return;
      Navigator.of(context).pop(); // Dismiss loading sheet.
      _showErrorSheet(
        icon: Icons.cloud_off_rounded,
        iconColor: AppColors.danger,
        title: 'Connection Error',
        message: 'Could not reach the server. Please check your connection and try again.',
        allowRetry: true,
      );
    }
  }

  /// Route to the existing queue preview (center + service fully resolved).
  Future<void> _routeToServicePreview({
    required ServiceCenter center,
    required List<Service> services,
    required String targetServiceId,
  }) async {
    // Find the service in the list returned by the backend for this center.
    // This validates that the serviceId from the QR actually belongs to this center.
    final matched = services.where((s) => s.id == targetServiceId).firstOrNull;

    if (matched == null) {
      _showErrorSheet(
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
          _routeToCenterDetail(center.id);
        },
      );
      return;
    }

    if (!matched.isActive) {
      _showErrorSheet(
        icon: Icons.pause_circle_outline_rounded,
        iconColor: AppColors.warning,
        title: 'Service Unavailable',
        message:
            '"${matched.name}" at ${center.name} is currently not accepting new queue entries. '
            'Please check with the service desk.',
        allowRetry: false,
        actionLabel: 'View Other Services',
        onAction: () {
          Navigator.of(context).pop();
          _routeToCenterDetail(center.id);
        },
      );
      return;
    }

    if (!mounted) return;

    // Navigate into the existing QueuePreviewScreen.
    // QueuePreviewScreen handles: join loading, duplicate-token error, confirmation.
    context.push('/queue/preview', extra: {
      'center': center,
      'service': matched,
    });
  }

  /// Navigate to the existing ServiceCenterDetailScreen for service selection.
  void _routeToCenterDetail(String centerId) {
    if (!mounted) return;
    context.push('/center/$centerId');
  }

  // ─── Sheets ───────────────────────────────────────────────────────────────

  void _showLoadingSheet() {
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
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Confirming service center details from server',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    ).whenComplete(_onSheetDismissed);
  }

  void _showErrorSheet({
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
      isDismissible: true,
      enableDrag: true,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: iconColor.withValues(alpha: 0.1),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(icon, color: iconColor, size: 24),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.surfaceElevated,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.border),
              ),
              child: Text(
                message,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
            const SizedBox(height: 20),
            if (onAction != null && actionLabel != null)
              ElevatedButton(
                onPressed: onAction,
                child: Text(actionLabel),
              ),
            if (allowRetry) ...[
              if (onAction != null) const SizedBox(height: 10),
              OutlinedButton(
                onPressed: () {
                  Navigator.of(ctx).pop();
                },
                child: const Text('Scan Again'),
              ),
            ] else if (onAction == null)
              ElevatedButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: const Text('Dismiss'),
              ),
          ],
        ),
      ),
    ).whenComplete(_onSheetDismissed);
  }

  void _showUnrecognizedSheet(String scannedContent) {
    showModalBottomSheet<void>(
      context: context,
      isDismissible: true,
      enableDrag: true,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.1),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.qr_code_scanner_rounded, color: AppColors.primary, size: 24),
                ),
                const SizedBox(width: 12),
                Text(
                  'QR Code Scanned',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ],
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.warning.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.warning.withValues(alpha: 0.3)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.info_outline_rounded, color: AppColors.warning, size: 20),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'This QR code is not a QueueFlow queue-entry code. '
                      'To join a queue, scan the QR code displayed at the service center or counter.',
                      style: TextStyle(color: AppColors.warning, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Scan Again'),
            ),
          ],
        ),
      ),
    ).whenComplete(_onSheetDismissed);
  }

  void _onSheetDismissed() {
    if (mounted) {
      setState(() => _hasScanned = false);
      _controller.start();
    }
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, color: Colors.white, size: 20),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: const Text('Scan QR Code', style: TextStyle(color: Colors.white)),
        actions: [
          IconButton(
            icon: const Icon(Icons.flash_on_rounded, color: Colors.white),
            onPressed: () => _controller.toggleTorch(),
          ),
          IconButton(
            icon: const Icon(Icons.cameraswitch_rounded, color: Colors.white),
            onPressed: () => _controller.switchCamera(),
          ),
        ],
      ),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _handleBarcode,
            errorBuilder: (context, error) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24.0),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.no_photography_rounded, size: 48, color: AppColors.danger),
                      const SizedBox(height: 16),
                      Text(
                        'Camera Unavailable',
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.white),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        error.errorCode == MobileScannerErrorCode.permissionDenied
                            ? 'Camera permission was denied. Please enable camera access in settings.'
                            : 'Unable to initialize camera: ${error.errorDetails?.message ?? "Unknown error"}',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
          // Viewfinder overlay
          Center(
            child: Container(
              width: 250,
              height: 250,
              decoration: BoxDecoration(
                border: Border.all(color: AppColors.primary, width: 2),
                borderRadius: BorderRadius.circular(20),
              ),
            ),
          ),
          Positioned(
            bottom: 40,
            left: 0,
            right: 0,
            child: Text(
              'Scan a QueueFlow QR code to join a queue',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.85),
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

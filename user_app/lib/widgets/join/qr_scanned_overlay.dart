import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

/// The moment the phone recognises a QueueFlow join QR.
///
/// Shown over whatever the customer was doing — camera viewfinder, browser
/// hand-off, home screen — and then handed straight to the queue preview, so a
/// scan never looks like it dead-ended.
///
/// It is deliberately a celebration of *recognition only*. No counter, no wait
/// estimate and no service name appear here: none of those exist yet, and every
/// number on the next screen must come from the backend. Showing a teaser
/// number and then replacing it would be exactly the kind of fabricated value
/// this flow must not produce.
///
/// Implemented as an [OverlayEntry] rather than a dialog route so it can never
/// be left behind in the navigator stack when the preview is pushed.
class QrScannedOverlay {
  QrScannedOverlay._(this._entry);

  final OverlayEntry _entry;
  bool _removed = false;

  /// How long the overlay stays up before it removes itself. Long enough to
  /// register as success, short enough not to hold up the queue.
  static const Duration displayDuration = Duration(milliseconds: 1050);

  /// Shows the overlay and removes it after [displayDuration].
  ///
  /// [dismiss] can be called earlier — the join flow does exactly that once the
  /// preview route is on screen.
  static QrScannedOverlay show(
    BuildContext context, {
    String? message,
    Duration displayDuration = QrScannedOverlay.displayDuration,
  }) {
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    final entry = OverlayEntry(
      builder: (ctx) => _QrScannedOverlayBody(message: message),
    );
    overlay?.insert(entry);

    final handle = QrScannedOverlay._(entry);
    if (overlay != null) {
      Timer(displayDuration, handle.dismiss);
    }
    return handle;
  }

  /// Removes the overlay. Safe to call more than once.
  void dismiss() {
    if (_removed) return;
    _removed = true;
    _entry.remove();
  }
}

class _QrScannedOverlayBody extends StatefulWidget {
  const _QrScannedOverlayBody({this.message});

  final String? message;

  @override
  State<_QrScannedOverlayBody> createState() => _QrScannedOverlayBodyState();
}

class _QrScannedOverlayBodyState extends State<_QrScannedOverlayBody>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..forward();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.background,
      child: Center(
        child: Semantics(
          liveRegion: true,
          label: 'QR code scanned. Finding queue information.',
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _ScanPulse(controller: _controller),
              const SizedBox(height: 26),
              const Text(
                'QR SCANNED',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 3,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.check_circle_rounded,
                    color: AppColors.primary,
                    size: 20,
                  ),
                  SizedBox(width: 6),
                  Text(
                    'RECOGNISED',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.6,
                      color: AppColors.primary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 26),
              const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2.2,
                  color: AppColors.secondary,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                widget.message ?? 'Finding queue information…',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 13,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// An expanding ring with a tick, so success is legible without relying on the
/// green colour alone.
class _ScanPulse extends StatelessWidget {
  const _ScanPulse({required this.controller});

  final AnimationController controller;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 132,
      height: 132,
      child: Stack(
        alignment: Alignment.center,
        children: [
          for (final offset in const [0.0, 0.34, 0.68])
            AnimatedBuilder(
              animation: controller,
              builder: (_, _) {
                final t = (controller.value - offset) % 1.0;
                if (t <= 0 || t >= 1) return const SizedBox.shrink();
                return Container(
                  width: 120 + t * 12,
                  height: 120 + t * 12,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: AppColors.primary.withValues(alpha: (1 - t) * 0.5),
                      width: 2,
                    ),
                  ),
                );
              },
            ),
          Container(
            width: 104,
            height: 104,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: AppColors.primary.withValues(alpha: 0.12),
              border: Border.all(color: AppColors.primary, width: 2),
            ),
            child: const Icon(
              Icons.qr_code_scanner_rounded,
              size: 42,
              color: AppColors.primary,
            ),
          ),
        ],
      ),
    );
  }
}

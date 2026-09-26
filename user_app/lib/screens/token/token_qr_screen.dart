import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/token.dart';
import '../../providers/app_providers.dart';
import '../../widgets/loading_state.dart';
import '../../widgets/error_state.dart';

class TokenQrScreen extends ConsumerStatefulWidget {
  const TokenQrScreen({
    super.key,
    required this.token,
  });

  final TokenModel token;

  @override
  ConsumerState<TokenQrScreen> createState() => _TokenQrScreenState();
}

class _TokenQrScreenState extends ConsumerState<TokenQrScreen> {
  String? _qrData;
  String? _error;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    if (widget.token.qrData != null && widget.token.qrData!.isNotEmpty) {
      _qrData = widget.token.qrData;
    } else {
      _fetchQR();
    }
  }

  Future<void> _fetchQR() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final api = ref.read(apiServiceProvider);
      final qr = await api.getTokenQR(widget.token.id);
      if (!mounted) return;
      setState(() {
        _qrData = qr;
        _isLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      // Do NOT invent a fake fallback barcode. Server-generated QR data is strictly required.
      setState(() {
        _qrData = null;
        _error = ApiException.getUserMessage(e);
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final token = widget.token;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => context.pop(),
        ),
        title: const Text('Token QR Code'),
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: AppColors.border),
                ),
                child: Column(
                  children: [
                    Text(
                      token.centerName ?? 'Service Center',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: AppColors.textSecondary,
                          ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      token.serviceName ?? 'Service Queue',
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      token.tokenCode,
                      style: AppTheme.monoStyle(
                        fontSize: 32,
                        color: AppColors.primary,
                      ),
                    ),
                    const SizedBox(height: 24),

                    if (_isLoading)
                      const SizedBox(
                        width: 200,
                        height: 200,
                        child: Center(
                          child: LoadingState(message: 'Loading official QR...'),
                        ),
                      )
                    else if (_error != null)
                      SizedBox(
                        width: 250,
                        height: 200,
                        child: ErrorState(
                          message: _error!,
                          onRetry: _fetchQR,
                        ),
                      )
                    else if (_qrData != null && _qrData!.isNotEmpty)
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: QrImageView(
                          data: _qrData!,
                          version: QrVersions.auto,
                          size: 200,
                          backgroundColor: Colors.white,
                          errorCorrectionLevel: QrErrorCorrectLevel.M,
                        ),
                      )
                    else
                      const SizedBox(
                        width: 200,
                        height: 200,
                        child: Center(
                          child: Text('QR data unavailable'),
                        ),
                      ),

                    const SizedBox(height: 24),
                    Text(
                      'Present this official QR code at the counter or kiosk to check in',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: AppColors.textMuted,
                          ),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 32),
              SizedBox(
                width: 200,
                child: OutlinedButton(
                  onPressed: () => context.pop(),
                  child: const Text('Back to Token'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/gemini_support_service.dart';

final geminiSupportServiceProvider = Provider<GeminiSupportService>((ref) {
  return GeminiSupportService();
});

final geminiHasApiKeyProvider = FutureProvider<bool>((ref) async {
  final service = ref.watch(geminiSupportServiceProvider);
  return await service.hasApiKey();
});

import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/storage_service.dart';
import 'app_providers.dart';

class AlertsPreferenceNotifier extends StateNotifier<bool> {
  AlertsPreferenceNotifier(this._storageService) : super(true) {
    _loadPreference();
  }

  final StorageService _storageService;
  static const String _storageKey = 'app_alerts_enabled';

  Future<void> _loadPreference() async {
    try {
      final saved = await _storageService.getBool(_storageKey, defaultValue: true);
      state = saved;
    } catch (_) {
      state = true;
    }
  }

  Future<void> setAlertsEnabled(bool enabled) async {
    state = enabled;
    try {
      await _storageService.setBool(_storageKey, enabled);
    } catch (_) {}
  }
}

final alertsPreferenceProvider =
    StateNotifierProvider<AlertsPreferenceNotifier, bool>((ref) {
  final storage = ref.watch(storageServiceProvider);
  return AlertsPreferenceNotifier(storage);
});

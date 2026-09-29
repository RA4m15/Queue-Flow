import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/user.dart';
import '../services/storage_service.dart';
import 'app_providers.dart';
import 'auth_provider.dart';

class AlertsPreferenceNotifier extends StateNotifier<bool> {
  AlertsPreferenceNotifier(this._storageService, [this._authNotifier]) : super(true);

  final StorageService _storageService;
  final AuthNotifier? _authNotifier;
  String? _currentUserId;

  static String scopedKey(String userId) => 'notification_pref_$userId';

  String? get currentUserId => _currentUserId;

  /// Reconcile with the authenticated user.
  /// Backend server preferences are authoritative.
  Future<void> onUserAuthenticated(AppUser user) async {
    _currentUserId = user.id;

    final dynamic serverValue = user.preferences?['notifyApp'];
    if (serverValue is bool) {
      state = serverValue;
      try {
        await _storageService.setBool(scopedKey(user.id), serverValue);
      } catch (_) {}
      return;
    }

    // Fall back to account-scoped local preference
    try {
      final local = await _storageService.getBool(scopedKey(user.id), defaultValue: true);
      state = local;
    } catch (_) {
      state = true;
    }
  }

  /// Reset state on logout so User A's settings never leak to User B.
  Future<void> onUserLoggedOut() async {
    _currentUserId = null;
    state = true;
  }

  Future<void> setAlertsEnabled(bool enabled) async {
    state = enabled;
    final userId = _currentUserId;
    if (userId != null && userId.isNotEmpty) {
      try {
        await _storageService.setBool(scopedKey(userId), enabled);
      } catch (_) {}
      try {
        await _authNotifier?.updateProfile(preferences: {'notifyApp': enabled});
      } catch (_) {}
    }
  }
}

final alertsPreferenceProvider =
    StateNotifierProvider<AlertsPreferenceNotifier, bool>((ref) {
  final storage = ref.watch(storageServiceProvider);
  final authNotifier = ref.watch(authProvider.notifier);
  final notifier = AlertsPreferenceNotifier(storage, authNotifier);

  ref.listen<AuthState>(authProvider, (previous, next) {
    if (next.isAuthenticated && next.user != null) {
      notifier.onUserAuthenticated(next.user!);
    } else if (previous?.isAuthenticated == true && !next.isAuthenticated) {
      notifier.onUserLoggedOut();
    }
  }, fireImmediately: true);

  return notifier;
});

import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/models/user.dart';
import 'package:user_app/providers/alerts_preference_provider.dart';
import 'harness.dart';

void main() {
  group('AlertsPreferenceNotifier Account Scoping & Reconciliation', () {
    late FakeStorageService fakeStorage;
    late AlertsPreferenceNotifier notifier;

    setUp(() {
      fakeStorage = FakeStorageService();
      notifier = AlertsPreferenceNotifier(fakeStorage);
    });

    test('Initial state defaults to true before authentication', () {
      expect(notifier.state, isTrue);
      expect(notifier.currentUserId, isNull);
    });

    test('User A login reconciles authoritative server preference', () async {
      final userA = AppUser(
        id: 'user_a_123',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'user',
        preferences: {
          'notifyApp': false,
          'notifySms': true,
          'notifyAheadCount': 5,
        },
      );

      await notifier.onUserAuthenticated(userA);

      expect(notifier.state, isFalse);
      expect(notifier.currentUserId, equals('user_a_123'));
      // Verifies account-scoped local cache key was written
      expect(
        await fakeStorage.getBool(AlertsPreferenceNotifier.scopedKey('user_a_123')),
        isFalse,
      );
    });

    test('Updating preference persists to scoped key only', () async {
      final userA = AppUser(
        id: 'user_a_123',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'user',
      );

      await notifier.onUserAuthenticated(userA);
      await notifier.setAlertsEnabled(false);

      expect(notifier.state, isFalse);
      expect(
        await fakeStorage.getBool('notification_pref_user_a_123'),
        isFalse,
      );
      // Ensure global unscoped key was never written
      expect(await fakeStorage.getString('alerts_enabled'), isNull);
    });

    test('Logout clears current user scope and resets state', () async {
      final userA = AppUser(
        id: 'user_a_123',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'user',
        preferences: {'notifyApp': false},
      );

      await notifier.onUserAuthenticated(userA);
      expect(notifier.state, isFalse);

      await notifier.onUserLoggedOut();
      expect(notifier.currentUserId, isNull);
      expect(notifier.state, isTrue);
    });

    test('User B login isolates preferences and never inherits User A state', () async {
      final userA = AppUser(
        id: 'user_a_123',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'user',
        preferences: {'notifyApp': false},
      );
      final userB = AppUser(
        id: 'user_b_456',
        name: 'Bob',
        email: 'bob@example.com',
        role: 'user',
        preferences: {'notifyApp': true},
      );

      // User A logs in and has notifyApp = false
      await notifier.onUserAuthenticated(userA);
      expect(notifier.state, isFalse);

      // User A logs out
      await notifier.onUserLoggedOut();
      expect(notifier.state, isTrue);

      // User B logs in and has notifyApp = true
      await notifier.onUserAuthenticated(userB);
      expect(notifier.state, isTrue);
      expect(notifier.currentUserId, equals('user_b_456'));

      // Both scoped cache entries are distinct and intact
      expect(
        await fakeStorage.getBool(AlertsPreferenceNotifier.scopedKey('user_a_123')),
        isFalse,
      );
      expect(
        await fakeStorage.getBool(AlertsPreferenceNotifier.scopedKey('user_b_456')),
        isTrue,
      );
    });
  });
}

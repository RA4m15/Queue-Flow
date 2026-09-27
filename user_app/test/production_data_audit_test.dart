import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Static audit of `lib/` for the production rules that cannot be expressed as
/// runtime behaviour tests:
///
///  * the backend is the single source of truth for all business data;
///  * no duplicate queue / notification / socket / storage subsystem;
///  * no provider credentials or secrets baked into client source.
///
/// These are intentionally source-level assertions — the failure mode they
/// catch (a hardcoded center name, a second API base URL, an FCM server key)
/// can never be observed from a widget test.
void main() {
  final libFiles = _dartFilesIn('lib');

  group('Production data audit', () {
    test('lib/ is not empty and the audit actually reads source', () {
      expect(libFiles.length, greaterThan(30));
      expect(libFiles.any((f) => f.endsWith('api_service.dart')), isTrue);
      expect(libFiles.any((f) => f.endsWith('api_constants.dart')), isTrue);
    });

    test('no mock, fake, dummy or demo business data is shipped', () {
      // Only comments may mention these words; any executable occurrence would
      // mean fabricated centers / tokens / queues in the production binary.
      final offenders = <String>[];
      final pattern = RegExp(
        r'\b(mock|dummy|faked|fakeData|sampleData|demoData|placeholderData)\w*\b',
        caseSensitive: false,
      );
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, pattern)) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('no service center, service or counter names are hardcoded', () {
      final offenders = <String>[];
      final nameLiterals = RegExp(
        r'''\b['"]?(name|serviceName|centerName|centerCode|serviceCode|counterName)['"]?\s*:\s*(const\s+)?[r]?['"][A-Za-z0-9][^'"]*['"]''',
      );
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, nameLiterals)) {
          // `name: json['name']` names a payload field, it is not a value.
          if (hit.text.contains('json[')) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('no Mongo ObjectId literals are baked into lib/', () {
      // Hardcoded ids would pin the app to one backend record.
      final offenders = <String>[];
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, RegExp(r'''['"]?[0-9a-f]{24}['"]?''', caseSensitive: false))) {
          // A bare run of 24 hex digits, quoted or not, is an ObjectId literal.
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('no token codes, queue positions or EWT values are hardcoded', () {
      final offenders = <String>[];
      // `status: 'WAITING'` style defaults are fine; numeric business values
      // (position 5, 22 minutes of EWT) are not.
      final pattern = RegExp(
        r'''['"]?(currentPosition|initialPosition|position|queuePosition|waitEstimateMinutes|estimatedWait|ewtMinutes|etaMinutes|tokenNumber|counterNumber)['"]?\s*:\s*(-?\d+|const\s+-?\d+)\b''',
      );
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, pattern)) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('no document requirement types are hardcoded', () {
      final offenders = <String>[];
      final pattern = RegExp(
        r'''['"](AADHAAR|AADHAAR_CARD|PAN|PAN_CARD|PASSPORT|DRIVING_LICENCE|DRIVING_LICENSE|VOTER_ID|RATION_CARD|UTILITY_BILL)['"]''',
        caseSensitive: false,
      );
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, pattern)) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('no service graph transition vocabulary is hardcoded', () {
      final offenders = <String>[];
      final pattern = RegExp(
        r'''['"](NEXT|SEQUENTIAL|PARALLEL|CONDITIONAL|PREREQUISITE|TERMINAL|LOOP|CROSS_CENTER)['"]''',
      );
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, pattern)) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('no client code claims a notification was delivered', () {
      final offenders = <String>[];
      final pattern = RegExp(
        r'(isDelivered|deliveryStatus|pushedSuccessfully|deliverySucceeded)\s*:\s*true\b',
        caseSensitive: false,
      );
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, pattern)) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });
  });

  group('No second backend', () {
    test('exactly one API base URL and one socket URL are configured', () {
      final constants = File('lib/core/constants/api_constants.dart').readAsStringSync();
      final urls = RegExp(r'''https?://[^\s'"]+''')
          .allMatches(constants)
          .map((m) => m.group(0)!)
          .toSet();
      expect(urls.length, lessThanOrEqualTo(2),
          reason: 'Unexpected extra hosts in api_constants.dart: $urls');
      expect(urls.any((u) => u.endsWith('/api')), isTrue,
          reason: 'apiConstants.baseUrl must point at the backend /api root');
    });

    test('no client file hardcodes a host other than the configured one', () {
      final offenders = <String>[];
      for (final file in libFiles) {
        if (file.endsWith('api_constants.dart')) continue;
        for (final hit in _matchesIn(file, RegExp(r'''https?://[^\s'"]+'''))) {
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('only ApiService may talk HTTP', () {
      // Every backend call in this app goes through ApiService. A screen or
      // provider issuing its own request would be a parallel API surface.
      final offenders = <String>[];
      final pattern = RegExp(r'(\b_dio|\bdio)\.(get|post|put|patch|delete)\b');
      for (final file in libFiles) {
        if (file.endsWith('api_service.dart') || file.endsWith('dio_client.dart')) continue;
        for (final hit in _matchesIn(file, pattern)) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));

      // And ApiService itself must route every verb through the shared client.
      final api = File('lib/services/api_service.dart').readAsStringSync();
      final bareVerbs = RegExp(r'(?<!_)\bdio\.(get|post|put|patch|delete)\b').allMatches(api);
      expect(bareVerbs, isEmpty, reason: 'ApiService must use the injected Dio client');
    });

    test('there is a single socket subsystem and a single storage subsystem', () {
      expect(libFiles.where((f) => f.endsWith('socket_service.dart')), hasLength(1));
      expect(libFiles.where((f) => f.endsWith('storage_service.dart')), hasLength(1));

      // Shared preferences access must be centralised in StorageService.
      final offenders = <String>[];
      for (final file in libFiles) {
        if (file.endsWith('storage_service.dart')) continue;
        for (final hit in _matchesIn(file, RegExp(r'shared_preferences|SharedPreferences\.'))) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('queue logic is not reimplemented in the client', () {
      // A locally computed position or EWT is forbidden: the backend owns it.
      final offenders = <String>[];
      final pattern = RegExp(
        r'(estimatedWait|waitEstimate|position)\s*[:=]\s*.*(Rate|avg|average|perCounter|Math\.(round|ceil|max))',
        caseSensitive: false,
      );
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, pattern)) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });
  });

  group('No secrets in client source', () {
    test('no Firebase service-account material is present', () {
      final offenders = <String>[];
      final privateKey = RegExp(r'-----BEGIN [A-Z ]*PRIVATE KEY-----');
      final serviceAccountMarkers = RegExp(
        r'(private_key_id|client_email|service_account|Bearer\s+[A-Za-z0-9._-]{30,})',
        caseSensitive: false,
      );
      for (final file in libFiles) {
        for (final pattern in [privateKey, serviceAccountMarkers]) {
          for (final hit in _matchesIn(file, pattern)) {
            if (hit.isComment) continue;
            offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
          }
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('the Firebase SDK is present but carries no server credential', () {
      final pubspec = File('pubspec.yaml').readAsStringSync();
      // The device push transport is compiled in so a Firebase project can be
      // attached without a code change. What must never appear in the client
      // is the *server* half of the credential.
      expect(pubspec.contains('firebase_core'), isTrue);
      expect(pubspec.contains('firebase_messaging'), isTrue);

      // A client config file is not a secret: it is the public Firebase app
      // identity and is normally committed or provided in the environment.
      // If present, verify it contains no server private keys.
      final androidConfig = File('android/app/google-services.json');
      if (androidConfig.existsSync()) {
        final content = androidConfig.readAsStringSync();
        expect(content.contains('BEGIN PRIVATE KEY'), isFalse);
        expect(content.contains('private_key'), isFalse);
      }
      final iosConfig = File('ios/Runner/GoogleService-Info.plist');
      if (iosConfig.existsSync()) {
        final content = iosConfig.readAsStringSync();
        expect(content.contains('BEGIN PRIVATE KEY'), isFalse);
      }

      // No server-side credential may ever be read or embedded client side.
      for (final path in libFiles) {
        final text = File(path).readAsStringSync();
        expect(text.contains('FIREBASE_SERVICE_ACCOUNT_JSON'), isFalse,
            reason: '$path must never reference a server service account');
        expect(text.contains('GOOGLE_APPLICATION_CREDENTIALS'), isFalse,
            reason: '$path must never reference a server credential path');
      }
    });

    test('push delivery is truthfully reported as unconfigured without a project', () {
      final client = File('lib/services/push_messaging_client.dart').readAsStringSync();
      // The fallback client is the honest one: it declares itself unavailable
      // and states why, instead of pretending to deliver.
      expect(client.contains('UnavailablePushMessagingClient'), isTrue);
      expect(client.contains('isAvailable => false'), isTrue);
      expect(client.contains('not configured'), isTrue);
      expect(client.contains('PushPermissionStatus.unavailable'), isTrue);
      expect(client.contains('Future<String?> deviceToken() async => null'), isTrue);

      // The real transport must take its token from the platform SDK and never
      // fabricate one.
      final firebase = File('lib/services/firebase_push_messaging_client.dart').readAsStringSync();
      expect(firebase.contains('_messaging.getToken()'), isTrue,
          reason: 'Tokens must come from the platform SDK');
      expect(firebase.contains('String generateToken'), isFalse,
          reason: 'A device token must never be fabricated client side');

      // The resolver must have exactly two honest outcomes: a configured
      // transport, or an explicit unavailable client.
      final transport = File('lib/services/push_transport.dart').readAsStringSync();
      expect(transport.contains('UnavailablePushMessagingClient('), isTrue);
      expect(transport.contains('PushUnavailableReason.notConfigured'), isTrue);
    });
  });

  group('Offline truthfulness', () {
    test('the offline refusal message is defined once in NetworkStatus', () {
      final status = File('lib/core/network/network_status.dart').readAsStringSync();
      expect(status.contains('This action requires an internet connection.'), isTrue);
    });

    test('no screen or provider simulates a successful offline mutation', () {
      final offenders = <String>[];
      final pattern =
          RegExp(r'(simulate|mockSuccess|fakeSuccess|pretendSuccess)\w*\s*\(', caseSensitive: false);
      for (final file in libFiles) {
        for (final hit in _matchesIn(file, pattern)) {
          if (hit.isComment) continue;
          offenders.add('${_rel(file)}:${hit.line}: ${hit.text.trim()}');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });
  });
}

class _Hit {
  _Hit(this.line, this.text, {required this.isComment});

  final int line;
  final String text;
  final bool isComment;
}

String _rel(String path) => path.replaceAll('\\', '/');

List<String> _dartFilesIn(String dir) {
  final root = Directory(dir);
  if (!root.existsSync()) return const [];
  return root
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => f.path.endsWith('.dart'))
      .map((f) => f.path)
      .toList()
    ..sort();
}

/// Runs [pattern] over [file] and reports each hit with its line number and
/// whether the whole line is a comment, so comment prose never trips a rule.
List<_Hit> _matchesIn(String file, RegExp pattern) {
  final lines = File(file).readAsLinesSync();
  final hits = <_Hit>[];
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    final trimmed = line.trim();
    final isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    for (final m in pattern.allMatches(line)) {
      hits.add(_Hit(i + 1, m.group(0)!, isComment: isComment));
    }
  }
  return hits;
}

// ignore_for_file: lines_longer_than_80_chars
library;

/// Canonical Customer Queue QR — Unified Format Tests
///
/// There is exactly ONE canonical customer queue QR:
///
///     https://<customer-web-host>/join?centerId=<24hexId>[&serviceId=<24hexId>]
///
/// It is the payload the Live Counter encodes, it is what the phone camera
/// opens via App Link / Universal Link, it is what a customer without the app
/// opens in the browser, and it is what the in-app scanner must recognise.
///
/// The legacy `queueflow://join?...` scheme is still accepted, but is never
/// the primary format.
///
/// Coverage:
///   1.  canonical HTTPS, center + service, is a valid join payload
///   2.  canonical HTTPS, center only, is a valid join payload
///   3.  legacy queueflow:// , center + service, still valid
///   4.  legacy queueflow:// , center only, still valid
///   5.  malformed URL is rejected
///   6.  wrong (untrusted) host is rejected
///   7.  wrong path on a trusted host is rejected
///   8.  staff HMAC check-in QR is rejected
///   9.  missing / malformed centerId is rejected
///   10. unrelated QRs (text, JSON, competitor scheme) are rejected
///   11. both accepted formats normalize to the same payload
///   12. cleartext HTTP is refused for production hosts, allowed for dev hosts
///   13. inbound app-link classification matches the scanner exactly
///   14. no credential ever appears in a join payload
///   15. join host allowlist is explicit and fail-closed
///   16. app-link configuration is present in the Android/iOS build files

import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/config/join_config.dart';
import 'package:user_app/utils/join_link_service.dart';
import 'package:user_app/utils/qr_payload_parser.dart';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const _centerId = '507f1f77bcf86cd799439011';
const _serviceId = '507f1f77bcf86cd799439022';

/// A host that is NOT trusted by default, standing in for the production
/// Customer Web domain. Tests opt it in explicitly to prove the allowlist is
/// what gates acceptance, not luck.
const _prodHost = 'join.example.test';

/// A third-party domain that is never trusted, even after _prodHost is added.
const _attackerHost = 'evil.example.test';

const _hmacCheckinQr =
    '{"v":1,"tid":"$_centerId","cid":"$_serviceId","sid":"507f1f77bcf86cd799439033",'
    '"iat":1700000000,"exp":1700001800,'
    '"jti":"550e8400-e29b-41d4-a716-446655440000","pur":"QUEUEFLOW_CHECKIN",'
    '"sig":"abcdef1234567890"}';

/// A HMAC payload served as a join-looking URL, to prove the signature check
/// runs before any URL parsing.
const _hmacUrl = 'https://$_attackerHost/join?centerId=$_centerId&payload=$_hmacCheckinQr';

void main() {
  // Opt the stand-in production host in for the whole suite; the default build
  // trusts only local dev hosts, which case 15 pins down explicitly.
  setUpAll(() => queueflowJoinHosts.add(_prodHost));
  tearDownAll(() => queueflowJoinHosts.remove(_prodHost));

  group('1. Canonical HTTPS join QR', () {
    test('1. HTTPS /join with centerId + serviceId is a join payload', () {
      final result = parseQrPayload(
        'https://$_prodHost/join?centerId=$_centerId&serviceId=$_serviceId',
      );

      expect(result, isA<QrJoinPayload>());
      final payload = result as QrJoinPayload;
      expect(payload.centerId, equals(_centerId));
      expect(payload.serviceId, equals(_serviceId));
      expect(payload.hasService, isTrue);
      expect(payload.format, equals(QrJoinFormat.httpsWeb));
    });

    test('2. HTTPS /join with centerId only is a join payload', () {
      final result = parseQrPayload('https://$_prodHost/join?centerId=$_centerId');

      expect(result, isA<QrJoinPayload>());
      final payload = result as QrJoinPayload;
      expect(payload.centerId, equals(_centerId));
      expect(payload.serviceId, isNull);
      expect(payload.hasService, isFalse);
    });
  });

  group('3, 4. Legacy queueflow:// join QR still works', () {
    test('3. queueflow:// with centerId + serviceId is a join payload', () {
      final result = parseQrPayload(
        'queueflow://join?centerId=$_centerId&serviceId=$_serviceId',
      );

      expect(result, isA<QrJoinPayload>());
      final payload = result as QrJoinPayload;
      expect(payload.centerId, equals(_centerId));
      expect(payload.serviceId, equals(_serviceId));
      expect(payload.format, equals(QrJoinFormat.legacyScheme));
    });

    test('4. queueflow:// with centerId only is a join payload', () {
      final result = parseQrPayload('queueflow://join?centerId=$_centerId');

      expect(result, isA<QrJoinPayload>());
      final payload = result as QrJoinPayload;
      expect(payload.centerId, equals(_centerId));
      expect(payload.serviceId, isNull);
      expect(payload.format, equals(QrJoinFormat.legacyScheme));
    });
  });

  group('5, 6, 7. Structural rejection is not weakened', () {
    test('5. malformed URL is rejected', () {
      // A scheme present but nothing parseable after it.
      for (final bad in <String>[
        'https://',
        'https://$_prodHost/join?centerId=%%%',
        'ht!tps://$_prodHost/join?centerId=$_centerId',
        '://$_prodHost/join?centerId=$_centerId',
      ]) {
        final result = parseQrPayload(bad);
        expect(
          result,
          isNot(isA<QrJoinPayload>()),
          reason: 'must not be accepted: $bad',
        );
      }
    });

    test('6. a host outside the allowlist is rejected', () {
      // A perfectly well-formed /join URL on the wrong domain must never enter
      // the queue flow, or any third-party QR could join a queue.
      final result = parseQrPayload(
        'https://$_attackerHost/join?centerId=$_centerId&serviceId=$_serviceId',
      );

      expect(result, isNot(isA<QrJoinPayload>()));
      expect(result, isA<QrUnrecognized>());
      expect((result as QrUnrecognized).hint, equals('untrusted_join_host'));
    });

    test('7. a trusted host with the wrong path is rejected', () {
      for (final badPath in <String>[
        'https://$_prodHost/queue/preview?centerId=$_centerId',
        'https://$_prodHost/join/extra?centerId=$_centerId',
        'https://$_prodHost/center/$_centerId',
        'https://$_prodHost/?centerId=$_centerId',
        'https://$_prodHost/JOIN?centerId=$_centerId', // path is case sensitive
      ]) {
        final result = parseQrPayload(badPath);
        expect(
          result,
          isNot(isA<QrJoinPayload>()),
          reason: 'must not be accepted: $badPath',
        );
      }
    });
  });

  group('8, 9, 10. QRs that are not customer join QRs', () {
    test('8. staff HMAC check-in QR is rejected in both forms', () {
      expect(parseQrPayload(_hmacCheckinQr), isA<QrUnrecognized>());
      expect(
        (parseQrPayload(_hmacCheckinQr) as QrUnrecognized).hint,
        equals('staff_hmac_payload'),
      );

      // Even when dressed up as a join URL, the signature check must win.
      expect(parseQrPayload(_hmacUrl), isA<QrUnrecognized>());
    });

    test('9. missing or malformed centerId is rejected', () {
      final cases = <String, Matcher>{
        'https://$_prodHost/join': isA<QrInvalid>(),
        'https://$_prodHost/join?': isA<QrInvalid>(),
        'https://$_prodHost/join?centerId=': isA<QrInvalid>(),
        'https://$_prodHost/join?centerId=short': isA<QrInvalid>(),
        'https://$_prodHost/join?centerId=zzzzzzzzzzzzzzzzzzzzzzzz':
            isA<QrInvalid>(),
        'https://$_prodHost/join?cid=$_centerId': isA<QrInvalid>(),
        'https://$_prodHost/join?centerId=${_centerId}x': isA<QrInvalid>(),
        // A valid center with an invalid service is still invalid.
        'https://$_prodHost/join?centerId=$_centerId&serviceId=nope':
            isA<QrInvalid>(),
        'https://$_prodHost/join?centerId=$_centerId&serviceId=$_centerId':
            isA<QrInvalid>(),
      };
      cases.forEach((qr, matcher) {
        expect(parseQrPayload(qr), matcher, reason: 'for $qr');
      });
    });

    test('10. unrelated QR content is rejected', () {
      final unrelated = <String>[
        'Hello World',
        '{"foo":"bar"}',
        'WIFI:T:WPA;S:QueueFlow;P:hunter2;;',
        'BEGIN:VCARD\nVERSION:3.0\nFN:John\nEND:VCARD',
        'mailto:someone@example.test',
        'tel:+911234567890',
        'myapp://join?centerId=$_centerId',
        'QUEUEFLOW://join?centerId=$_centerId'.toLowerCase(),
        'queueflow://verify?centerId=$_centerId',
        '',
        '    ',
        'https://$_prodHost/join?centerId=$_centerId extra',
      ];
      for (final qr in unrelated) {
        expect(
          parseQrPayload(qr),
          isNot(isA<QrJoinPayload>()),
          reason: 'must not be accepted: $qr',
        );
      }
    });
  });

  group('11. One payload shape for both formats', () {
    test('11. HTTPS and queueflow:// normalize identically', () {
      for (final service in <String>[_serviceId, '']) {
        final web = parseQrPayload(
          service.isEmpty
              ? 'https://$_prodHost/join?centerId=$_centerId'
              : 'https://$_prodHost/join?centerId=$_centerId&serviceId=$service',
        ) as QrJoinPayload;
        final legacy = parseQrPayload(
          service.isEmpty
              ? 'queueflow://join?centerId=$_centerId'
              : 'queueflow://join?centerId=$_centerId&serviceId=$service',
        ) as QrJoinPayload;

        expect(web.centerId, equals(legacy.centerId));
        expect(web.serviceId, equals(legacy.serviceId));
        expect(web.hasService, equals(legacy.hasService));
        // The only difference is provenance, never destination.
        expect(web.format, isNot(equals(legacy.format)));
      }
    });

    test('11b. query parameter order and case do not change the result', () {
      final a = parseQrPayload(
        'https://$_prodHost/join?serviceId=$_serviceId&centerId=$_centerId',
      ) as QrJoinPayload;
      final b = parseQrPayload(
        'https://$_prodHost/join?centerId=$_centerId&serviceId=$_serviceId',
      ) as QrJoinPayload;

      expect(a.centerId, equals(b.centerId));
      expect(a.serviceId, equals(b.serviceId));
    });

    test('11c. a trailing slash on /join is still not the canonical path', () {
      expect(
        parseQrPayload('https://$_prodHost/join/?centerId=$_centerId'),
        isNot(isA<QrJoinPayload>()),
      );
    });
  });

  group('12. Transport rules', () {
    test('12a. cleartext HTTP is refused for production hosts', () {
      final result =
          parseQrPayload('http://$_prodHost/join?centerId=$_centerId');

      expect(result, isA<QrUnrecognized>());
      expect((result as QrUnrecognized).hint, equals('insecure_join_scheme'));
    });

    test('12b. cleartext HTTP is allowed for local dev hosts', () {
      // The Customer Web dev server runs on http://localhost:5173. A QR
      // generated against it must still be scannable during development.
      final result =
          parseQrPayload('http://localhost:5173/join?centerId=$_centerId');

      expect(result, isA<QrJoinPayload>());
      expect((result as QrJoinPayload).centerId, equals(_centerId));
    });

    test('12c. uppercase HTTPS scheme is accepted', () {
      expect(
        parseQrPayload('HTTPS://$_prodHost/join?centerId=$_centerId'),
        isA<QrJoinPayload>(),
      );
    });
  });

  group('13. Inbound app link === in-app scan', () {
    test('13a. the same string yields the same payload either way', () {
      for (final url in <String>[
        'https://$_prodHost/join?centerId=$_centerId&serviceId=$_serviceId',
        'https://$_prodHost/join?centerId=$_centerId',
        'queueflow://join?centerId=$_centerId',
      ]) {
        final scanned = parseQrPayload(url);
        final linked = classifyJoinLink(Uri.parse(url));

        expect(linked, isNotNull, reason: url);
        expect(linked!.centerId, equals((scanned as QrJoinPayload).centerId));
        expect(linked.serviceId, equals(scanned.serviceId));
        expect(linked.hasService, equals(scanned.hasService));
      }
    });

    test('13b. a non-join inbound link is ignored, not surfaced as an error', () {
      // The app must never interrupt the user with a QR error because the OS
      // handed it an unrelated deep link.
      for (final uri in <String>[
        'https://$_attackerHost/join?centerId=$_centerId',
        _hmacCheckinQr,
        'https://$_prodHost/token/abc',
        'myapp://something',
        'not a uri at all',
      ]) {
        expect(classifyJoinLink(Uri.tryParse(uri)), isNull, reason: uri);
      }
      expect(classifyJoinLink(null), isNull);
    });
  });

  group('14. No credentials in a join payload', () {
    test('14. parsed IDs are bare 24-hex ObjectIds and nothing else', () {
      final payload = parseQrPayload(
        'https://$_prodHost/join?centerId=$_centerId&serviceId=$_serviceId',
      ) as QrJoinPayload;

      expect(payload.centerId, matches(RegExp(r'^[0-9a-fA-F]{24}$')));
      expect(payload.serviceId, matches(RegExp(r'^[0-9a-fA-F]{24}$')));
    });

    test('14b. extra credential-looking query params never reach the payload', () {
      // A hostile QR could try to smuggle a token in. Extra parameters must be
      // ignored entirely, not surfaced anywhere downstream.
      final payload = parseQrPayload(
        'https://$_prodHost/join?centerId=$_centerId&token=eyJhbGciOiJIUzI1NiJ9'
        '.secret&apiKey=abc123&IOT_SECRET=shhh',
      ) as QrJoinPayload;

      expect(payload.centerId, equals(_centerId));
      expect(payload.serviceId, isNull);
      expect(payload.toString(), isNot(contains('secret')));
      expect(payload.toString(), isNot(contains('token')));
    });

    test('14c. oversized input is capped at 512 chars before parsing', () {
      // Junk trailing the IDs is ignored, and nothing is smuggled through: the
      // payload is exactly the two validated ObjectIds and nothing else.
      final oversized =
          'https://$_prodHost/join?centerId=$_centerId&${'x' * 800}';
      final result = parseQrPayload(oversized);
      expect(result, isA<QrJoinPayload>());
      final payload = result as QrJoinPayload;
      expect(payload.centerId, equals(_centerId));
      expect(payload.serviceId, isNull);
      expect(payload.toString().length, lessThan(200));

      // Truncation is real: a URL whose valid-looking prefix only appears past
      // the cap must NOT resolve, proving the cap is applied and not ignored.
      final late =
          'https://$_prodHost/join?${'a' * 600}centerId=$_centerId';
      expect(parseQrPayload(late), isNot(isA<QrJoinPayload>()));
    });
  });

  group('15. Join host allowlist', () {
    test('15a. the canonical path is a single constant', () {
      expect(kCanonicalJoinPath, equals('/join'));
    });

    test('15b. an unconfigured production build trusts dev hosts only', () {
      // This build has no QUEUEFLOW_JOIN_HOSTS dart-define, so fail-closed is
      // the correct and intended behaviour.
      expect(hasConfiguredProductionJoinHost, isFalse);
      for (final host in kDevJoinHosts) {
        expect(isAllowedJoinHost(host), isTrue, reason: host);
      }
      expect(isAllowedJoinHost('anything.else.test'), isFalse);
      expect(isAllowedJoinHost(null), isFalse);
    });

    test('15c. host matching is case-insensitive and host-only', () {
      expect(isAllowedJoinHost('LOCALHOST'), isTrue);
      expect(isAllowedJoinHost('  localhost  '), isTrue);
      // A host plus port is not a host name; `Uri.host` strips the port so the
      // parser never sees this, but the helper must not match it by accident.
      expect(isAllowedJoinHost('localhost:5173'), isFalse);
      // Path traversal must not be smuggled in as a host.
      expect(isAllowedJoinHost('evil.test/localhost'), isFalse);
    });

    test('15d. only https, or http on a dev host, is an allowed scheme', () {
      expect(isAllowedJoinScheme('https', _prodHost), isTrue);
      expect(isAllowedJoinScheme('https', _attackerHost), isTrue);
      expect(isAllowedJoinScheme('http', _prodHost), isFalse);
      expect(isAllowedJoinScheme('http', 'localhost'), isTrue);
      expect(isAllowedJoinScheme('ftp', 'localhost'), isFalse);
      expect(isAllowedJoinScheme('queueflow', 'localhost'), isFalse);
    });
  });

  group('16. App-link configuration', () {
    late String manifest;
    late String infoPlist;
    late String entitlements;
    late String pbxproj;
    late String gradle;
    late String gradleHostProperties;
    late String mainActivity;
    late String appRouter;

    setUpAll(() {
      manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      infoPlist = File('ios/Runner/Info.plist').readAsStringSync();
      entitlements = File('ios/Runner/Runner.entitlements').readAsStringSync();
      pbxproj = File('ios/Runner.xcodeproj/project.pbxproj').readAsStringSync();
      gradle = File('android/app/build.gradle.kts').readAsStringSync();
      gradleHostProperties =
          File('android/queueflow_join_host.properties').readAsStringSync();
      mainActivity = File(
        'android/app/src/main/kotlin/com/example/user_app/MainActivity.kt',
      ).readAsStringSync();
      appRouter = File('lib/core/router/app_router.dart').readAsStringSync();
    });

    test('16a. Android declares a verified App Link for the /join route', () {
      expect(manifest, contains('android:autoVerify="true"'));
      expect(manifest, contains('android:scheme="https"'));
      expect(manifest, contains(r'android:pathPrefix="/join"'));
      expect(manifest, contains('android.intent.action.VIEW'));
      expect(manifest, contains('android.intent.category.BROWSABLE'));
      expect(manifest, contains('android.intent.category.DEFAULT'));
    });

    test('16b. Android actually opts in to handling those intents', () {
      // This is the failure mode a manifest review hides: the Flutter Android
      // embedding DISCARDS incoming VIEW intents unless deep-link handling is
      // explicitly enabled, so a perfect autoVerify filter can still be dead.
      expect(
        manifest,
        contains('flutter_deeplinking_enabled'),
        reason: 'the manifest must enable Flutter deep-link handling',
      );
      expect(RegExp(r'flutter_deeplinking_enabled"\s*\n?\s*android:value="true"')
          .hasMatch(manifest), isTrue);
      expect(
        mainActivity,
        contains('override fun shouldHandleDeeplinking(): Boolean = true'),
      );
    });

    test('16c. the /join route exists in the router', () {
      // The OS hands Flutter the link as a route, not as a channel message, so
      // without a matching route the link lands on the 404 screen.
      expect(appRouter, contains('path: joinLinkLocation()'));
      expect(
        appRouter,
        contains('JoinLinkTransitScreen'),
        reason: 'the join route must not render a 404',
      );
      // Validation must NOT be done from the router's copy of the location:
      // go_router rebuilds it relative to the app, which drops the host and
      // would silently disable the host allowlist.
      expect(
        RegExp(r'classifyJoinLink\(\s*state\.uri').hasMatch(appRouter),
        isFalse,
        reason: 'state.uri has no host; validating it would weaken the allowlist',
      );
    });

    test('16d. Android keeps the legacy custom scheme registered', () {
      // Without this, QR codes printed before the HTTPS format silently stop
      // opening the app.
      expect(manifest, contains('android:scheme="queueflow"'));
      expect(manifest, contains('android:host="join"'));
    });

    test('16e. the App Link host is injected, never hardcoded in the manifest', () {
      expect(manifest, contains(r'android:host="${queueflowJoinHost}"'));
      expect(
        gradle,
        contains('manifestPlaceholders["queueflowJoinHost"]'),
        reason: 'the domain must have a single source of truth',
      );
    });

    test('16f. iOS registers the legacy custom scheme', () {
      expect(infoPlist, contains('<key>CFBundleURLTypes</key>'));
      expect(infoPlist, contains('<key>CFBundleURLSchemes</key>'));
      expect(infoPlist, contains('<string>queueflow</string>'));
    });

    test('16g. iOS declares associated domains and they are actually signed', () {
      expect(entitlements, contains('com.apple.developer.associated-domains'));
      expect(entitlements, contains('applinks:'));

      // An entitlements file that nothing references has no effect at all, so
      // the Runner target must actually use it.
      expect(
        pbxproj,
        contains('CODE_SIGN_ENTITLEMENTS = Runner/Runner.entitlements;'),
      );
      // Debug, Release and Profile configurations.
      expect(
        RegExp(r'CODE_SIGN_ENTITLEMENTS = Runner/Runner\.entitlements;')
            .allMatches(pbxproj)
            .length,
        greaterThanOrEqualTo(3),
      );
    });

    test('16h. no localhost is baked into the shipped link configuration', () {
      // A localhost host in the App Link / Universal Link config would make the
      // QR dead on every real device.
      final files = <String, String>{
        'AndroidManifest.xml': manifest,
        'Runner.entitlements': entitlements,
        'queueflow_join_host.properties': gradleHostProperties,
      };
      files.forEach((file, content) {
        expect(content, isNot(contains('localhost')), reason: file);
        expect(content, isNot(contains('127.0.0.1')), reason: file);
      });
    });

    test('16i. the unconfigured placeholder host can never resolve', () {
      // The App Link / Universal Link default must be a reserved TLD (RFC 2606)
      // so a build that forgot to configure the domain can never be mistaken
      // for a working deployment. Android and iOS simply cannot verify a host
      // that does not exist, and the QR falls back to the Customer Web page.
      final reserved = RegExp(r'\.(invalid|test|example|localhost|local)$');
      final shippedHost =
          RegExp(r'applinks:([^<\s]+)').firstMatch(entitlements)?.group(1);
      expect(shippedHost, isNotNull, reason: 'no applinks: entry in entitlements');
      expect(reserved.hasMatch(shippedHost!), isTrue,
          reason: 'shipped applinks host "$shippedHost" is not a reserved TLD');
      expect(gradle.contains('"join.invalid"'), isTrue,
          reason: 'the Gradle placeholder must also be a reserved TLD');
    });
  });

  group('17. Inbound platform routes drive the one shared flow', () {
    /// Collects everything the observer republishes until the test ends.
    List<QrJoinPayload> observe(JoinLinkRouteObserver observer) {
      final received = <QrJoinPayload>[];
      final sub = observer.joins.listen(received.add);
      addTearDown(sub.cancel);
      return received;
    }

    test('17a. a platform route is republished as a join payload', () async {
      joinLinkRouteObserver.reset();
      final received = observe(joinLinkRouteObserver);

      // Exactly what the engine pushes when an App Link is tapped.
      joinLinkRouteObserver.handle(
        Uri.parse(
          'https://$_prodHost/join?centerId=$_centerId&serviceId=$_serviceId',
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
      expect(received.single.centerId, equals(_centerId));
      expect(received.single.serviceId, equals(_serviceId));
    });

    test('17b. a non-join platform route is ignored entirely', () async {
      joinLinkRouteObserver.reset();
      final received = observe(joinLinkRouteObserver);

      for (final route in <String>[
        'https://$_attackerHost/join?centerId=$_centerId',
        'https://$_prodHost/token/abc',
        'queueflow://checkin?centerId=$_centerId',
        'myapp://elsewhere',
        '/home',
      ]) {
        joinLinkRouteObserver.handle(Uri.parse(route));
      }
      await Future<void>.delayed(Duration.zero);

      // A staff link, an unrelated deep link or a third-party URL must leave the
      // app alone. Surfacing a QR error here would be a bug, not a feature.
      expect(received, isEmpty);
    });

    test('17c. the same link reported twice is acted on once', () async {
      joinLinkRouteObserver.reset();
      final received = observe(joinLinkRouteObserver);

      // A cold start can report the launch route and then the same pushed route.
      joinLinkRouteObserver.handle(
        Uri.parse('https://$_prodHost/join?centerId=$_centerId'),
      );
      joinLinkRouteObserver.handle(
        Uri.parse('https://$_prodHost/join?centerId=$_centerId'),
      );
      await Future<void>.delayed(Duration.zero);
      expect(received, hasLength(1));

      // A genuinely different scan still works.
      joinLinkRouteObserver.handle(
        Uri.parse('https://$_prodHost/join?centerId=$_serviceId'),
      );
      await Future<void>.delayed(Duration.zero);
      expect(received, hasLength(2));
      expect(received.last.centerId, equals(_serviceId));
    });

    test('17d. the parked payload survives until it is consumed', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      expect(container.read(pendingJoinLinkProvider), isNull);

      // This is what JoinLinkListener does on a stream callback: park it.
      final payload = classifyJoinLink(
        Uri.parse('https://$_prodHost/join?centerId=$_centerId'),
      );
      container.read(pendingJoinLinkProvider.notifier).set(payload!);

      // Every route in this app redirects a signed-out user to /login. The link
      // has to still be here afterwards, or "scan the QR, then sign in" breaks.
      final parked = container.read(pendingJoinLinkProvider);
      expect(parked, isNotNull);
      expect(parked!.centerId, equals(_centerId));

      container.read(pendingJoinLinkProvider.notifier).clear();
      expect(container.read(pendingJoinLinkProvider), isNull);
    });

    test('17e. the router exposes a route for the canonical path', () {
      // Without it, an inbound link renders the 404 screen while the join flow
      // runs behind it.
      expect(joinLinkLocation(), equals('/join'));
      expect(joinLinkLocation(), equals(kCanonicalJoinPath));
    });
  });
}

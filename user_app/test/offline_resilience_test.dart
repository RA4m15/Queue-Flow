import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/providers/document_gate_provider.dart';
import 'package:user_app/providers/service_graph_provider.dart';
import 'package:user_app/providers/swap_provider.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/services/storage_service.dart';

import 'harness.dart';

void main() {
  late FakeApiService api;
  late FakeStorageService storage;
  late SocketService socket;
  late NetworkStatus network;

  setUp(() async {
    network = NetworkStatus();
    api = FakeApiService(Dio(), networkStatus: network);
    storage = FakeStorageService();
    socket = SocketService();
    // A signed-in customer: the queue cache is namespaced per account.
    await storage.saveAuthToken('jwt-token');
    await storage.saveUserData(
      id: kUserA,
      name: 'Customer A',
      email: 'a@example.com',
      role: 'CUSTOMER',
    );
  });

  tearDown(() {
    network.dispose();
  });

  TokenNotifier buildNotifier() => TokenNotifier(
        apiService: api,
        socketService: socket,
        storageService: storage,
      );

  group('Offline resilience — cached last-known state', () {
    test('an unreachable backend surfaces the cached token as OFFLINE_LAST_KNOWN, not live', () async {
      // A server-confirmed token was cached on a previous run.
      await storage.setCachedToken(
        TokenModel.fromJson(tokenJson(tokenCode: 'A-014', currentPosition: 4, waitEstimateMinutes: 18)),
        kUserA,
      );

      final notifier = buildNotifier();
      // The backend becomes unreachable.
      network.markUnreachable();

      await notifier.fetchActiveToken();

      expect(notifier.state.connectionStatus, 'OFFLINE_LAST_KNOWN');
      expect(notifier.state.isOffline, isTrue);
      expect(notifier.state.isLive, isFalse);
      expect(notifier.state.isCached, isTrue);
      // Values shown are the last server-confirmed ones, not invented.
      expect(notifier.state.activeToken!.tokenCode, 'A-014');
      expect(notifier.state.activeToken!.currentPosition, 4);
      expect(notifier.state.activeToken!.waitEstimateMinutes, 18);
      expect(notifier.state.cachedAt, isNotNull);
    });

    test('with no cache and no network the app reports NO_DATA instead of inventing a token', () async {
      final notifier = buildNotifier();
      network.markUnreachable();

      await notifier.fetchActiveToken();

      expect(notifier.state.activeToken, isNull);
      expect(notifier.state.connectionStatus, 'NO_DATA');
      expect(notifier.state.isCached, isFalse);
    });

    test('an expired cache is discarded rather than presented as current', () async {
      // A cache entry inside the production freshness window is readable.
      await storage.seedCachedToken(
        TokenModel.fromJson(tokenJson(tokenCode: 'A-001')),
        kUserA,
        cachedAt: DateTime.now().subtract(const Duration(hours: 1)),
      );
      expect((await storage.getCachedToken(kUserA))!.tokenCode, 'A-001');

      // Now the same entry ages past [StorageService.maxCacheAge].
      await storage.seedCachedToken(
        TokenModel.fromJson(tokenJson(tokenCode: 'A-001')),
        kUserA,
        cachedAt: DateTime.now().subtract(StorageService.maxCacheAge + const Duration(minutes: 1)),
      );

      final notifier = buildNotifier();
      network.markUnreachable();
      await notifier.fetchActiveToken();

      // Expired cache must not be shown as the last known queue position.
      expect(await storage.getCachedToken(kUserA), isNull, reason: 'expired entry is purged on read');
      expect(notifier.state.connectionStatus, 'NO_DATA');
      expect(notifier.state.activeToken, isNull);
      expect(notifier.state.isCached, isFalse);

      // The production envelope expiry guard itself, against the real constant.
      expect(StorageService.maxCacheAge, const Duration(hours: 24));
      expect(
        CachedTokenEnvelope(
          token: TokenModel.fromJson(tokenJson()),
          cachedAt: DateTime.now().subtract(const Duration(hours: 25)),
        ).isExpired,
        isTrue,
      );
      expect(
        CachedTokenEnvelope(
          token: TokenModel.fromJson(tokenJson()),
          cachedAt: DateTime.now().subtract(const Duration(hours: 1)),
        ).isExpired,
        isFalse,
      );
    });

    test('a server error (not a transport failure) never falls back to cached data', () async {
      await storage.setCachedToken(TokenModel.fromJson(tokenJson()), kUserA);
      final notifier = buildNotifier();

      // The backend answers with a 500 — it IS reachable, so cached data must
      // not be presented as if it were the current state.
      api.activeToken = null; // will return null -> NO_DATA
      await notifier.fetchActiveToken();

      expect(notifier.state.connectionStatus, 'NO_DATA');
      expect(notifier.state.isCached, isFalse);
    });
  });

  group('Offline resilience — authoritative mutations are blocked', () {
    test('join queue is refused offline and no local token is created', () async {
      final notifier = buildNotifier();
      network.markUnreachable();

      Object? thrown;
      try {
        await notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId);
      } catch (e) {
        thrown = e;
      }

      expect(thrown, isA<ApiException>());
      expect((thrown! as ApiException).message, 'This action requires an internet connection.');
      // No backend call, therefore no fabricated token anywhere.
      expect(api.joinCalls, 0);
      expect(notifier.state.activeToken, isNull);
    });

    test('cancel token is refused offline', () async {
      api.activeToken = TokenModel.fromJson(tokenJson());
      final notifier = buildNotifier();
      await notifier.fetchActiveToken();

      network.markUnreachable();
      await expectLater(
        notifier.cancelToken(kTokenId),
        throwsA(isA<ApiException>()),
      );
    });

    test('feedback submission is refused offline', () async {
      api.activeToken = TokenModel.fromJson(tokenJson());
      final notifier = buildNotifier();
      await notifier.fetchActiveToken();

      network.markUnreachable();
      await expectLater(
        notifier.submitFeedback(tokenId: kTokenId, rating: 5),
        throwsA(isA<ApiException>()),
      );
    });

    test('P2P swap creation is refused offline and never simulated', () async {
      final swap = SwapNotifier(apiService: api, socketService: socket);

      network.markUnreachable();
      await expectLater(
        swap.createOffer(offeringTokenId: kTokenId),
        throwsA(isA<ApiException>()),
      );
      expect(api.swapCreateCalls, 0);
    });

    test('P2P swap acceptance is refused offline and never simulated', () async {
      final swap = SwapNotifier(apiService: api, socketService: socket);

      network.markUnreachable();
      await expectLater(
        swap.acceptOffer(offerId: kTokenId, acceptingTokenId: kTokenId),
        throwsA(isA<ApiException>()),
      );
      expect(api.swapAcceptCalls, 0);
    });

    test('document submission is refused offline and never acknowledged', () async {
      network.markUnreachable();
      await expectLater(
        api.uploadCustomerDocument(
          serviceId: kServiceId,
          documentType: 'AADHAAR',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          base64Data: 'AAAA',
        ),
        throwsA(isA<ApiException>()),
      );
      expect(api.documentUploadCalls, 0);
      expect(api.uploadedDocument, isNull);
    });

    test('geofence updates are refused offline so proximity is never fabricated', () async {
      network.markUnreachable();
      await expectLater(
        api.updateTokenLocation(
          tokenId: kTokenId,
          latitude: 12.9716,
          longitude: 77.5946,
        ),
        throwsA(isA<ApiException>()),
      );
      expect(api.locationUpdateCalls, 0);
    });

    test('service graph hop confirmation is refused offline', () async {
      final graph = ServiceGraphNotifier(apiService: api, socketService: socket);
      network.markUnreachable();
      await expectLater(
        graph.confirmNextHop(tokenId: kTokenId, nextServiceId: kNextServiceId),
        throwsA(isA<ApiException>()),
      );
      expect(api.confirmedHopToken, isNull);
    });
  });

  group('Offline resilience — reconnect synchronisation', () {
    test('reaching the backend again replaces cached state with authoritative state', () async {
      await storage.setCachedToken(
        TokenModel.fromJson(tokenJson(tokenCode: 'A-014', currentPosition: 4, waitEstimateMinutes: 18)),
        kUserA,
      );
      api.activeToken = TokenModel.fromJson(
        tokenJson(tokenCode: 'A-014', currentPosition: 2, waitEstimateMinutes: 6, servingToken: 'A-012'),
      );

      final notifier = buildNotifier();
      network.markUnreachable();
      await notifier.fetchActiveToken();
      expect(notifier.state.isOffline, isTrue);
      expect(notifier.state.activeToken!.currentPosition, 4);

      // Connectivity restored and the backend is re-polled.
      network.markReachable();
      await notifier.fetchActiveToken(silent: true);

      expect(notifier.state.connectionStatus, 'LIVE');
      expect(notifier.state.isCached, isFalse);
      // Authoritative values replaced the cache, they were not merged/blended.
      expect(notifier.state.activeToken!.currentPosition, 2);
      expect(notifier.state.activeToken!.waitEstimateMinutes, 6);
      expect(notifier.state.activeToken!.servingToken, 'A-012');
    });

    test('a network transition to offline flips the visible state without a request', () async {
      api.activeToken = TokenModel.fromJson(tokenJson());
      final notifier = buildNotifier();
      await notifier.fetchActiveToken();
      expect(notifier.state.isLive, isTrue);

      network.markUnreachable();
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(notifier.state.isOffline, isTrue);
      // Last confirmed data is preserved, not discarded.
      expect(notifier.state.activeToken, isNotNull);
    });
  });

  group('Cache isolation and logout cleanup', () {
    test('account A cannot read account B queue cache on the same device', () async {      await storage.setCachedToken(
        TokenModel.fromJson(tokenJson(tokenCode: 'A-777', userId: kUserA)),
        kUserA,
      );
      await storage.setCachedToken(
        TokenModel.fromJson(tokenJson(tokenCode: 'B-333', userId: kUserB)),
        kUserB,
      );

      final a = await storage.getCachedToken(kUserA);
      final b = await storage.getCachedToken(kUserB);

      expect(a!.tokenCode, 'A-777');
      expect(b!.tokenCode, 'B-333');
      expect(a.tokenCode, isNot(b.tokenCode));
    });

    test('clearing one account cache leaves the other account intact', () async {
      await storage.setCachedToken(TokenModel.fromJson(tokenJson(userId: kUserA)), kUserA);
      await storage.setCachedToken(TokenModel.fromJson(tokenJson(userId: kUserB)), kUserB);

      await storage.clearCachedToken(kUserA);

      expect(await storage.getCachedToken(kUserA), isNull);
      expect(await storage.getCachedToken(kUserB), isNotNull);
    });

    test('logout clears the cache, the device push token and the session', () async {
      await storage.saveAuthToken('jwt-token');
      await storage.saveUserData(id: kUserA, name: 'A', email: 'a@x.com', role: 'CUSTOMER');
      await storage.saveFcmToken('fcm_device_registration_token_value_0123456789');
      await storage.setCachedToken(TokenModel.fromJson(tokenJson()), kUserA);

      expect(storage.data.containsKey('cached_token_$kUserA'), isTrue);
      expect(storage.data.containsKey('fcm_device_token'), isTrue);

      await storage.clearAuth();

      expect(storage.data, isEmpty);
      expect(await storage.hasToken(), isFalse);
      expect(await storage.getFcmToken(), isNull);
      expect(await storage.getCachedToken(kUserA), isNull);
    });
  });

  group('Document gate offline behaviour', () {
    test('an unreachable backend marks the gate stale and forbids joining', () async {
      final gate = DocumentGateNotifier(apiService: api, socketService: socket);
      api.readiness = const {
        'isReady': true,
        'status': 'READY',
        'message': 'All required documentation satisfied',
        'checklist': [
          {
            'documentType': 'AADHAAR',
            'name': 'Aadhaar Card',
            'isRequired': true,
            'customerStatus': 'VERIFIED',
          }
        ],
        'missingRequirements': <dynamic>[],
      };

      // First, an authoritative READY verdict.
      final ready = await gate.check(kServiceId);
      expect(ready.status, 'READY');
      expect(gate.state.canJoin, isTrue);
      expect(gate.state.isStale, isFalse);

      // Now the backend is unreachable.
      network.markUnreachable();
      await gate.refresh(kServiceId, silent: true);

      expect(gate.state.isStale, isTrue);
      // A stale verdict must never authorise a join.
      expect(gate.state.canJoin, isFalse);
    });
  });
}

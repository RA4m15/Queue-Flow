import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/providers/document_gate_provider.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/services/socket_service.dart';

import 'harness.dart';

/// Direct queue join.
///
/// The token, its number, its queue position and its EWT are produced by the
/// backend and surfaced verbatim. A join that the backend refuses must not
/// produce a token on the device, and the Document Gate must be satisfied by
/// the backend's own verdict before the join button is even enabled.
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
    await storage.saveUserData(
      id: kUserA,
      name: 'Customer A',
      email: 'a@example.com',
      role: 'CUSTOMER',
    );
  });

  tearDown(() => network.dispose());

  TokenNotifier build() => TokenNotifier(
        apiService: api,
        socketService: socket,
        storageService: storage,
      );

  group('Queue join — the token comes from the backend', () {
    test('a successful join stores the exact token the server issued', () async {
      final notifier = build();

      final token = await notifier.joinQueue(
        centerId: kCenterId,
        serviceId: kServiceId,
      );

      expect(api.joinCalls, 1);
      expect(token.id, kTokenId);
      expect(token.tokenCode, 'A-014');
      expect(token.tokenNumber, 14);
      expect(token.status, 'WAITING');
      // Position and EWT are the server's values, not computed on the device.
      expect(token.currentPosition, 1);
      expect(token.centerId, kCenterId);
      expect(token.serviceId, kServiceId);

      expect(notifier.state.activeToken, isNotNull);
      expect(notifier.state.activeToken!.tokenCode, 'A-014');
      expect(notifier.state.isLive, isTrue);
      expect(notifier.state.isCached, isFalse);
      expect(notifier.state.error, isNull);
    });

    test('a successful join is cached for offline resilience', () async {
      final notifier = build();
      await notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId);

      final cached = await storage.getCachedToken(kUserA);
      expect(cached, isNotNull);
      expect(cached!.tokenCode, 'A-014');
    });

    test('a server rejection leaves no token and no optimistic state', () async {
      api.joinError = ApiException(
        message: 'You already have an active token for this service.',
        code: 'ACTIVE_TOKEN_EXISTS',
      );
      final notifier = build();

      await expectLater(
        notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId),
        throwsA(isA<ApiException>()),
      );

      expect(notifier.state.activeToken, isNull, reason: 'no token is invented');
      expect(notifier.state.error, isNotNull);
      expect(notifier.state.isLoading, isFalse);
      expect(await storage.getCachedToken(kUserA), isNull);
    });

    test('a duplicate-join rejection keeps the backend error code intact', () async {
      api.joinError = ApiException(
        message: 'You already have an active token.',
        code: 'ACTIVE_TOKEN_EXISTS',
      );
      final notifier = build();

      try {
        await notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId);
        fail('expected the join to be refused');
      } on ApiException catch (e) {
        expect(e.code, 'ACTIVE_TOKEN_EXISTS');
      }
    });

    test('a second join while one is in flight is refused, not queued twice', () async {
      final notifier = build();
      final first = notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId);
      // The first call has already flipped isLoading.
      await expectLater(
        notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'A queue operation is already in progress.',
          ),
        ),
      );
      await first;
      expect(api.joinCalls, 1);
    });

    test('an offline join is refused before any request reaches the backend', () async {
      final notifier = build();
      network.markUnreachable();

      await expectLater(
        notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'This action requires an internet connection.',
          ),
        ),
      );

      expect(api.joinCalls, 0);
      expect(notifier.state.activeToken, isNull);
    });
  });

  group('Queue join — the document gate must be satisfied server-side', () {
    test('a READY gate authorises the join', () async {
      final gate = DocumentGateNotifier(apiService: api, socketService: socket);
      api.readiness = const {
        'isReady': true,
        'status': 'READY',
        'message': 'All required documentation satisfied',
        'checklist': <dynamic>[],
        'missingRequirements': <dynamic>[],
      };
      await gate.check(kServiceId);

      final notifier = build();
      await notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId);

      expect(gate.state.canJoin, isTrue);
      expect(api.joinCalls, 1);
    });

    test('an INCOMPLETE gate is reported and must not be joined against', () async {
      final gate = DocumentGateNotifier(apiService: api, socketService: socket);
      api.readiness = const {
        'isReady': false,
        'status': 'INCOMPLETE',
        'message': 'Missing required documentation',
        'checklist': [
          {
            'documentType': 'AADHAAR',
            'name': 'Aadhaar Card',
            'isRequired': true,
            'customerStatus': 'NOT_UPLOADED',
          },
        ],
        'missingRequirements': [
          {
            'documentType': 'AADHAAR',
            'name': 'Aadhaar Card',
            'reason': 'Document not uploaded',
          },
        ],
      };

      final readiness = await gate.check(kServiceId);

      expect(gate.state.canJoin, isFalse);
      expect(readiness.missingItems, hasLength(1));
      expect(readiness.missingItems.first.name, 'Aadhaar Card');
    });

    test('an unrecognisable gate verdict never authorises a join', () async {
      final gate = DocumentGateNotifier(apiService: api, socketService: socket);
      // A payload with no `status` cannot be interpreted, so it must fail closed.
      api.readiness = const {'isReady': true, 'checklist': <dynamic>[]};

      final readiness = await gate.check(kServiceId);

      expect(readiness.status, 'UNAVAILABLE');
      expect(gate.state.canJoin, isFalse);
    });

    test('a gate that cannot be refreshed is stale and cannot authorise a join', () async {
      final gate = DocumentGateNotifier(apiService: api, socketService: socket);
      api.readiness = const {
        'isReady': true,
        'status': 'READY',
        'checklist': <dynamic>[],
        'missingRequirements': <dynamic>[],
      };
      await gate.check(kServiceId);
      expect(gate.state.canJoin, isTrue);

      network.markUnreachable();
      await gate.refresh(kServiceId, silent: true);

      expect(gate.state.isStale, isTrue);
      expect(gate.state.canJoin, isFalse);
    });

    test('the backend remains the final authority on join eligibility', () async {
      // Even when the client believes the gate is open, the server re-checks
      // it. A server refusal must propagate and produce no local token.
      final gate = DocumentGateNotifier(apiService: api, socketService: socket);
      api.readiness = const {
        'isReady': true,
        'status': 'READY',
        'checklist': <dynamic>[],
        'missingRequirements': <dynamic>[],
      };
      await gate.check(kServiceId);
      expect(gate.state.canJoin, isTrue);

      api.joinError = ApiException(
        message: 'Document verification is required before joining.',
        code: 'DOCUMENT_REQUIRED',
      );
      final notifier = build();

      await expectLater(
        notifier.joinQueue(centerId: kCenterId, serviceId: kServiceId),
        throwsA(isA<ApiException>()),
      );
      expect(notifier.state.activeToken, isNull);
    });
  });

  group('Queue join — cancelling is server authoritative', () {
    test('cancelling adopts the CANCELLED state the server returns', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(status: 'WAITING'));
      final notifier = build();
      await notifier.fetchActiveToken();

      await notifier.cancelToken(kTokenId);

      expect(notifier.state.activeToken!.status, 'CANCELLED');
      expect(notifier.state.activeToken!.currentPosition, isNull);
      // The cancelled token is not left in the offline cache.
      expect(await storage.getCachedToken(kUserA), isNull);
    });

    test('an offline cancel is refused and the token stays active', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(status: 'WAITING'));
      final notifier = build();
      await notifier.fetchActiveToken();

      network.markUnreachable();
      await expectLater(notifier.cancelToken(kTokenId), throwsA(isA<ApiException>()));

      expect(notifier.state.activeToken!.status, 'WAITING');
    });
  });

  group('Queue join — centre and service data is backend supplied', () {
    test('an empty centre list is a valid, non-error state', () async {
      api.centers = [];
      final centers = await api.getServiceCenters();

      expect(centers, isEmpty);
      expect(api.centerListCalls, 1);
    });

    test('an empty service list for a centre is a valid, non-error state', () async {
      api.services = [];
      final services = await api.getServices(kCenterId);

      expect(services, isEmpty);
      expect(api.serviceListCalls, 1);
    });

    test('a queue preview with no queue yet reports null rather than a guess', () async {
      api.queueDetails = const {
        'queue': null,
        'calledTokens': <dynamic>[],
      };

      final preview = await api.getServiceQueue(kCenterId, kServiceId);

      expect(preview['queue'], isNull);
      expect(preview['calledTokens'], isEmpty);
    });
  });
}

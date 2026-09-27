import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/next_hop_state.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/providers/service_graph_provider.dart';
import 'package:user_app/services/socket_service.dart';

import 'harness.dart';

/// Service Graph behaviour.
///
/// Fixtures mirror the real responses of
/// `GET /api/tokens/:id/next-service` and `GET /api/tokens/:id/journey`
/// (`backend/src/services/serviceGraphService.js`).
Map<String, dynamic> nextServicePayload({
  bool hasNextService = true,
  bool canTransition = true,
  bool alreadyTransitioned = false,
  bool isJourneyComplete = false,
  String? status,
  String? message,
  List<Map<String, dynamic>>? nextServices,
}) {
  return {
    'hasNextService': hasNextService,
    'canTransition': canTransition,
    if (alreadyTransitioned) 'alreadyTransitioned': true,
    'isJourneyComplete': isJourneyComplete,
    'status': ?status,
    'message': ?message,
    'nextServices': ?nextServices,
  };
}

/// One `nextServices[]` candidate exactly as the backend builds it.
Map<String, dynamic> candidate({
  String serviceId = kNextServiceId,
  String name = 'Photo Booth',
  String? tokenPrefix = 'P',
  String? description = 'Passport photographs',
  int? avgServiceTimeMinutes = 6,
  int? waitEstimateMinutes = 4,
  int waitingCount = 3,
}) {
  return {
    'serviceId': serviceId,
    'name': name,
    'tokenPrefix': tokenPrefix,
    'description': description,
    'avgServiceTimeMinutes': avgServiceTimeMinutes,
    'relationshipType': 'SEQUENTIAL',
    'waitEstimateMinutes': waitEstimateMinutes,
    'waitingCount': waitingCount,
  };
}

void main() {
  late FakeApiService api;
  late SocketService socket;
  late NetworkStatus network;

  setUp(() {
    network = NetworkStatus();
    api = FakeApiService(Dio(), networkStatus: network);
    socket = SocketService();
  });

  tearDown(() => network.dispose());

  ServiceGraphNotifier build() =>
      ServiceGraphNotifier(apiService: api, socketService: socket);

  /// A completed token, which is the precondition the backend enforces
  /// before it will report a next hop.
  TokenModel completedToken() => TokenModel.fromJson(
        tokenJson(status: 'COMPLETED', currentPosition: null, servingToken: null),
      );

  group('Service Graph — next hop comes from the backend only', () {
    test('a completed token renders the candidate services the backend reports', () async {
      api.nextServices = nextServicePayload(nextServices: [
        candidate(),
        candidate(
          serviceId: kTargetServiceId,
          name: 'Delivery Counter',
          tokenPrefix: 'D',
        ),
      ]);

      final graph = build();
      await graph.track(completedToken());

      expect(graph.state.hasData, isTrue);
      expect(graph.state.isStale, isFalse);
      expect(graph.state.nextHop!.hasNextService, isTrue);
      expect(graph.state.nextHop!.canTransition, isTrue);
      expect(graph.state.nextHop!.nextServices, hasLength(2));
      expect(graph.state.nextHop!.nextServices.first.serviceId, kNextServiceId);
      expect(graph.state.nextHop!.nextServices.first.name, 'Photo Booth');
      expect(graph.state.nextHop!.nextServices.last.name, 'Delivery Counter');
      expect(graph.state.canTransition, isTrue);
    });

    test('an in-progress token yields no next hop and no transition', () async {
      // Backend: token.status !== 'COMPLETED' -> "Current service is still in progress"
      api.nextServices = nextServicePayload(
        hasNextService: false,
        canTransition: false,
        status: 'SERVING',
        message: 'Current service is still in progress',
      );

      final graph = build();
      await graph.track(TokenModel.fromJson(tokenJson(status: 'SERVING')));

      expect(graph.state.nextHop!.hasNextService, isFalse);
      expect(graph.state.nextHop!.tokenStatus, 'SERVING');
      expect(graph.state.nextHop!.message, 'Current service is still in progress');
      // Nothing is offered to the customer at all.
      expect(graph.state.nextHop!.hasCandidate, isFalse);
      expect(graph.state.canTransition, isFalse);
    });

    test('a completed journey reports no next hop rather than a dead end', () async {
      api.nextServices = nextServicePayload(
        hasNextService: false,
        canTransition: false,
        isJourneyComplete: true,
        message: 'Journey complete',
      );

      final graph = build();
      await graph.track(completedToken());

      expect(graph.state.nextHop!.hasNextService, isFalse);
      expect(graph.state.nextHop!.message, 'Journey complete');
      expect(graph.state.canTransition, isFalse);
    });

    test('an already-confirmed hop is not offered twice', () async {
      api.nextServices = nextServicePayload(
        hasNextService: false,
        canTransition: false,
        alreadyTransitioned: true,
        message: 'Next service already confirmed',
      );

      final graph = build();
      await graph.track(completedToken());

      expect(graph.state.nextHop!.alreadyTransitioned, isTrue);
      expect(graph.state.nextHop!.hasNextService, isFalse);
      expect(graph.state.canTransition, isFalse);
    });

    test('a null response is reported as unavailable, never as a hop', () {
      final hop = NextHopState.fromJson(null);
      expect(hop.tokenStatus, 'UNKNOWN');
      expect(hop.hasNextService, isFalse);
      expect(hop.canTransition, isFalse);
      expect(hop.message, 'Next service data is unavailable.');
    });

    test('candidates with no resolvable service id are dropped', () async {
      api.nextServices = nextServicePayload(nextServices: [
        candidate(),
        {'name': 'Orphan relationship', 'serviceId': null},
      ]);

      final graph = build();
      await graph.track(completedToken());

      expect(graph.state.nextHop!.nextServices, hasLength(1));
      expect(graph.state.nextHop!.nextServices.first.serviceId, kNextServiceId);
    });
  });

  group('Service Graph — journey lineage', () {
    test('journey token codes are rendered from the backend list', () async {
      api.nextServices = nextServicePayload(nextServices: [candidate()]);
      api.journey = {
        'tokens': [
          {'_id': kTokenId, 'tokenCode': 'A-014', 'status': 'COMPLETED'},
          {'_id': kHopTokenId, 'tokenCode': 'P-002', 'status': 'WAITING'},
        ],
      };

      final graph = build();
      await graph.track(completedToken());

      expect(graph.state.journey, ['A-014', 'P-002']);
    });

    test('a failing journey endpoint does not break the next-hop verdict', () async {
      api.nextServices = nextServicePayload(nextServices: [candidate()]);
      // Offline-free failure: getJourney returns {} in the double.
      api.journey = const {'tokens': <dynamic>[]};

      final graph = build();
      await graph.track(completedToken());

      expect(graph.state.journey, isEmpty);
      expect(graph.state.canTransition, isTrue);
    });
  });

  group('Service Graph — hop confirmation goes through the backend', () {
    test('confirming a hop returns the token the backend created', () async {
      api.nextServices = nextServicePayload(nextServices: [candidate()]);

      final graph = build();
      await graph.track(completedToken());

      final created = await graph.confirmNextHop(
        tokenId: kTokenId,
        nextServiceId: kNextServiceId,
      );

      expect(api.graphConfirmCalls, 1);
      expect(created.id, kHopTokenId);
      expect(created.serviceId, kNextServiceId);
      expect(created.status, 'WAITING');
    });

    test('a hop cannot be confirmed when the backend offers none', () async {
      api.nextServices = nextServicePayload(
        hasNextService: false,
        canTransition: false,
        message: 'Current service is still in progress',
      );

      final graph = build();
      await graph.track(TokenModel.fromJson(tokenJson(status: 'SERVING')));

      await expectLater(
        graph.confirmNextHop(tokenId: kTokenId, nextServiceId: kNextServiceId),
        throwsA(isA<ApiException>()),
      );
      // No request is sent, so no token is ever fabricated locally.
      expect(api.graphConfirmCalls, 0);
      expect(api.confirmedHopToken, isNull);
    });

    test('a stale verdict blocks the hop even when it said yes earlier', () async {
      api.nextServices = nextServicePayload(nextServices: [candidate()]);

      final graph = build();
      await graph.track(completedToken());
      expect(graph.state.canTransition, isTrue);

      network.markUnreachable();
      await graph.refresh(kTokenId, silent: true);
      expect(graph.state.isStale, isTrue);
      expect(graph.state.canTransition, isFalse);

      await expectLater(
        graph.confirmNextHop(tokenId: kTokenId, nextServiceId: kNextServiceId),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'This action requires an internet connection.',
          ),
        ),
      );
      expect(api.graphConfirmCalls, 0);
    });

    test('confirming while offline is refused before any request', () async {
      api.nextServices = nextServicePayload(nextServices: [candidate()]);
      final graph = build();
      await graph.track(completedToken());

      network.markUnreachable();
      await expectLater(
        graph.confirmNextHop(tokenId: kTokenId, nextServiceId: kNextServiceId),
        throwsA(
          isA<ApiException>().having(
            (e) => e.code,
            'code',
            'OFFLINE',
          ),
        ),
      );
      expect(api.graphConfirmCalls, 0);
    });
  });

  group('Service Graph — realtime re-validation', () {
    test('a terminal token event for this customer re-checks the graph', () async {
      api.nextServices = nextServicePayload(
        hasNextService: false,
        canTransition: false,
        message: 'Current service is still in progress',
      );

      final graph = build();
      await graph.track(TokenModel.fromJson(tokenJson(status: 'SERVING')));
      final callsBefore = api.nextServiceCalls;

      // The token is completed server-side; the graph must be re-evaluated.
      api.nextServices = nextServicePayload(nextServices: [candidate()]);
      socket.handleEventForTesting('token.completed', {
        'token': tokenJson(status: 'COMPLETED', currentPosition: null, servingToken: null),
      });
      await pumpEventQueue();

      expect(api.nextServiceCalls, greaterThan(callsBefore));
      expect(graph.state.nextHop!.hasNextService, isTrue);
      expect(graph.state.canTransition, isTrue);
    });

    test('a terminal event for a different token is ignored', () async {
      api.nextServices = nextServicePayload(nextServices: [candidate()]);

      final graph = build();
      await graph.track(completedToken());
      final callsBefore = api.nextServiceCalls;

      socket.handleEventForTesting('token.completed', {
        'token': tokenJson(
          id: kHopTokenId,
          status: 'COMPLETED',
          currentPosition: null,
          servingToken: null,
        ),
      });
      await pumpEventQueue();

      expect(api.nextServiceCalls, callsBefore);
    });

    test('a reconnect re-evaluates the graph', () async {
      api.nextServices = nextServicePayload(
        hasNextService: false,
        canTransition: false,
        message: 'Journey complete',
      );

      final graph = build();
      await graph.track(completedToken());
      final callsBefore = api.nextServiceCalls;

      api.nextServices = nextServicePayload(nextServices: [candidate()]);
      socket.handleConnectForTesting();
      await pumpEventQueue();

      expect(api.nextServiceCalls, greaterThan(callsBefore));
      expect(graph.state.canTransition, isTrue);
    });
  });

  group('Service Graph — unreachable backend', () {
    test('an unreachable backend never invents a hop', () async {
      network.markUnreachable();
      final graph = build();

      await graph.track(completedToken());

      expect(graph.state.hasData, isFalse);
      expect(graph.state.nextHop, isNull);
      expect(graph.state.canTransition, isFalse);
      expect(graph.state.isStale, isTrue);
      expect(api.nextServiceCalls, 0);
    });

    test('clear() wipes the tracked graph', () async {
      api.nextServices = nextServicePayload(nextServices: [candidate()]);
      final graph = build();
      await graph.track(completedToken());

      graph.clear();

      expect(graph.state.nextHop, isNull);
      expect(graph.state.hasData, isFalse);
      expect(graph.state.canTransition, isFalse);
    });

    test('switching tokens resets the previous token graph', () async {
      api.nextServices = nextServicePayload(nextServices: [candidate()]);
      final graph = build();
      await graph.track(completedToken());
      expect(graph.state.canTransition, isTrue);

      // A different token: state must not be carried over.
      api.nextServices = nextServicePayload(
        hasNextService: false,
        canTransition: false,
        message: 'Current service is still in progress',
        status: 'WAITING',
      );
      await graph.track(TokenModel.fromJson(tokenJson(id: kHopTokenId, status: 'WAITING')));

      expect(graph.state.nextHop!.tokenStatus, 'WAITING');
      expect(graph.state.canTransition, isFalse);
    });
  });
}

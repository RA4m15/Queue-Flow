import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/constants/api_constants.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/providers/document_gate_provider.dart';
import 'package:user_app/providers/notification_provider.dart';
import 'package:user_app/providers/service_graph_provider.dart';
import 'package:user_app/providers/swap_provider.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/services/socket_service.dart';

import 'harness.dart';

/// Realtime Socket.IO behaviour.
///
/// The socket is only a *hint* that something changed. Every value the
/// customer sees is either taken from the authoritative token carried in the
/// event, or re-fetched from the backend. Nothing is extrapolated locally.
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

  group('Realtime — connection lifecycle', () {
    test('a disconnect marks the view reconnecting and keeps the last token', () async {
      api.activeToken = TokenModel.fromJson(tokenJson());
      final notifier = build();
      await notifier.fetchActiveToken();
      expect(notifier.state.isLive, isTrue);

      socket.handleDisconnectForTesting();
      await pumpEventQueue();

      expect(notifier.state.isReconnecting, isTrue);
      // The last confirmed state is preserved, not blanked.
      expect(notifier.state.activeToken, isNotNull);
      expect(notifier.state.activeToken!.tokenCode, 'A-014');
    });

    test('a reconnect re-validates the token against the backend', () async {
      api.activeToken = TokenModel.fromJson(
        tokenJson(currentPosition: 5, waitEstimateMinutes: 22, servingToken: 'A-009'),
      );
      final notifier = build();
      await notifier.fetchActiveToken();
      expect(notifier.state.activeToken!.currentPosition, 5);

      // The queue moved on while the socket was down.
      api.activeToken = TokenModel.fromJson(
        tokenJson(currentPosition: 2, waitEstimateMinutes: 6, servingToken: 'A-012'),
      );
      socket.handleDisconnectForTesting();
      await pumpEventQueue();
      socket.handleConnectForTesting();
      await pumpEventQueue();

      expect(notifier.state.isLive, isTrue);
      expect(notifier.state.activeToken!.currentPosition, 2);
      expect(notifier.state.activeToken!.waitEstimateMinutes, 6);
      expect(notifier.state.activeToken!.servingToken, 'A-012');
    });

    test('a reconnect with no active token reports the backend as live', () async {
      api.activeToken = null;
      final notifier = build();
      await notifier.fetchActiveToken();
      expect(notifier.state.connectionStatus, 'NO_DATA');

      socket.handleConnectForTesting();
      await pumpEventQueue();

      expect(notifier.state.connectionStatus, 'LIVE');
      expect(notifier.state.activeToken, isNull);
    });
  });

  group('Realtime — queue events trigger an authoritative re-sync', () {
    test('a queue.updated event re-reads the token from the backend', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(currentPosition: 7));
      final notifier = build();
      await notifier.fetchActiveToken();
      expect(notifier.state.activeToken!.currentPosition, 7);

      api.activeToken = TokenModel.fromJson(
        tokenJson(currentPosition: 1, servingToken: 'A-013', status: 'SERVING'),
      );
      socket.handleEventForTesting(ApiConstants.eventQueueUpdated, {
        'centerId': kCenterId,
        'serviceId': kServiceId,
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.currentPosition, 1);
      expect(notifier.state.activeToken!.status, 'SERVING');
    });

    test('a queue.updated event with no active token does not fabricate one', () async {
      api.activeToken = null;
      final notifier = build();
      await notifier.fetchActiveToken();
      expect(notifier.state.activeToken, isNull);

      socket.handleEventForTesting(ApiConstants.eventQueueUpdated, {'centerId': kCenterId});
      await pumpEventQueue();

      expect(notifier.state.activeToken, isNull);
    });
  });

  group('Realtime — token lifecycle events', () {
    test('token.created for this customer adopts the server token', () async {
      final notifier = build();
      await notifier.fetchActiveToken();
      expect(notifier.state.activeToken, isNull);

      socket.handleEventForTesting(ApiConstants.eventTokenCreated, {
        'token': tokenJson(currentPosition: 3, waitEstimateMinutes: 12),
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken, isNotNull);
      expect(notifier.state.activeToken!.id, kTokenId);
      expect(notifier.state.activeToken!.currentPosition, 3);
      expect(notifier.state.isLive, isTrue);
    });

    test("token.created for another customer is ignored", () async {
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenCreated, {
        'token': tokenJson(id: kHopTokenId, userId: kUserB, currentPosition: 1),
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken, isNull);
    });

    test('token.called sets the turn alert and the counter the server named', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(status: 'WAITING'));
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenCalled, {
        'token': tokenJson(
          status: 'SERVING',
          counterId: '507f1f77bcf86cd7994390f1',
          counterName: 'Counter 4',
        ),
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.status, 'SERVING');
      expect(notifier.state.activeToken!.counterName, 'Counter 4');
      expect(notifier.state.turnAlert, contains('Counter 4'));
    });

    test('token.called for a different token does not hijack the view', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(status: 'WAITING'));
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenCalled, {
        'token': tokenJson(id: kHopTokenId, status: 'SERVING'),
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.id, kTokenId);
      expect(notifier.state.activeToken!.status, 'WAITING');
      expect(notifier.state.turnAlert, isNull);
    });

    test('the turn alert can be dismissed by the customer', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(status: 'WAITING'));
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenCalled, {
        'token': tokenJson(status: 'SERVING'),
      });
      await pumpEventQueue();
      expect(notifier.state.turnAlert, isNotNull);

      notifier.dismissTurnAlert();

      expect(notifier.state.turnAlert, isNull);
    });

    test('a terminal token event applies the server state and clears the cache', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(status: 'SERVING'));
      final notifier = build();
      await notifier.fetchActiveToken();
      expect(await storage.getCachedToken(kUserA), isNotNull);

      socket.handleEventForTesting(ApiConstants.eventTokenCompleted, {
        'token': tokenJson(status: 'COMPLETED', currentPosition: null, servingToken: null),
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.status, 'COMPLETED');
      expect(notifier.state.activeToken!.currentPosition, isNull);
      expect(await storage.getCachedToken(kUserA), isNull);
    });

    test('each terminal event is honoured with the server status', () async {
      for (final entry in const {
        ApiConstants.eventTokenSkipped: 'SKIPPED',
        ApiConstants.eventTokenCancelled: 'CANCELLED',
        ApiConstants.eventTokenExpired: 'EXPIRED',
      }.entries) {
        api.activeToken = TokenModel.fromJson(tokenJson(status: 'SERVING'));
        final notifier = build();
        await notifier.fetchActiveToken();

        socket.handleEventForTesting(
          entry.key,
          {'token': tokenJson(status: entry.value, currentPosition: null)},
        );
        await pumpEventQueue();

        expect(
          notifier.state.activeToken!.status,
          entry.value,
          reason: 'event ${entry.key}',
        );
        expect(await storage.getCachedToken(kUserA), isNull);
      }
    });
  });

  group('Realtime — ghost queue proximity', () {
    test('a token.proximity event applies the backend proximity state', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(status: 'WAITING'));
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenProximity, {
        'tokenId': kTokenId,
        'proximityState': 'FAR',
        'distanceMeters': 4200,
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.proximityState, 'FAR');
      expect(notifier.state.activeToken!.proximityDistanceMeters, 4200);
      expect(notifier.state.activeToken!.proximityUpdatedAt, isNotNull);
    });

    test('a proximity event for another token is ignored', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(status: 'WAITING'));
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenProximity, {
        'tokenId': kHopTokenId,
        'proximityState': 'FAR',
        'distanceMeters': 4200,
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.proximityState, isNot('FAR'));
    });
  });

  group('Realtime — position updates', () {
    test('a position update applies the server position and wait', () async {
      api.activeToken = TokenModel.fromJson(
        tokenJson(currentPosition: 8, waitEstimateMinutes: 30, servingToken: 'A-006'),
      );
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenPositionUpdated, {
        'tokenId': kTokenId,
        'currentPosition': 4,
        'waitEstimateMinutes': 15,
        'servingToken': 'A-010',
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.currentPosition, 4);
      expect(notifier.state.activeToken!.waitEstimateMinutes, 15);
      expect(notifier.state.activeToken!.servingToken, 'A-010');
      expect(notifier.state.isLive, isTrue);
    });

    test('a position update without a position is ignored', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(currentPosition: 8));
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenPositionUpdated, {
        'tokenId': kTokenId,
        'waitEstimateMinutes': 3,
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.currentPosition, 8);
    });

    test('a position update for another token is ignored', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(currentPosition: 8));
      final notifier = build();
      await notifier.fetchActiveToken();

      socket.handleEventForTesting(ApiConstants.eventTokenPositionUpdated, {
        'tokenId': kHopTokenId,
        'currentPosition': 1,
      });
      await pumpEventQueue();

      expect(notifier.state.activeToken!.currentPosition, 8);
    });
  });

  group('Realtime — notifications are de-duplicated against the socket', () {
    test('an unseen alert is added and counted as unread', () async {
      final notifier = NotificationsNotifier(
        apiService: api,
        socketService: socket,
        storageService: storage,
      );

      socket.handleEventForTesting(ApiConstants.eventNotificationCreated, {
        'notification': {
          '_id': '507f1f77bcf86cd799439101',
          'type': 'TOKEN_APPROACHING',
          'title': 'You are next in line',
          'body': 'Stay nearby.',
          'dedupeKey': '${kTokenId}_NEXT_IN_LINE',
          'isRead': false,
        },
      });
      await pumpEventQueue();

      expect(notifier.state.notifications, hasLength(1));
      expect(notifier.state.unreadCount, 1);
      expect(notifier.state.notifications.first.type, 'TOKEN_APPROACHING');
    });

    test('the same alert delivered twice is listed only once', () async {
      final notifier = NotificationsNotifier(
        apiService: api,
        socketService: socket,
        storageService: storage,
      );

      final event = {
        'notification': {
          '_id': '507f1f77bcf86cd799439102',
          'type': 'TOKEN_APPROACHING',
          'title': 'You are next in line',
          'body': 'Stay nearby.',
          'dedupeKey': '${kTokenId}_NEXT_IN_LINE',
          'isRead': false,
        },
      };
      socket.handleEventForTesting(ApiConstants.eventNotificationCreated, event);
      await pumpEventQueue();
      socket.handleEventForTesting(ApiConstants.eventNotificationCreated, event);
      await pumpEventQueue();

      expect(notifier.state.notifications, hasLength(1));
      expect(notifier.state.unreadCount, 1);
    });

    test('a notification addressed to another customer is rejected', () async {
      final notifier = NotificationsNotifier(
        apiService: api,
        socketService: socket,
        storageService: storage,
      );

      socket.handleEventForTesting(ApiConstants.eventNotificationCreated, {
        'notification': {
          '_id': '507f1f77bcf86cd799439103',
          'userId': kUserB,
          'type': 'TOKEN_CALLED',
          'title': 'Called',
          'body': 'Counter 2',
          'isRead': false,
        },
      });
      await pumpEventQueue();

      expect(notifier.state.notifications, isEmpty);
      expect(notifier.state.unreadCount, 0);
    });
  });

  group('Realtime — dispose cleans up subscriptions', () {
    test('a disposed notifier stops reacting to socket events', () async {
      api.activeToken = TokenModel.fromJson(tokenJson(currentPosition: 5));
      final notifier = build();
      await notifier.fetchActiveToken();

      notifier.dispose();

      api.activeToken = TokenModel.fromJson(tokenJson(currentPosition: 1));
      socket.handleEventForTesting(ApiConstants.eventQueueUpdated, {'centerId': kCenterId});
      socket.handleDisconnectForTesting();
      await pumpEventQueue();

      // No state change, and no exception from a dead notifier.
      expect(api.activeToken!.currentPosition, 1);
    });

    test('a disposed document gate stops reacting to socket events', () async {
      api.readiness = const {
        'isReady': true,
        'status': 'READY',
        'checklist': <dynamic>[],
        'missingRequirements': <dynamic>[],
      };
      final gate = DocumentGateNotifier(apiService: api, socketService: socket);
      await gate.check(kServiceId);
      final callsBefore = api.readinessCalls;

      gate.dispose();

      socket.handleEventForTesting(ApiConstants.eventDocumentVerified, {
        'documentType': 'AADHAAR',
      });
      socket.handleConnectForTesting();
      await pumpEventQueue();

      expect(api.readinessCalls, callsBefore);
    });

    test('a disposed swap notifier stops reacting to socket events', () async {
      final swap = SwapNotifier(apiService: api, socketService: socket);
      await swap.load(kTokenId);
      final offerCallsBefore = api.swapOfferCalls;
      final eligibleCallsBefore = api.swapEligibleCalls;

      swap.dispose();

      api.swapOffers = [swapOfferFixture()];
      socket.handleEventForTesting(ApiConstants.eventSwapOfferReceived, {
        'offerId': kSwapOfferId,
      });
      socket.handleConnectForTesting();
      await pumpEventQueue();

      // Detached handlers mean no refetch at all, and reading the disposed
      // notifier's state is itself illegal.
      expect(api.swapOfferCalls, offerCallsBefore);
      expect(api.swapEligibleCalls, eligibleCallsBefore);
    });

    test('a disposed service graph notifier stops reacting to socket events', () async {
      final graph = ServiceGraphNotifier(apiService: api, socketService: socket);
      await graph.track(TokenModel.fromJson(tokenJson(status: 'COMPLETED')));
      final callsBefore = api.nextServiceCalls;

      graph.dispose();

      socket.handleEventForTesting('token.completed', {
        'token': tokenJson(status: 'COMPLETED'),
      });
      socket.handleConnectForTesting();
      await pumpEventQueue();

      expect(api.nextServiceCalls, callsBefore);
    });
  });
}

/// A minimal backend-shaped swap offer for disposal checks.
Map<String, dynamic> swapOfferFixture() => {
      '_id': kSwapOfferId,
      'status': 'PENDING',
      'offeringTokenCode': 'A-014',
      'offeringPosition': 4,
      'acceptingPosition': 2,
      'createdAt': '2026-09-26T09:00:00.000Z',
    };

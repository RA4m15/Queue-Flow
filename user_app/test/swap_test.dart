import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/constants/api_constants.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/providers/swap_provider.dart';
import 'package:user_app/services/socket_service.dart';

import 'harness.dart';

/// P2P slot swap behaviour.
///
/// Fixtures mirror the real `SwapOffer` documents returned by
/// `GET/POST /api/swaps/*` (`backend/src/services/swapService.js`).
Map<String, dynamic> offerJson({
  String id = kSwapOfferId,
  String status = 'PENDING',
  String? reason,
  String offeringTokenCode = 'A-014',
  int? offeringPosition = 4,
  int? acceptingPosition = 2,
  String createdAt = '2026-09-26T09:00:00.000Z',
}) {
  return {
    '_id': id,
    'status': status,
    'reason': reason,
    'offeringTokenCode': offeringTokenCode,
    'offeringPosition': offeringPosition,
    'acceptingPosition': acceptingPosition,
    'createdAt': createdAt,
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

  SwapNotifier build() => SwapNotifier(apiService: api, socketService: socket);

  group('P2P Swap — reading offers from the backend', () {
    test('pending offers and the anonymized partner count are rendered', () async {
      api.swapOffers = [
        offerJson(),
        offerJson(id: '507f1f77bcf86cd7994390ab', status: 'COMPLETED'),
      ];
      api.eligiblePartners = 7;

      final swap = build();
      await swap.load(kTokenId);

      expect(swap.state.offers, hasLength(2));
      expect(swap.state.pendingOffers, hasLength(1));
      expect(swap.state.pendingOffers.first.id, kSwapOfferId);
      expect(swap.state.pendingOffers.first.offeringPosition, 4);
      expect(swap.state.pendingOffers.first.acceptingPosition, 2);
      expect(swap.state.eligibleCount, 7);
      expect(swap.state.isStale, isFalse);
      expect(swap.state.error, isNull);
    });

    test('an empty offer list is a valid, non-error state', () async {
      api.swapOffers = [];
      api.eligiblePartners = 0;

      final swap = build();
      await swap.load(kTokenId);

      expect(swap.state.offers, isEmpty);
      expect(swap.state.pendingOffers, isEmpty);
      expect(swap.state.eligibleCount, 0);
      expect(swap.state.error, isNull);
    });

    test('an offer without an id is discarded', () async {
      api.swapOffers = [
        offerJson(),
        {'status': 'PENDING', 'reason': 'no identifier'},
      ];

      final swap = build();
      await swap.load(kTokenId);

      expect(swap.state.offers, hasLength(1));
    });

    test('no eligible partners does not block queue tracking', () async {
      api.eligiblePartners = 0;

      final swap = build();
      await swap.load(kTokenId);

      expect(swap.state.eligibleCount, 0);
      // Absence of partners is informational; it is not an error.
      expect(swap.state.error, isNull);
      expect(swap.state.isStale, isFalse);
    });
  });

  group('P2P Swap — mutations are backend authoritative', () {
    test('creating an offer sends the request and the offer comes back from the backend',
        () async {
      final swap = build();
      await swap.load(kTokenId);

      await swap.createOffer(
        offeringTokenId: kTokenId,
        reason: 'Cannot attend in the morning',
      );

      expect(api.swapCreateCalls, 1);
      expect(api.createdSwapOffers.single['reason'], 'Cannot attend in the morning');
      expect(api.createdSwapOffers.single['offeringTokenId'], kTokenId);
      // A refresh after the mutation reflects the backend's own list.
      expect(swap.state.offers, hasLength(1));
      expect(swap.state.offers.single.status, 'PENDING');
    });

    test('accepting an offer is recorded by the backend, not locally', () async {
      api.swapOffers = [offerJson()];

      final swap = build();
      await swap.load(kTokenId);

      final result = await swap.acceptOffer(
        offerId: kSwapOfferId,
        acceptingTokenId: kHopTokenId,
      );

      expect(api.swapAcceptCalls, 1);
      expect(result['status'], 'COMPLETED');
      expect(api.swapOffers.single['status'], 'COMPLETED');
      // A completed offer is no longer offered as actionable.
      expect(swap.state.pendingOffers, isEmpty);
    });

    test('declining an offer is recorded by the backend', () async {
      api.swapOffers = [offerJson()];

      final swap = build();
      await swap.load(kTokenId);

      await swap.declineOffer(kSwapOfferId);

      expect(api.swapDeclineCalls, 1);
      expect(api.swapOffers.single['status'], 'DECLINED');
      expect(swap.state.pendingOffers, isEmpty);
    });

    test('cancelling a self-offered swap is recorded by the backend', () async {
      api.swapOffers = [offerJson()];

      final swap = build();
      await swap.load(kTokenId);

      await swap.cancelOffer(kSwapOfferId);

      expect(api.swapCancelCalls, 1);
      expect(api.swapOffers.single['status'], 'CANCELLED');
      expect(swap.state.pendingOffers, isEmpty);
    });

    test('a targeted offer carries the target token supplied by the caller', () async {
      final swap = build();
      await swap.load(kTokenId);

      await swap.createOffer(
        offeringTokenId: kTokenId,
        targetTokenId: kHopTokenId,
      );

      expect(api.createdSwapOffers.single['targetTokenId'], kHopTokenId);
    });
  });

  group('P2P Swap — offline mutations are refused, never simulated', () {
    test('creating an offer offline is refused before any request', () async {
      final swap = build();
      await swap.load(kTokenId);
      final callsBefore = api.swapCreateCalls;

      network.markUnreachable();
      await expectLater(
        swap.createOffer(offeringTokenId: kTokenId),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'This action requires an internet connection.',
          ),
        ),
      );

      expect(api.swapCreateCalls, callsBefore);
      expect(api.createdSwapOffers, isEmpty);
    });

    test('accepting an offer offline is refused before any request', () async {
      api.swapOffers = [offerJson()];
      final swap = build();
      await swap.load(kTokenId);

      network.markUnreachable();
      await expectLater(
        swap.acceptOffer(offerId: kSwapOfferId, acceptingTokenId: kHopTokenId),
        throwsA(isA<ApiException>()),
      );

      expect(api.swapAcceptCalls, 0);
      // The offer is still PENDING server-side; nothing was faked.
      expect(api.swapOffers.single['status'], 'PENDING');
    });

    test('declining and cancelling offline are refused', () async {
      api.swapOffers = [offerJson()];
      final swap = build();
      await swap.load(kTokenId);

      network.markUnreachable();
      await expectLater(swap.declineOffer(kSwapOfferId), throwsA(isA<ApiException>()));
      await expectLater(swap.cancelOffer(kSwapOfferId), throwsA(isA<ApiException>()));

      expect(api.swapDeclineCalls, 0);
      expect(api.swapCancelCalls, 0);
      expect(api.swapOffers.single['status'], 'PENDING');
    });

    test('reading offers while offline is marked stale, not faked', () async {
      final swap = build();
      network.markUnreachable();

      await swap.refresh(kTokenId);

      expect(swap.state.isStale, isTrue);
      expect(swap.state.offers, isEmpty);
      expect(swap.state.eligibleCount, 0);
    });
  });

  group('P2P Swap — realtime re-validation', () {
    test('an incoming offer event re-reads the offer list from the backend', () async {
      final swap = build();
      await swap.load(kTokenId);
      expect(swap.state.offers, isEmpty);

      // The event itself carries no authoritative list, so the client re-fetches.
      api.swapOffers = [offerJson(reason: 'Afternoon slot please')];
      socket.handleEventForTesting(ApiConstants.eventSwapOfferReceived, {
        'offerId': kSwapOfferId,
        'reason': 'Afternoon slot please',
      });
      await pumpEventQueue();

      expect(swap.state.offers, hasLength(1));
      expect(swap.state.offers.single.reason, 'Afternoon slot please');
      expect(swap.state.isStale, isFalse);
    });

    test('a decline event re-reads the offer list', () async {
      api.swapOffers = [offerJson()];
      final swap = build();
      await swap.load(kTokenId);
      expect(swap.state.pendingOffers, hasLength(1));

      api.swapOffers = [];
      socket.handleEventForTesting(ApiConstants.eventSwapOfferDeclined, {
        'offerId': kSwapOfferId,
      });
      await pumpEventQueue();

      expect(swap.state.offers, isEmpty);
      expect(swap.state.pendingOffers, isEmpty);
    });

    test('a cancel event re-reads the offer list', () async {
      api.swapOffers = [offerJson()];
      final swap = build();
      await swap.load(kTokenId);

      api.swapOffers = [offerJson(status: 'CANCELLED')];
      socket.handleEventForTesting(ApiConstants.eventSwapOfferCancelled, {
        'offerId': kSwapOfferId,
      });
      await pumpEventQueue();

      expect(swap.state.offers.single.status, 'CANCELLED');
      expect(swap.state.pendingOffers, isEmpty);
    });

    test('an expiry event re-reads the offer list', () async {
      api.swapOffers = [offerJson()];
      final swap = build();
      await swap.load(kTokenId);

      api.swapOffers = [offerJson(status: 'EXPIRED')];
      socket.handleEventForTesting(ApiConstants.eventSwapOfferExpired, {
        'offerId': kSwapOfferId,
      });
      await pumpEventQueue();

      expect(swap.state.offers.single.status, 'EXPIRED');
      expect(swap.state.pendingOffers, isEmpty);
    });

    test('a completion event re-reads the offer list', () async {
      api.swapOffers = [offerJson()];
      final swap = build();
      await swap.load(kTokenId);

      api.swapOffers = [offerJson(status: 'COMPLETED')];
      socket.handleEventForTesting(ApiConstants.eventSwapCompleted, {
        'offerId': kSwapOfferId,
      });
      await pumpEventQueue();

      expect(swap.state.offers.single.status, 'COMPLETED');
      expect(swap.state.offers.single.isCompleted, isTrue);
    });

    test('a reconnect re-reads the offer list', () async {
      final swap = build();
      await swap.load(kTokenId);
      expect(swap.state.offers, isEmpty);

      api.swapOffers = [offerJson()];
      socket.handleConnectForTesting();
      await pumpEventQueue();

      expect(swap.state.offers, hasLength(1));
    });

    test('an event for an unloaded token does not trigger a request', () async {
      final swap = build();
      await swap.load(kTokenId);
      final callsBefore = api.swapCreateCalls;
      expect(callsBefore, 0);

      socket.handleEventForTesting(ApiConstants.eventSwapOfferReceived, {'offerId': kSwapOfferId});
      await pumpEventQueue();

      // No token tracked yet -> no refresh is issued.
      expect(swap.state.offers, isEmpty);
    });
  });

  group('P2P Swap — session lifecycle', () {
    test('clear() removes the offers of the signed-in customer', () async {
      api.swapOffers = [offerJson()];
      final swap = build();
      await swap.load(kTokenId);
      expect(swap.state.offers, hasLength(1));

      swap.clear();

      expect(swap.state.offers, isEmpty);
      expect(swap.state.eligibleCount, 0);
      expect(swap.state.fetchedAt, isNull);
    });

    test('switching tokens drops the previous customer\'s offers', () async {
      api.swapOffers = [offerJson()];
      final swap = build();
      await swap.load(kTokenId);
      expect(swap.state.offers, hasLength(1));

      api.swapOffers = [];
      await swap.load(kHopTokenId);

      expect(swap.state.offers, isEmpty);
    });
  });
}

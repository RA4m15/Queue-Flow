import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/network/api_exception.dart';
import '../core/constants/api_constants.dart';
import '../services/api_service.dart';
import '../services/socket_service.dart';
import 'app_providers.dart';

class SwapOffer {
  const SwapOffer({
    required this.id,
    this.status = 'PENDING',
    this.reason,
    this.createdAt,
    this.offeringPosition,
    this.acceptingPosition,
    this.offeringTokenCode,
  });

  final String id;
  final String status;
  final String? reason;
  final DateTime? createdAt;
  final int? offeringPosition;
  final int? acceptingPosition;
  final String? offeringTokenCode;

  bool get isPending => status.toUpperCase() == 'PENDING';
  bool get isCompleted => status.toUpperCase() == 'COMPLETED';

  factory SwapOffer.fromJson(Map<String, dynamic> json) {
    return SwapOffer(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      status: (json['status'] ?? 'PENDING').toString(),
      reason: json['reason']?.toString(),
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'].toString())
          : null,
      offeringPosition: (json['offeringPosition'] as num?)?.toInt(),
      acceptingPosition: (json['acceptingPosition'] as num?)?.toInt(),
      offeringTokenCode: json['offeringTokenCode']?.toString(),
    );
  }
}

class SwapState {
  const SwapState({
    this.offers = const [],
    this.eligibleCount = 0,
    this.isLoading = false,
    this.error,
    this.fetchedAt,
    this.isStale = false,
  });

  final List<SwapOffer> offers;

  /// Anonymized count of eligible partners, as reported by the backend.
  final int eligibleCount;

  final bool isLoading;
  final String? error;
  final DateTime? fetchedAt;
  final bool isStale;

  List<SwapOffer> get pendingOffers => offers.where((o) => o.isPending).toList();

  SwapState copyWith({
    List<SwapOffer>? offers,
    int? eligibleCount,
    bool? isLoading,
    String? error,
    bool clearError = false,
    DateTime? fetchedAt,
    bool? isStale,
  }) {
    return SwapState(
      offers: offers ?? this.offers,
      eligibleCount: eligibleCount ?? this.eligibleCount,
      isLoading: isLoading ?? this.isLoading,
      error: clearError ? null : (error ?? this.error),
      fetchedAt: fetchedAt ?? this.fetchedAt,
      isStale: isStale ?? this.isStale,
    );
  }
}

/// P2P slot swapping against the existing backend swap API.
///
/// Offline the customer cannot create, accept, decline or cancel an offer, and
/// no swap is ever simulated. After a successful swap the caller revalidates
/// authoritative token state — token identity is never changed locally.
class SwapNotifier extends StateNotifier<SwapState> {
  SwapNotifier({
    required this.apiService,
    required this.socketService,
  }) : super(const SwapState()) {
    _onConnect = () {
      final tokenId = _activeTokenId;
      if (tokenId != null && tokenId.isNotEmpty) {
        refresh(tokenId, silent: true);
      }
    };
    socketService.addConnectListener(_onConnect!);

    for (final event in const [
      ApiConstants.eventSwapOfferReceived,
      ApiConstants.eventSwapOfferDeclined,
      ApiConstants.eventSwapOfferCancelled,
      ApiConstants.eventSwapOfferExpired,
      ApiConstants.eventSwapCompleted,
    ]) {
      void handler(dynamic _) {
        final tokenId = _activeTokenId;
        if (tokenId != null && tokenId.isNotEmpty) {
          refresh(tokenId, silent: true);
        }
      }

      socketService.on(event, handler);
      _socketHandlers.add((event: event, handler: handler));
    }
  }

  final ApiService apiService;
  final SocketService socketService;

  String? _activeTokenId;

  /// Handlers registered on the shared [SocketService], detached on dispose.
  final List<({String event, dynamic Function(dynamic) handler})> _socketHandlers = [];
  VoidCallback? _onConnect;

  @override
  void dispose() {
    for (final entry in _socketHandlers) {
      socketService.off(entry.event, entry.handler);
    }
    _socketHandlers.clear();
    final onConnect = _onConnect;
    if (onConnect != null) socketService.removeConnectListener(onConnect);
    _onConnect = null;
    super.dispose();
  }

  void _requireOnline() {
    // Truthful refusal — the backend is the only authority on slot ownership.
    apiService.networkStatus.requireOnline();
  }

  Future<void> load(String tokenId) async {
    _activeTokenId = tokenId;
    await refresh(tokenId);
  }

  Future<void> refresh(String tokenId, {bool silent = false}) async {
    _activeTokenId = tokenId;
    if (!silent) {
      state = state.copyWith(isLoading: true, clearError: true);
    }
    try {
      final offersJson = await apiService.getSwapOffers(tokenId);
      final raw = (offersJson['offers'] as List?) ?? const [];
      final offers = raw
          .whereType<Map>()
          .map((e) => SwapOffer.fromJson(Map<String, dynamic>.from(e)))
          .where((o) => o.id.isNotEmpty)
          .toList();

      var eligible = 0;
      try {
        final eligibleJson = await apiService.getSwapEligible(tokenId);
        eligible = (eligibleJson['eligiblePartners'] as num?)?.toInt() ??
            ((eligibleJson['partners'] as List?) ?? const []).length;
      } catch (_) {
        // Eligibility is supplementary information.
      }

      state = state.copyWith(
        offers: offers,
        eligibleCount: eligible,
        isLoading: false,
        clearError: true,
        fetchedAt: DateTime.now(),
        isStale: false,
      );
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        isStale: true,
        error: ApiException.getUserMessage(e),
      );
    }
  }

  /// Create an offer. Refused offline.
  Future<Map<String, dynamic>> createOffer({
    required String offeringTokenId,
    String? targetTokenId,
    String? reason,
  }) async {
    _requireOnline();
    final result = await apiService.createSwapOffer(
      offeringTokenId: offeringTokenId,
      targetTokenId: targetTokenId,
      reason: reason,
    );
    await refresh(offeringTokenId, silent: true);
    return result;
  }

  /// Accept an offer. Refused offline. Token identity comes from the backend.
  Future<Map<String, dynamic>> acceptOffer({
    required String offerId,
    required String acceptingTokenId,
  }) async {
    _requireOnline();
    final result = await apiService.acceptSwapOffer(
      offerId: offerId,
      acceptingTokenId: acceptingTokenId,
    );
    await refresh(acceptingTokenId, silent: true);
    return result;
  }

  Future<void> declineOffer(String offerId) async {
    _requireOnline();
    await apiService.declineSwapOffer(offerId);
    final tokenId = _activeTokenId;
    if (tokenId != null) {
      await refresh(tokenId, silent: true);
    }
  }

  Future<void> cancelOffer(String offerId) async {
    _requireOnline();
    await apiService.cancelSwapOffer(offerId);
    final tokenId = _activeTokenId;
    if (tokenId != null) {
      await refresh(tokenId, silent: true);
    }
  }

  void clear() {
    _activeTokenId = null;
    state = const SwapState();
  }
}

final swapProvider = StateNotifierProvider<SwapNotifier, SwapState>((ref) {
  return SwapNotifier(
    apiService: ref.watch(apiServiceProvider),
    socketService: ref.watch(socketServiceProvider),
  );
});

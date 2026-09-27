import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/network/api_exception.dart';
import '../models/next_hop_state.dart';
import '../models/token.dart';
import '../services/api_service.dart';
import '../services/socket_service.dart';
import 'app_providers.dart';

class ServiceGraphState {
  const ServiceGraphState({
    this.nextHop,
    this.journey = const [],
    this.isLoading = false,
    this.error,
    this.fetchedAt,
    this.isStale = false,
  });

  /// Backend-authoritative next-hop verdict. Null until fetched.
  final NextHopState? nextHop;

  /// Journey lineage (token codes) as returned by the backend.
  final List<String> journey;

  final bool isLoading;
  final String? error;
  final DateTime? fetchedAt;

  /// True when the data on screen is a previously confirmed value that could
  /// not be refreshed (e.g. offline).
  final bool isStale;

  bool get hasData => nextHop != null;

  /// A next hop may only be offered when the backend says so *and* the data
  /// is current.
  bool get canTransition => (nextHop?.canTransition ?? false) && !isStale;

  ServiceGraphState copyWith({
    NextHopState? nextHop,
    bool clearNextHop = false,
    List<String>? journey,
    bool? isLoading,
    String? error,
    bool clearError = false,
    DateTime? fetchedAt,
    bool? isStale,
  }) {
    return ServiceGraphState(
      nextHop: clearNextHop ? null : (nextHop ?? this.nextHop),
      journey: journey ?? this.journey,
      isLoading: isLoading ?? this.isLoading,
      error: clearError ? null : (error ?? this.error),
      fetchedAt: fetchedAt ?? this.fetchedAt,
      isStale: isStale ?? this.isStale,
    );
  }
}

/// Consumes real Service Graph data.
///
/// Graph transitions are never derived in Dart: the next hop shown to the
/// customer is always the one the backend reports for the current token, and
/// it is re-fetched after every reconnect.
class ServiceGraphNotifier extends StateNotifier<ServiceGraphState> {
  ServiceGraphNotifier({
    required this.apiService,
    required this.socketService,
  }) : super(const ServiceGraphState()) {
    _onConnect = () {
      final tokenId = _activeTokenId;
      if (tokenId != null && tokenId.isNotEmpty) {
        refresh(tokenId, silent: true);
      }
    };
    socketService.addConnectListener(_onConnect!);

    // A token reaching a terminal state can open a new graph hop.
    for (final event in const [
      'token.completed',
      'token.skipped',
      'token.cancelled',
      'token.expired',
    ]) {
      void handler(dynamic data) {
        if (data is! Map) return;
        final token = (data['token'] is Map)
            ? TokenModel.fromJson(Map<String, dynamic>.from(data['token'] as Map))
            : null;
        if (token != null && token.id == _activeTokenId) {
          refresh(token.id, silent: true);
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

  /// Fetch the authoritative next hop for [tokenId].
  Future<void> track(TokenModel token) async {
    if (_activeTokenId != token.id) {
      _activeTokenId = token.id;
      state = const ServiceGraphState();
    }
    await refresh(token.id);
  }

  Future<void> refresh(String tokenId, {bool silent = false}) async {
    _activeTokenId = tokenId;
    if (!silent) {
      state = state.copyWith(isLoading: true, clearError: true);
    }

    try {
      final nextHopJson = await apiService.getNextServices(tokenId);
      final nextHop = NextHopState.fromJson(nextHopJson);

      List<String> journey = const [];
      try {
        final journeyJson = await apiService.getJourney(tokenId);
        final tokens = (journeyJson['tokens'] as List?) ?? const [];
        journey = tokens
            .whereType<Map>()
            .map((e) => (e['tokenCode'] ?? '').toString())
            .where((c) => c.isNotEmpty)
            .toList();
      } catch (_) {
        // Journey lineage is supplementary; the next-hop verdict stands alone.
      }

      state = state.copyWith(
        nextHop: nextHop,
        journey: journey,
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

  /// Confirm a hop chosen by the customer.
  ///
  /// Uses the backend graph endpoint only; token identity is never changed
  /// locally. Refused while offline.
  Future<TokenModel> confirmNextHop({
    required String tokenId,
    required String nextServiceId,
  }) async {
    // Guard before any request: a hop must never be applied locally.
    apiService.networkStatus.requireOnline();
    if (!state.canTransition) {
      throw ApiException(
        message: state.isStale
            ? 'This action requires an internet connection.'
            : 'The service center has not opened the next step for this token yet.',
      );
    }
    final updated = await apiService.confirmNextHop(
      tokenId: tokenId,
      nextServiceId: nextServiceId,
    );
    await refresh(tokenId, silent: true);
    return updated;
  }

  void clear() {
    _activeTokenId = null;
    state = const ServiceGraphState();
  }
}

final serviceGraphProvider =
    StateNotifierProvider<ServiceGraphNotifier, ServiceGraphState>((ref) {
  return ServiceGraphNotifier(
    apiService: ref.watch(apiServiceProvider),
    socketService: ref.watch(socketServiceProvider),
  );
});

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/constants/api_constants.dart';
import '../core/network/api_exception.dart';
import '../models/document_readiness.dart';
import '../services/api_service.dart';
import '../services/socket_service.dart';
import 'app_providers.dart';

class DocumentGateState {
  const DocumentGateState({
    this.readiness = DocumentReadiness.unavailable,
    this.isLoading = false,
    this.error,
    this.fetchedAt,
    this.isStale = false,
  });

  /// The backend's authoritative verdict. Defaults to
  /// [DocumentReadiness.unavailable] (isReady == false) so an unknown gate
  /// never permits a join.
  final DocumentReadiness readiness;

  final bool isLoading;
  final String? error;

  /// When this verdict was last received from the backend.
  final DateTime? fetchedAt;

  /// True when the verdict could not be refreshed (e.g. offline) and the
  /// value on screen is a previously confirmed one.
  final bool isStale;

  bool get canJoin => readiness.isReady && !isStale;

  DocumentGateState copyWith({
    DocumentReadiness? readiness,
    bool? isLoading,
    String? error,
    bool clearError = false,
    DateTime? fetchedAt,
    bool? isStale,
  }) {
    return DocumentGateState(
      readiness: readiness ?? this.readiness,
      isLoading: isLoading ?? this.isLoading,
      error: clearError ? null : (error ?? this.error),
      fetchedAt: fetchedAt ?? this.fetchedAt,
      isStale: isStale ?? this.isStale,
    );
  }
}

/// Fetches and caches the server-authoritative document gate for a service.
///
/// Readiness is never computed locally. The backend re-validates the gate on
/// `POST /tokens`, so a stale client verdict can never create a token.
class DocumentGateNotifier extends StateNotifier<DocumentGateState> {
  DocumentGateNotifier({
    required this.apiService,
    required this.socketService,
  }) : super(const DocumentGateState()) {
    _initSocket();
  }

  final ApiService apiService;
  final SocketService socketService;

  String? _activeServiceId;

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

  void _initSocket() {
    // Staff verification / customer upload emits these on the private user
    // room. Re-fetch the authoritative gate rather than patching local state.
    for (final event in const [
      ApiConstants.eventDocumentUpdated,
      ApiConstants.eventDocumentVerified,
      ApiConstants.eventDocumentRejected,
    ]) {
      void handler(dynamic _) {
        final serviceId = _activeServiceId;
        if (serviceId != null && serviceId.isNotEmpty) {
          refresh(serviceId, silent: true);
        }
      }

      socketService.on(event, handler);
      _socketHandlers.add((event: event, handler: handler));
    }

    // After a reconnect the cached verdict may be out of date.
    _onConnect = () {
      final serviceId = _activeServiceId;
      if (serviceId != null && serviceId.isNotEmpty) {
        refresh(serviceId, silent: true);
      }
    };
    socketService.addConnectListener(_onConnect!);
  }

  /// Request the authoritative readiness for [serviceId].
  Future<DocumentReadiness> check(String serviceId) async {
    _activeServiceId = serviceId;
    return refresh(serviceId);
  }

  Future<DocumentReadiness> refresh(String serviceId, {bool silent = false}) async {
    if (!silent) {
      state = state.copyWith(isLoading: true, clearError: true);
    }

    try {
      final json = await apiService.checkServiceDocumentReadiness(serviceId);
      final readiness = DocumentReadiness.fromJson(json);
      state = state.copyWith(
        readiness: readiness,
        isLoading: false,
        clearError: true,
        fetchedAt: DateTime.now(),
        isStale: false,
      );
      return readiness;
    } catch (e) {
      // Offline / failure: keep the last confirmed verdict but mark it stale
      // so the UI cannot present it as current.
      state = state.copyWith(
        isLoading: false,
        isStale: true,
        error: ApiException.getUserMessage(e),
      );
      return state.readiness;
    }
  }

  void clear() {
    _activeServiceId = null;
    state = const DocumentGateState();
  }
}

final documentGateProvider =
    StateNotifierProvider<DocumentGateNotifier, DocumentGateState>((ref) {
  return DocumentGateNotifier(
    apiService: ref.watch(apiServiceProvider),
    socketService: ref.watch(socketServiceProvider),
  );
});

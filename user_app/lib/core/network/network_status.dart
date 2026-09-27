import 'dart:async';
import 'package:dio/dio.dart';
import 'api_exception.dart';

/// Reachability of the QueueFlow backend as observed from real transport
/// outcomes.
///
/// The flag is only ever set from a genuine transport-level failure
/// (connection error / timeout) and is cleared by the first successful
/// response. It is deliberately *not* derived from platform connectivity
/// plugins, so it never claims to be offline while the backend is reachable.
class NetworkStatus {
  NetworkStatus();

  bool _offline = false;
  DateTime? _offlineSince;
  int _consecutiveFailures = 0;

  final StreamController<bool> _controller = StreamController<bool>.broadcast();

  /// Emits `true` when the backend becomes reachable again, `false` when a
  /// transport failure is observed.
  Stream<bool> get onStatusChange => _controller.stream;

  bool get isOffline => _offline;
  bool get isOnline => !_offline;

  /// When the backend was first observed to be unreachable in the current
  /// outage. Used for truthful "last contacted" messaging.
  DateTime? get offlineSince => _offlineSince;

  int get consecutiveFailures => _consecutiveFailures;

  void markReachable() {
    _consecutiveFailures = 0;
    if (!_offline) return;
    _offline = false;
    _offlineSince = null;
    if (!_controller.isClosed) _controller.add(true);
  }

  void markUnreachable() {
    _consecutiveFailures++;
    if (_offline) return;
    _offline = true;
    _offlineSince = DateTime.now();
    if (!_controller.isClosed) _controller.add(false);
  }

  /// Reset for a fresh session (login / logout) so a previous account's
  /// connectivity verdict is never carried over.
  void reset() {
    _consecutiveFailures = 0;
    _offlineSince = null;
    if (_offline) {
      _offline = false;
      if (!_controller.isClosed) _controller.add(true);
    }
  }

  /// Guard for backend-authoritative mutations.
  ///
  /// Throws a truthful error instead of letting the caller proceed, so no
  /// local token/swap/document mutation is ever faked while offline.
  void requireOnline() {
    if (_offline) {
      throw ApiException(
        message: 'This action requires an internet connection.',
        code: 'OFFLINE',
      );
    }
  }

  /// True when a DioException represents a transport-level failure rather
  /// than a server response.
  static bool isTransportFailure(DioException e) {
    switch (e.type) {
      case DioExceptionType.connectionError:
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.transformTimeout:
      case DioExceptionType.unknown:
        return true;
      case DioExceptionType.badCertificate:
      case DioExceptionType.badResponse:
      case DioExceptionType.cancel:
        return false;
    }
  }

  void dispose() {
    if (!_controller.isClosed) _controller.close();
  }
}

import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../core/constants/api_constants.dart';

class SocketService {
  io.Socket? _socket;
  String? _currentUserId;
  String? _currentCenterId;
  String? _currentToken;
  bool _isConnected = false;

  // Managed listener registry to prevent listener leaks and guarantee
  // automatic re-binding when socket reconnects or is re-created
  final Map<String, Set<dynamic Function(dynamic)>> _listeners = {};

  bool get isConnected => _isConnected;
  String? get currentUserId => _currentUserId;

  void connect({required String userId, String? centerId, String? token}) {
    final sanitizedUserId = userId.trim();
    if (sanitizedUserId.isEmpty) return;

    if (token != null && token.trim().isNotEmpty) {
      _currentToken = token.trim();
    }

    if (_socket != null && _socket!.connected) {
      if (_currentUserId != sanitizedUserId ||
          (_currentToken != null && token != null && _currentToken != token.trim())) {
        _socket!.disconnect();
        _socket!.dispose();
        _socket = null;
        _isConnected = false;
      } else {
        if (centerId != null && centerId.trim().isNotEmpty && _currentCenterId != centerId.trim()) {
          joinCenter(centerId.trim());
        }
        return;
      }
    }

    _currentUserId = sanitizedUserId;
    if (centerId != null && centerId.trim().isNotEmpty) {
      _currentCenterId = centerId.trim();
    }

    try {
      final builder = io.OptionBuilder()
          .setTransports(['websocket', 'polling'])
          .disableAutoConnect()
          .enableReconnection()
          .setReconnectionDelay(1000)
          .setReconnectionDelayMax(5000)
          .setReconnectionAttempts(10);

      if (_currentToken != null && _currentToken!.isNotEmpty) {
        builder.setAuth({'token': _currentToken!});
        builder.setExtraHeaders({'Authorization': 'Bearer ${_currentToken!}'});
      }

      _socket = io.io(
        ApiConstants.socketUrl,
        builder.build(),
      );

      _socket!.onConnect((_) {
        _isConnected = true;
        if (kDebugMode) {
          debugPrint('[SocketService] Connected to gateway');
        }

        // Re-attach all registered listeners onto the new socket
        _attachRegisteredListeners();

        if (_currentUserId != null) {
          joinUser(_currentUserId!);
        }
        if (_currentCenterId != null) {
          joinCenter(_currentCenterId!);
        }
      });

      _socket!.onDisconnect((_) {
        _isConnected = false;
        if (kDebugMode) {
          debugPrint('[SocketService] Disconnected from gateway');
        }
      });

      _socket!.onConnectError((_) {
        _isConnected = false;
        if (kDebugMode) {
          debugPrint('[SocketService] Connection error to gateway');
        }
      });

      _socket!.connect();
    } catch (_) {
      if (kDebugMode) {
        debugPrint('[SocketService] Failed to initialize socket connection');
      }
    }
  }

  void _attachRegisteredListeners() {
    if (_socket == null) return;
    for (final entry in _listeners.entries) {
      final event = entry.key;
      for (final handler in entry.value) {
        _socket!.off(event, handler);
        _socket!.on(event, handler);
      }
    }
  }

  void joinUser(String userId) {
    final id = userId.trim();
    if (id.isEmpty) return;
    // Client defense-in-depth: do not join rooms for other users
    if (_currentUserId != null && _currentUserId != id) {
      return;
    }
    _currentUserId = id;
    if (_socket != null && _socket!.connected) {
      _socket!.emit(ApiConstants.roomJoinUser, id);
    }
  }

  void joinCenter(String centerId) {
    final id = centerId.trim();
    if (id.isEmpty) return;
    if (_currentCenterId != null && _currentCenterId != id) {
      leaveCenter(_currentCenterId!);
    }
    _currentCenterId = id;
    if (_socket != null && _socket!.connected) {
      _socket!.emit(ApiConstants.roomJoinCenter, id);
    }
  }

  void leaveCenter(String centerId) {
    final id = centerId.trim();
    if (id.isEmpty) return;
    if (_socket != null && _socket!.connected) {
      _socket!.emit('leave:center', id);
    }
    if (_currentCenterId == id) {
      _currentCenterId = null;
    }
  }

  void on(String event, dynamic Function(dynamic) handler) {
    _listeners.putIfAbsent(event, () => <dynamic Function(dynamic)>{}).add(handler);
    if (_socket != null) {
      _socket!.off(event, handler);
      _socket!.on(event, handler);
    }
  }

  void off(String event, [dynamic Function(dynamic)? handler]) {
    if (handler != null) {
      _listeners[event]?.remove(handler);
      _socket?.off(event, handler);
    } else {
      _listeners.remove(event);
      _socket?.off(event);
    }
  }

  @visibleForTesting
  void handleEventForTesting(String event, dynamic data) {
    final handlers = _listeners[event];
    if (handlers != null) {
      for (final handler in handlers.toList()) {
        handler(data);
      }
    }
  }

  void disconnect({bool clearListeners = false}) {
    if (clearListeners) {
      _listeners.clear();
    }
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
    _isConnected = false;
    _currentUserId = null;
    _currentCenterId = null;
    _currentToken = null;
  }
}

import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../models/token.dart';

class StorageService {
  StorageService([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(
                resetOnError: true,
              ),
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
              webOptions: WebOptions(
                dbName: 'queueflow_storage',
                publicKey: 'queueflow_storage',
              ),
            );

  final FlutterSecureStorage _storage;
  static const Duration _opTimeout = Duration(seconds: 2);

  static const String _keyToken = 'auth_token';
  static const String _keyUserId = 'user_id';
  static const String _keyUserEmail = 'user_email';
  static const String _keyUserName = 'user_name';
  static const String _keyUserRole = 'user_role';

  static const String _keyFcmToken = 'fcm_device_token';
  static const String _keyPrefixCachedToken = 'cached_token_';
  static const String _keyLastToken = 'last_known_token';
  static const Duration maxCacheAge = Duration(hours: 24);

  Future<void> saveAuthToken(String token) async {
    final clean = token.trim();
    if (clean.isNotEmpty) {
      try {
        await _storage.write(key: _keyToken, value: clean).timeout(_opTimeout);
      } catch (_) {}
    }
  }

  Future<String?> getAuthToken() async {
    try {
      final token = await _storage.read(key: _keyToken).timeout(_opTimeout);
      if (token != null && token.trim().isNotEmpty) {
        return token.trim();
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // ─── GENERAL PREFERENCES (THEME, ALERTS, ETC.) ─────────────

  Future<String?> getString(String key) async {
    try {
      return await _storage.read(key: key).timeout(_opTimeout);
    } catch (_) {
      return null;
    }
  }

  Future<void> setString(String key, String value) async {
    try {
      await _storage.write(key: key, value: value).timeout(_opTimeout);
    } catch (_) {}
  }

  Future<bool> getBool(String key, {bool defaultValue = false}) async {
    try {
      final val = await _storage.read(key: key).timeout(_opTimeout);
      if (val == null) return defaultValue;
      return val == 'true';
    } catch (_) {
      return defaultValue;
    }
  }

  Future<void> setBool(String key, bool value) async {
    try {
      await _storage.write(key: key, value: value.toString()).timeout(_opTimeout);
    } catch (_) {}
  }


  Future<void> saveUserData({
    required String id,
    required String name,
    required String email,
    required String role,
  }) async {
    try {
      await Future.wait([
        _storage.write(key: _keyUserId, value: id),
        _storage.write(key: _keyUserName, value: name),
        _storage.write(key: _keyUserEmail, value: email),
        _storage.write(key: _keyUserRole, value: role),
      ]).timeout(_opTimeout);
    } catch (_) {}
  }

  Future<Map<String, String?>> getUserData() async {
    try {
      final results = await Future.wait([
        _storage.read(key: _keyUserId),
        _storage.read(key: _keyUserName),
        _storage.read(key: _keyUserEmail),
        _storage.read(key: _keyUserRole),
      ]).timeout(_opTimeout);

      return {
        'id': results[0],
        'name': results[1],
        'email': results[2],
        'role': results[3],
      };
    } catch (_) {
      return {};
    }
  }

  // ─── PUSH NOTIFICATION / FCM TOKEN ────────────────────────

  Future<void> saveFcmToken(String token) async {
    final clean = token.trim();
    if (clean.isNotEmpty) {
      try {
        await _storage.write(key: _keyFcmToken, value: clean).timeout(_opTimeout);
      } catch (_) {}
    }
  }

  Future<String?> getFcmToken() async {
    try {
      final token = await _storage.read(key: _keyFcmToken).timeout(_opTimeout);
      return (token != null && token.trim().isNotEmpty) ? token.trim() : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> clearFcmToken() async {
    try {
      await _storage.delete(key: _keyFcmToken).timeout(_opTimeout);
    } catch (_) {}
  }

  // ─── OFFLINE RESILIENCE: TOKEN ENVELOPE CACHE ──────────────

  Future<void> setCachedToken(TokenModel token, [String? userId]) async {
    try {
      final key = userId != null && userId.isNotEmpty
          ? '$_keyPrefixCachedToken$userId'
          : '${_keyPrefixCachedToken}anon';

      final envelope = {
        'data': token.toJson(),
        'cachedAt': DateTime.now().toIso8601String(),
        'receivedAt': DateTime.now().toIso8601String(),
        'source': 'server',
        'userId': userId ?? token.userId,
        'version': 1,
      };

      final serialized = jsonEncode(envelope);
      await Future.wait([
        _storage.write(key: key, value: serialized),
        _storage.write(key: _keyLastToken, value: serialized),
      ]).timeout(_opTimeout);
    } catch (_) {}
  }

  Future<CachedTokenEnvelope?> getCachedTokenEnvelope([String? userId]) async {
    try {
      final key = userId != null && userId.isNotEmpty
          ? '$_keyPrefixCachedToken$userId'
          : '${_keyPrefixCachedToken}anon';

      var raw = await _storage.read(key: key).timeout(_opTimeout);
      if (raw == null && (userId == null || userId.isEmpty)) {
        raw = await _storage.read(key: _keyLastToken).timeout(_opTimeout);
      }
      if (raw == null || raw.isEmpty) return null;

      final Map<String, dynamic> envelope = jsonDecode(raw) as Map<String, dynamic>;
      final cachedAtStr = envelope['cachedAt']?.toString();
      final cachedAt = cachedAtStr != null ? DateTime.tryParse(cachedAtStr) : null;
      if (cachedAt == null) return null;

      // Enforce 24-hour max cache age
      if (DateTime.now().difference(cachedAt) > maxCacheAge) {
        await clearCachedToken(userId);
        return null;
      }

      final data = envelope['data'] as Map<String, dynamic>?;
      if (data == null) return null;

      final token = TokenModel.fromJson(data);
      return CachedTokenEnvelope(
        token: token,
        cachedAt: cachedAt,
        source: envelope['source']?.toString() ?? 'server',
        userId: envelope['userId']?.toString(),
      );
    } catch (_) {
      return null;
    }
  }

  Future<TokenModel?> getCachedToken([String? userId]) async {
    final env = await getCachedTokenEnvelope(userId);
    return env?.token;
  }

  Future<void> clearCachedToken([String? userId]) async {
    try {
      final key = userId != null && userId.isNotEmpty
          ? '$_keyPrefixCachedToken$userId'
          : '${_keyPrefixCachedToken}anon';
      await Future.wait([
        _storage.delete(key: key),
        _storage.delete(key: _keyLastToken),
      ]).timeout(_opTimeout);
    } catch (_) {}
  }

  Future<void> clearAuth() async {
    try {
      await _storage.deleteAll().timeout(_opTimeout);
    } catch (_) {
      try {
        await Future.wait([
          _storage.delete(key: _keyToken),
          _storage.delete(key: _keyUserId),
          _storage.delete(key: _keyUserName),
          _storage.delete(key: _keyUserEmail),
          _storage.delete(key: _keyUserRole),
          _storage.delete(key: _keyFcmToken),
          _storage.delete(key: _keyLastToken),
        ]).timeout(_opTimeout);
      } catch (_) {}
    }
  }

  Future<bool> hasToken() async {
    final token = await getAuthToken();
    return token != null && token.isNotEmpty;
  }
}

class CachedTokenEnvelope {
  const CachedTokenEnvelope({
    required this.token,
    required this.cachedAt,
    this.source = 'server',
    this.userId,
    this.version = 1,
  });

  final TokenModel token;
  final DateTime cachedAt;
  final String source;
  final String? userId;
  final int version;

  bool get isExpired => DateTime.now().difference(cachedAt) > StorageService.maxCacheAge;
}

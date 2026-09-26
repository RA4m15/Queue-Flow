import 'package:flutter_secure_storage/flutter_secure_storage.dart';

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
        ]).timeout(_opTimeout);
      } catch (_) {}
    }
  }

  Future<bool> hasToken() async {
    final token = await getAuthToken();
    return token != null && token.isNotEmpty;
  }
}

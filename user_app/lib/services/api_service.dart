import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import '../core/constants/api_constants.dart';
import '../core/network/api_exception.dart';
import '../models/user.dart';
import '../models/service_center.dart';
import '../models/service.dart';
import '../models/queue_status.dart';
import '../models/crowd_status.dart';
import '../models/token.dart';
import '../models/notification.dart';

class ApiService {
  ApiService(this._dio);

  final Dio _dio;

  // ─── AUTHENTICATION ────────────────────────────────────────

  Future<Map<String, dynamic>> login({
    required String email,
    required String password,
  }) async {
    final cleanEmail = email.trim().toLowerCase();
    if (cleanEmail.isEmpty || password.isEmpty) {
      throw ApiException(message: 'Email and password must not be empty.');
    }

    try {
      final response = await _dio.post(
        ApiConstants.authLogin,
        data: {'email': cleanEmail, 'password': password},
      );
      final data = response.data['data'] as Map<String, dynamic>;
      return {
        'user': AppUser.fromJson(data['user'] as Map<String, dynamic>),
        'token': data['token'] as String,
      };
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<Map<String, dynamic>> register({
    required String name,
    required String email,
    required String password,
    String? phone,
  }) async {
    final cleanName = name.trim();
    final cleanEmail = email.trim().toLowerCase();
    final cleanPhone = phone?.trim();

    if (cleanName.length < 2) {
      throw ApiException(message: 'Name must be at least 2 characters long.');
    }
    if (cleanName.length > 80) {
      throw ApiException(message: 'Name cannot exceed 80 characters.');
    }
    if (!cleanEmail.contains('@') || !cleanEmail.contains('.')) {
      throw ApiException(message: 'Please enter a valid email address.');
    }
    if (password.length < 8) {
      throw ApiException(message: 'Password must be at least 8 characters long.');
    }
    if (!RegExp(r'^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)').hasMatch(password)) {
      throw ApiException(message: 'Password must contain uppercase, lowercase, and a number.');
    }
    if (password.length > 128) {
      throw ApiException(message: 'Password is too long (maximum 128 characters).');
    }

    final payload = <String, dynamic>{
      'name': cleanName,
      'email': cleanEmail,
      'password': password,
      'role': 'CUSTOMER',
    };
    if (cleanPhone != null && cleanPhone.isNotEmpty) {
      if (cleanPhone.length > 25) {
        throw ApiException(message: 'Phone number is too long.');
      }
      payload['phone'] = cleanPhone;
    }

    try {
      debugPrint('[Auth] Registration request started: POST ${ApiConstants.authRegister}');
      final response = await _dio.post(
        ApiConstants.authRegister,
        data: payload,
      );
      debugPrint('[Auth] Registration HTTP response status: ${response.statusCode}');

      final data = response.data['data'] as Map<String, dynamic>;
      final user = AppUser.fromJson(data['user'] as Map<String, dynamic>);
      final token = data['token'] as String;
      return {
        'user': user,
        'token': token,
      };
    } on DioException catch (e) {
      debugPrint('[Auth] Registration DioException: status=${e.response?.statusCode}, type=${e.type}');
      throw ApiException.fromDioException(e);
    } catch (e) {
      debugPrint('[Auth] Registration error: ${e.runtimeType}');
      rethrow;
    }
  }

  Future<AppUser> getCurrentUser() async {
    try {
      final response = await _dio.get(ApiConstants.authMe);
      final data = response.data['data'] as Map<String, dynamic>;
      return AppUser.fromJson(data['user'] as Map<String, dynamic>);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<AppUser> updateProfile({
    String? name,
    String? phone,
    String? fcmToken,
  }) async {
    final payload = <String, dynamic>{};
    if (name != null) {
      final cleanName = name.trim();
      if (cleanName.isNotEmpty && cleanName.length <= 100) {
        payload['name'] = cleanName;
      }
    }
    if (phone != null) {
      final cleanPhone = phone.trim();
      if (cleanPhone.length <= 25) {
        payload['phone'] = cleanPhone;
      }
    }
    if (fcmToken != null && fcmToken.trim().isNotEmpty) {
      payload['fcmToken'] = fcmToken.trim();
    }

    try {
      final response = await _dio.patch(
        ApiConstants.authMe,
        data: payload,
      );
      final data = response.data['data'] as Map<String, dynamic>;
      return AppUser.fromJson(data['user'] as Map<String, dynamic>);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<void> logout() async {
    try {
      await _dio.post(ApiConstants.authLogout);
    } catch (_) {
      // Best-effort remote session revocation
    }
  }

  static final _idRegex = RegExp(r'^[a-fA-F0-9]{24}$');

  void _requireValidId(String id, String fieldName) {
    final clean = id.trim();
    if (clean.isEmpty || !_idRegex.hasMatch(clean)) {
      throw ApiException(message: 'Invalid $fieldName: expected 24-character hexadecimal identifier.');
    }
  }

  // ─── SERVICE CENTERS ───────────────────────────────────────

  Future<List<ServiceCenter>> getServiceCenters() async {
    try {
      final response = await _dio.get(ApiConstants.serviceCenters);
      final data = response.data['data'];
      final List list;
      if (data is Map && data.containsKey('centers')) {
        list = data['centers'] as List;
      } else if (data is List) {
        list = data;
      } else {
        list = [];
      }
      return list.map((item) => ServiceCenter.fromJson(item as Map<String, dynamic>)).toList();
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<Map<String, dynamic>> getServiceCenterDetail(String centerId) async {
    _requireValidId(centerId, 'center ID');
    final cleanId = centerId.trim();

    try {
      final response = await _dio.get('${ApiConstants.serviceCenters}/$cleanId');
      final data = response.data['data'] as Map<String, dynamic>;
      final center = ServiceCenter.fromJson(data['center'] as Map<String, dynamic>);
      final servicesRaw = (data['services'] as List?) ?? [];
      final services = servicesRaw.map((s) => Service.fromJson(s as Map<String, dynamic>)).toList();
      return {
        'center': center,
        'services': services,
        'currentCrowd': (data['currentCrowd'] as num?)?.toInt() ?? center.currentCrowd,
      };
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  // ─── SERVICES ──────────────────────────────────────────────

  Future<List<Service>> getServices(String centerId) async {
    _requireValidId(centerId, 'center ID');
    final cleanId = centerId.trim();

    try {
      final response = await _dio.get(
        ApiConstants.services,
        queryParameters: {'centerId': cleanId},
      );
      final data = response.data['data'];
      final List list;
      if (data is Map && data.containsKey('services')) {
        list = data['services'] as List;
      } else if (data is List) {
        list = data;
      } else {
        list = [];
      }
      return list.map((item) => Service.fromJson(item as Map<String, dynamic>)).toList();
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  // ─── QUEUE ─────────────────────────────────────────────────

  Future<List<QueueStatus>> getQueueStatus(String centerId) async {
    _requireValidId(centerId, 'center ID');
    final cleanId = centerId.trim();

    try {
      final response = await _dio.get('${ApiConstants.queue}/$cleanId');
      final data = response.data['data'];
      final List list;
      if (data is Map && data.containsKey('queues')) {
        list = data['queues'] as List;
      } else if (data is List) {
        list = data;
      } else {
        list = [];
      }
      return list.map((item) => QueueStatus.fromJson(item as Map<String, dynamic>)).toList();
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<Map<String, dynamic>> getServiceQueue(String centerId, String serviceId) async {
    _requireValidId(centerId, 'center ID');
    _requireValidId(serviceId, 'service ID');
    final cleanCenterId = centerId.trim();
    final cleanServiceId = serviceId.trim();

    try {
      final response = await _dio.get('${ApiConstants.queue}/$cleanCenterId/$cleanServiceId');
      final data = response.data['data'] as Map<String, dynamic>;
      return data;
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  // ─── CROWD ─────────────────────────────────────────────────

  Future<CrowdStatus> getCrowd(String centerId) async {
    _requireValidId(centerId, 'center ID');
    final cleanId = centerId.trim();

    try {
      final response = await _dio.get('${ApiConstants.crowd}/$cleanId');
      final data = response.data['data'] as Map<String, dynamic>;
      return CrowdStatus.fromJson(data);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  // ─── TOKENS ────────────────────────────────────────────────

  Future<TokenModel> joinQueue({
    required String centerId,
    required String serviceId,
    bool notifyApp = true,
    bool notifySms = false,
  }) async {
    _requireValidId(centerId, 'center ID');
    _requireValidId(serviceId, 'service ID');
    final cleanCenterId = centerId.trim();
    final cleanServiceId = serviceId.trim();

    try {
      final response = await _dio.post(
        ApiConstants.tokens,
        data: {
          'centerId': cleanCenterId,
          'serviceId': cleanServiceId,
          'notifyApp': notifyApp,
          'notifySms': notifySms,
        },
      );
      final data = response.data['data'] as Map<String, dynamic>;
      return TokenModel.fromJson(data['token'] as Map<String, dynamic>);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<TokenModel?> getActiveToken() async {
    try {
      final response = await _dio.get(ApiConstants.tokensActive);
      final data = response.data['data'];
      if (data is Map && data['token'] != null) {
        return TokenModel.fromJson(data['token'] as Map<String, dynamic>);
      }
      return null;
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<List<TokenModel>> getMyTokens({int page = 1, int limit = 20}) async {
    if (page < 1) throw ApiException(message: 'Page number must be at least 1.');
    if (limit < 1 || limit > 100) throw ApiException(message: 'Limit must be between 1 and 100.');

    try {
      final response = await _dio.get(
        ApiConstants.tokensMy,
        queryParameters: {'page': page, 'limit': limit},
      );
      final data = response.data['data'];
      final List list;
      if (data is Map && data.containsKey('tokens')) {
        list = data['tokens'] as List;
      } else if (data is List) {
        list = data;
      } else {
        list = [];
      }
      return list.map((item) => TokenModel.fromJson(item as Map<String, dynamic>)).toList();
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<TokenModel> getTokenDetail(String tokenId) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.get('${ApiConstants.tokens}/$cleanId');
      final data = response.data['data'] as Map<String, dynamic>;
      return TokenModel.fromJson(data['token'] as Map<String, dynamic>);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<String> getTokenQR(String tokenId) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.get('${ApiConstants.tokens}/$cleanId/qr');
      final data = response.data['data'] as Map<String, dynamic>;
      final qr = (data['qrData'] ?? '').toString();
      if (qr.isEmpty) {
        throw ApiException(message: 'No official QR data returned by server.');
      }
      return qr;
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<TokenModel> cancelToken(String tokenId) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.post('${ApiConstants.tokens}/$cleanId/cancel');
      final data = response.data['data'] as Map<String, dynamic>;
      return TokenModel.fromJson(data['token'] as Map<String, dynamic>);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<TokenModel> submitFeedback({
    required String tokenId,
    required int rating,
    String? comment,
  }) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    if (rating < 1 || rating > 5) {
      throw ApiException(message: 'Rating must be an integer between 1 and 5.');
    }

    String? cleanComment;
    if (comment != null) {
      final trimmed = comment.trim();
      if (trimmed.length > 500) {
        throw ApiException(message: 'Comment must not exceed 500 characters.');
      }
      if (trimmed.isNotEmpty) {
        cleanComment = trimmed;
      }
    }

    try {
      final response = await _dio.post(
        '${ApiConstants.tokens}/$cleanId/feedback',
        data: {
          'rating': rating,
          'comment': ?cleanComment,
        },
      );
      final data = response.data['data'] as Map<String, dynamic>;
      return TokenModel.fromJson(data['token'] as Map<String, dynamic>);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  // ─── NOTIFICATIONS ─────────────────────────────────────────

  Future<Map<String, dynamic>> getNotifications({int page = 1, int limit = 30}) async {
    if (page < 1) throw ApiException(message: 'Page number must be at least 1.');
    if (limit < 1 || limit > 100) throw ApiException(message: 'Limit must be between 1 and 100.');

    try {
      final response = await _dio.get(
        ApiConstants.notifications,
        queryParameters: {'page': page, 'limit': limit},
      );
      final data = response.data['data'] as Map<String, dynamic>;
      final list = (data['notifications'] as List?) ?? [];
      final notifications = list.map((n) => NotificationModel.fromJson(n as Map<String, dynamic>)).toList();
      final unreadCount = (data['unreadCount'] as num?)?.toInt() ?? 0;
      return {
        'notifications': notifications,
        'unreadCount': unreadCount,
      };
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<void> markNotificationRead(String id) async {
    _requireValidId(id, 'notification ID');
    final cleanId = id.trim();

    try {
      await _dio.patch('${ApiConstants.notifications}/$cleanId/read');
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<void> markAllNotificationsRead() async {
    try {
      await _dio.patch(ApiConstants.notificationsReadAll);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }
}

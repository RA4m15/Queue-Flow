import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import '../core/constants/api_constants.dart';
import '../core/network/api_exception.dart';
import '../core/network/network_status.dart';
import '../models/user.dart';
import '../models/service_center.dart';
import '../models/service.dart';
import '../models/queue_status.dart';
import '../models/crowd_status.dart';
import '../models/token.dart';
import '../models/notification.dart';

class ApiService {
  ApiService(this._dio, {NetworkStatus? networkStatus})
      : networkStatus = networkStatus ?? NetworkStatus();

  final Dio _dio;

  /// Reachability of the backend, observed from real transport outcomes.
  /// Every backend-authoritative mutation is refused while it reports
  /// offline, so the app can never simulate a successful join/swap/upload.
  final NetworkStatus networkStatus;

  bool get isOffline => networkStatus.isOffline;

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
    Map<String, dynamic>? preferences,
  }) async {
    networkStatus.requireOnline();
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
    if (preferences != null) {
      payload['preferences'] = preferences;
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

  Future<void> registerDeviceToken(String fcmToken) async {
    networkStatus.requireOnline();
    final clean = fcmToken.trim();
    if (clean.length < 20 || clean.length > 255) {
      throw ApiException(message: 'Invalid FCM device token.');
    }
    try {
      await _dio.patch(
        ApiConstants.authMe,
        data: {'fcmToken': clean},
      );
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<void> unregisterDeviceToken() async {
    try {
      await _dio.patch(
        ApiConstants.authMe,
        data: {'fcmToken': null},
      );
    } catch (_) {
      // Best-effort unregistration
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

  Future<List<ServiceCenter>> getServiceCenters({bool? isOpen = true}) async {
    try {
      final response = await _dio.get(
        ApiConstants.serviceCenters,
        queryParameters: isOpen != null ? {'isOpen': isOpen.toString()} : null,
      );
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
    double? latitude,
    double? longitude,
    double? accuracy,
    DateTime? timestamp,
  }) async {
    networkStatus.requireOnline();
    _requireValidId(centerId, 'center ID');
    _requireValidId(serviceId, 'service ID');
    final cleanCenterId = centerId.trim();
    final cleanServiceId = serviceId.trim();

    try {
      final payload = <String, dynamic>{
        'centerId': cleanCenterId,
        'serviceId': cleanServiceId,
        'notifyApp': notifyApp,
        'notifySms': notifySms,
      };
      if (latitude != null) payload['latitude'] = latitude;
      if (longitude != null) payload['longitude'] = longitude;
      if (accuracy != null) payload['accuracy'] = accuracy;
      if (timestamp != null) payload['timestamp'] = timestamp.toIso8601String();

      final response = await _dio.post(
        ApiConstants.tokens,
        data: payload,
      );
      final data = response.data['data'] as Map<String, dynamic>;
      return TokenModel.fromJson(data['token'] as Map<String, dynamic>);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Shares one live location reading for an active token (Phase 2 heartbeat).
  ///
  /// Reuses the Phase 1 geofence endpoint: there is no second location system.
  /// The returned map is the backend's own verdict
  /// (`locationStatus`, `distanceMeters`, `updatedAt`); the app never derives
  /// in-range status itself.
  ///
  /// Returns null when the sample could not be accepted. This is an expected
  /// outcome on a flaky connection, not an error worth interrupting the user
  /// over, so it is not thrown.
  Future<Map<String, dynamic>?> shareTokenLocation({
    required String tokenId,
    required double latitude,
    required double longitude,
    double? accuracy,
    DateTime? timestamp,
  }) async {
    _requireValidId(tokenId, 'token ID');

    final payload = <String, dynamic>{
      'latitude': latitude,
      'longitude': longitude,
      'timestamp': (timestamp ?? DateTime.now()).toUtc().toIso8601String(),
    };
    if (accuracy != null) payload['accuracy'] = accuracy;

    try {
      final response = await _dio.post(
        '${ApiConstants.tokens}/$tokenId/location',
        data: payload,
      );
      final data = response.data['data'];
      if (data is Map<String, dynamic>) return data;
      return null;
    } on DioException {
      // Swallowed deliberately: the heartbeat must never surface a transport
      // failure to the customer. A reading we could not send simply leaves the
      // previous one in place, which the backend will age into LOCATION_STALE.
      return null;
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
    networkStatus.requireOnline();
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
    networkStatus.requireOnline();
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

  // ─── TIER 4 FEATURE 1: GHOST QUEUE GEOFENCING ─────────────

  Future<Map<String, dynamic>> updateTokenLocation({
    required String tokenId,
    required double latitude,
    required double longitude,
    double? accuracy,
    int? timestamp,
    String? centerId,
  }) async {
    // Ghost Queue proximity is backend-authoritative; never fabricate it offline.
    networkStatus.requireOnline();
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.post(
        '${ApiConstants.tokens}/$cleanId/location',
        data: {
          'latitude': latitude,
          'longitude': longitude,
          'accuracy': ?accuracy,
          'timestamp': ?timestamp,
          'centerId': ?centerId,
        },
      );
      final data = response.data['data'] as Map<String, dynamic>;      return data;
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<Map<String, dynamic>> getTokenProximity(String tokenId) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.get('${ApiConstants.tokens}/$cleanId/proximity');
      final data = response.data['data'] as Map<String, dynamic>;
      return data;
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

  // ─── TIER 4 FEATURE 2: SERVICE GRAPH MULTI-HOP ────────────

  Future<Map<String, dynamic>> getNextServices(String tokenId) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.get('${ApiConstants.tokens}/$cleanId/next-service');
      return (response.data['data'] as Map<String, dynamic>?) ?? {};
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  Future<TokenModel> confirmNextHop({
    required String tokenId,
    required String nextServiceId,
    bool notifyApp = true,
    bool notifySms = false,
  }) async {
    networkStatus.requireOnline();
    _requireValidId(tokenId, 'token ID');
    _requireValidId(nextServiceId, 'next service ID');
    final cleanTokenId = tokenId.trim();
    final cleanServiceId = nextServiceId.trim();

    try {
      final response = await _dio.post(
        '${ApiConstants.tokens}/$cleanTokenId/next-service/confirm',
        data: {
          'nextServiceId': cleanServiceId,
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

  Future<Map<String, dynamic>> getJourney(String tokenId) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.get('${ApiConstants.tokens}/$cleanId/journey');
      return (response.data['data'] as Map<String, dynamic>?) ?? {};
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  // ─── TIER 4 FEATURE 3: P2P SLOT SWAPPING ──────────────────

  /// Get anonymized eligible swap partners for a token.
  /// Returns only position + tokenCode — no customer PII.
  Future<Map<String, dynamic>> getSwapEligible(String tokenId) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.get('/swaps/eligible?tokenId=$cleanId');
      return (response.data['data'] as Map<String, dynamic>?) ?? {};
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Get caller's own offers + open eligible offers in their queue.
  Future<Map<String, dynamic>> getSwapOffers(String tokenId) async {
    _requireValidId(tokenId, 'token ID');
    final cleanId = tokenId.trim();

    try {
      final response = await _dio.get('/swaps/my?tokenId=$cleanId');
      return (response.data['data'] as Map<String, dynamic>?) ?? {};
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Create a swap offer for a WAITING token.
  /// [targetTokenId] — optional; if null, offer is open to any eligible customer.
  Future<Map<String, dynamic>> createSwapOffer({
    required String offeringTokenId,
    String? targetTokenId,
    String? reason,
  }) async {
    // Offline swaps can neither be created nor confirmed; refuse before any
    // request so a swap is never simulated locally.
    networkStatus.requireOnline();
    _requireValidId(offeringTokenId, 'offering token ID');
    if (targetTokenId != null) {
      _requireValidId(targetTokenId, 'target token ID');
    }

    final payload = <String, dynamic>{
      'offeringTokenId': offeringTokenId.trim(),
    };
    if (targetTokenId != null) {
      payload['targetTokenId'] = targetTokenId.trim();
    }
    if (reason != null && reason.trim().isNotEmpty) {
      payload['reason'] = reason.trim().substring(0, reason.trim().length.clamp(0, 200));
    }

    try {
      final response = await _dio.post('/swaps', data: payload);
      return (response.data['data'] as Map<String, dynamic>?) ?? {};
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Accept a swap offer and execute the atomic position swap.
  Future<Map<String, dynamic>> acceptSwapOffer({
    required String offerId,
    required String acceptingTokenId,
  }) async {
    networkStatus.requireOnline();
    _requireValidId(offerId, 'offer ID');
    _requireValidId(acceptingTokenId, 'accepting token ID');

    try {
      final response = await _dio.post(
        '/swaps/${offerId.trim()}/accept',
        data: {'acceptingTokenId': acceptingTokenId.trim()},
      );
      return (response.data['data'] as Map<String, dynamic>?) ?? {};
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Decline an incoming swap offer.
  Future<void> declineSwapOffer(String offerId) async {
    networkStatus.requireOnline();
    _requireValidId(offerId, 'offer ID');

    try {
      await _dio.post('/swaps/${offerId.trim()}/decline');
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Cancel your own pending swap offer.
  Future<void> cancelSwapOffer(String offerId) async {
    networkStatus.requireOnline();
    _requireValidId(offerId, 'offer ID');

    try {
      await _dio.post('/swaps/${offerId.trim()}/cancel');
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  // ─── TIER 4 FEATURE 4: DOCUMENT-READY GATEKEEPING ──────────

  /// Fetch active document requirements for a service.
  Future<List<Map<String, dynamic>>> getServiceDocumentRequirements(String serviceId) async {
    _requireValidId(serviceId, 'service ID');
    try {
      final response = await _dio.get('/documents/services/${serviceId.trim()}/requirements');
      final list = (response.data['data']?['requirements'] as List<dynamic>?) ?? [];
      return list.map((e) => e as Map<String, dynamic>).toList();
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Get server-authoritative readiness state for the authenticated customer.
  Future<Map<String, dynamic>> checkServiceDocumentReadiness(String serviceId) async {
    _requireValidId(serviceId, 'service ID');
    try {
      final response = await _dio.get('/documents/services/${serviceId.trim()}/readiness');
      return (response.data['data'] as Map<String, dynamic>?) ?? {};
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Upload customer document with base64 encoded payload.
  Future<Map<String, dynamic>> uploadCustomerDocument({
    required String serviceId,
    required String documentType,
    required String fileName,
    required String mimeType,
    required String base64Data,
  }) async {
    // Document submission is backend-authoritative; never queue it for blind
    // replay and never acknowledge an upload the server never received.
    networkStatus.requireOnline();
    _requireValidId(serviceId, 'service ID');
    try {
      final response = await _dio.post('/documents/upload', data: {
        'serviceId': serviceId.trim(),
        'documentType': documentType.trim().toUpperCase(),
        'fileName': fileName.trim(),
        'mimeType': mimeType.trim(),
        'fileData': base64Data,
      });
      return (response.data['data']?['document'] as Map<String, dynamic>?) ?? {};
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Create a real persistent support ticket on backend.
  Future<Map<String, dynamic>> createSupportTicket({
    required String category,
    required String subject,
    required String description,
  }) async {
    networkStatus.requireOnline();
    try {
      final response = await _dio.post(
        ApiConstants.supportTickets,
        data: {
          'category': category.trim(),
          'subject': subject.trim(),
          'description': description.trim(),
        },
      );
      final data = response.data['data'] as Map<String, dynamic>;
      return (data['ticket'] as Map<String, dynamic>?) ?? data;
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  /// Get real support tickets created by the current user.
  Future<List<Map<String, dynamic>>> getMySupportTickets() async {
    networkStatus.requireOnline();
    try {
      final response = await _dio.get(ApiConstants.supportTickets);
      final data = response.data['data'] as Map<String, dynamic>;
      final list = (data['tickets'] as List<dynamic>?) ?? [];
      return list.map((e) => e as Map<String, dynamic>).toList();
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }
}

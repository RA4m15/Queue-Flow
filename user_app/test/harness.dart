import 'dart:async';
import 'dart:convert';

import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/notification.dart';
import 'package:user_app/models/service.dart';
import 'package:user_app/models/service_center.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/models/user.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:user_app/services/api_service.dart';
import 'package:user_app/services/push_messaging_client.dart';
import 'package:user_app/services/storage_service.dart';

/// Deterministic identifiers used across the test suite. These are
/// well-formed Mongo ObjectIds so they exercise the same client-side
/// validation as production, but they are not business data — every
/// service center, service, token, EWT and queue position used in tests is
/// supplied by a test double standing in for the backend.
const String kCenterId = '507f1f77bcf86cd799439001';
const String kServiceId = '507f1f77bcf86cd799439002';
const String kTokenId = '507f1f77bcf86cd799439003';
const String kUserA = '507f1f77bcf86cd79943900a';
const String kUserB = '507f1f77bcf86cd79943900b';
const String kNextServiceId = '507f1f77bcf86cd799439004';
const String kTargetServiceId = '507f1f77bcf86cd799439005';

/// The token the backend creates when a customer confirms a graph hop.
const String kHopTokenId = '507f1f77bcf86cd79943900c';

/// A swap offer identifier shaped like the backend `SwapOffer` `_id`.
const String kSwapOfferId = '507f1f77bcf86cd7994390aa';

/// Builds a token payload shaped exactly like the backend `Token` document
/// returned by `GET /api/tokens/active`.
Map<String, dynamic> tokenJson({
  String id = kTokenId,
  String tokenCode = 'A-014',
  int tokenNumber = 14,
  String userId = kUserA,
  String centerId = kCenterId,
  String centerName = 'Test Center',
  String serviceId = kServiceId,
  String serviceName = 'Test Service',
  String status = 'WAITING',
  int? currentPosition = 5,
  int? initialPosition = 5,
  int? waitEstimateMinutes = 22,
  String? servingToken = 'A-009',
  String? counterId,
  String? counterName,
  Map<String, dynamic> extra = const {},
}) {
  return {
    '_id': id,
    'tokenCode': tokenCode,
    'tokenNumber': tokenNumber,
    'userId': userId,
    'centerId': {'_id': centerId, 'name': centerName},
    'serviceId': {'_id': serviceId, 'name': serviceName},
    'status': status,
    'initialPosition': initialPosition,
    'currentPosition': currentPosition,
    'waitEstimateMinutes': waitEstimateMinutes,
    'servingToken': servingToken,
    'createdAt': '2026-09-26T09:00:00.000Z',
    if (counterId != null)
      'counterId': {'_id': counterId, 'name': counterName, 'number': 2},
    ...extra,
  };
}

/// Builds a user payload shaped like the backend `User` document.
Map<String, dynamic> userJson({
  String id = kUserA,
  String name = 'Customer A',
  String email = 'a@example.com',
  String role = 'CUSTOMER',
  bool isActive = true,
  bool isVerified = true,
}) {
  return {
    '_id': id,
    'name': name,
    'email': email,
    'role': role,
    'isActive': isActive,
    'isVerified': isVerified,
    'createdAt': '2026-09-26T08:00:00.000Z',
  };
}

/// In-memory storage double. Models the real `flutter_secure_storage` surface
/// the app uses, including per-user queue-cache key namespacing.
class FakeStorageService extends StorageService {
  FakeStorageService();

  final Map<String, String> data = {};

  /// Simulate a storage backend that throws, for resilience tests.
  bool failAll = false;

  @override
  Future<void> saveAuthToken(String token) async {
    if (failAll) throw Exception('storage offline');
    data['auth_token'] = token;
  }

  @override
  Future<String?> getAuthToken() async {
    if (failAll) throw Exception('storage offline');
    return data['auth_token'];
  }

  @override
  Future<void> saveUserData({
    required String id,
    required String name,
    required String email,
    required String role,
  }) async {
    if (failAll) throw Exception('storage offline');
    data['user_id'] = id;
    data['user_name'] = name;
    data['user_email'] = email;
    data['user_role'] = role;
  }

  @override
  Future<Map<String, String?>> getUserData() async {
    if (failAll) throw Exception('storage offline');
    return {
      'id': data['user_id'],
      'name': data['user_name'],
      'email': data['user_email'],
      'role': data['user_role'],
    };
  }

  @override
  Future<void> saveFcmToken(String token) async => data['fcm_device_token'] = token;

  @override
  Future<String?> getFcmToken() async => data['fcm_device_token'];

  @override
  Future<void> clearFcmToken() async => data.remove('fcm_device_token');

  @override
  Future<void> setCachedToken(TokenModel token, [String? userId]) async {
    await seedCachedToken(token, userId);
  }

  /// Writes a cache entry using the same serialized envelope shape and the
  /// same [StorageService.maxCacheAge] guard as the real `StorageService`, but
  /// lets a test control `cachedAt` so staleness can be exercised.
  Future<void> seedCachedToken(
    TokenModel token,
    String? userId, {
    DateTime? cachedAt,
  }) async {
    if (failAll) return;
    final stamp = (cachedAt ?? DateTime.now()).toIso8601String();
    data[cachedKey(userId)] = jsonEncode({
      'data': token.toJson(),
      'cachedAt': stamp,
      'receivedAt': stamp,
      'source': 'server',
      'userId': userId ?? token.userId,
      'version': 1,
    });
  }

  static String cachedKey(String? userId) =>
      userId != null && userId.isNotEmpty ? 'cached_token_$userId' : 'cached_token_anon';

  @override
  Future<TokenModel?> getCachedToken([String? userId]) async {
    final env = await getCachedTokenEnvelope(userId);
    return env?.token;
  }

  @override
  Future<CachedTokenEnvelope?> getCachedTokenEnvelope([String? userId]) async {
    if (failAll) return null;
    final raw = data[cachedKey(userId)];
    if (raw == null || raw.isEmpty) return null;

    final Map<String, dynamic> envelope = jsonDecode(raw) as Map<String, dynamic>;
    final cachedAt = DateTime.tryParse(envelope['cachedAt']?.toString() ?? '');
    if (cachedAt == null) return null;

    // Identical freshness rule to StorageService.getCachedTokenEnvelope.
    if (DateTime.now().difference(cachedAt) > StorageService.maxCacheAge) {
      await clearCachedToken(userId);
      return null;
    }

    final payload = envelope['data'] as Map<String, dynamic>?;
    if (payload == null) return null;

    return CachedTokenEnvelope(
      token: TokenModel.fromJson(payload),
      cachedAt: cachedAt,
      source: envelope['source']?.toString() ?? 'server',
      userId: envelope['userId']?.toString(),
    );
  }

  @override
  Future<void> clearCachedToken([String? userId]) async {
    if (failAll) return;
    data.remove(cachedKey(userId));
  }

  @override
  Future<void> clearAuth() async {
    if (failAll) return;
    data.clear();
  }

  @override
  Future<bool> hasToken() async {
    if (failAll) return false;
    final t = data['auth_token'];
    return t != null && t.isNotEmpty;
  }
}

/// Scriptable [PushMessagingClient] standing in for a real push SDK.
///
/// The app itself ships [UnavailablePushMessagingClient] because no push
/// transport (Firebase Messaging / APNs) is compiled or configured into this
/// build. This double exercises the *contract* so that if a transport is ever
/// wired in, the client-side plumbing is already covered.
class FakePushMessagingClient implements PushMessagingClient {
  FakePushMessagingClient({
    this.isAvailable = true,
    this.permission = PushPermissionStatus.granted,
    this.grantedOnRequest = true,
    this.token = 'fake-device-push-registration-token-0123456789',
  });

  @override
  final bool isAvailable;

  /// What `currentPermission()` reports before any prompt.
  PushPermissionStatus permission;

  /// What the platform returns when the user is prompted.
  bool grantedOnRequest;

  /// The device registration token, or null when the SDK has none.
  String? token;

  int permissionRequestCount = 0;

  final _tokenRefresh = StreamController<String>.broadcast();
  final _foreground = StreamController<PushMessage>.broadcast();
  final _opened = StreamController<PushMessage>.broadcast();

  @override
  Future<PushPermissionStatus> currentPermission() async => permission;

  @override
  Future<PushPermissionStatus> requestPermission() async {
    permissionRequestCount++;
    permission = grantedOnRequest
        ? PushPermissionStatus.granted
        : PushPermissionStatus.denied;
    return permission;
  }

  @override
  Future<String?> deviceToken() async => token;

  @override
  Stream<String> get onTokenRefresh => _tokenRefresh.stream;

  @override
  Stream<PushMessage> get onForegroundMessage => _foreground.stream;

  @override
  Stream<PushMessage> get onMessageOpened => _opened.stream;

  // ── test drivers ────────────────────────────────────────────
  void emitTokenRefresh(String newToken) {
    token = newToken;
    _tokenRefresh.add(newToken);
  }

  void emitForeground(PushMessage message) => _foreground.add(message);

  void emitOpened(PushMessage message) => _opened.add(message);

  @override
  void dispose() {
    _tokenRefresh.close();
    _foreground.close();
    _opened.close();
  }
}

/// [AuthNotifier] without the Socket.IO handshake.
///
/// `AuthNotifier.login` opens a real Socket.IO connection, which leaves a
/// pending timer in a widget test. This subclass drives the same
/// [AuthState] the real notifier publishes, so provider wiring can be
/// exercised without a network transport.
class TestAuthNotifier extends AuthNotifier {
  TestAuthNotifier({
    required super.apiService,
    required super.storageService,
    required super.socketService,
  });

  /// Publishes a signed-in session exactly as a successful login would.
  Future<void> signInForTest({String id = kUserA, String email = 'a@example.com'}) async {
    await storageService.saveAuthToken('jwt-for-$email');
    await storageService.saveUserData(
      id: id,
      name: 'Customer A',
      email: email,
      role: 'CUSTOMER',
    );
    state = AuthState(
      isLoading: false,
      isAuthenticated: true,
      user: AppUser.fromJson(userJson(id: id, email: email)),
    );
  }
}

/// ApiService double backed by in-memory backend responses.
///
/// Every value it returns originates here (i.e. from the "backend"), never
/// from the Flutter client.
class FakeApiService extends ApiService {
  FakeApiService(super.dio, {NetworkStatus? networkStatus})
      : super(networkStatus: networkStatus ?? NetworkStatus());

  // Centers / services / queue
  List<ServiceCenter> centers = [];
  List<Service> services = [];
  Map<String, dynamic>? queueDetails;
  int centerListCalls = 0;
  int serviceListCalls = 0;
  int queuePreviewCalls = 0;

  // Tokens
  TokenModel? activeToken;
  List<TokenModel> myTokens = [];

  /// When set, the next [joinQueue] throws this error.
  Object? joinError;

  /// Number of successful joins performed (must stay 0 when offline).
  int joinCalls = 0;

  // Document gate
  Map<String, dynamic> readiness = const {
    'isReady': true,
    'status': 'REQUIREMENTS_NOT_CONFIGURED',
    'checklist': [],
    'missingRequirements': [],
  };
  int readinessCalls = 0;

  // Service graph
  Map<String, dynamic> nextServices = const {'hasNextService': false};
  Map<String, dynamic> journey = const {'tokens': <dynamic>[]};
  int nextServiceCalls = 0;
  int graphConfirmCalls = 0;
  TokenModel? confirmedHopToken;

  // Swaps
  List<Map<String, dynamic>> swapOffers = [];
  final List<Map<String, dynamic>> createdSwapOffers = [];
  int eligiblePartners = 0;
  int swapCreateCalls = 0;
  int swapAcceptCalls = 0;
  int swapDeclineCalls = 0;
  int swapCancelCalls = 0;
  int swapOfferCalls = 0;
  int swapEligibleCalls = 0;

  // Documents
  int documentUploadCalls = 0;
  Map<String, dynamic>? uploadedDocument;

  // Geofence
  int locationUpdateCalls = 0;
  Map<String, dynamic> proximity = const {
    'proximityState': 'NEAR',
    'distanceMeters': 300,
  };

  // Device token
  final List<String> registeredDeviceTokens = [];
  int deviceTokenCalls = 0;
  Object? deviceTokenError;

  // Notifications
  Map<String, dynamic> notificationsResponse = {
    'notifications': <NotificationModel>[],
    'unreadCount': 0,
  };
  final List<String> readNotificationIds = [];
  int markAllReadCalls = 0;

  // Auth
  String currentUserId = kUserA;
  int loginCalls = 0;
  int logoutCalls = 0;
  Object? loginError;

  @override
  Future<List<ServiceCenter>> getServiceCenters() async {
    centerListCalls++;
    return centers;
  }

  @override
  Future<List<Service>> getServices(String centerId) async {
    serviceListCalls++;
    return services;
  }

  @override
  Future<Map<String, dynamic>> getServiceQueue(String centerId, String serviceId) async {
    queuePreviewCalls++;
    return queueDetails ?? const {'queue': null, 'calledTokens': <dynamic>[]};
  }

  @override
  Future<TokenModel?> getActiveToken() async {
    // Simulate a transport failure when the network is known to be down so
    // callers exercise their offline path.
    if (networkStatus.isOffline) {
      throw ApiException(message: 'connection error');
    }
    return activeToken;
  }

  @override
  Future<List<TokenModel>> getMyTokens({int page = 1, int limit = 20}) async => myTokens;

  @override
  Future<TokenModel> joinQueue({
    required String centerId,
    required String serviceId,
    bool notifyApp = true,
    bool notifySms = false,
  }) async {
    networkStatus.requireOnline();
    if (joinError != null) {
      final e = joinError!;
      joinError = null;
      throw e;
    }
    joinCalls++;
    final created = TokenModel.fromJson(tokenJson(status: 'WAITING', currentPosition: 1));
    activeToken = created;
    return created;
  }

  @override
  Future<TokenModel> cancelToken(String tokenId) async {
    networkStatus.requireOnline();
    final cancelled = TokenModel.fromJson(tokenJson(status: 'CANCELLED', currentPosition: null));
    activeToken = cancelled;
    return cancelled;
  }

  @override
  Future<TokenModel> submitFeedback({
    required String tokenId,
    required int rating,
    String? comment,
  }) async {
    networkStatus.requireOnline();
    return activeToken ?? TokenModel.fromJson(tokenJson());
  }

  @override
  Future<Map<String, dynamic>> checkServiceDocumentReadiness(String serviceId) async {
    if (networkStatus.isOffline) {
      throw ApiException(message: 'connection error');
    }
    readinessCalls++;
    return readiness;
  }

  @override
  Future<List<Map<String, dynamic>>> getServiceDocumentRequirements(String serviceId) async {
    final checklist = (readiness['checklist'] as List?) ?? const [];
    return checklist.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
  }

  @override
  Future<Map<String, dynamic>> uploadCustomerDocument({
    required String serviceId,
    required String documentType,
    required String fileName,
    required String mimeType,
    required String base64Data,
  }) async {
    networkStatus.requireOnline();
    documentUploadCalls++;
    uploadedDocument = {
      'serviceId': serviceId,
      'documentType': documentType,
      'fileName': fileName,
    };
    return uploadedDocument!;
  }

  @override
  Future<Map<String, dynamic>> getNextServices(String tokenId) async {
    if (networkStatus.isOffline) {
      throw ApiException(message: 'connection error');
    }
    nextServiceCalls++;
    return nextServices;
  }

  @override
  Future<Map<String, dynamic>> getJourney(String tokenId) async {
    if (networkStatus.isOffline) return const {};
    return journey;
  }

  @override
  Future<TokenModel> confirmNextHop({
    required String tokenId,
    required String nextServiceId,
    bool notifyApp = true,
    bool notifySms = false,
  }) async {
    networkStatus.requireOnline();
    graphConfirmCalls++;
    confirmedHopToken = TokenModel.fromJson(
      tokenJson(
        id: kHopTokenId,
        serviceId: nextServiceId,
        serviceName: 'Next Service',
        status: 'WAITING',
      ),
    );
    return confirmedHopToken!;
  }

  @override
  Future<Map<String, dynamic>> getSwapEligible(String tokenId) async {
    if (networkStatus.isOffline) {
      throw ApiException(message: 'connection error');
    }
    swapEligibleCalls++;
    return {'eligiblePartners': eligiblePartners};
  }

  @override
  Future<Map<String, dynamic>> getSwapOffers(String tokenId) async {
    if (networkStatus.isOffline) {
      throw ApiException(message: 'connection error');
    }
    swapOfferCalls++;
    // Newly created offers become visible in the backend's own list.
    return {'offers': [...swapOffers, ...createdSwapOffers]};
  }

  @override
  Future<Map<String, dynamic>> createSwapOffer({
    required String offeringTokenId,
    String? targetTokenId,
    String? reason,
  }) async {
    networkStatus.requireOnline();
    swapCreateCalls++;
    createdSwapOffers.add({
      '_id': kSwapOfferId,
      'status': 'PENDING',
      'reason': reason,
      'offeringTokenId': offeringTokenId,
      'targetTokenId': targetTokenId,
    });
    return {'offer': createdSwapOffers.last};
  }

  @override
  Future<Map<String, dynamic>> acceptSwapOffer({
    required String offerId,
    required String acceptingTokenId,
  }) async {
    networkStatus.requireOnline();
    swapAcceptCalls++;
    _setOfferStatus(offerId, 'COMPLETED');
    return {'status': 'COMPLETED', 'offer': _findOffer(offerId)};
  }

  @override
  Future<void> declineSwapOffer(String offerId) async {
    networkStatus.requireOnline();
    swapDeclineCalls++;
    _setOfferStatus(offerId, 'DECLINED');
  }

  @override
  Future<void> cancelSwapOffer(String offerId) async {
    networkStatus.requireOnline();
    swapCancelCalls++;
    _setOfferStatus(offerId, 'CANCELLED');
  }

  Map<String, dynamic>? _findOffer(String id) {
    for (final o in swapOffers) {
      if (o['_id'] == id) return o;
    }
    for (final o in createdSwapOffers) {
      if (o['_id'] == id) return o;
    }
    return null;
  }

  void _setOfferStatus(String id, String status) {
    final offer = _findOffer(id);
    offer?['status'] = status;
  }

  @override
  Future<Map<String, dynamic>> updateTokenLocation({
    required String tokenId,
    required double latitude,
    required double longitude,
    double? accuracy,
    int? timestamp,
    String? centerId,
  }) async {
    networkStatus.requireOnline();
    locationUpdateCalls++;
    return proximity;
  }

  @override
  Future<Map<String, dynamic>> getTokenProximity(String tokenId) async {
    if (networkStatus.isOffline) {
      throw ApiException(message: 'connection error');
    }
    return proximity;
  }

  @override
  Future<void> registerDeviceToken(String fcmToken) async {
    networkStatus.requireOnline();
    if (deviceTokenError != null) throw deviceTokenError!;
    deviceTokenCalls++;
    registeredDeviceTokens.add(fcmToken);
  }

  @override
  Future<void> unregisterDeviceToken() async {}

  @override
  Future<Map<String, dynamic>> getNotifications({int page = 1, int limit = 30}) async {
    if (networkStatus.isOffline) {
      throw ApiException(message: 'connection error');
    }
    return notificationsResponse;
  }

  @override
  Future<void> markNotificationRead(String id) async {
    networkStatus.requireOnline();
    readNotificationIds.add(id);
  }

  @override
  Future<void> markAllNotificationsRead() async {
    networkStatus.requireOnline();
    markAllReadCalls++;
  }

  @override
  Future<Map<String, dynamic>> login({
    required String email,
    required String password,
  }) async {
    networkStatus.requireOnline();
    final clean = email.trim().toLowerCase();
    if (clean.isEmpty || password.isEmpty) {
      throw ApiException(message: 'Email and password must not be empty.');
    }
    if (loginError != null) throw loginError!;
    loginCalls++;
    return {
      'user': AppUser.fromJson(userJson(id: currentUserId, email: clean)),
      'token': 'jwt-for-$clean',
    };
  }

  @override
  Future<void> logout() async {
    networkStatus.requireOnline();
    logoutCalls++;
  }
}

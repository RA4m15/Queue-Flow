import 'package:dio/dio.dart';
import '../constants/api_constants.dart';
import '../../services/storage_service.dart';
import 'network_status.dart';

class DioClient {
  DioClient(this._storageService, {this.onUnauthorized, NetworkStatus? networkStatus})
      : networkStatus = networkStatus ?? NetworkStatus() {
    final reachability = this.networkStatus;
    _dio = Dio(
      BaseOptions(
        baseUrl: ApiConstants.baseUrl,
        connectTimeout: ApiConstants.connectTimeout,
        receiveTimeout: ApiConstants.receiveTimeout,
        sendTimeout: ApiConstants.connectTimeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      ),
    );

    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          // Do not inject Authorization header on unauthenticated auth routes
          final isPublicAuth = options.path.contains(ApiConstants.authRegister) ||
              options.path.contains(ApiConstants.authLogin);

          if (!isPublicAuth) {
            final token = await _storageService.getAuthToken();
            if (token != null && token.isNotEmpty) {
              options.headers['Authorization'] = 'Bearer $token';
            }
          }
          return handler.next(options);
        },
        onResponse: (response, handler) {
          // Any authoritative response proves the backend is reachable.
          reachability.markReachable();
          return handler.next(response);
        },
        onError: (DioException error, handler) async {
          final isPublicAuth = error.requestOptions.path.contains(ApiConstants.authRegister) ||
              error.requestOptions.path.contains(ApiConstants.authLogin);

          if (NetworkStatus.isTransportFailure(error) && !isPublicAuth) {
            reachability.markUnreachable();
          } else if (!isPublicAuth) {
            // A real server response (4xx/5xx) also proves reachability.
            reachability.markReachable();
          }

          if (error.response?.statusCode == 401 && !isPublicAuth) {
            // Expired or revoked JWT on protected resources - atomically purge local credentials
            await _storageService.clearAuth();
            try {
              onUnauthorized?.call();
            } catch (_) {}
          }
          return handler.next(error);
        },
      ),
    );
  }

  final StorageService _storageService;

  /// Shared reachability tracker, observed for every authenticated request.
  final NetworkStatus networkStatus;

  void Function()? onUnauthorized;
  late final Dio _dio;

  Dio get dio => _dio;
}

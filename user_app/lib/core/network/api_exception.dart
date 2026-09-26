import 'package:dio/dio.dart';

class ApiException implements Exception {
  ApiException({
    required this.message,
    this.statusCode,
    this.code,
  });

  final String message;
  final int? statusCode;
  final String? code;

  @override
  String toString() => message;

  factory ApiException.fromDioException(DioException e) {
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.sendTimeout ||
        e.type == DioExceptionType.receiveTimeout ||
        e.type == DioExceptionType.connectionError) {
      return ApiException(
        message: 'Unable to connect to QueueFlow server. Please check your internet connection.',
        statusCode: e.response?.statusCode,
      );
    }

    final statusCode = e.response?.statusCode;
    final data = e.response?.data;
    String? serverMessage;

    if (data is Map<String, dynamic>) {
      if (data['errors'] is List && (data['errors'] as List).isNotEmpty) {
        final firstErr = (data['errors'] as List).first;
        if (firstErr is Map && firstErr['message'] != null) {
          serverMessage = firstErr['message'].toString();
        } else if (firstErr is String) {
          serverMessage = firstErr;
        }
      }
      serverMessage ??= data['message']?.toString();
      if (serverMessage == null && data['error'] is Map) {
        serverMessage = data['error']['message']?.toString();
      }
    }

    switch (statusCode) {
      case 400:
        return ApiException(
          message: serverMessage ?? 'Invalid request. Please check your input and try again.',
          statusCode: 400,
        );
      case 401:
        return ApiException(
          message: serverMessage ?? 'Your session has expired or is invalid. Please sign in again.',
          statusCode: 401,
        );
      case 403:
        return ApiException(
          message: serverMessage ?? 'You do not have permission to perform this action.',
          statusCode: 403,
        );
      case 404:
        return ApiException(
          message: serverMessage ?? 'The requested item was not found.',
          statusCode: 404,
        );
      case 409:
        if (serverMessage != null && serverMessage.contains('already have an active token')) {
          return ApiException(
            message: 'You already have an active token for this queue.',
            statusCode: 409,
            code: 'ACTIVE_TOKEN_EXISTS',
          );
        }
        return ApiException(
          message: serverMessage ?? 'Conflict. An active token or resource already exists.',
          statusCode: 409,
        );
      case 422:
        return ApiException(
          message: serverMessage ?? 'Validation error. Please verify the entered data.',
          statusCode: 422,
        );
      case 429:
        return ApiException(
          message: 'Too many requests. Please wait a few minutes before trying again.',
          statusCode: 429,
        );
      case 500:
      case 502:
      case 503:
      case 504:
        return ApiException(
          message: 'The QueueFlow server is temporarily unavailable. Please try again in a moment.',
          statusCode: statusCode,
        );
      default:
        return ApiException(
          message: 'Unable to complete your request. Please try again.',
          statusCode: statusCode,
        );
    }
  }

  static String getUserMessage(dynamic error) {
    if (error is ApiException) {
      return error.message;
    }
    if (error is DioException) {
      return ApiException.fromDioException(error).message;
    }
    final str = error.toString();
    if (str.contains('SocketException') || str.contains('Failed host lookup') || str.contains('Network is unreachable')) {
      return 'Network connection error. Please verify your connection.';
    }
    return 'An unexpected error occurred. Please try again.';
  }
}

import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/storage_service.dart';
import '../core/network/dio_client.dart';
import '../services/api_service.dart';
import '../services/socket_service.dart';

// Core Services
final storageServiceProvider = Provider<StorageService>((ref) {
  return StorageService();
});

final dioClientProvider = Provider<DioClient>((ref) {
  final storageService = ref.watch(storageServiceProvider);
  return DioClient(storageService);
});

final apiServiceProvider = Provider<ApiService>((ref) {
  final dioClient = ref.watch(dioClientProvider);
  return ApiService(dioClient.dio);
});

final socketServiceProvider = Provider<SocketService>((ref) {
  final service = SocketService();
  ref.onDispose(() {
    service.disconnect();
  });
  return service;
});

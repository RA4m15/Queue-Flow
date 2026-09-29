import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/storage_service.dart';
import '../core/network/dio_client.dart';
import '../services/api_service.dart';
import '../services/fcm_service.dart';
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

final fcmServiceProvider = Provider<FcmService>((ref) {
  final apiService = ref.watch(apiServiceProvider);
  return FcmService(apiService);
});

final socketServiceProvider = Provider<SocketService>((ref) {
  final service = SocketService();
  ref.onDispose(() {
    service.disconnect();
  });
  return service;
});

/// Whether the QueueFlow backend is currently unreachable.
///
/// Derived entirely from real transport outcomes in [NetworkStatus] — never
/// from platform connectivity plugins, so it is only ever true when the
/// backend itself cannot be reached, not merely because Wi-Fi is off.
///
/// The initial value is read synchronously from [NetworkStatus.isOffline] so
/// the state is correct before the first stream event fires (e.g. when the
/// provider is first observed while already offline). The stream then keeps
/// it current for the lifetime of the widget subtree.
///
/// This is the canonical signal any screen can watch to refuse backend-
/// authoritative mutations while offline. It is deliberately separate from
/// [tokenProvider].isOffline, which carries a richer "I have a cached token
/// but cannot refresh it" semantic that only applies when a token is in play.
final networkOfflineProvider = StreamProvider<bool>((ref) async* {
  final networkStatus = ref.watch(apiServiceProvider).networkStatus;
  // Emit the current state synchronously so the first frame is correct.
  yield networkStatus.isOffline;
  // Then follow every subsequent transport verdict.
  await for (final online in networkStatus.onStatusChange) {
    yield !online;
  }
});

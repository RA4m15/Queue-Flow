import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/service_center.dart';
import '../models/service.dart';
import '../models/crowd_status.dart';
import '../models/queue_status.dart';
import 'app_providers.dart';

final serviceCentersProvider = FutureProvider.autoDispose<List<ServiceCenter>>((ref) async {
  final apiService = ref.watch(apiServiceProvider);
  return await apiService.getServiceCenters();
});

final serviceCenterDetailProvider = FutureProvider.autoDispose.family<Map<String, dynamic>, String>((ref, centerId) async {
  final apiService = ref.watch(apiServiceProvider);
  return await apiService.getServiceCenterDetail(centerId);
});

final centerServicesProvider = FutureProvider.autoDispose.family<List<Service>, String>((ref, centerId) async {
  final apiService = ref.watch(apiServiceProvider);
  return await apiService.getServices(centerId);
});

final centerCrowdProvider = FutureProvider.autoDispose.family<CrowdStatus, String>((ref, centerId) async {
  final apiService = ref.watch(apiServiceProvider);
  return await apiService.getCrowd(centerId);
});

final centerQueueStatusProvider = FutureProvider.autoDispose.family<List<QueueStatus>, String>((ref, centerId) async {
  final apiService = ref.watch(apiServiceProvider);
  return await apiService.getQueueStatus(centerId);
});

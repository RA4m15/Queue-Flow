import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/constants/api_constants.dart';
import 'package:user_app/models/service_center.dart';

void main() {
  group('Production Render Backend Integration Test', () {
    final dio = Dio(
      BaseOptions(
        baseUrl: ApiConstants.baseUrl,
        connectTimeout: const Duration(seconds: 30),
        receiveTimeout: const Duration(seconds: 30),
      ),
    );

    test('Reaches production backend and fetches real service centers', () async {
      final response = await dio.get(ApiConstants.serviceCenters);

      expect(response.statusCode, 200);
      expect(response.data, isA<Map<String, dynamic>>());

      final data = response.data['data'];
      expect(data, isNotNull);

      List rawList;
      if (data is Map && data.containsKey('centers')) {
        rawList = data['centers'] as List;
      } else if (data is List) {
        rawList = data;
      } else {
        rawList = [];
      }

      expect(rawList, isNotEmpty);

      // Verify that data parses correctly into our ServiceCenter domain model
      final centers = rawList.map((c) => ServiceCenter.fromJson(c as Map<String, dynamic>)).toList();
      expect(centers.first.name, isNotEmpty);
      expect(centers.first.id, isNotEmpty);
      expect(centers.first.code, isNotEmpty);
    });

    test('Fetches queue status for first service center', () async {
      final centersRes = await dio.get(ApiConstants.serviceCenters);
      final rawList = (centersRes.data['data']['centers'] as List?) ?? [];
      if (rawList.isNotEmpty) {
        final firstCenterId = rawList.first['_id'];
        final queueRes = await dio.get('${ApiConstants.queue}/$firstCenterId');
        expect(queueRes.statusCode, 200);
      }
    });
  });
}

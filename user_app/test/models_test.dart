import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/models/user.dart';
import 'package:user_app/models/service_center.dart';
import 'package:user_app/models/service.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/models/queue_status.dart';
import 'package:user_app/models/crowd_status.dart';
import 'package:user_app/models/notification.dart';

void main() {
  group('Models Unit Tests', () {
    test('AppUser fromJson parses correctly', () {
      final json = {
        '_id': 'u123',
        'name': 'Alice Customer',
        'email': 'alice@example.com',
        'role': 'CUSTOMER',
        'phone': '1234567890',
      };

      final user = AppUser.fromJson(json);
      expect(user.id, 'u123');
      expect(user.name, 'Alice Customer');
      expect(user.email, 'alice@example.com');
      expect(user.isCustomer, true);
      expect(user.isAdmin, false);
      expect(user.phone, '1234567890');
    });

    test('ServiceCenter fromJson and crowdStatus', () {
      final json = {
        '_id': 'sc001',
        'name': 'Downtown Hospital',
        'code': 'DTH-01',
        'type': 'HOSPITAL',
        'isOpen': true,
        'capacity': 100,
        'currentCrowd': 85,
        'crowdThresholds': {'moderate': 50, 'high': 80},
        'address': {
          'street': '123 Health Ave',
          'city': 'Metropolis',
          'state': 'NY',
          'zip': '10001',
        },
      };

      final center = ServiceCenter.fromJson(json);
      expect(center.id, 'sc001');
      expect(center.typeEmoji, '🏥');
      expect(center.crowdStatus, 'HIGH');
      expect(center.isOpen, true);
      expect(center.address?.city, 'Metropolis');
    });

    test('Service fromJson parses correctly', () {
      final json = {
        '_id': 'srv01',
        'name': 'General Consultation',
        'code': 'GEN-CONS',
        'centerId': 'sc001',
        'isActive': true,
        'prefix': 'A',
        'estimatedDuration': 15,
      };

      final service = Service.fromJson(json);
      expect(service.id, 'srv01');
      expect(service.name, 'General Consultation');
      expect(service.prefix, 'A');
      expect(service.estimatedDuration, 15);
      expect(service.isActive, true);
    });

    test('TokenModel lifecycle properties and states', () {
      final json = {
        '_id': 'tok999',
        'tokenCode': 'A-047',
        'tokenNumber': 47,
        'userId': 'u123',
        'centerId': {'_id': 'sc001', 'name': 'Downtown Hospital'},
        'serviceId': {'_id': 'srv01', 'name': 'General Consultation'},
        'counterId': {'_id': 'cnt1', 'name': 'Counter 3', 'number': 3},
        'status': 'CALLED',
        'initialPosition': 5,
        'currentPosition': 1,
        'waitEstimateMinutes': 2,
        'calledAt': '2026-09-21T18:00:00.000Z',
      };

      final token = TokenModel.fromJson(json);
      expect(token.id, 'tok999');
      expect(token.tokenCode, 'A-047');
      expect(token.centerName, 'Downtown Hospital');
      expect(token.serviceName, 'General Consultation');
      expect(token.counterName, 'Counter 3');
      expect(token.isCalled, true);
      expect(token.isActive, true);
      expect(token.canCancel, false); // can only cancel when WAITING
    });

    test('QueueStatus fromJson parses correctly', () {
      final json = {
        'service': {
          '_id': 'srv01',
          'name': 'General Consultation',
          'tokenPrefix': 'A',
        },
        'status': 'OPEN',
        'waitingCount': 7,
        'activeCount': 2,
        'completedCount': 25,
        'totalIssued': 34,
        'avgServiceTimeSeconds': 600,
      };

      final queue = QueueStatus.fromJson(json);
      expect(queue.serviceId, 'srv01');
      expect(queue.serviceName, 'General Consultation');
      expect(queue.waitingCount, 7);
      expect(queue.completedCount, 25);
      expect(queue.avgServiceTimeMinutes, 10);
    });

    test('CrowdStatus calculation and thresholds', () {
      final json = {
        'centerId': 'sc001',
        'name': 'Downtown Hospital',
        'currentCrowd': 45,
        'capacity': 100,
        'crowdPercent': 45,
        'crowdStatus': 'LOW',
      };

      final crowd = CrowdStatus.fromJson(json);
      expect(crowd.currentCrowd, 45);
      expect(crowd.capacity, 100);
      expect(crowd.crowdPercent, 45);
      expect(crowd.crowdStatus, 'LOW');
    });

    test('NotificationModel fromJson parses correctly', () {
      final json = {
        '_id': 'notif01',
        'userId': 'u123',
        'type': 'TOKEN_CALLED',
        'title': 'Your Turn!',
        'body': 'Token A-047 — Please proceed to Counter 3',
        'isRead': false,
        'createdAt': '2026-09-21T18:01:00.000Z',
      };

      final notif = NotificationModel.fromJson(json);
      expect(notif.id, 'notif01');
      expect(notif.type, 'TOKEN_CALLED');
      expect(notif.title, 'Your Turn!');
      expect(notif.isRead, false);
    });
  });
}

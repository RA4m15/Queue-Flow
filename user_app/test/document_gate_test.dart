import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/constants/api_constants.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/document_readiness.dart';
import 'package:user_app/providers/document_gate_provider.dart';
import 'package:user_app/services/socket_service.dart';

import 'harness.dart';

/// Document Gate behaviour.
///
/// Every payload below is shaped exactly like the backend response of
/// `GET /api/documents/services/:serviceId/readiness`
/// (`backend/src/services/documentGateService.js#checkServiceReadiness`).
/// The Flutter client must never compute readiness itself: it renders the
/// server verdict and the server checklist verbatim.
Map<String, dynamic> readinessPayload({
  required String status,
  required bool isReady,
  String? message,
  List<Map<String, dynamic>> checklist = const [],
  List<Map<String, dynamic>> missing = const [],
}) {
  return {
    'isReady': isReady,
    'status': status,
    'message': message,
    'checklist': checklist,
    'missingRequirements': missing,
    'serviceId': kServiceId,
  };
}

/// One `checklist[]` entry as emitted by the backend gate.
Map<String, dynamic> checklistItem({
  String documentType = 'AADHAAR',
  String name = 'Aadhaar Card',
  bool isRequired = true,
  bool verificationRequired = true,
  String customerStatus = 'NOT_UPLOADED',
  String? rejectionReason,
  DateTime? uploadedAt,
  DateTime? verifiedAt,
}) {
  return {
    'requirementId': '507f1f77bcf86cd7994390d1',
    'documentType': documentType,
    'name': name,
    'description': '',
    'isRequired': isRequired,
    'verificationRequired': verificationRequired,
    'customerStatus': customerStatus,
    'customerDocument': customerStatus == 'NOT_UPLOADED'
        ? null
        : {
            '_id': '507f1f77bcf86cd7994390d2',
            'fileName': 'doc.pdf',
            'mimeType': 'application/pdf',
            'fileSizeBytes': 1024,
            'status': customerStatus,
            'uploadedAt': (uploadedAt ?? DateTime(2026, 9, 25)).toIso8601String(),
            'verifiedAt': verifiedAt?.toIso8601String(),
            'rejectedAt': null,
            'rejectionReason': rejectionReason,
          },
  };
}

void main() {
  late FakeApiService api;
  late SocketService socket;
  late NetworkStatus network;

  setUp(() {
    network = NetworkStatus();
    api = FakeApiService(Dio(), networkStatus: network);
    socket = SocketService();
  });

  tearDown(() => network.dispose());

  DocumentGateNotifier build() =>
      DocumentGateNotifier(apiService: api, socketService: socket);

  group('Document Gate — parsing the authoritative backend verdict', () {
    test('REQUIREMENTS_NOT_CONFIGURED is ready and renders an empty checklist', () async {
      api.readiness = readinessPayload(
        status: 'REQUIREMENTS_NOT_CONFIGURED',
        isReady: true,
        message: 'Requirements not configured',
      );

      final gate = build();
      final readiness = await gate.check(kServiceId);

      expect(readiness.status, 'REQUIREMENTS_NOT_CONFIGURED');
      expect(readiness.isReady, isTrue);
      expect(readiness.isNotRequired, isTrue);
      expect(readiness.hasRequirements, isFalse);
      expect(readiness.checklist, isEmpty);
      expect(readiness.missingRequirements, isEmpty);
      expect(readiness.hasBlockingRequirement, isFalse);
      expect(gate.state.canJoin, isTrue);
    });

    test('NOT_REQUIRED is ready even when optional documents are listed', () async {
      api.readiness = readinessPayload(
        status: 'NOT_REQUIRED',
        isReady: true,
        message: 'No mandatory documents required for this service',
        checklist: [
          checklistItem(
            documentType: 'PASSPORT',
            name: 'Passport (optional)',
            isRequired: false,
            customerStatus: 'NOT_UPLOADED',
          ),
        ],
      );

      final readiness = await build().check(kServiceId);

      expect(readiness.status, 'NOT_REQUIRED');
      expect(readiness.isReady, isTrue);
      expect(readiness.checklist, hasLength(1));
      // An optional, unuploaded document must never gate the queue.
      expect(readiness.checklist.first.isBlocking, isFalse);
      expect(readiness.hasBlockingRequirement, isFalse);
      expect(readiness.missingItems, isEmpty);
    });

    test('INCOMPLETE blocks the join and names the missing requirement', () async {
      api.readiness = readinessPayload(
        status: 'INCOMPLETE',
        isReady: false,
        message: 'Missing required documentation',
        checklist: [
          checklistItem(
            documentType: 'AADHAAR',
            name: 'Aadhaar Card',
            customerStatus: 'NOT_UPLOADED',
          ),
        ],
        missing: [
          {
            'documentType': 'AADHAAR',
            'name': 'Aadhaar Card',
            'reason': 'Document not uploaded',
          },
        ],
      );

      final gate = build();
      final readiness = await gate.check(kServiceId);

      expect(readiness.isReady, isFalse);
      expect(readiness.hasBlockingRequirement, isTrue);
      expect(readiness.missingItems, hasLength(1));
      expect(readiness.missingItems.first.documentType, 'AADHAAR');
      expect(readiness.missingItems.first.isMissing, isTrue);
      expect(readiness.missingRequirements.first['reason'], 'Document not uploaded');
      expect(gate.state.canJoin, isFalse);
    });

    test('PENDING_VERIFICATION blocks the join until staff verify', () async {
      api.readiness = readinessPayload(
        status: 'PENDING_VERIFICATION',
        isReady: false,
        message: 'Required documents are pending verification by service staff',
        checklist: [
          checklistItem(
            documentType: 'AADHAAR',
            name: 'Aadhaar Card',
            customerStatus: 'PENDING',
          ),
        ],
      );

      final readiness = await build().check(kServiceId);

      expect(readiness.status, 'PENDING_VERIFICATION');
      expect(readiness.isReady, isFalse);
      expect(readiness.pendingItems, hasLength(1));
      expect(readiness.pendingItems.first.isPending, isTrue);
      expect(readiness.hasBlockingRequirement, isTrue);
    });

    test('REJECTED blocks the join and surfaces the staff rejection reason', () async {
      api.readiness = readinessPayload(
        status: 'REJECTED',
        isReady: false,
        message: 'One or more required documents were rejected. Please re-upload.',
        checklist: [
          checklistItem(
            documentType: 'AADHAAR',
            name: 'Aadhaar Card',
            customerStatus: 'REJECTED',
            rejectionReason: 'Image is not legible',
          ),
        ],
      );

      final readiness = await build().check(kServiceId);

      expect(readiness.status, 'REJECTED');
      expect(readiness.isReady, isFalse);
      expect(readiness.rejectedItems, hasLength(1));
      expect(
        readiness.checklist.first.rejectionReason,
        'Image is not legible',
      );
      expect(readiness.hasBlockingRequirement, isTrue);
    });

    test('READY permits the join when every required document is verified', () async {
      api.readiness = readinessPayload(
        status: 'READY',
        isReady: true,
        message: 'All required documentation satisfied',
        checklist: [
          checklistItem(
            documentType: 'AADHAAR',
            name: 'Aadhaar Card',
            customerStatus: 'VERIFIED',
            verifiedAt: DateTime(2026, 9, 25, 10),
          ),
          checklistItem(
            documentType: 'ADDRESS_PROOF',
            name: 'Address Proof',
            isRequired: false,
            customerStatus: 'NOT_UPLOADED',
          ),
        ],
      );

      final gate = build();
      final readiness = await gate.check(kServiceId);

      expect(readiness.status, 'READY');
      expect(readiness.isReady, isTrue);
      expect(readiness.checklist, hasLength(2));
      expect(readiness.missingItems, isEmpty, reason: 'the missing one is optional');
      expect(readiness.hasBlockingRequirement, isFalse);
      expect(gate.state.canJoin, isTrue);
    });

    test('an unknown backend status fails closed rather than permitting a join', () async {
      api.readiness = {'isReady': true, 'message': 'no status field'};

      final gate = build();
      final readiness = await gate.check(kServiceId);

      // Missing `status` cannot be interpreted, so the verdict is unavailable.
      expect(readiness.status, 'UNAVAILABLE');
      expect(readiness.isReady, isFalse);
      expect(gate.state.canJoin, isFalse);
    });

    test('a null response is treated as unavailable and fails closed', () async {
      final readiness = DocumentReadiness.fromJson(null);
      expect(readiness.status, 'UNAVAILABLE');
      expect(readiness.isReady, isFalse);
      expect(DocumentReadiness.unavailable.isReady, isFalse);
    });
  });

  group('Document Gate — customer-facing copy is derived from the backend status', () {
    test('each backend status maps to a distinct label and description', () {
      final cases = <String, String>{
        DocumentReadiness.ready: 'Document Gate: Verified',
        DocumentReadiness.requirementsNotConfigured: 'Document Gate: Not Configured',
        DocumentReadiness.notRequired: 'Document Gate: Not Required',
        DocumentReadiness.incomplete: 'Document Gate: Documents Missing',
        DocumentReadiness.pendingVerification: 'Document Gate: Verification Pending',
        DocumentReadiness.rejected: 'Document Gate: Documents Rejected',
        'SOMETHING_ELSE': 'Document Gate: Unavailable',
      };

      cases.forEach((status, label) {
        final r = DocumentReadiness(status: status, isReady: false);
        expect(r.statusLabel, label, reason: 'status $status');
      });
    });

    test('the backend message is preferred over the local fallback copy', () {
      final r = DocumentReadiness(
        status: DocumentReadiness.incomplete,
        isReady: false,
        message: 'Missing required documentation',
      );
      expect(r.statusDescription, 'Missing required documentation');
    });

    test('a fallback description is used when the backend sends no message', () {
      final r = DocumentReadiness(status: DocumentReadiness.incomplete, isReady: false);
      expect(
        r.statusDescription,
        'Upload the required documents before joining this queue.',
      );
    });
  });

  group('Document Gate — realtime re-validation', () {
    test('a document.verified socket event re-checks the gate with the backend', () async {
      api.readiness = readinessPayload(
        status: 'PENDING_VERIFICATION',
        isReady: false,
        message: 'Required documents are pending verification by service staff',
        checklist: [checklistItem(customerStatus: 'PENDING')],
      );

      final gate = build();
      await gate.check(kServiceId);
      expect(gate.state.canJoin, isFalse);
      final callsBefore = api.readinessCalls;

      // Staff approves the document; the socket event carries no verdict, so
      // the client must ask the backend again instead of patching local state.
      api.readiness = readinessPayload(
        status: 'READY',
        isReady: true,
        message: 'All required documentation satisfied',
        checklist: [checklistItem(customerStatus: 'VERIFIED')],
      );
      socket.handleEventForTesting(ApiConstants.eventDocumentVerified, {
        'documentType': 'AADHAAR',
        'status': 'VERIFIED',
      });
      await pumpEventQueue();

      expect(api.readinessCalls, greaterThan(callsBefore));
      expect(gate.state.readiness.status, 'READY');
      expect(gate.state.canJoin, isTrue);
    });

    test('a document.rejected event re-checks and keeps the join blocked', () async {
      api.readiness = readinessPayload(
        status: 'READY',
        isReady: true,
        message: 'All required documentation satisfied',
        checklist: [checklistItem(customerStatus: 'VERIFIED')],
      );

      final gate = build();
      await gate.check(kServiceId);
      expect(gate.state.canJoin, isTrue);

      api.readiness = readinessPayload(
        status: 'REJECTED',
        isReady: false,
        message: 'One or more required documents were rejected. Please re-upload.',
        checklist: [checklistItem(customerStatus: 'REJECTED')],
      );
      socket.handleEventForTesting(ApiConstants.eventDocumentRejected, {
        'documentType': 'AADHAAR',
        'status': 'REJECTED',
      });
      await pumpEventQueue();

      expect(gate.state.readiness.status, 'REJECTED');
      expect(gate.state.canJoin, isFalse);
    });

    test('a socket reconnect re-checks the cached verdict', () async {
      api.readiness = readinessPayload(status: 'READY', isReady: true);

      final gate = build();
      await gate.check(kServiceId);
      final callsBefore = api.readinessCalls;

      socket.handleConnectForTesting();
      await pumpEventQueue();

      expect(api.readinessCalls, greaterThan(callsBefore));
    });

    test('a document event for an unloaded service does not trigger a request', () async {
      final gate = build();
      final callsBefore = api.readinessCalls;

      socket.handleEventForTesting(ApiConstants.eventDocumentUpdated, {'documentType': 'AADHAAR'});
      await pumpEventQueue();

      expect(api.readinessCalls, callsBefore);
      expect(gate.state.readiness.status, 'UNAVAILABLE');
    });
  });

  group('Document Gate — server failure fails closed', () {
    test('a failed refresh keeps the last verdict but marks it stale', () async {
      api.readiness = readinessPayload(status: 'READY', isReady: true);

      final gate = build();
      await gate.check(kServiceId);
      expect(gate.state.canJoin, isTrue);
      expect(gate.state.isStale, isFalse);

      // The backend becomes unreachable mid-session.
      network.markUnreachable();
      await gate.refresh(kServiceId, silent: true);

      expect(gate.state.isStale, isTrue);
      // The previously confirmed verdict is still on screen, but it is no
      // longer allowed to authorise a join.
      expect(gate.state.readiness.status, 'READY');
      expect(gate.state.canJoin, isFalse);
      expect(gate.state.error, isNotNull);
    });

    test('clear() resets the gate to a non-joining state', () async {
      api.readiness = readinessPayload(status: 'READY', isReady: true);

      final gate = build();
      await gate.check(kServiceId);
      expect(gate.state.canJoin, isTrue);

      gate.clear();

      expect(gate.state.readiness.isReady, isFalse);
      expect(gate.state.canJoin, isFalse);
      expect(gate.state.fetchedAt, isNull);
    });

    test('the gate never reports ready while the backend is unreachable', () async {
      network.markUnreachable();
      final gate = build();

      final readiness = await gate.check(kServiceId);

      expect(readiness.isReady, isFalse);
      expect(gate.state.canJoin, isFalse);
      expect(gate.state.isStale, isTrue);
      expect(api.readinessCalls, 0, reason: 'no request is made while offline');
    });
  });

  group('Document Gate — upload path is server acknowledged', () {
    test('a document upload only records the file the backend accepted', () async {
      final gate = build();
      await gate.check(kServiceId);

      final result = await api.uploadCustomerDocument(
        serviceId: kServiceId,
        documentType: 'AADHAAR',
        fileName: 'aadhaar.pdf',
        mimeType: 'application/pdf',
        base64Data: 'JVBERi0xLjQK',
      );

      expect(api.documentUploadCalls, 1);
      expect(result['documentType'], 'AADHAAR');
      expect(result['fileName'], 'aadhaar.pdf');
      // The gate verdict is unchanged until the backend re-states it.
      expect(api.uploadedDocument!['serviceId'], kServiceId);
    });

    test('an offline upload is refused with the truthful connectivity message', () async {
      network.markUnreachable();
      await expectLater(
        api.uploadCustomerDocument(
          serviceId: kServiceId,
          documentType: 'AADHAAR',
          fileName: 'aadhaar.pdf',
          mimeType: 'application/pdf',
          base64Data: 'JVBERi0xLjQK',
        ),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'This action requires an internet connection.',
          ),
        ),
      );
      expect(api.documentUploadCalls, 0);
    });
  });
}

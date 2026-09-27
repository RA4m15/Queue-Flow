/// Authoritative Document Gate state.
///
/// Every field is sourced verbatim from the backend
/// `GET /api/documents/services/:serviceId/readiness` response
/// (see `backend/src/services/documentGateService.js#checkServiceReadiness`).
/// Readiness is NEVER computed in Dart — the client only renders the
/// server verdict and the server checklist it ships with it.
library;

/// One entry of the backend `checklist` array.
class DocumentRequirementItem {
  const DocumentRequirementItem({
    required this.documentType,
    required this.name,
    this.description = '',
    this.isRequired = false,
    this.verificationRequired = true,
    this.customerStatus = DocumentReadiness.notUploaded,
    this.rejectionReason,
    this.uploadedAt,
    this.verifiedAt,
  });

  final String documentType;
  final String name;
  final String description;
  final bool isRequired;
  final bool verificationRequired;

  /// Backend `CustomerDocument.status`: NOT_UPLOADED | UPLOADED | PENDING |
  /// VERIFIED | REJECTED.
  final String customerStatus;

  final String? rejectionReason;
  final DateTime? uploadedAt;
  final DateTime? verifiedAt;

  bool get isMissing => customerStatus == DocumentReadiness.notUploaded;
  bool get isPending => customerStatus == 'PENDING' || customerStatus == 'UPLOADED';
  bool get isRejected => customerStatus == 'REJECTED';
  bool get isVerified => customerStatus == 'VERIFIED';

  /// True when this requirement is mandatory and not yet satisfied.
  bool get isBlocking =>
      isRequired && (isMissing || isPending || isRejected);

  factory DocumentRequirementItem.fromJson(Map<String, dynamic> json) {
    final doc = json['customerDocument'];
    final docMap = doc is Map ? Map<String, dynamic>.from(doc) : null;
    return DocumentRequirementItem(
      documentType: (json['documentType'] ?? '').toString(),
      name: (json['name'] ?? json['documentType'] ?? '').toString(),
      description: (json['description'] ?? '').toString(),
      isRequired: json['isRequired'] == true,
      verificationRequired: json['verificationRequired'] != false,
      customerStatus: (json['customerStatus'] ?? DocumentReadiness.notUploaded).toString(),
      rejectionReason: (docMap?['rejectionReason'])?.toString(),
      uploadedAt: _parseDate(docMap?['uploadedAt']),
      verifiedAt: _parseDate(docMap?['verifiedAt']),
    );
  }
}

class DocumentReadiness {
  const DocumentReadiness({
    required this.status,
    required this.isReady,
    this.message,
    this.checklist = const [],
    this.missingRequirements = const [],
  });

  /// `REQUIREMENTS_NOT_CONFIGURED`
  static const String requirementsNotConfigured = 'REQUIREMENTS_NOT_CONFIGURED';

  /// `NOT_REQUIRED`
  static const String notRequired = 'NOT_REQUIRED';

  /// `INCOMPLETE`
  static const String incomplete = 'INCOMPLETE';

  /// `PENDING_VERIFICATION`
  static const String pendingVerification = 'PENDING_VERIFICATION';

  /// `READY`
  static const String ready = 'READY';

  /// `REJECTED`
  static const String rejected = 'REJECTED';

  /// Backend `CustomerDocument.status` sentinel for an absent upload.
  static const String notUploaded = 'NOT_UPLOADED';

  final String status;

  /// The backend's own `isReady` verdict. This is the only gate the client
  /// treats as authoritative; the server re-checks it on join regardless.
  final bool isReady;

  final String? message;
  final List<DocumentRequirementItem> checklist;
  final List<Map<String, dynamic>> missingRequirements;

  /// True when the service actually declares document requirements.
  bool get hasRequirements =>
      status != requirementsNotConfigured && checklist.isNotEmpty;

  /// A requirement blocks joining only when it is mandatory AND unsatisfied.
  /// Optional requirements never gate the queue.
  bool get hasBlockingRequirement =>
      checklist.any((r) => r.isBlocking);

  List<DocumentRequirementItem> get missingItems =>
      checklist.where((r) => r.isRequired && r.isMissing).toList();

  List<DocumentRequirementItem> get pendingItems =>
      checklist.where((r) => r.isRequired && r.isPending).toList();

  List<DocumentRequirementItem> get rejectedItems =>
      checklist.where((r) => r.isRequired && r.isRejected).toList();

  /// True when the service declares no mandatory documents at all.
  bool get isNotRequired =>
      status == notRequired || status == requirementsNotConfigured;

  /// Customer-facing gate headline derived from the backend status enum.
  String get statusLabel {
    switch (status) {
      case ready:
        return 'Document Gate: Verified';
      case requirementsNotConfigured:
        return 'Document Gate: Not Configured';
      case notRequired:
        return 'Document Gate: Not Required';
      case incomplete:
        return 'Document Gate: Documents Missing';
      case pendingVerification:
        return 'Document Gate: Verification Pending';
      case rejected:
        return 'Document Gate: Documents Rejected';
      default:
        return 'Document Gate: Unavailable';
    }
  }

  String get statusDescription {
    if (message != null && message!.trim().isNotEmpty) return message!;
    switch (status) {
      case ready:
        return 'All required documentation is verified by the service center.';
      case requirementsNotConfigured:
        return 'This service has no document requirements configured.';
      case notRequired:
        return 'This service does not require any mandatory documents.';
      case incomplete:
        return 'Upload the required documents before joining this queue.';
      case pendingVerification:
        return 'Your documents are awaiting verification by service staff.';
      case rejected:
        return 'One or more documents were rejected. Please re-upload them.';
      default:
        return 'Document requirements are currently unavailable.';
    }
  }

  /// True when the verdict itself could not be obtained (network failure).
  /// Callers must treat this as "do not join" rather than "ready".
  static const DocumentReadiness unavailable = DocumentReadiness(
    status: 'UNAVAILABLE',
    isReady: false,
    message: 'Document readiness could not be verified.',
  );

  factory DocumentReadiness.fromJson(Map<String, dynamic>? json) {
    if (json == null) return unavailable;

    final status = (json['status'] ?? '').toString();
    final isReady = json['isReady'] == true;

    // REQUIREMENTS_NOT_CONFIGURED legitimately ships an empty checklist.
    if (status.isEmpty) return unavailable;

    final rawChecklist = (json['checklist'] as List?) ?? const [];
    final checklist = rawChecklist
        .whereType<Map>()
        .map((e) => DocumentRequirementItem.fromJson(Map<String, dynamic>.from(e)))
        .toList();

    final rawMissing = (json['missingRequirements'] as List?) ?? const [];
    final missing = rawMissing
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();

    return DocumentReadiness(
      status: status,
      isReady: isReady,
      message: json['message']?.toString(),
      checklist: checklist,
      missingRequirements: missing,
    );
  }
}

DateTime? _parseDate(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}

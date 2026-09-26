class QueueStatus {
  const QueueStatus({
    required this.serviceId,
    required this.serviceName,
    required this.waitingCount,
    required this.activeCount,
    required this.completedCount,
    required this.totalIssued,
    this.tokenPrefix,
    this.status = 'OPEN',
    this.avgServiceTimeMinutes,
    this.estimatedWaitMinutes,
  });

  final String serviceId;
  final String serviceName;
  final int waitingCount;
  final int activeCount;
  final int completedCount;
  final int totalIssued;
  final String? tokenPrefix;
  final String status;
  final int? avgServiceTimeMinutes;

  /// Server-authoritative Estimated Wait Time in minutes.
  ///
  /// Tier 3 / Feature 1: the backend context-aware EWT engine owns this number.
  /// The client MUST render it as-is and MUST NOT derive a second estimate from
  /// [avgServiceTimeMinutes] or [waitingCount].
  final int? estimatedWaitMinutes;

  factory QueueStatus.fromJson(Map<String, dynamic> json) {
    // Handle both /api/queue/:centerId array items and /api/queue/:centerId/:serviceId objects
    final serviceObj = json['service'] ?? json['serviceId'];
    String sId = '';
    String sName = 'Service';
    String? sPrefix;
    int? sAvg;

    if (serviceObj is Map) {
      sId = (serviceObj['_id'] ?? serviceObj['id'] ?? '').toString();
      sName = (serviceObj['name'] ?? 'Service').toString();
      sPrefix = serviceObj['tokenPrefix']?.toString();
      sAvg = (serviceObj['avgServiceTimeMinutes'] as num?)?.toInt();
    } else if (serviceObj != null) {
      sId = serviceObj.toString();
    }

    final avgSecs = (json['avgServiceTimeSeconds'] as num?)?.toInt();
    if (avgSecs != null && avgSecs > 0) {
      sAvg = (avgSecs / 60).ceil();
    }

    return QueueStatus(
      serviceId: sId,
      serviceName: sName,
      waitingCount: (json['waitingCount'] as num?)?.toInt() ?? 0,
      activeCount: (json['activeCount'] as num?)?.toInt() ?? 0,
      completedCount: (json['completedCount'] as num?)?.toInt() ?? 0,
      totalIssued: (json['totalIssued'] as num?)?.toInt() ?? 0,
      tokenPrefix: sPrefix,
      status: (json['status'] ?? 'OPEN').toString(),
      avgServiceTimeMinutes: sAvg,
      estimatedWaitMinutes: (json['estimatedWaitMinutes'] as num?)?.toInt(),
    );
  }
}

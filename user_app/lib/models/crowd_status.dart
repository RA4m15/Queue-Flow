class CrowdStatus {
  const CrowdStatus({
    required this.centerId,
    required this.name,
    required this.currentCrowd,
    required this.capacity,
    required this.crowdPercent,
    required this.crowdStatus,
    this.capacityAlertThreshold = 90,
  });

  final String centerId;
  final String name;
  final int currentCrowd;
  final int capacity;
  final int crowdPercent;
  final String crowdStatus; // LOW, MODERATE, HIGH, CRITICAL, UNKNOWN
  final int capacityAlertThreshold;

  bool get hasCapacity => capacity > 0;

  factory CrowdStatus.fromJson(Map<String, dynamic> json) {
    final current = (json['currentCrowd'] as num?)?.toInt() ?? 0;
    final cap = (json['capacity'] as num?)?.toInt() ?? 0;
    final int pct;
    if (json['crowdPercent'] != null) {
      pct = (json['crowdPercent'] as num).toInt();
    } else if (cap > 0) {
      pct = ((current / cap) * 100).round();
    } else {
      pct = 0;
    }

    String status = (json['crowdStatus'] ?? '').toString();
    if (status.isEmpty) {
      if (cap > 0) {
        status = pct >= 80 ? 'HIGH' : pct >= 50 ? 'MODERATE' : 'LOW';
      } else {
        status = 'UNKNOWN';
      }
    }

    return CrowdStatus(
      centerId: (json['centerId'] ?? '').toString(),
      name: (json['name'] ?? '').toString(),
      currentCrowd: current,
      capacity: cap,
      crowdPercent: pct,
      crowdStatus: status,
      capacityAlertThreshold: (json['capacityAlertThreshold'] as num?)?.toInt() ?? 90,
    );
  }
}

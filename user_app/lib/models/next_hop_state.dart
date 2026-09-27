/// Authoritative Service Graph state for a customer's completed hop.
///
/// Mirrors `backend/src/services/serviceGraphService.js#getNextServicesForToken`.
/// The client never infers graph transitions: if the backend reports
/// `hasNextService: false`, no next hop is presented, and if the payload
/// cannot be fetched the state is reported as unavailable/stale.
library;

class NextServiceCandidate {
  const NextServiceCandidate({
    required this.serviceId,
    required this.name,
    this.description = '',
    this.tokenPrefix,
    this.avgServiceTimeMinutes,
  });

  final String serviceId;
  final String name;
  final String description;
  final String? tokenPrefix;
  final int? avgServiceTimeMinutes;

  factory NextServiceCandidate.fromJson(Map<String, dynamic> json) {
    final service = json['targetService'] is Map
        ? Map<String, dynamic>.from(json['targetService'] as Map)
        : json['service'] is Map
            ? Map<String, dynamic>.from(json['service'] as Map)
            : <String, dynamic>{};

    final rawId = json['targetServiceId'] ?? service['_id'] ?? json['serviceId'];
    return NextServiceCandidate(
      serviceId: rawId is Map ? (rawId['_id'] ?? '').toString() : (rawId ?? '').toString(),
      name: (json['name'] ?? service['name'] ?? '').toString(),
      description: (json['description'] ?? service['description'] ?? '').toString(),
      tokenPrefix: (json['tokenPrefix'] ?? service['tokenPrefix'])?.toString(),
      avgServiceTimeMinutes:
          (json['avgServiceTimeMinutes'] ?? service['avgServiceTimeMinutes']) is num
              ? ((json['avgServiceTimeMinutes'] ?? service['avgServiceTimeMinutes']) as num).toInt()
              : null,
    );
  }
}

class NextHopState {
  const NextHopState({
    required this.tokenStatus,
    this.hasNextService = false,
    this.canTransition = false,
    this.alreadyTransitioned = false,
    this.nextServices = const [],
    this.journeyHop = 0,
    this.journeyTotal = 0,
    this.message,
  });

  /// Backend status of the token the graph was evaluated for.
  final String tokenStatus;

  final bool hasNextService;
  final bool canTransition;
  final bool alreadyTransitioned;
  final List<NextServiceCandidate> nextServices;

  /// 1-based position of this hop within the journey, as reported by backend.
  final int journeyHop;
  final int journeyTotal;

  final String? message;

  bool get isJourney => journeyTotal > 1;

  bool get hasCandidate => nextServices.isNotEmpty;

  factory NextHopState.fromJson(Map<String, dynamic>? json) {
    if (json == null) {
      return const NextHopState(
        tokenStatus: 'UNKNOWN',
        message: 'Next service data is unavailable.',
      );
    }

    final raw = (json['nextServices'] as List?) ?? const [];
    final candidates = raw
        .whereType<Map>()
        .map((e) => NextServiceCandidate.fromJson(Map<String, dynamic>.from(e)))
        .where((c) => c.serviceId.isNotEmpty)
        .toList();

    return NextHopState(
      tokenStatus: (json['status'] ?? 'UNKNOWN').toString(),
      hasNextService: json['hasNextService'] == true,
      canTransition: json['canTransition'] == true,
      alreadyTransitioned: json['alreadyTransitioned'] == true,
      nextServices: candidates,
      journeyHop: (json['journeyHop'] as num?)?.toInt() ?? 0,
      journeyTotal: (json['journeyTotal'] as num?)?.toInt() ?? 0,
      message: json['message']?.toString(),
    );
  }
}

class Service {
  const Service({
    required this.id,
    required this.name,
    required this.code,
    required this.centerId,
    required this.isActive,
    this.prefix,
    this.estimatedDuration,
    this.description,
    this.priorityAllowed = false,
  });

  final String id;
  final String name;
  final String code;
  final String centerId;
  final bool isActive;
  final String? prefix;
  final int? estimatedDuration;
  final String? description;
  final bool priorityAllowed;

  /// The backend's own field name for [prefix] (`Service.tokenPrefix`).
  ///
  /// Read directly so the "A-104" style token codes the customer sees always
  /// come from the one token sequence the server maintains.
  String? get tokenPrefix => prefix;

  /// The backend's own field name for [estimatedDuration]
  /// (`Service.avgServiceTimeMinutes`).
  ///
  /// This is the service's configured average handling time. It is NOT a wait
  /// estimate — only the backend's EWT engine may produce one of those.
  int? get avgServiceTimeMinutes => estimatedDuration;

  /// Whether the backend currently accepts new queue entries for this service.
  bool get isJoinable => isActive;

  factory Service.fromJson(Map<String, dynamic> json) {
    // The backend `Service` model names these `tokenPrefix` and
    // `avgServiceTimeMinutes`. The legacy `prefix` / `estimatedDuration` keys
    // are still accepted so older cached payloads keep parsing, but the real
    // server field always wins — reading only the legacy keys silently dropped
    // the average service time and token prefix for every real center.
    final rawPrefix = json['tokenPrefix'] ?? json['prefix'];
    final rawDuration = json['avgServiceTimeMinutes'] ?? json['estimatedDuration'];
    // A missing, null, non-string or blank description is the same thing to the
    // UI: there is nothing to show. Normalising here keeps every `description!`
    // in the app safe.
    final rawDescription = json['description'];
    final description = (rawDescription != null && rawDescription.toString().trim().isNotEmpty)
        ? rawDescription.toString().trim()
        : null;

    return Service(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      name: (json['name'] ?? '').toString(),
      code: (json['code'] ?? '').toString(),
      centerId: (json['centerId'] is Map ? json['centerId']['_id'] : json['centerId'] ?? '').toString(),
      isActive: json['isActive'] == true,
      prefix: rawPrefix?.toString(),
      estimatedDuration: (rawDuration as num?)?.toInt(),
      description: description,
      priorityAllowed: json['priorityAllowed'] == true,
    );
  }
}

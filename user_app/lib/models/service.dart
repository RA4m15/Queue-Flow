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

  factory Service.fromJson(Map<String, dynamic> json) {
    return Service(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      name: (json['name'] ?? '').toString(),
      code: (json['code'] ?? '').toString(),
      centerId: (json['centerId'] is Map ? json['centerId']['_id'] : json['centerId'] ?? '').toString(),
      isActive: json['isActive'] == true,
      prefix: json['prefix']?.toString(),
      estimatedDuration: (json['estimatedDuration'] as num?)?.toInt(),
      description: json['description']?.toString(),
      priorityAllowed: json['priorityAllowed'] == true,
    );
  }
}

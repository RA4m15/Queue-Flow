class ServiceCenterAddress {
  const ServiceCenterAddress({
    this.street,
    this.city,
    this.state,
    this.zip,
  });

  final String? street;
  final String? city;
  final String? state;
  final String? zip;

  factory ServiceCenterAddress.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const ServiceCenterAddress();
    return ServiceCenterAddress(
      street: json['street']?.toString(),
      city: json['city']?.toString(),
      state: json['state']?.toString(),
      zip: json['zip']?.toString(),
    );
  }

  String get fullAddress {
    final parts = [street, city, state, zip].where((p) => p != null && p.isNotEmpty).toList();
    return parts.isEmpty ? 'Address not specified' : parts.join(', ');
  }
}

class ServiceCenter {
  const ServiceCenter({
    required this.id,
    required this.name,
    required this.code,
    required this.type,
    required this.isOpen,
    required this.capacity,
    required this.currentCrowd,
    this.address,
    this.phone,
    this.email,
    this.activeCounters = 0,
    this.crowdModerateThreshold = 50,
    this.crowdHighThreshold = 80,
  });

  final String id;
  final String name;
  final String code;
  final String type;
  final bool isOpen;
  final int capacity;
  final int currentCrowd;
  final ServiceCenterAddress? address;
  final String? phone;
  final String? email;
  final int activeCounters;
  final int crowdModerateThreshold;
  final int crowdHighThreshold;

  // Crowd status computation (no fake capacity)
  String get crowdStatus {
    if (capacity <= 0) return 'UNKNOWN';
    final pct = (currentCrowd / capacity) * 100;
    if (pct >= crowdHighThreshold) return 'HIGH';
    if (pct >= crowdModerateThreshold) return 'MODERATE';
    return 'LOW';
  }

  String get typeDisplayName {
    switch (type.toUpperCase()) {
      case 'HOSPITAL':
        return 'Hospital & Health';
      case 'BANK':
        return 'Banking & Finance';
      case 'GOVT_OFFICE':
        return 'Government Office';
      case 'TELECOM':
        return 'Telecom & Network';
      default:
        return type;
    }
  }

  String get typeEmoji {
    switch (type.toUpperCase()) {
      case 'HOSPITAL':
        return '🏥';
      case 'BANK':
        return '🏦';
      case 'GOVT_OFFICE':
        return '🏛️';
      case 'TELECOM':
        return '📡';
      default:
        return '🏢';
    }
  }

  factory ServiceCenter.fromJson(Map<String, dynamic> json) {
    final thresholds = json['crowdThresholds'] as Map<String, dynamic>?;
    return ServiceCenter(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      name: (json['name'] ?? '').toString(),
      code: (json['code'] ?? '').toString(),
      type: (json['type'] ?? 'OTHER').toString(),
      isOpen: json['isOpen'] == true,
      capacity: (json['capacity'] as num?)?.toInt() ?? 0,
      currentCrowd: (json['currentCrowd'] as num?)?.toInt() ?? 0,
      address: json['address'] is Map ? ServiceCenterAddress.fromJson(Map<String, dynamic>.from(json['address'])) : null,
      phone: json['phone']?.toString(),
      email: json['email']?.toString(),
      activeCounters: (json['activeCounters'] as num?)?.toInt() ?? 0,
      crowdModerateThreshold: (thresholds?['moderate'] as num?)?.toInt() ?? 50,
      crowdHighThreshold: (thresholds?['high'] as num?)?.toInt() ?? 80,
    );
  }
}

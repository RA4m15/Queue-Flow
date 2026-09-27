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
      // The backend address schema names this field `pincode`.
      zip: (json['pincode'] ?? json['zip'])?.toString(),
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
    this.capacityAlertThreshold = 80,
    this.backendCrowdStatus,
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

  /// Admin-configured "crowd is too high" percentage from the backend.
  final int capacityAlertThreshold;

  /// The backend's own `crowdStatus` virtual, when the payload includes it.
  final String? backendCrowdStatus;

  /// Mirrors the backend `crowdStatus` virtual, which is only attached to
  /// payloads read with `lean({ virtuals: true })`. `GET /service-centers`
  /// is a plain `.lean()` and therefore omits it, so the same rule is applied
  /// locally against the real `currentCrowd` / `capacity` / alert threshold.
  String get crowdStatus {
    final reported = backendCrowdStatus;
    if (reported != null && reported.isNotEmpty) return reported;
    if (capacity <= 0) return 'UNKNOWN';
    final pct = (currentCrowd / capacity) * 100;
    if (pct >= capacityAlertThreshold) return 'HIGH';
    if (pct >= _moderateThresholdPercent) return 'MODERATE';
    return 'LOW';
  }

  /// The backend virtual hard-codes the MODERATE cut-off at 50 %.
  static const int _moderateThresholdPercent = 50;

  /// The backend `type` enum is BANK | HOSPITAL | GOVT | RAILWAY | SUPPORT | OTHER.
  String get typeDisplayName {
    switch (type.toUpperCase()) {
      case 'HOSPITAL':
        return 'Hospital & Health';
      case 'BANK':
        return 'Banking & Finance';
      case 'GOVT':
        return 'Government Office';
      case 'RAILWAY':
        return 'Railway & Transport';
      case 'SUPPORT':
        return 'Customer Support';
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
      case 'GOVT':
        return '🏛️';
      case 'RAILWAY':
        return '🚆';
      case 'SUPPORT':
        return '🎧';
      default:
        return '🏢';
    }
  }

  factory ServiceCenter.fromJson(Map<String, dynamic> json) {
    final reportedCrowdStatus = json['crowdStatus']?.toString();
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
      capacityAlertThreshold: (json['capacityAlertThreshold'] as num?)?.toInt() ?? 80,
      backendCrowdStatus:
          (reportedCrowdStatus == null || reportedCrowdStatus.isEmpty) ? null : reportedCrowdStatus,
    );
  }
}

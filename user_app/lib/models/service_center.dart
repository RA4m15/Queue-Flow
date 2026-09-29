import 'operating_hours.dart';

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

class ServiceCenterLocation {
  const ServiceCenterLocation({
    this.latitude,
    this.longitude,
  });

  final double? latitude;
  final double? longitude;

  bool get isConfigured => latitude != null && longitude != null;

  factory ServiceCenterLocation.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const ServiceCenterLocation();
    final lat = (json['latitude'] as num?)?.toDouble();
    final lng = (json['longitude'] as num?)?.toDouble();
    return ServiceCenterLocation(latitude: lat, longitude: lng);
  }
}

class ServiceCenterGeofence {
  const ServiceCenterGeofence({
    this.enabled = false,
    this.radiusMeters = 100,
    this.nearRadiusMeters = 500,
    this.approachingRadiusMeters = 1000,
  });

  final bool enabled;
  final int radiusMeters;
  final int nearRadiusMeters;
  final int approachingRadiusMeters;

  factory ServiceCenterGeofence.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const ServiceCenterGeofence();
    return ServiceCenterGeofence(
      enabled: json['enabled'] == true,
      radiusMeters: (json['radiusMeters'] as num?)?.toInt() ?? 100,
      nearRadiusMeters: (json['nearRadiusMeters'] as num?)?.toInt() ?? 500,
      approachingRadiusMeters: (json['approachingRadiusMeters'] as num?)?.toInt() ?? 1000,
    );
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
    this.backendCrowdPercent,
    this.operatingHours = const <OperatingHoursDay>[],
    this.location,
    this.geofence,
    this.latitude,
    this.longitude,
    this.joiningRadiusMeters = 100,
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
  final ServiceCenterLocation? location;
  final ServiceCenterGeofence? geofence;
  final double? latitude;
  final double? longitude;
  final int joiningRadiusMeters;

  /// Admin-configured "crowd is too high" percentage from the backend.
  final int capacityAlertThreshold;

  /// The backend's own `crowdStatus` virtual, when the payload includes it.
  final String? backendCrowdStatus;

  /// The backend's own `crowdPercent` virtual, when the payload includes it.
  ///
  /// `GET /api/service-centers` is a plain `.lean()` and omits virtuals, so
  /// this is usually null there and present on `GET /api/service-centers/:id`,
  /// which reads with `.lean({ virtuals: true })`.
  final int? backendCrowdPercent;

  /// Admin-configured opening hours. Empty when the center has none on file.
  ///
  /// This is the only time-bound data the service-center schema exposes. It is
  /// never used to invent a QR expiry or a queue admission deadline.
  final List<OperatingHoursDay> operatingHours;

  /// Mirrors the backend `crowdStatus` virtual, which is only attached to
  /// payloads read with `lean({ virtuals: true })`. `GET /service-centers`
  /// is a plain `.lean()` and therefore omits it, so the same rule is applied
  /// locally against the real `currentCrowd` / `capacity` / alert threshold.
  String get crowdStatus {
    final reported = backendCrowdStatus;
    if (reported != null && reported.isNotEmpty) return reported;
    if (capacity <= 0) return 'UNKNOWN';
    final pct = crowdPercent;
    if (pct >= capacityAlertThreshold) return 'HIGH';
    if (pct >= _moderateThresholdPercent) return 'MODERATE';
    return 'LOW';
  }

  /// Occupancy as a whole percentage, preferring the backend's own virtual.
  int get crowdPercent {
    final reported = backendCrowdPercent;
    if (reported != null) return reported.clamp(0, 100);
    if (capacity <= 0) return 0;
    return ((currentCrowd / capacity) * 100).round().clamp(0, 100);
  }

  /// Whether joining is possible at all, per the backend's own admission rules.
  ///
  /// `queueService.joinQueue` rejects the request when `center.isOpen` is false,
  /// so this mirrors an authoritative check rather than inventing local policy.
  /// Crowd and operating hours are deliberately absent: the backend does not
  /// gate joining on either.
  bool get isJoinable => isOpen;

  /// The joining window configured for [now], or an unconfigured result.
  ///
  /// See [OperatingHoursWindowResolver] for the exact semantics.
  OperatingHoursWindow resolveJoiningWindow(DateTime now) =>
      OperatingHoursWindowResolver.resolve(operatingHours, now);

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
    final reportedCrowdPercent = (json['crowdPercent'] as num?)?.toInt();
    final hours = json['operatingHours'];
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
      backendCrowdPercent: reportedCrowdPercent,
      operatingHours: hours is List
          ? hours
              .whereType<Map>()
              .map((h) => OperatingHoursDay.fromJson(Map<String, dynamic>.from(h)))
              .toList(growable: false)
          : const <OperatingHoursDay>[],
      latitude: (json['location'] is Map && json['location']['latitude'] != null)
          ? (json['location']['latitude'] as num).toDouble()
          : (json['latitude'] as num?)?.toDouble(),
      longitude: (json['location'] is Map && json['location']['longitude'] != null)
          ? (json['location']['longitude'] as num).toDouble()
          : (json['longitude'] as num?)?.toDouble(),
      joiningRadiusMeters: (json['geofence'] is Map && json['geofence']['radiusMeters'] != null)
          ? (json['geofence']['radiusMeters'] as num).toInt()
          : ((json['joiningRadiusMeters'] as num?)?.toInt() ?? 100),
      location: json['location'] is Map
          ? ServiceCenterLocation.fromJson(Map<String, dynamic>.from(json['location']))
          : ((json['latitude'] != null && json['longitude'] != null)
              ? ServiceCenterLocation(
                  latitude: (json['latitude'] as num?)?.toDouble(),
                  longitude: (json['longitude'] as num?)?.toDouble(),
                )
              : null),
      geofence: json['geofence'] is Map
          ? ServiceCenterGeofence.fromJson(Map<String, dynamic>.from(json['geofence']))
          : ServiceCenterGeofence(
              enabled: (json['latitude'] != null && json['longitude'] != null),
              radiusMeters: (json['joiningRadiusMeters'] as num?)?.toInt() ?? 100,
            ),
    );
  }
}

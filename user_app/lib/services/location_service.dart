import 'dart:math' as math;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

/// User geographic position snapshot.
class UserLocation {
  const UserLocation({
    required this.latitude,
    required this.longitude,
    this.accuracy,
    this.timestamp,
  });

  final double latitude;
  final double longitude;
  final double? accuracy;
  final DateTime? timestamp;

  /// Whether this reading was captured recently enough to trust for admission.
  /// Defaults to 90 seconds (aligning with backend Phase 2 staleness threshold).
  bool isFresh([Duration maxAge = const Duration(seconds: 90)]) {
    if (timestamp == null) return false;
    final now = DateTime.now();
    final diff = now.difference(timestamp!);
    // Allow up to 60s future clock skew; reject if older than maxAge.
    return diff.inSeconds >= -60 && diff.inSeconds <= maxAge.inSeconds;
  }
}

/// Standard Haversine geodesic distance in integer meters.
double calculateHaversineDistanceMeters(
  double lat1,
  double lon1,
  double lat2,
  double lon2,
) {
  const r = 6371000.0; // Earth radius in meters
  final toRad = math.pi / 180.0;
  final dLat = (lat2 - lat1) * toRad;
  final dLon = (lon2 - lon1) * toRad;
  final rLat1 = lat1 * toRad;
  final rLat2 = lat2 * toRad;

  final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(rLat1) * math.cos(rLat2) * math.sin(dLon / 2) * math.sin(dLon / 2);
  final c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));

  return r * c;
}

/// Formats distance into a human-friendly string ('42 m' or '1.8 km').
String formatDistance(double meters) {
  if (meters < 1000) {
    return '${meters.round()} m';
  } else {
    final km = meters / 1000.0;
    return '${km.toStringAsFixed(1)} km';
  }
}

/// Abstract location service interface to allow deterministic headless unit tests.
abstract class LocationService {
  Future<bool> isLocationServiceEnabled();
  Future<LocationPermission> checkPermission();
  Future<LocationPermission> requestPermission();
  Future<UserLocation?> getCurrentLocation({bool requestPermission = true});
  Stream<UserLocation> getPositionStream();
}

/// Production implementation backed by platform Geolocator plugin.
class GeolocatorLocationService implements LocationService {
  const GeolocatorLocationService();

  @override
  Future<bool> isLocationServiceEnabled() async {
    return await Geolocator.isLocationServiceEnabled();
  }

  @override
  Future<LocationPermission> checkPermission() async {
    return await Geolocator.checkPermission();
  }

  @override
  Future<LocationPermission> requestPermission() async {
    return await Geolocator.requestPermission();
  }

  @override
  Future<UserLocation?> getCurrentLocation({bool requestPermission = true}) async {
    try {
      final serviceEnabled = await isLocationServiceEnabled();
      if (!serviceEnabled) {
        return null;
      }

      LocationPermission permission = await checkPermission();
      if (permission == LocationPermission.denied && requestPermission) {
        permission = await this.requestPermission();
      }

      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return null;
      }

      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );

      return UserLocation(
        latitude: pos.latitude,
        longitude: pos.longitude,
        accuracy: pos.accuracy,
        timestamp: pos.timestamp,
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<UserLocation> getPositionStream() async* {
    try {
      final serviceEnabled = await isLocationServiceEnabled();
      if (!serviceEnabled) return;

      final permission = await checkPermission();
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return;
      }

      yield* Geolocator.getPositionStream(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          distanceFilter: 3,
        ),
      ).map((pos) => UserLocation(
            latitude: pos.latitude,
            longitude: pos.longitude,
            accuracy: pos.accuracy,
            timestamp: pos.timestamp,
          ));
    } catch (_) {
      // Gracefully return empty stream on sensor / permission error
    }
  }
}

/// Riverpod provider for location service.
final locationServiceProvider = Provider<LocationService>((ref) {
  return const GeolocatorLocationService();
});

/// Riverpod provider for fetching current user location on demand.
final currentUserLocationProvider =
    FutureProvider.autoDispose<UserLocation?>((ref) async {
  final service = ref.watch(locationServiceProvider);
  return await service.getCurrentLocation();
});

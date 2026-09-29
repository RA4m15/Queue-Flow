import 'package:flutter/material.dart';
import '../core/theme/app_theme.dart';
import '../models/service_center.dart';
import '../services/location_service.dart';
import 'crowd_indicator.dart';

class ServiceCenterCard extends StatelessWidget {
  const ServiceCenterCard({
    super.key,
    required this.center,
    required this.onTap,
    this.userLocation,
  });

  final ServiceCenter center;
  final VoidCallback onTap;
  final UserLocation? userLocation;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: context.themeSurfaceElevated,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: context.themeBorder),
                    ),
                    child: Text(
                      center.typeEmoji,
                      style: const TextStyle(fontSize: 22),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          center.name,
                          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 4),
                        Text(
                          center.typeDisplayName,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: center.isOpen
                          ? AppColors.success.withValues(alpha: 0.12)
                          : AppColors.danger.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      center.isOpen ? 'OPEN' : 'CLOSED',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        color: center.isOpen ? AppColors.success : AppColors.danger,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  const Icon(Icons.location_on_outlined, size: 14, color: AppColors.textMuted),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      center.address?.fullAddress ?? 'No address provided',
                      style: Theme.of(context).textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              if (userLocation != null && center.location?.isConfigured == true) ...[
                const SizedBox(height: 8),
                Builder(
                  builder: (context) {
                    final dist = calculateHaversineDistanceMeters(
                      center.location!.latitude!,
                      center.location!.longitude!,
                      userLocation!.latitude,
                      userLocation!.longitude,
                    );
                    final radius = center.geofence?.radiusMeters ?? 100;
                    final inRange = dist <= radius;
                    return Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: inRange
                            ? AppColors.success.withValues(alpha: 0.12)
                            : AppColors.surfaceElevated,
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(
                          color: inRange
                              ? AppColors.success.withValues(alpha: 0.3)
                              : context.themeBorder,
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            inRange ? Icons.near_me_rounded : Icons.location_off_rounded,
                            size: 11,
                            color: inRange ? AppColors.success : AppColors.textMuted,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            inRange
                                ? 'Within range · ${formatDistance(dist)}'
                                : 'Out of range · ${formatDistance(dist)}',
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w600,
                              color: inRange ? AppColors.success : AppColors.textMuted,
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ],
              Divider(color: context.themeBorder, height: 24),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  CrowdIndicator(
                    crowdStatus: center.crowdStatus,
                    currentCrowd: center.currentCrowd,
                    capacity: center.capacity,
                  ),
                  Row(
                    children: [
                      Text(
                        'View queues',
                        style: TextStyle(
                          color: context.themePrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        Icons.arrow_forward_ios_rounded,
                        size: 12,
                        color: context.themePrimary,
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

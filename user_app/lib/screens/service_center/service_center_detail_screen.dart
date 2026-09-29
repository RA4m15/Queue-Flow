import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/theme/app_theme.dart';
import '../../models/service_center.dart';
import '../../models/service.dart';
import '../../providers/service_center_provider.dart';
import '../../widgets/crowd_indicator.dart';
import '../../widgets/loading_state.dart';
import '../../widgets/error_state.dart';
import '../../widgets/empty_state.dart';

class ServiceCenterDetailScreen extends ConsumerWidget {
  const ServiceCenterDetailScreen({
    super.key,
    required this.centerId,
  });

  final String centerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detailAsync = ref.watch(serviceCenterDetailProvider(centerId));
    // `GET /api/service-centers/:id` returns the center alone — it has no
    // `services` key. The service list comes from `GET /api/services?centerId=`,
    // which the backend filters to `isActive: true`.
    final servicesAsync = ref.watch(centerServicesProvider(centerId));
    final crowdAsync = ref.watch(centerCrowdProvider(centerId));
    final queueAsync = ref.watch(centerQueueStatusProvider(centerId));

    void refreshAll() {
      ref.invalidate(serviceCenterDetailProvider(centerId));
      ref.invalidate(centerServicesProvider(centerId));
      ref.invalidate(centerCrowdProvider(centerId));
      ref.invalidate(centerQueueStatusProvider(centerId));
    }

    return Scaffold(
      backgroundColor: context.themeBackground,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => context.pop(),
        ),
        title: const Text('Center Details'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: 'Refresh',
            onPressed: refreshAll,
          ),
        ],
      ),
      body: detailAsync.when(
        data: (data) {
          final center = data['center'] as ServiceCenter;
          final services = servicesAsync.valueOrNull ?? const <Service>[];

          return RefreshIndicator(
            color: context.themePrimary,
            backgroundColor: context.themeSurface,
            onRefresh: () async => refreshAll(),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // ─── CENTER HEADER CARD ──────────────────────────────
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: context.themeSurface,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: context.themeBorder),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 56,
                            height: 56,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: context.themeSurfaceElevated,
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(color: context.themeBorder),
                            ),
                            child: Text(
                              center.typeEmoji,
                              style: const TextStyle(fontSize: 30),
                            ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        center.name,
                                        style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                                              fontSize: 20,
                                            ),
                                      ),
                                    ),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                      decoration: BoxDecoration(
                                        color: center.isOpen
                                            ? AppColors.success.withValues(alpha: 0.12)
                                            : AppColors.danger.withValues(alpha: 0.12),
                                        borderRadius: BorderRadius.circular(8),
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
                                const SizedBox(height: 4),
                                Text(
                                  center.typeDisplayName,
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Divider(color: context.themeBorder),
                      const SizedBox(height: 12),

                      // Address info
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(Icons.location_on_outlined, size: 18, color: context.themeTextMuted),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              center.address?.fullAddress ?? 'No physical address provided',
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                          ),
                        ],
                      ),

                      if (center.phone != null && center.phone!.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            Icon(Icons.phone_outlined, size: 18, color: context.themeTextMuted),
                            const SizedBox(width: 8),
                            Text(
                              center.phone!,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                          ],
                        ),
                      ],

                      const SizedBox(height: 16),
                      // Crowd stats bar
                      crowdAsync.when(
                        data: (crowd) => Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: context.themeSurfaceElevated,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: context.themeBorder),
                          ),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Live Facility Crowd',
                                    style: Theme.of(context).textTheme.bodySmall,
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    '${crowd.currentCrowd} people inside',
                                    style: AppTheme.monoStyle(
                                      fontSize: 15,
                                      color: context.themeTextPrimary,
                                    ),
                                  ),
                                ],
                              ),
                              CrowdIndicator(
                                crowdStatus: crowd.crowdStatus,
                                currentCrowd: crowd.currentCrowd,
                                capacity: crowd.capacity,
                              ),
                            ],
                          ),
                        ),
                        loading: () => const SizedBox.shrink(),
                        error: (_, _) => const SizedBox.shrink(),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),

                // ─── SERVICES TITLE ──────────────────────────────────
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      'Available Services',
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                    ),
                    Text(
                      servicesAsync.isLoading
                          ? 'Loading…'
                          : '${services.length} services',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
                const SizedBox(height: 12),

                // ─── SERVICES LIST ───────────────────────────────────
                if (servicesAsync.isLoading)
                  ...const [3, 4, 5].map((i) => Container(
                        height: 96 + i.toDouble(),
                        margin: const EdgeInsets.only(bottom: 12),
                        decoration: BoxDecoration(
                          color: context.themeSurfaceElevated,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: context.themeBorder),
                        ),
                      ))
                else if (servicesAsync.hasError)
                  // The centre loaded but its services did not. Saying "no
                  // services" here would be a lie: the truth is unknown.
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Column(
                      children: [
                        const Text(
                          'Service list unavailable. The service center could '
                          'not be reached.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 12.5, height: 1.5),
                        ),
                        const SizedBox(height: 14),
                        OutlinedButton(
                          onPressed: refreshAll,
                          child: const Text('RETRY'),
                        ),
                      ],
                    ),
                  )
                else if (services.isEmpty)
                  const EmptyState(
                    title: 'No services available',
                    message: 'This center has not published any active queue services.',
                    icon: Icons.design_services_outlined,
                  )
                else
                  ...services.map((service) {
                    return Container(
                      margin: const EdgeInsets.only(bottom: 12),
                      decoration: BoxDecoration(
                        color: context.themeSurface,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: context.themeBorder),
                      ),
                      child: ListTile(
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                        title: Text(
                          service.name,
                          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                        ),
                        subtitle: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (service.description != null && service.description!.isNotEmpty) ...[
                              const SizedBox(height: 4),
                              Text(
                                service.description!,
                                style: Theme.of(context).textTheme.bodySmall,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                            const SizedBox(height: 8),
                            // Queue status pill
                            queueAsync.when(
                              data: (queues) {
                                final q = queues.where((item) => item.serviceId == service.id).firstOrNull;
                                final waitCount = q?.waitingCount;
                                // Tier 3 / Feature 1: consume the server-authoritative
                                // context-aware EWT. Never recompute it in Dart, and
                                // never fall back to the average service time — that
                                // number is a handling duration, not a wait.
                                final estMins = q?.estimatedWaitMinutes;

                                return Row(
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                      decoration: BoxDecoration(
                                        color: context.themePrimary.withValues(alpha: 0.1),
                                        borderRadius: BorderRadius.circular(6),
                                      ),
                                      child: Text(
                                        waitCount == null ? 'n/a waiting' : '$waitCount waiting',
                                        style: TextStyle(
                                          color: context.themePrimary,
                                          fontSize: 11,
                                          fontWeight: FontWeight.bold,
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    Flexible(
                                      child: Text(
                                        estMins != null
                                            ? '~$estMins min wait'
                                            : 'Wait time not reported',
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: Theme.of(context).textTheme.bodySmall,
                                      ),
                                    ),
                                  ],
                                );
                              },
                              loading: () => Text(
                                service.avgServiceTimeMinutes != null
                                    ? '~${service.avgServiceTimeMinutes} min avg service'
                                    : 'Queue available',
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                              error: (_, _) => Text(
                                'Queue figures not reported',
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            ),
                          ],
                        ),
                        trailing: ElevatedButton(
                          onPressed: center.isOpen
                              // Ids only, so the destination is the same
                              // addressable join route a QR opens.
                              ? () => context.push(
                                    '/join/preview'
                                    '?centerId=${center.id}'
                                    '&serviceId=${service.id}',
                                  )
                              : null,
                          style: ElevatedButton.styleFrom(
                            minimumSize: const Size(80, 36),
                            padding: const EdgeInsets.symmetric(horizontal: 14),
                          ),
                          child: const Text('Join', style: TextStyle(fontSize: 13)),
                        ),
                      ),
                    );
                  }),
              ],
            ),
          );
        },
        loading: () => const LoadingState(message: 'Loading center details...'),
        error: (err, _) => ErrorState(
          message: 'Unable to load service center details.',
          onRetry: () => ref.invalidate(serviceCenterDetailProvider(centerId)),
        ),
      ),
    );
  }
}

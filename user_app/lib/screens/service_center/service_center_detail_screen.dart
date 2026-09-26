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
    final crowdAsync = ref.watch(centerCrowdProvider(centerId));
    final queueAsync = ref.watch(centerQueueStatusProvider(centerId));

    return Scaffold(
      backgroundColor: AppColors.background,
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
            onPressed: () {
              ref.invalidate(serviceCenterDetailProvider(centerId));
              ref.invalidate(centerCrowdProvider(centerId));
              ref.invalidate(centerQueueStatusProvider(centerId));
            },
          ),
        ],
      ),
      body: detailAsync.when(
        data: (data) {
          final center = data['center'] as ServiceCenter;
          final services = data['services'] as List<Service>;

          return RefreshIndicator(
            color: AppColors.primary,
            backgroundColor: AppColors.surface,
            onRefresh: () async {
              ref.invalidate(serviceCenterDetailProvider(centerId));
              ref.invalidate(centerCrowdProvider(centerId));
              ref.invalidate(centerQueueStatusProvider(centerId));
            },
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // ─── CENTER HEADER CARD ──────────────────────────────
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: AppColors.border),
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
                              color: AppColors.surfaceElevated,
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(color: AppColors.border),
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
                      const Divider(color: AppColors.border),
                      const SizedBox(height: 12),

                      // Address info
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(Icons.location_on_outlined, size: 18, color: AppColors.textMuted),
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
                            const Icon(Icons.phone_outlined, size: 18, color: AppColors.textMuted),
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
                            color: AppColors.surfaceElevated,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: AppColors.border),
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
                                      color: AppColors.textPrimary,
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
                      '${services.length} services',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
                const SizedBox(height: 12),

                // ─── SERVICES LIST ───────────────────────────────────
                if (services.isEmpty)
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
                        color: AppColors.surface,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: AppColors.border),
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
                                final waitCount = q?.waitingCount ?? 0;
                                // Tier 3 / Feature 1: consume the server-authoritative
                                // context-aware EWT. Never recompute it in Dart.
                                final estMins = q?.estimatedWaitMinutes ?? service.estimatedDuration;

                                return Row(
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                      decoration: BoxDecoration(
                                        color: AppColors.primary.withValues(alpha: 0.1),
                                        borderRadius: BorderRadius.circular(6),
                                      ),
                                      child: Text(
                                        '$waitCount waiting',
                                        style: const TextStyle(
                                          color: AppColors.primary,
                                          fontSize: 11,
                                          fontWeight: FontWeight.bold,
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      estMins != null && estMins > 0 ? '~$estMins min wait' : 'Wait time unavailable',
                                      style: Theme.of(context).textTheme.bodySmall,
                                    ),
                                  ],
                                );
                              },
                              loading: () => Text(
                                service.estimatedDuration != null
                                    ? '~${service.estimatedDuration} min avg service'
                                    : 'Queue available',
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                              error: (_, _) => Text(
                                service.estimatedDuration != null
                                    ? '~${service.estimatedDuration} min avg service'
                                    : 'Queue available',
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            ),
                          ],
                        ),
                        trailing: ElevatedButton(
                          onPressed: center.isOpen
                              ? () {
                                  context.push(
                                    '/queue/preview',
                                    extra: {
                                      'center': center,
                                      'service': service,
                                    },
                                  );
                                }
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

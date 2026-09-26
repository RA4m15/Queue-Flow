import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/theme/app_theme.dart';
import '../../providers/auth_provider.dart';
import '../../providers/token_provider.dart';
import '../../providers/service_center_provider.dart';
import '../../widgets/service_center_card.dart';
import '../../widgets/token_status_badge.dart';
import '../../widgets/loading_state.dart';
import '../../widgets/error_state.dart';
import '../../widgets/empty_state.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  String _selectedCategory = 'ALL';
  String _searchQuery = '';
  final _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(tokenProvider.notifier).fetchActiveToken();
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);
    final user = authState.user;
    final tokenState = ref.watch(tokenProvider);
    final centersAsync = ref.watch(serviceCentersProvider);

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'QueueFlow',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.bold,
                    letterSpacing: -0.5,
                  ),
            ),
            if (user != null)
              Text(
                'Hello, ${user.name}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.qr_code_scanner_rounded, color: AppColors.primary),
            tooltip: 'Scan QR',
            onPressed: () => context.push('/scan'),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: AppColors.primary,
        backgroundColor: AppColors.surface,
        onRefresh: () async {
          ref.invalidate(serviceCentersProvider);
          await ref.read(tokenProvider.notifier).fetchActiveToken();
        },
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            // ─── OFFLINE / INFO BANNER ───────────────────────────────
            // Shown when signed in from a cached session but the server could
            // not be reached (e.g. "Working offline: unable to reach QueueFlow
            // server."). Live data already falls back gracefully elsewhere.
            if (authState.isAuthenticated && authState.errorMessage != null)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.warning.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.warning.withValues(alpha: 0.4)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.wifi_off_rounded, color: AppColors.warning, size: 20),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            authState.errorMessage!,
                            style: const TextStyle(
                              color: AppColors.textPrimary,
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),

            // ─── ACTIVE TOKEN BANNER ─────────────────────────────────
            if (tokenState.activeToken != null && tokenState.activeToken!.isActive)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: InkWell(
                    onTap: () => context.push('/token/live'),
                    borderRadius: BorderRadius.circular(16),
                    child: Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          colors: [
                            AppColors.surfaceElevated,
                            AppColors.primary.withValues(alpha: 0.1),
                          ],
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                        ),
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: AppColors.primary.withValues(alpha: 0.4), width: 1.5),
                      ),
                      child: Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                            decoration: BoxDecoration(
                              color: AppColors.surface,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: AppColors.border),
                            ),
                            child: Text(
                              tokenState.activeToken!.tokenCode,
                              style: AppTheme.monoStyle(
                                fontSize: 18,
                                color: AppColors.primary,
                              ),
                            ),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    TokenStatusBadge(status: tokenState.activeToken!.status, fontSize: 10),
                                    const SizedBox(width: 8),
                                    Expanded(
                                      child: Text(
                                        tokenState.activeToken!.serviceName ?? 'Service',
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  tokenState.activeToken!.status == 'CALLED'
                                      ? 'Proceed to ${tokenState.activeToken!.counterName ?? "counter"}!'
                                      : 'Position ${tokenState.activeToken!.currentPosition != null ? "#${tokenState.activeToken!.currentPosition}" : "--"} • Est. ${tokenState.activeToken!.waitEstimateMinutes != null ? "${tokenState.activeToken!.waitEstimateMinutes}m" : "--"} wait',
                                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                        color: tokenState.activeToken!.status == 'CALLED'
                                            ? AppColors.secondary
                                            : AppColors.textSecondary,
                                        fontWeight: tokenState.activeToken!.status == 'CALLED'
                                            ? FontWeight.bold
                                            : FontWeight.normal,
                                      ),
                                ),
                              ],
                            ),
                          ),
                          const Icon(Icons.arrow_forward_ios_rounded, size: 14, color: AppColors.primary),
                        ],
                      ),
                    ),
                  ),
                ),
              ),

            // ─── SEARCH & FILTER ─────────────────────────────────────
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    TextField(
                      controller: _searchController,
                      maxLength: 100,
                      style: const TextStyle(color: AppColors.textPrimary),
                      decoration: InputDecoration(
                        hintText: 'Search service centers or cities...',
                        counterText: '',
                        prefixIcon: const Icon(Icons.search_rounded, color: AppColors.textMuted),
                        suffixIcon: _searchQuery.isNotEmpty
                            ? IconButton(
                                icon: const Icon(Icons.clear_rounded, size: 18, color: AppColors.textMuted),
                                onPressed: () {
                                  _searchController.clear();
                                  setState(() => _searchQuery = '');
                                },
                              )
                            : null,
                      ),
                      onChanged: (val) => setState(() => _searchQuery = val.trim().toLowerCase()),
                    ),
                    const SizedBox(height: 12),
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          _buildFilterChip('ALL', 'All Centers'),
                          _buildFilterChip('HOSPITAL', '🏥 Hospital'),
                          _buildFilterChip('BANK', '🏦 Banking'),
                          _buildFilterChip('GOVT_OFFICE', '🏛️ Govt'),
                          _buildFilterChip('TELECOM', '📡 Telecom'),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // ─── SECTION HEADER ──────────────────────────────────────
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Text(
                  'Service Centers',
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                ),
              ),
            ),

            // ─── CENTERS LIST ────────────────────────────────────────
            centersAsync.when(
              data: (centers) {
                var filtered = centers;

                if (_selectedCategory != 'ALL') {
                  filtered = filtered.where((c) => c.type.toUpperCase() == _selectedCategory).toList();
                }

                if (_searchQuery.isNotEmpty) {
                  filtered = filtered.where((c) {
                    final matchName = c.name.toLowerCase().contains(_searchQuery);
                    final matchCity = c.address?.city?.toLowerCase().contains(_searchQuery) ?? false;
                    return matchName || matchCity;
                  }).toList();
                }

                if (filtered.isEmpty) {
                  return SliverFillRemaining(
                    hasScrollBody: false,
                    child: EmptyState(
                      title: 'No centers found',
                      message: _searchQuery.isNotEmpty
                          ? 'No service center matches "$_searchQuery". Try another search.'
                          : 'No service centers available in this category.',
                      icon: Icons.storefront_outlined,
                    ),
                  );
                }

                return SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final center = filtered[index];
                      return ServiceCenterCard(
                        center: center,
                        onTap: () => context.push('/center/${center.id}'),
                      );
                    },
                    childCount: filtered.length,
                  ),
                );
              },
              loading: () => const SliverFillRemaining(
                hasScrollBody: false,
                child: LoadingState(message: 'Loading live service centers...'),
              ),
              error: (err, _) => SliverFillRemaining(
                hasScrollBody: false,
                child: ErrorState(
                  message: 'Failed to load service centers. Please check your connection.',
                  onRetry: () => ref.invalidate(serviceCentersProvider),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildFilterChip(String key, String label) {
    final isSelected = _selectedCategory == key;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: FilterChip(
        label: Text(label),
        selected: isSelected,
        onSelected: (_) => setState(() => _selectedCategory = key),
        backgroundColor: AppColors.surface,
        selectedColor: AppColors.primary.withValues(alpha: 0.2),
        checkmarkColor: AppColors.primary,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(
            color: isSelected ? AppColors.primary : AppColors.border,
          ),
        ),
        labelStyle: TextStyle(
          color: isSelected ? AppColors.primary : AppColors.textSecondary,
          fontSize: 12,
          fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
        ),
      ),
    );
  }
}

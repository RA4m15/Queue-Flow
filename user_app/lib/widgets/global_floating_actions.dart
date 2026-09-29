import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/router/app_router.dart';
import '../core/theme/app_theme.dart';
import '../providers/auth_provider.dart';
import '../providers/token_provider.dart';
import 'emergency_assistance_sheet.dart';

/// Overlay widget that wraps the application's top-level router/navigator,
/// rendering persistent "Call for Emergency" and "AI Chat" floating buttons
/// on every page.
class GlobalFloatingActions extends ConsumerStatefulWidget {
  const GlobalFloatingActions({
    super.key,
    required this.child,
  });

  final Widget child;

  @override
  ConsumerState<GlobalFloatingActions> createState() => _GlobalFloatingActionsState();
}

class _GlobalFloatingActionsState extends ConsumerState<GlobalFloatingActions>
    with TickerProviderStateMixin {
  // Animation controller for pulsing emergency button ring
  late final AnimationController _emergencyPulseController;
  late final Animation<double> _emergencyPulseAnimation;

  // Animation controller for AI sparkle shimmer
  late final AnimationController _aiShimmerController;

  // Custom user drag offset from bottom (null means default position)
  double? _customBottomOffset;

  @override
  void initState() {
    super.initState();
    _emergencyPulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);

    _emergencyPulseAnimation = Tween<double>(begin: 0.95, end: 1.08).animate(
      CurvedAnimation(parent: _emergencyPulseController, curve: Curves.easeInOut),
    );

    _aiShimmerController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2500),
    )..repeat();
  }

  @override
  void dispose() {
    _emergencyPulseController.dispose();
    _aiShimmerController.dispose();
    super.dispose();
  }

  void _onEmergencyTap(BuildContext context) {
    final navContext = rootNavigatorKey.currentContext ?? context;
    final tokenState = ref.read(tokenProvider);
    showEmergencyAssistanceSheet(
      navContext,
      activeToken: tokenState.activeToken,
    );
  }

  void _onAiChatTap(BuildContext context) {
    final navContext = rootNavigatorKey.currentContext ?? context;
    final authState = ref.read(authProvider);

    if (authState.isAuthenticated) {
      ref.read(routerProvider).push('/support-chat');
    } else {
      // Prompt user to sign in or get guest help
      showModalBottomSheet<void>(
        context: navContext,
        backgroundColor: Colors.transparent,
        builder: (ctx) {
          final isDark = Theme.of(ctx).brightness == Brightness.dark;
          return SafeArea(
            child: Container(
              margin: const EdgeInsets.all(16),
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: isDark ? const Color(0xFF131A15) : Colors.white,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(
                  color: AppColors.primary.withValues(alpha: 0.3),
                  width: 1.5,
                ),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [AppColors.primary, AppColors.secondary],
                      ),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.auto_awesome, color: Colors.black, size: 28),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'QueueFlow AI Assistant',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Get instant answers about queue rules, wait time estimates, and department navigation powered by Gemini AI.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 13,
                      color: isDark ? AppColors.textSecondary : AppColors.lightTextSecondary,
                    ),
                  ),
                  const SizedBox(height: 18),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        foregroundColor: Colors.black,
                        padding: const EdgeInsets.symmetric(vertical: 13),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      onPressed: () {
                        Navigator.of(ctx).pop();
                        ref.read(routerProvider).go('/login');
                      },
                      child: const Text('Sign In to Chat', style: TextStyle(fontWeight: FontWeight.bold)),
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(),
                    child: const Text('Dismiss'),
                  ),
                ],
              ),
            ),
          );
        },
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(routerProvider);
    String currentPath = '';
    try {
      currentPath = router.routerDelegate.currentConfiguration.uri.path;
    } catch (_) {}
    if (currentPath.isEmpty) {
      try {
        currentPath = router.routeInformationProvider.value.uri.path;
      } catch (_) {}
    }

    final keyboardVisible = MediaQuery.of(context).viewInsets.bottom > 80;
    final showOverlay = currentPath != '/splash' && !keyboardVisible;

    final isChatScreen = currentPath == '/support-chat';
    final isShellTab = currentPath == '/home' ||
        currentPath == '/token/live' ||
        currentPath == '/history' ||
        currentPath == '/notifications' ||
        currentPath == '/profile';

    // Default vertical positioning: Above bottom nav bar on shell tabs, else near bottom
    final double defaultBottom = isShellTab ? 96.0 : 32.0;
    final screenHeight = MediaQuery.of(context).size.height;

    // Clamp vertical position so it stays comfortably on screen
    final bottomPosition = (_customBottomOffset ?? defaultBottom).clamp(
      24.0,
      screenHeight > 240 ? screenHeight - 200.0 : 24.0,
    );

    return Stack(
      children: [
        // Main page content
        widget.child,

        // Floating quick actions overlay
        if (showOverlay)
          Positioned(
            right: 16,
            bottom: bottomPosition,
            child: GestureDetector(
              onVerticalDragUpdate: (details) {
                setState(() {
                  _customBottomOffset = (screenHeight - details.globalPosition.dy) - 30;
                });
              },
              child: Material(
                color: Colors.transparent,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    // 1. CALL FOR EMERGENCY BUTTON (Always visible across every page)
                    _buildEmergencyButton(context),

                    // 2. AI CHAT BUTTON (Visible on all pages except when already inside support chat)
                    if (!isChatScreen) ...[
                      const SizedBox(height: 12),
                      _buildAiChatButton(context),
                    ],
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildEmergencyButton(BuildContext context) {
    return ScaleTransition(
      scale: _emergencyPulseAnimation,
      child: Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: AppColors.danger.withValues(alpha: 0.45),
              blurRadius: 16,
              spreadRadius: 2,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Material(
          color: Colors.transparent,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: Ink(
            width: 52,
            height: 52,
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                colors: [
                  Color(0xFFFF3B30),
                  Color(0xFFDC2626),
                ],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              shape: BoxShape.circle,
            ),
            child: InkWell(
              onTap: () => _onEmergencyTap(context),
              splashColor: Colors.white24,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  const Icon(
                    Icons.phone_in_talk_rounded,
                    color: Colors.white,
                    size: 26,
                  ),
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: const Text(
                        'SOS',
                        style: TextStyle(
                          color: Color(0xFFDC2626),
                          fontSize: 8,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildAiChatButton(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        boxShadow: [
          BoxShadow(
            color: AppColors.primary.withValues(alpha: 0.4),
            blurRadius: 16,
            spreadRadius: 1,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: Ink(
          width: 52,
          height: 52,
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [
                Color(0xFF00FF87),
                Color(0xFF00D4FF),
              ],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            shape: BoxShape.circle,
          ),
          child: InkWell(
            onTap: () => _onAiChatTap(context),
            splashColor: Colors.black12,
            child: Stack(
              alignment: Alignment.center,
              children: [
                const Icon(
                  Icons.auto_awesome,
                  color: Color(0xFF08120A),
                  size: 26,
                ),
                Positioned(
                  top: 5,
                  right: 6,
                  child: RotationTransition(
                    turns: _aiShimmerController,
                    child: Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        shape: BoxShape.circle,
                        boxShadow: [
                          BoxShadow(
                            color: Colors.white.withValues(alpha: 0.8),
                            blurRadius: 4,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

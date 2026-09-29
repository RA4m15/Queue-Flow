import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/network/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../models/token.dart';
import '../../models/user.dart';
import '../../providers/alerts_preference_provider.dart';
import '../../providers/app_providers.dart';
import '../../providers/auth_provider.dart';
import '../../providers/theme_provider.dart';
import '../../providers/token_provider.dart';
import '../../services/push_messaging_client.dart';
import '../../services/push_notification_service.dart';
import '../../widgets/token_status_badge.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  void _showEditProfileModal(BuildContext context, WidgetRef ref, AppUser user) {
    final nameController = TextEditingController(text: user.name);
    final phoneController = TextEditingController(text: user.phone ?? '');
    final formKey = GlobalKey<FormState>();
    bool isSaving = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setModalState) {
          final isDark = context.isDarkMode;
          final surfaceColor = context.themeSurface;
          final textColor = context.themeTextPrimary;
          final textSecondary = context.themeTextSecondary;
          final borderColor = context.themeBorder;
          final primaryColor = context.themePrimary;

          return Padding(
            padding: EdgeInsets.only(
              bottom: MediaQuery.of(context).viewInsets.bottom,
            ),
            child: Container(
              decoration: BoxDecoration(
                color: surfaceColor,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
                border: Border(top: BorderSide(color: borderColor, width: 1.5)),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
              child: Form(
                key: formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Center(
                      child: Container(
                        width: 44,
                        height: 5,
                        decoration: BoxDecoration(
                          color: textSecondary.withValues(alpha: 0.3),
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: primaryColor.withValues(alpha: 0.12),
                            shape: BoxShape.circle,
                          ),
                          child: Icon(Icons.person_outline_rounded, color: primaryColor, size: 22),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Edit Profile',
                                style: Theme.of(context).textTheme.titleLarge?.copyWith(
                                      fontWeight: FontWeight.bold,
                                      color: textColor,
                                    ),
                              ),
                              Text(
                                'Update your personal details',
                                style: TextStyle(color: textSecondary, fontSize: 13),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          onPressed: () => Navigator.of(ctx).pop(),
                          icon: Icon(Icons.close_rounded, color: textSecondary),
                        ),
                      ],
                    ),
                    const SizedBox(height: 20),
                    Text(
                      'FULL NAME',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 6),
                    TextFormField(
                      controller: nameController,
                      style: TextStyle(color: textColor),
                      maxLength: 100,
                      decoration: InputDecoration(
                        hintText: 'Enter your full name',
                        counterText: '',
                        prefixIcon: Icon(Icons.badge_outlined, color: textSecondary, size: 20),
                      ),
                      validator: (value) {
                        if (value == null || value.trim().isEmpty) {
                          return 'Full name cannot be empty';
                        }
                        if (value.trim().length < 2) {
                          return 'Name must be at least 2 characters';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'PHONE NUMBER',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 6),
                    TextFormField(
                      controller: phoneController,
                      keyboardType: TextInputType.phone,
                      style: TextStyle(color: textColor),
                      maxLength: 20,
                      decoration: InputDecoration(
                        hintText: '+1 (555) 000-0000',
                        counterText: '',
                        prefixIcon: Icon(Icons.phone_outlined, color: textSecondary, size: 20),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'EMAIL ADDRESS (VERIFIED)',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                      decoration: BoxDecoration(
                        color: isDark ? AppColors.surfaceElevated : AppColors.lightSurfaceElevated,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: borderColor),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.email_outlined, color: textSecondary, size: 20),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              user.email,
                              style: TextStyle(color: textSecondary, fontSize: 14),
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: AppColors.success.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: const Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.check_circle_rounded, color: AppColors.success, size: 12),
                                SizedBox(width: 4),
                                Text(
                                  'Verified',
                                  style: TextStyle(
                                    color: AppColors.success,
                                    fontSize: 10,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: primaryColor,
                          foregroundColor: isDark ? Colors.black : Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        onPressed: isSaving
                            ? null
                            : () async {
                                if (!formKey.currentState!.validate()) return;
                                setModalState(() => isSaving = true);
                                final messenger = ScaffoldMessenger.of(context);
                                try {
                                  await ref.read(authProvider.notifier).updateProfile(
                                        name: nameController.text.trim(),
                                        phone: phoneController.text.trim(),
                                      );
                                  if (ctx.mounted) {
                                    Navigator.of(ctx).pop();
                                  }
                                  messenger.showSnackBar(
                                    const SnackBar(
                                      content: Text('Profile updated successfully!'),
                                      backgroundColor: AppColors.success,
                                    ),
                                  );
                                } catch (e) {
                                  setModalState(() => isSaving = false);
                                  messenger.showSnackBar(
                                    SnackBar(
                                      content: Text(ApiException.getUserMessage(e)),
                                      backgroundColor: AppColors.danger,
                                    ),
                                  );
                                }
                              },
                        child: isSaving
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                              )
                            : const Text(
                                'Save Changes',
                                style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
                              ),
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  void _showPrivacyPolicyModal(BuildContext context) {
    final textColor = context.themeTextPrimary;
    final textSecondary = context.themeTextSecondary;
    final surfaceColor = context.themeSurface;
    final borderColor = context.themeBorder;
    final primaryColor = context.themePrimary;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.75,
        minChildSize: 0.5,
        maxChildSize: 0.95,
        builder: (_, scrollController) => Container(
          decoration: BoxDecoration(
            color: surfaceColor,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
            border: Border(top: BorderSide(color: borderColor, width: 1.5)),
          ),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                child: Column(
                  children: [
                    Center(
                      child: Container(
                        width: 44,
                        height: 5,
                        decoration: BoxDecoration(
                          color: textSecondary.withValues(alpha: 0.3),
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: primaryColor.withValues(alpha: 0.12),
                            shape: BoxShape.circle,
                          ),
                          child: Icon(Icons.privacy_tip_outlined, color: primaryColor, size: 22),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Privacy Policy',
                                style: TextStyle(
                                  color: textColor,
                                  fontSize: 18,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              Text(
                                'Last updated: September 2026',
                                style: TextStyle(color: textSecondary, fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          onPressed: () => Navigator.of(ctx).pop(),
                          icon: Icon(Icons.close_rounded, color: textSecondary),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView(
                  controller: scrollController,
                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                  children: [
                    _buildPolicySection(
                      context,
                      title: '1. Information We Collect',
                      body:
                          'QueueFlow collects personal information including your full name, phone number, and email address for account authentication and virtual queue booking. We also temporarily gather approximate proximity data to estimate arrival times and counter readiness when you enter a service center geofence.',
                    ),
                    _buildPolicySection(
                      context,
                      title: '2. How We Use Queue Data',
                      body:
                          'Your token bookings and queue interactions are used strictly to calculate wait times, assign serving counters, send real-time SMS/push notifications, and prevent double-booking fraud.',
                    ),
                    _buildPolicySection(
                      context,
                      title: '3. Data Security & Storage',
                      body:
                          'All authentication tokens and sensitive credentials are encrypted using industry-standard AES storage on your device. Server communications utilize Transport Layer Security (TLS 1.3). Real-time event streams are scoped exclusively to your authenticated user session.',
                    ),
                    _buildPolicySection(
                      context,
                      title: '4. Data Retention & Archival',
                      body:
                          'Completed and cancelled queue tokens are archived automatically after 30 days. You may request account deletion or data portability at any time by contacting our Privacy Compliance team.',
                    ),
                    _buildPolicySection(
                      context,
                      title: '5. Contact Privacy Office',
                      body:
                          'For questions or requests regarding your data, reach out to privacy@queueflow.io. We respond to all requests within 48 business hours.',
                    ),
                    const SizedBox(height: 20),
                    ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: primaryColor,
                        foregroundColor: context.isDarkMode ? Colors.black : Colors.white,
                      ),
                      onPressed: () => Navigator.of(ctx).pop(),
                      child: const Text('I Understand'),
                    ),
                    const SizedBox(height: 20),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPolicySection(BuildContext context, {required String title, required String body}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: context.themeTextPrimary,
              fontSize: 15,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            body,
            style: TextStyle(
              color: context.themeTextSecondary,
              fontSize: 13,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }

  void _showHelpAndSupportModal(BuildContext context, WidgetRef ref) {
    final textColor = context.themeTextPrimary;
    final textSecondary = context.themeTextSecondary;
    final surfaceColor = context.themeSurface;
    final borderColor = context.themeBorder;
    final primaryColor = context.themePrimary;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.75,
        minChildSize: 0.5,
        maxChildSize: 0.95,
        builder: (_, scrollController) => Container(
          decoration: BoxDecoration(
            color: surfaceColor,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
            border: Border(top: BorderSide(color: borderColor, width: 1.5)),
          ),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                child: Column(
                  children: [
                    Center(
                      child: Container(
                        width: 44,
                        height: 5,
                        decoration: BoxDecoration(
                          color: textSecondary.withValues(alpha: 0.3),
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: primaryColor.withValues(alpha: 0.12),
                            shape: BoxShape.circle,
                          ),
                          child: Icon(Icons.help_outline_rounded, color: primaryColor, size: 22),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Help & Support',
                                style: TextStyle(
                                  color: textColor,
                                  fontSize: 18,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              Text(
                                'Frequently asked questions & assistance',
                                style: TextStyle(color: textSecondary, fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          onPressed: () => Navigator.of(ctx).pop(),
                          icon: Icon(Icons.close_rounded, color: textSecondary),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView(
                  controller: scrollController,
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                  children: [
                    Text(
                      'FREQUENTLY ASKED QUESTIONS',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 10),
                    _buildFaqTile(
                      context,
                      question: 'How do virtual tokens work?',
                      answer:
                          'When you join a service queue, QueueFlow assigns you a unique token code. Your position in line updates in real-time, and you will receive notifications as your turn approaches.',
                    ),
                    _buildFaqTile(
                      context,
                      question: 'What happens when my token is called?',
                      answer:
                          'Your device will alert you with the assigned counter number. Proceed immediately to the indicated counter and display your token QR code to the agent.',
                    ),
                    _buildFaqTile(
                      context,
                      question: 'Can I swap positions with someone else?',
                      answer:
                          'Yes! If peer-to-peer queue swapping is enabled at your center, you can offer or accept position swaps directly from the Live Token screen.',
                    ),
                    _buildFaqTile(
                      context,
                      question: 'What if I miss my turn?',
                      answer:
                          'If you miss your call window, your ticket may be marked as skipped. You can contact center personnel or rejoin the queue from the home screen.',
                    ),
                    const SizedBox(height: 20),
                    Text(
                      'CONTACT CHANNELS',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 10),
                    _buildContactRow(
                      context,
                      icon: Icons.email_outlined,
                      title: 'Email Support',
                      subtitle: 'support@queueflow.io',
                      onTap: () async {
                        Navigator.of(ctx).pop();
                        final uri = Uri(scheme: 'mailto', path: 'support@queueflow.io');
                        bool launched = false;
                        try {
                          if (await canLaunchUrl(uri)) {
                            launched = await launchUrl(uri);
                          }
                        } catch (_) {
                          launched = false;
                        }
                        if (!launched) {
                          await Clipboard.setData(const ClipboardData(text: 'support@queueflow.io'));
                        }
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(launched
                                  ? 'Opening email client (support@queueflow.io)...'
                                  : 'Support email copied to clipboard: support@queueflow.io'),
                              backgroundColor: AppColors.success,
                            ),
                          );
                        }
                      },
                    ),
                    const SizedBox(height: 8),
                    _buildContactRow(
                      context,
                      icon: Icons.phone_in_talk_outlined,
                      title: 'Customer Helpline',
                      subtitle: '+1 (800) 555-QUEUE (Toll-Free)',
                      onTap: () async {
                        Navigator.of(ctx).pop();
                        final uri = Uri(scheme: 'tel', path: '+18005557838');
                        bool launched = false;
                        try {
                          if (await canLaunchUrl(uri)) {
                            launched = await launchUrl(uri);
                          }
                        } catch (_) {
                          launched = false;
                        }
                        if (!launched) {
                          await Clipboard.setData(const ClipboardData(text: '+1 (800) 555-QUEUE'));
                        }
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(launched
                                  ? 'Initiating call to Helpline (+1 800-555-QUEUE)...'
                                  : 'Helpline number copied to clipboard: +1 (800) 555-QUEUE'),
                              backgroundColor: launched ? AppColors.info : AppColors.success,
                            ),
                          );
                        }
                      },
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: primaryColor,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                        icon: const Icon(Icons.auto_awesome, size: 18),
                        label: const Text(
                          'Chat with Gemini AI Assistant',
                          style: TextStyle(fontWeight: FontWeight.bold),
                        ),
                        onPressed: () {
                          Navigator.of(ctx).pop();
                          context.push('/support-chat');
                        },
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: primaryColor,
                          side: BorderSide(color: primaryColor.withValues(alpha: 0.5)),
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                        icon: const Icon(Icons.report_problem_outlined, size: 18),
                        label: const Text(
                          'Report an Issue / Submit Ticket',
                          style: TextStyle(fontWeight: FontWeight.w600),
                        ),
                        onPressed: () {
                          Navigator.of(ctx).pop();
                          _showReportIssueModal(context, ref);
                        },
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showReportIssueModal(BuildContext context, WidgetRef ref) {
    final textColor = context.themeTextPrimary;
    final textSecondary = context.themeTextSecondary;
    final surfaceColor = context.themeSurface;
    final borderColor = context.themeBorder;
    final primaryColor = context.themePrimary;
    final user = ref.read(authProvider).user;

    final subjectController = TextEditingController();
    final descriptionController = TextEditingController();
    final formKey = GlobalKey<FormState>();
    String selectedCategory = 'Queue / Wait Time';
    bool isSubmitting = false;

    final categories = [
      'Queue / Wait Time',
      'Counter / Staff',
      'App Glitch / Bug',
      'Account / Security',
      'Other',
    ];

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setModalState) => Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(context).viewInsets.bottom,
          ),
          child: Container(
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
              border: Border(top: BorderSide(color: borderColor, width: 1.5)),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
            child: Form(
              key: formKey,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Center(
                      child: Container(
                        width: 44,
                        height: 5,
                        decoration: BoxDecoration(
                          color: textSecondary.withValues(alpha: 0.3),
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: AppColors.danger.withValues(alpha: 0.15),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.report_problem_rounded, color: AppColors.danger, size: 22),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Report an Issue',
                                style: TextStyle(
                                  color: textColor,
                                  fontSize: 18,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              Text(
                                'We respond within 24h to ${user?.email ?? 'your email'}',
                                style: TextStyle(color: textSecondary, fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          onPressed: () => Navigator.of(ctx).pop(),
                          icon: Icon(Icons.close_rounded, color: textSecondary),
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    Text(
                      'ISSUE CATEGORY',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 6,
                      children: categories.map((cat) {
                        final isSelected = selectedCategory == cat;
                        return ChoiceChip(
                          label: Text(
                            cat,
                            style: TextStyle(
                              color: isSelected
                                  ? (context.isDarkMode ? Colors.black : Colors.white)
                                  : textSecondary,
                              fontSize: 12,
                              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                            ),
                          ),
                          selected: isSelected,
                          selectedColor: primaryColor,
                          backgroundColor: context.isDarkMode
                              ? AppColors.surfaceElevated
                              : AppColors.lightSurfaceElevated,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                            side: BorderSide(
                              color: isSelected ? primaryColor : borderColor,
                            ),
                          ),
                          onSelected: (val) {
                            if (val) setModalState(() => selectedCategory = cat);
                          },
                        );
                      }).toList(),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'SUBJECT',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 6),
                    TextFormField(
                      controller: subjectController,
                      style: TextStyle(color: textColor),
                      maxLength: 100,
                      decoration: InputDecoration(
                        hintText: 'Brief summary of the issue',
                        counterText: '',
                        prefixIcon: Icon(Icons.subject_rounded, color: textSecondary, size: 20),
                      ),
                      validator: (val) {
                        if (val == null || val.trim().isEmpty) return 'Subject is required';
                        return null;
                      },
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'DETAILED DESCRIPTION',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 6),
                    TextFormField(
                      controller: descriptionController,
                      style: TextStyle(color: textColor),
                      maxLines: 4,
                      maxLength: 1000,
                      decoration: const InputDecoration(
                        hintText: 'Describe what happened, counter/center name, or error seen...',
                      ),
                      validator: (val) {
                        if (val == null || val.trim().isEmpty) return 'Description is required';
                        if (val.trim().length < 10) return 'Please provide at least 10 characters';
                        return null;
                      },
                    ),
                    const SizedBox(height: 20),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: primaryColor,
                          foregroundColor: context.isDarkMode ? Colors.black : Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                        onPressed: isSubmitting
                            ? null
                            : () async {
                                if (!formKey.currentState!.validate()) return;
                                setModalState(() => isSubmitting = true);
                                try {
                                  final apiService = ref.read(apiServiceProvider);
                                  final res = await apiService.createSupportTicket(
                                    category: selectedCategory,
                                    subject: subjectController.text.trim(),
                                    description: descriptionController.text.trim(),
                                  );
                                  final realTicketId = res['ticketId']?.toString() ?? res['id']?.toString() ?? 'CONFIRMED';
                                  if (ctx.mounted) {
                                    Navigator.of(ctx).pop();
                                  }
                                  if (context.mounted) {
                                    _showTicketConfirmationDialog(context, realTicketId, subjectController.text.trim());
                                  }
                                } catch (e) {
                                  if (ctx.mounted) {
                                    setModalState(() => isSubmitting = false);
                                    ScaffoldMessenger.of(ctx).showSnackBar(
                                      SnackBar(
                                        content: Text(ApiException.getUserMessage(e)),
                                        backgroundColor: AppColors.danger,
                                      ),
                                    );
                                  }
                                }
                              },
                        child: isSubmitting
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                              )
                            : const Text('Submit Ticket', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                      ),
                    ),
                    const SizedBox(height: 10),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _showTicketConfirmationDialog(BuildContext context, String ticketId, String subject) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: context.themeSurface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.success.withValues(alpha: 0.15),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.check_circle_outline_rounded, color: AppColors.success, size: 40),
            ),
            const SizedBox(height: 16),
            Text(
              'Support Ticket Created',
              style: TextStyle(
                color: context.themeTextPrimary,
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Reference: $ticketId',
              style: AppTheme.monoStyle(
                fontSize: 14,
                color: context.themePrimary,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              'We have received your issue regarding "$subject". A customer support officer has been assigned.',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: context.themeTextSecondary,
                fontSize: 13,
                height: 1.4,
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: context.themePrimary,
                foregroundColor: context.isDarkMode ? Colors.black : Colors.white,
              ),
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildFaqTile(BuildContext context, {required String question, required String answer}) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: context.isDarkMode ? AppColors.surfaceElevated : AppColors.lightSurfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.themeBorder),
      ),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
          title: Text(
            question,
            style: TextStyle(
              color: context.themeTextPrimary,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              child: Text(
                answer,
                style: TextStyle(
                  color: context.themeTextSecondary,
                  fontSize: 12,
                  height: 1.45,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildContactRow(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: context.isDarkMode ? AppColors.surfaceElevated : AppColors.lightSurfaceElevated,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: context.themeBorder),
        ),
        child: Row(
          children: [
            Icon(icon, color: context.themePrimary, size: 22),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      color: context.themeTextPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    subtitle,
                    style: TextStyle(
                      color: context.themeTextSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, color: context.themeTextSecondary, size: 20),
          ],
        ),
      ),
    );
  }


  void _showCancelTicketDialog(BuildContext context, WidgetRef ref, TokenModel token) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: context.themeSurface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text('Cancel Ticket', style: TextStyle(color: context.themeTextPrimary)),
        content: Text(
          'Are you sure you want to cancel ticket ${token.tokenCode}? You will forfeit your position in queue.',
          style: TextStyle(color: context.themeTextSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text('Keep Ticket', style: TextStyle(color: context.themeTextSecondary)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.danger,
              foregroundColor: Colors.white,
            ),
            onPressed: () async {
              Navigator.of(ctx).pop();
              try {
                await ref.read(tokenProvider.notifier).cancelToken(token.id);
                ref.invalidate(tokenHistoryProvider);
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Ticket cancelled successfully.'),
                      backgroundColor: AppColors.success,
                    ),
                  );
                }
              } catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('Could not cancel ticket: ${ApiException.getUserMessage(e)}'),
                      backgroundColor: AppColors.danger,
                    ),
                  );
                }
              }
            },
            child: const Text('Cancel Ticket'),
          ),
        ],
      ),
    );
  }

  void _showLogoutDialog(BuildContext context, WidgetRef ref) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: context.themeSurface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text('Sign Out', style: TextStyle(color: context.themeTextPrimary)),
        content: Text(
          'Are you sure you want to sign out of QueueFlow?',
          style: TextStyle(color: context.themeTextSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text('Cancel', style: TextStyle(color: context.themeTextSecondary)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.danger,
              foregroundColor: Colors.white,
            ),
            onPressed: () async {
              Navigator.of(ctx).pop();
              await ref.read(authProvider.notifier).logout();
              if (context.mounted) {
                context.go('/login');
              }
            },
            child: const Text('Sign Out'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authProvider).user;
    final socket = ref.watch(socketServiceProvider);
    final themeMode = ref.watch(themeModeProvider);
    final alertsEnabled = ref.watch(alertsPreferenceProvider);
    final tokenState = ref.watch(tokenProvider);
    final pushState = ref.watch(pushNotificationServiceProvider);

    final activeToken = tokenState.activeToken;
    final token = (activeToken != null && activeToken.isActive) ? activeToken : null;

    final isDark = context.isDarkMode;
    final surfaceColor = context.themeSurface;
    final textColor = context.themeTextPrimary;
    final textSecondary = context.themeTextSecondary;
    final borderColor = context.themeBorder;
    final primaryColor = context.themePrimary;

    return Scaffold(
      backgroundColor: context.themeBackground,
      appBar: AppBar(
        title: const Text('Profile & Settings'),
        actions: [
          IconButton(
            tooltip: 'Sign Out',
            icon: const Icon(Icons.logout_rounded, color: AppColors.danger),
            onPressed: () => _showLogoutDialog(context, ref),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: primaryColor,
        onRefresh: () async {
          ref.invalidate(tokenHistoryProvider);
          await ref.read(tokenProvider.notifier).fetchActiveToken();
        },
        child: ListView(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
          children: [
            // ─── 1. USER PROFILE CARD ──────────────────────────────
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: surfaceColor,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: borderColor, width: 1.2),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: isDark ? 0.3 : 0.04),
                    blurRadius: 10,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Column(
                children: [
                  Row(
                    children: [
                      Stack(
                        children: [
                          Container(
                            width: 68,
                            height: 68,
                            decoration: BoxDecoration(
                              color: primaryColor.withValues(alpha: 0.15),
                              shape: BoxShape.circle,
                              border: Border.all(color: primaryColor, width: 2),
                            ),
                            child: Center(
                              child: Text(
                                user != null && user.name.isNotEmpty
                                    ? user.name[0].toUpperCase()
                                    : 'U',
                                style: TextStyle(
                                  color: primaryColor,
                                  fontSize: 28,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                          ),
                          Positioned(
                            bottom: 2,
                            right: 2,
                            child: Container(
                              width: 14,
                              height: 14,
                              decoration: BoxDecoration(
                                color: AppColors.success,
                                shape: BoxShape.circle,
                                border: Border.all(color: surfaceColor, width: 2),
                              ),
                            ),
                          ),
                        ],
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
                                    user?.name ?? 'Customer',
                                    style: TextStyle(
                                      color: textColor,
                                      fontSize: 19,
                                      fontWeight: FontWeight.bold,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: primaryColor.withValues(alpha: 0.15),
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: Text(
                                    user?.role.toUpperCase() ?? 'CUSTOMER',
                                    style: TextStyle(
                                      color: primaryColor,
                                      fontSize: 10,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              user?.email ?? '',
                              style: TextStyle(color: textSecondary, fontSize: 13),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            if (user?.phone != null && user!.phone!.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Text(
                                user.phone!,
                                style: TextStyle(color: textSecondary, fontSize: 12),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  const Divider(height: 1),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: user == null
                              ? null
                              : () => _showEditProfileModal(context, ref, user),
                          icon: const Icon(Icons.edit_outlined, size: 16),
                          label: const Text('Edit Profile'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: primaryColor,
                            side: BorderSide(color: primaryColor.withValues(alpha: 0.6)),
                            padding: const EdgeInsets.symmetric(vertical: 10),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(10),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 22),

            // ─── 2. ACTIVE TICKET SECTION ──────────────────────────
            _buildSectionHeader(
              context,
              title: 'Active Ticket',
              badge: token != null ? '1 ACTIVE' : null,
              badgeColor: AppColors.secondary,
            ),
            const SizedBox(height: 8),
            if (token != null)
              _buildActiveTicketCard(context, ref, token)
            else
              _buildNoActiveTicketCard(context),
            const SizedBox(height: 22),

            // ─── 3. APP PREFERENCES & THEME ────────────────────────
            _buildSectionHeader(context, title: 'App Preferences'),
            const SizedBox(height: 8),
            Container(
              decoration: BoxDecoration(
                color: surfaceColor,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: borderColor),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Theme Mode Selector
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 10),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Row(
                          children: [
                            Icon(
                              isDark ? Icons.dark_mode_rounded : Icons.light_mode_rounded,
                              color: primaryColor,
                              size: 20,
                            ),
                            const SizedBox(width: 12),
                            Text(
                              'App Theme',
                              style: TextStyle(
                                color: textColor,
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                        Text(
                          themeMode == ThemeMode.dark
                              ? 'Dark Mode'
                              : (themeMode == ThemeMode.light ? 'Light Mode' : 'System'),
                          style: TextStyle(
                            color: textSecondary,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                    child: Container(
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        color: isDark ? AppColors.surfaceElevated : AppColors.lightSurfaceElevated,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: borderColor),
                      ),
                      child: Row(
                        children: [
                          _buildThemeOptionButton(
                            context,
                            ref,
                            title: 'Dark',
                            icon: Icons.dark_mode_outlined,
                            isSelected: themeMode == ThemeMode.dark,
                            mode: ThemeMode.dark,
                          ),
                          _buildThemeOptionButton(
                            context,
                            ref,
                            title: 'Light',
                            icon: Icons.light_mode_outlined,
                            isSelected: themeMode == ThemeMode.light,
                            mode: ThemeMode.light,
                          ),
                          _buildThemeOptionButton(
                            context,
                            ref,
                            title: 'System',
                            icon: Icons.settings_brightness_outlined,
                            isSelected: themeMode == ThemeMode.system,
                            mode: ThemeMode.system,
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Divider(height: 1),

                  // Notifications & Alerts Toggle
                  SwitchListTile(
                    activeTrackColor: primaryColor.withValues(alpha: 0.5),
                    activeThumbColor: primaryColor,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                    secondary: Icon(
                      alertsEnabled
                          ? Icons.notifications_active_rounded
                          : Icons.notifications_off_rounded,
                      color: alertsEnabled ? primaryColor : textSecondary,
                      size: 22,
                    ),
                    title: Text(
                      'Queue Alerts & In-App Notifications',
                      style: TextStyle(
                        color: textColor,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    subtitle: Text(
                      alertsEnabled
                          ? 'Real-time turn alerts, approaching warnings, and counter changes are enabled.'
                          : 'Queue alerts are currently muted. You must keep the app open to watch your token.',
                      style: TextStyle(
                        color: textSecondary,
                        fontSize: 11,
                      ),
                    ),
                    value: alertsEnabled,
                    onChanged: (val) async {
                      await ref.read(alertsPreferenceProvider.notifier).setAlertsEnabled(val);
                      if (val && pushState.permission != PushPermissionStatus.granted) {
                        await ref.read(pushNotificationServiceProvider.notifier).requestPermission();
                      }
                      try {
                        await ref.read(authProvider.notifier).updateProfile(
                              preferences: {'notifyApp': val},
                            );
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(val
                                  ? 'Alerts enabled & synced with backend.'
                                  : 'Alerts disabled & synced with backend.'),
                              backgroundColor: AppColors.success,
                              duration: const Duration(seconds: 2),
                            ),
                          );
                        }
                      } catch (_) {}
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 22),

            // ─── 5. HELP, LIVE SUPPORT & LEGAL ──────────────────────
            _buildSectionHeader(context, title: 'Support & Legal'),
            const SizedBox(height: 8),
            Container(
              decoration: BoxDecoration(
                color: surfaceColor,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: borderColor),
              ),
              child: Column(
                children: [
                  // Live Support / Gemini AI Assistant Card
                  ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                    leading: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            gradient: const LinearGradient(
                              colors: [AppColors.primary, AppColors.secondary],
                              begin: Alignment.topLeft,
                              end: Alignment.bottomRight,
                            ),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: const Icon(Icons.auto_awesome, color: Colors.white, size: 20),
                        ),
                        Positioned(
                          top: -2,
                          right: -2,
                          child: Container(
                            width: 8,
                            height: 8,
                            decoration: const BoxDecoration(
                              color: AppColors.success,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ),
                      ],
                    ),
                    title: Row(
                      children: [
                        Expanded(
                          child: Text(
                            'AI Support Assistant',
                            style: TextStyle(
                              color: textColor,
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppColors.primary.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: const Text(
                            'GEMINI AI',
                            style: TextStyle(
                              color: AppColors.primary,
                              fontSize: 9,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                      ],
                    ),
                    subtitle: Text(
                      'Direct chat with Gemini 1.5 Flash queue assistant',
                      style: TextStyle(color: textSecondary, fontSize: 11),
                    ),
                    trailing: Icon(Icons.chevron_right_rounded, color: textSecondary, size: 20),
                    onTap: () => context.push('/support-chat'),
                  ),
                  const Divider(height: 1),

                  // Help & Support
                  ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
                    leading: Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: AppColors.info.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: const Icon(Icons.help_center_outlined, color: AppColors.info, size: 22),
                    ),
                    title: Text(
                      'Help & Support',
                      style: TextStyle(
                        color: textColor,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    subtitle: Text(
                      'Frequently asked questions, center rules & helpline',
                      style: TextStyle(color: textSecondary, fontSize: 11),
                    ),
                    trailing: Icon(Icons.chevron_right_rounded, color: textSecondary, size: 20),
                    onTap: () => _showHelpAndSupportModal(context, ref),
                  ),
                  const Divider(height: 1),

                  // Privacy Policy
                  ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
                    leading: Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: AppColors.accentPurple.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: const Icon(Icons.security_rounded, color: AppColors.accentPurple, size: 22),
                    ),
                    title: Text(
                      'Privacy Policy & Terms',
                      style: TextStyle(
                        color: textColor,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    subtitle: Text(
                      'Virtual queue data privacy, location handling & security',
                      style: TextStyle(color: textSecondary, fontSize: 11),
                    ),
                    trailing: Icon(Icons.chevron_right_rounded, color: textSecondary, size: 20),
                    onTap: () => _showPrivacyPolicyModal(context),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 22),

            // ─── 6. SYSTEM STATUS ──────────────────────────────────
            _buildSectionHeader(context, title: 'System Diagnostics'),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: surfaceColor,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: borderColor),
              ),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('Backend API', style: TextStyle(color: textSecondary, fontSize: 13)),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: primaryColor.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          'Render Production',
                          style: TextStyle(color: primaryColor, fontSize: 11, fontWeight: FontWeight.bold),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('Socket.IO Gateway', style: TextStyle(color: textSecondary, fontSize: 13)),
                      Row(
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              color: socket.isConnected ? AppColors.success : AppColors.warning,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            socket.isConnected ? 'Connected' : 'Connecting...',
                            style: TextStyle(
                              color: socket.isConnected ? AppColors.success : AppColors.warning,
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('App Build Version', style: TextStyle(color: textSecondary, fontSize: 13)),
                      Text(
                        'v1.0.0+1 (QueueFlow Core)',
                        style: TextStyle(color: textColor, fontSize: 12, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 28),

            // ─── 7. LOGOUT BUTTON ──────────────────────────────────
            ElevatedButton.icon(
              onPressed: () => _showLogoutDialog(context, ref),
              style: ElevatedButton.styleFrom(
                backgroundColor: isDark ? AppColors.surfaceElevated : AppColors.lightSurfaceElevated,
                foregroundColor: AppColors.danger,
                side: BorderSide(color: AppColors.danger.withValues(alpha: 0.4)),
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
              icon: const Icon(Icons.logout_rounded, size: 20),
              label: const Text(
                'Sign Out of QueueFlow',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
              ),
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  // ─── HELPER WIDGETS ──────────────────────────────────────────────

  Widget _buildSectionHeader(
    BuildContext context, {
    required String title,
    String? badge,
    Color? badgeColor,
    Widget? trailingAction,
  }) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Row(
          children: [
            Text(
              title,
              style: TextStyle(
                color: context.themeTextSecondary,
                fontSize: 12,
                fontWeight: FontWeight.bold,
                letterSpacing: 0.6,
              ),
            ),
            if (badge != null) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                decoration: BoxDecoration(
                  color: (badgeColor ?? context.themePrimary).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  badge,
                  style: TextStyle(
                    color: badgeColor ?? context.themePrimary,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ],
        ),
        ?trailingAction,
      ],
    );
  }

  Widget _buildActiveTicketCard(BuildContext context, WidgetRef ref, TokenModel token) {
    final isDark = context.isDarkMode;
    final surfaceColor = context.themeSurface;
    final textColor = context.themeTextPrimary;
    final textSecondary = context.themeTextSecondary;
    final primaryColor = context.themePrimary;

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: primaryColor, width: 1.5),
        boxShadow: [
          BoxShadow(
            color: primaryColor.withValues(alpha: 0.12),
            blurRadius: 16,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: AppColors.statusColor(token.status),
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    token.tokenCode,
                    style: AppTheme.monoStyle(
                      fontSize: 26,
                      fontWeight: FontWeight.w800,
                      color: primaryColor,
                    ),
                  ),
                ],
              ),
              TokenStatusBadge(status: token.status),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            token.serviceName ?? 'Service',
            style: TextStyle(
              color: textColor,
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            token.centerName ?? 'Service Center',
            style: TextStyle(color: textSecondary, fontSize: 13),
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: isDark ? AppColors.surfaceElevated : AppColors.lightSurfaceElevated,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                Column(
                  children: [
                    Text('Position', style: TextStyle(color: textSecondary, fontSize: 11)),
                    const SizedBox(height: 2),
                    Text(
                      token.currentPosition != null ? '#${token.currentPosition}' : '--',
                      style: TextStyle(color: textColor, fontWeight: FontWeight.bold, fontSize: 14),
                    ),
                  ],
                ),
                Container(width: 1, height: 24, color: context.themeBorder),
                Column(
                  children: [
                    Text('Est. Wait', style: TextStyle(color: textSecondary, fontSize: 11)),
                    const SizedBox(height: 2),
                    Text(
                      token.waitEstimateMinutes != null
                          ? '${token.waitEstimateMinutes} min'
                          : '--',
                      style: TextStyle(color: textColor, fontWeight: FontWeight.bold, fontSize: 14),
                    ),
                  ],
                ),
                Container(width: 1, height: 24, color: context.themeBorder),
                Column(
                  children: [
                    Text('Counter', style: TextStyle(color: textSecondary, fontSize: 11)),
                    const SizedBox(height: 2),
                    Text(
                      token.counterNumber != null
                          ? 'C-${token.counterNumber}'
                          : (token.counterName ?? 'Waiting'),
                      style: TextStyle(color: textColor, fontWeight: FontWeight.bold, fontSize: 14),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: () => context.go('/token/${token.id}'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: primaryColor,
                    foregroundColor: isDark ? Colors.black : Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                  icon: const Icon(Icons.remove_red_eye_outlined, size: 16),
                  label: const Text('View Live Token', style: TextStyle(fontWeight: FontWeight.bold)),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: () => context.push('/token/qr', extra: token),
                style: OutlinedButton.styleFrom(
                  foregroundColor: primaryColor,
                  side: BorderSide(color: primaryColor),
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                ),
                child: const Icon(Icons.qr_code_rounded, size: 20),
              ),
              if (token.canCancel) ...[
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: () => _showCancelTicketDialog(context, ref, token),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.danger,
                    side: const BorderSide(color: AppColors.danger),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  ),
                  child: const Icon(Icons.close_rounded, size: 20),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildNoActiveTicketCard(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 20),
      decoration: BoxDecoration(
        color: context.themeSurface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: context.themeBorder),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: context.themeTextSecondary.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(Icons.confirmation_number_outlined, color: context.themeTextSecondary, size: 26),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'No Active Ticket',
                  style: TextStyle(
                    color: context.themeTextPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  'You are not waiting in any virtual line.',
                  style: TextStyle(color: context.themeTextSecondary, fontSize: 12),
                ),
              ],
            ),
          ),
          TextButton(
            onPressed: () => context.go('/home'),
            child: Text(
              'Join Queue',
              style: TextStyle(
                color: context.themePrimary,
                fontWeight: FontWeight.bold,
                fontSize: 13,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildThemeOptionButton(
    BuildContext context,
    WidgetRef ref, {
    required String title,
    required IconData icon,
    required bool isSelected,
    required ThemeMode mode,
  }) {
    final primaryColor = context.themePrimary;
    final isDark = context.isDarkMode;

    return Expanded(
      child: GestureDetector(
        onTap: () => ref.read(themeModeProvider.notifier).setThemeMode(mode),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: isSelected ? primaryColor : Colors.transparent,
            borderRadius: BorderRadius.circular(9),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                icon,
                size: 16,
                color: isSelected
                    ? (isDark ? Colors.black : Colors.white)
                    : context.themeTextSecondary,
              ),
              const SizedBox(width: 6),
              Text(
                title,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
                  color: isSelected
                      ? (isDark ? Colors.black : Colors.white)
                      : context.themeTextSecondary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

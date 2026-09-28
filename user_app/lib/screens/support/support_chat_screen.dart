import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dash_chat_2/dash_chat_2.dart';
import 'package:google_generative_ai/google_generative_ai.dart';
import '../../core/theme/app_theme.dart';
import '../../providers/auth_provider.dart';
import '../../providers/gemini_support_provider.dart';

class SupportChatScreen extends ConsumerStatefulWidget {
  const SupportChatScreen({super.key});

  @override
  ConsumerState<SupportChatScreen> createState() => _SupportChatScreenState();
}

class _SupportChatScreenState extends ConsumerState<SupportChatScreen> {
  // Local Dart list to store DashChat UI message history
  final List<ChatMessage> _messages = [];
  bool _isTyping = false;
  bool _hasCustomKey = false;

  late final ChatUser _botUser;
  late ChatUser _currentUser;

  final List<String> _quickSuggestions = [
    '🎫 How to book a ticket?',
    '⏱️ How are wait times calculated?',
    '🔄 How does ticket swap work?',
    '🔔 How do alerts work?',
    '🏢 Find nearest service center',
  ];

  @override
  void initState() {
    super.initState();
    _botUser = ChatUser(
      id: 'queueflow_gemini_bot',
      firstName: 'QueueFlow',
      lastName: 'Assistant',
      profileImage: null,
    );

    _currentUser = ChatUser(
      id: 'current_user',
      firstName: 'You',
    );

    // Initial welcoming message from Gemini QueueFlow Assistant
    _messages.add(
      ChatMessage(
        user: _botUser,
        createdAt: DateTime.now(),
        text: "Hello! 👋 I'm your QueueFlow AI Assistant, powered by Gemini. Ask me anything about your queue tickets, live wait times, or service centers!",
      ),
    );

    _checkApiKeyStatus();
  }

  Future<void> _checkApiKeyStatus() async {
    final service = ref.read(geminiSupportServiceProvider);
    final hasKey = await service.hasApiKey();
    if (mounted) {
      setState(() {
        _hasCustomKey = hasKey;
      });
    }
  }

  void _syncCurrentUser(dynamic authUser) {
    if (authUser != null) {
      final name = authUser.name?.toString() ?? 'You';
      final parts = name.split(' ');
      _currentUser = ChatUser(
        id: authUser.id?.toString() ?? 'current_user',
        firstName: parts.isNotEmpty ? parts.first : 'You',
        lastName: parts.length > 1 ? parts.sublist(1).join(' ') : null,
      );
    }
  }

  Future<void> _handleSendMessage(ChatMessage chatMessage) async {
    final text = chatMessage.text.trim();
    if (text.isEmpty) return;

    // 1. Add user's message to local message history
    setState(() {
      _messages.insert(0, chatMessage);
      _isTyping = true;
    });

    try {
      final geminiService = ref.read(geminiSupportServiceProvider);

      // 2. Pass the last 5-10 messages with every new API call to give the bot short-term memory
      final replyText = await geminiService.sendMessage(
        userText: text,
        history: _messages,
        currentUserId: _currentUser.id,
        historyLimit: 10,
      );

      if (!mounted) return;

      // 3. Add bot's reply to message history
      final botMessage = ChatMessage(
        user: _botUser,
        createdAt: DateTime.now(),
        text: replyText.isNotEmpty ? replyText : "I am here to assist with your QueueFlow tickets. What can I do for you?",
      );

      setState(() {
        _messages.insert(0, botMessage);
        _isTyping = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isTyping = false;
        _messages.insert(
          0,
          ChatMessage(
            user: _botUser,
            createdAt: DateTime.now(),
            text: "Sorry, I encountered an issue processing your request ($e). Please try again.",
          ),
        );
      });
    }
  }

  void _onSuggestionTapped(String text) {
    // Strip leading emoji if present for a clean query
    final cleanText = text.replaceAll(RegExp(r'^[^\w\s]+\s*'), '');
    final msg = ChatMessage(
      user: _currentUser,
      createdAt: DateTime.now(),
      text: cleanText,
    );
    _handleSendMessage(msg);
  }

  void _clearChat() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: context.themeSurface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Text(
          'Clear Conversation?',
          style: TextStyle(color: context.themeTextPrimary, fontWeight: FontWeight.bold),
        ),
        content: Text(
          'This will clear the current support chat history and reset short-term memory.',
          style: TextStyle(color: context.themeTextSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Cancel', style: TextStyle(color: context.themeTextSecondary)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.danger,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              setState(() {
                _messages.clear();
                _messages.add(
                  ChatMessage(
                    user: _botUser,
                    createdAt: DateTime.now(),
                    text: "Conversation reset. How can I help you today?",
                  ),
                );
              });
            },
            child: const Text('Clear'),
          ),
        ],
      ),
    );
  }

  void _showApiKeyDialog() async {
    final service = ref.read(geminiSupportServiceProvider);
    final currentKey = await service.getApiKey() ?? '';
    final controller = TextEditingController(text: currentKey);
    bool isTesting = false;
    String? statusMessage;
    bool isSuccess = false;

    if (!mounted) return;

    showDialog(
      context: context,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (ctx, setDialogState) {
          return AlertDialog(
            backgroundColor: context.themeSurface,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            title: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(Icons.key_rounded, color: AppColors.primary, size: 20),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'Gemini API Key',
                    style: TextStyle(color: context.themeTextPrimary, fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                ),
              ],
            ),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Provide your Google Gemini API key to securely send customer queries directly to the Gemini 1.5 Flash model.',
                    style: TextStyle(color: context.themeTextSecondary, fontSize: 13, height: 1.4),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: controller,
                    obscureText: true,
                    style: TextStyle(color: context.themeTextPrimary, fontSize: 14),
                    decoration: InputDecoration(
                      labelText: 'API Key',
                      labelStyle: TextStyle(color: context.themeTextSecondary),
                      hintText: 'Enter API Key...',
                      hintStyle: TextStyle(color: context.themeTextSecondary.withValues(alpha: 0.5)),
                      prefixIcon: const Icon(Icons.vpn_key_outlined, size: 18),
                      filled: true,
                      fillColor: context.themeSurfaceCard,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: context.themeBorder),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: context.themeBorder),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: AppColors.primary, width: 1.5),
                      ),
                    ),
                  ),
                  if (statusMessage != null) ...[
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Icon(
                          isSuccess ? Icons.check_circle_rounded : Icons.error_outline_rounded,
                          color: isSuccess ? AppColors.success : AppColors.danger,
                          size: 16,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            statusMessage!,
                            style: TextStyle(
                              color: isSuccess ? AppColors.success : AppColors.danger,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 12),
                  Text(
                    'Note: Keys can also be provided at build time via --dart-define=GEMINI_API_KEY=your_key.',
                    style: TextStyle(color: context.themeTextMuted, fontSize: 11),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: isTesting ? null : () => Navigator.pop(dialogCtx),
                child: Text('Close', style: TextStyle(color: context.themeTextSecondary)),
              ),
              OutlinedButton(
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.primary,
                  side: const BorderSide(color: AppColors.primary),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                onPressed: isTesting
                    ? null
                    : () async {
                        final key = controller.text.trim();
                        if (key.isEmpty) {
                          setDialogState(() {
                            statusMessage = 'Please enter an API key to test.';
                            isSuccess = false;
                          });
                          return;
                        }
                        setDialogState(() {
                          isTesting = true;
                          statusMessage = 'Connecting to Gemini...';
                          isSuccess = false;
                        });
                        try {
                          final model = service.createModel(apiKey: key);
                          final res = await model.generateContent([
                            Content.text('Ping. Reply with one word: OK.'),
                          ]);
                          if (res.text != null && res.text!.isNotEmpty) {
                            setDialogState(() {
                              isTesting = false;
                              statusMessage = 'Connected! Gemini response received.';
                              isSuccess = true;
                            });
                          } else {
                            setDialogState(() {
                              isTesting = false;
                              statusMessage = 'No response received from Gemini.';
                              isSuccess = false;
                            });
                          }
                        } catch (e) {
                          setDialogState(() {
                            isTesting = false;
                            statusMessage = 'Connection failed: $e';
                            isSuccess = false;
                          });
                        }
                      },
                child: isTesting
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary),
                      )
                    : const Text('Test Key'),
              ),
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                onPressed: () async {
                  final key = controller.text.trim();
                  final messenger = ScaffoldMessenger.of(context);
                  await service.saveApiKey(key);
                  if (dialogCtx.mounted) {
                    Navigator.pop(dialogCtx);
                  }
                  if (!mounted) return;
                  setState(() {
                    _hasCustomKey = key.isNotEmpty;
                  });
                  messenger.showSnackBar(
                    SnackBar(
                      content: Text(
                        key.isNotEmpty ? 'Gemini API Key saved securely.' : 'Gemini API Key removed.',
                      ),
                      behavior: SnackBarBehavior.floating,
                      backgroundColor: AppColors.success,
                    ),
                  );
                },
                child: const Text('Save'),
              ),
            ],
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);
    _syncCurrentUser(authState.user);

    final isDark = context.isDarkMode;
    final primaryColor = context.themePrimary;
    final botAvatarBg = isDark ? const Color(0xFF1E293B) : const Color(0xFFEFF6FF);

    return Scaffold(
      backgroundColor: context.themeBackground,
      appBar: AppBar(
        backgroundColor: context.themeSurface,
        elevation: 0,
        scrolledUnderElevation: 0.5,
        leading: IconButton(
          icon: Icon(Icons.arrow_back_rounded, color: context.themeTextPrimary),
          onPressed: () => Navigator.pop(context),
        ),
        title: Row(
          children: [
            Stack(
              clipBehavior: Clip.none,
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      colors: [AppColors.primary, AppColors.secondary],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.auto_awesome, color: Colors.white, size: 20),
                ),
                Positioned(
                  right: -2,
                  bottom: -2,
                  child: Container(
                    width: 11,
                    height: 11,
                    decoration: BoxDecoration(
                      color: AppColors.success,
                      shape: BoxShape.circle,
                      border: Border.all(color: context.themeSurface, width: 2),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          'QueueFlow Assistant',
                          style: TextStyle(
                            color: context.themeTextPrimary,
                            fontSize: 15,
                            fontWeight: FontWeight.bold,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
                        decoration: BoxDecoration(
                          color: primaryColor.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          'GEMINI 1.5',
                          style: TextStyle(
                            color: primaryColor,
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Online • Short-term Memory Active',
                    style: TextStyle(
                      color: context.themeTextSecondary,
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Gemini API Key Settings',
            icon: Icon(
              _hasCustomKey ? Icons.key_rounded : Icons.key_off_rounded,
              color: _hasCustomKey ? primaryColor : context.themeTextSecondary,
              size: 20,
            ),
            onPressed: _showApiKeyDialog,
          ),
          IconButton(
            tooltip: 'Clear Chat',
            icon: Icon(Icons.delete_outline_rounded, color: context.themeTextSecondary, size: 20),
            onPressed: _clearChat,
          ),
        ],
      ),
      body: Column(
        children: [
          // Quick Questions Suggestion Bar
          Container(
            height: 44,
            margin: const EdgeInsets.symmetric(vertical: 6),
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              scrollDirection: Axis.horizontal,
              itemCount: _quickSuggestions.length,
              separatorBuilder: (context, index) => const SizedBox(width: 8),
              itemBuilder: (context, index) {
                final suggestion = _quickSuggestions[index];
                return ActionChip(
                  label: Text(
                    suggestion,
                    style: TextStyle(
                      color: isDark ? const Color(0xFF93C5FD) : const Color(0xFF1D4ED8),
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  backgroundColor: isDark
                      ? const Color(0xFF1E293B)
                      : const Color(0xFFEFF6FF),
                  side: BorderSide(
                    color: isDark
                        ? const Color(0xFF334155)
                        : const Color(0xFFDBEAFE),
                  ),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 0),
                  onPressed: () => _onSuggestionTapped(suggestion),
                );
              },
            ),
          ),
          Divider(height: 1, color: context.themeBorder.withValues(alpha: 0.5)),

          // DashChat 2 UI with local message history
          Expanded(
            child: DashChat(
              currentUser: _currentUser,
              onSend: _handleSendMessage,
              messages: _messages,
              typingUsers: _isTyping ? [_botUser] : [],
              messageOptions: MessageOptions(
                currentUserContainerColor: primaryColor,
                currentUserTextColor: Colors.white,
                containerColor: isDark ? const Color(0xFF1E293B) : const Color(0xFFF1F5F9),
                textColor: context.themeTextPrimary,
                showTime: true,
                timeFormat: null,
                avatarBuilder: (user, onPressAvatar, onLongPressAvatar) {
                  if (user.id == _botUser.id) {
                    return Container(
                      width: 32,
                      height: 32,
                      margin: const EdgeInsets.only(right: 8),
                      decoration: BoxDecoration(
                        color: botAvatarBg,
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: primaryColor.withValues(alpha: 0.3),
                          width: 1.5,
                        ),
                      ),
                      child: Icon(Icons.auto_awesome, color: primaryColor, size: 16),
                    );
                  }
                  return DefaultAvatar(
                    user: user,
                    fallbackImage: null,
                  );
                },
              ),
              inputOptions: InputOptions(
                inputDecoration: InputDecoration(
                  hintText: 'Ask QueueFlow Assistant...',
                  hintStyle: TextStyle(color: context.themeTextSecondary, fontSize: 14),
                  filled: true,
                  fillColor: isDark ? const Color(0xFF1E293B) : const Color(0xFFF8FAFC),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide(color: context.themeBorder),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide(color: context.themeBorder),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide(color: primaryColor, width: 1.5),
                  ),
                ),
                sendButtonBuilder: (onSend) {
                  return Container(
                    margin: const EdgeInsets.only(left: 8),
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(
                        colors: [AppColors.primary, AppColors.secondary],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      shape: BoxShape.circle,
                    ),
                    child: IconButton(
                      icon: const Icon(Icons.arrow_upward_rounded, color: Colors.white, size: 20),
                      onPressed: onSend,
                    ),
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

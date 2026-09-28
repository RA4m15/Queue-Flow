import 'package:flutter/foundation.dart';
import 'package:google_generative_ai/google_generative_ai.dart';
import 'package:dash_chat_2/dash_chat_2.dart';
import 'storage_service.dart';

/// Service responsible for managing Gemini AI support conversations,
/// defining strict queue-management system instructions, and maintaining
/// short-term memory across chat turns.
class GeminiSupportService {
  GeminiSupportService({StorageService? storageService})
      : _storageService = storageService ?? StorageService();

  final StorageService _storageService;

  static const String _storageKey = 'gemini_api_key';
  static const String _envApiKey = String.fromEnvironment('GEMINI_API_KEY');

  /// Strict system instruction defining the bot's behavior for QueueFlow
  static const String systemInstruction = '''
You are QueueFlow Assistant, a helpful, polite, and concise support assistant for the QueueFlow smart queue management platform.

Your primary mission:
1. Assist customers with booking tickets, tracking real-time wait times, counter assignments, and service center categories (Banks, Hospitals, Government Offices, Railway counters).
2. Explain how to join queues via QR code scanning or center directory, how to swap positions with peers, and how document verification gates work.
3. Be concise, clear, and reassuring. Keep answers brief (typically 2-4 sentences) unless a detailed step-by-step troubleshooting guide is explicitly requested.
4. If a user asks about services outside QueueFlow (e.g., general world facts, politics, coding, or unrelated tasks), politely decline and steer them back to QueueFlow queue management and assistance.
5. If an issue requires human counter staff or physical intervention, advise them to approach the physical counter officer or contact official support at support@queueflow.io.
''';

  /// Default model identifier
  static const String defaultModelName = 'gemini-1.5-flash';

  /// Resolves the current Gemini API key, prioritizing compile-time env and then secure storage.
  Future<String?> getApiKey() async {
    if (_envApiKey.trim().isNotEmpty) {
      return _envApiKey.trim();
    }
    final stored = await _storageService.getString(_storageKey);
    if (stored != null && stored.trim().isNotEmpty) {
      return stored.trim();
    }
    return null;
  }

  /// Stores a user-provided Gemini API key securely in local storage.
  Future<void> saveApiKey(String key) async {
    await _storageService.setString(_storageKey, key.trim());
  }

  /// Clears any user-stored API key.
  Future<void> clearApiKey() async {
    await _storageService.setString(_storageKey, '');
  }

  /// Returns true if an API key is currently configured.
  Future<bool> hasApiKey() async {
    final key = await getApiKey();
    return key != null && key.isNotEmpty;
  }

  /// Initializes a GenerativeModel with strict system prompt and generation config.
  GenerativeModel createModel({
    required String apiKey,
    String modelName = defaultModelName,
  }) {
    return GenerativeModel(
      model: modelName,
      apiKey: apiKey,
      systemInstruction: Content.system(systemInstruction),
      generationConfig: GenerationConfig(
        temperature: 0.4,
        topK: 32,
        topP: 0.9,
        maxOutputTokens: 500,
      ),
    );
  }

  /// Formats the last 5-10 messages from DashChat history into Gemini `Content` turns.
  /// Ensures valid alternation and starting with role 'user'.
  List<Content> formatHistory({
    required List<ChatMessage> history,
    required String currentUserId,
    int maxMessages = 10,
  }) {
    if (history.isEmpty) return [];

    // In DashChat, history is typically ordered with the newest message at index 0.
    // We slice the newest `maxMessages`, then reverse them to chronological order (oldest to newest).
    final recent = history.take(maxMessages).toList().reversed.toList();

    final List<Content> contents = [];

    for (final msg in recent) {
      final text = msg.text.trim();
      if (text.isEmpty) continue;

      final role = (msg.user.id == currentUserId) ? 'user' : 'model';

      // Gemini requires the multi-turn conversation history to start with a 'user' turn.
      if (contents.isEmpty && role != 'user') {
        continue;
      }

      // If the consecutive turn has the same role, merge them to avoid Gemini API 400 errors.
      if (contents.isNotEmpty && contents.last.role == role) {
        final lastContent = contents.removeLast();
        final combinedText = '${lastContent.parts.map((p) => (p as TextPart).text).join('\n')}\n$text';
        contents.add(Content(role, [TextPart(combinedText)]));
      } else {
        contents.add(Content(role, [TextPart(text)]));
      }
    }

    return contents;
  }

  /// Sends the user message directly to Gemini along with the formatted short-term memory history.
  Future<String> sendMessage({
    required String userText,
    required List<ChatMessage> history,
    required String currentUserId,
    int historyLimit = 8,
  }) async {
    final cleanInput = userText.trim();
    if (cleanInput.isEmpty) return '';

    final apiKey = await getApiKey();
    if (apiKey == null || apiKey.isEmpty) {
      return _generateOfflineFallback(cleanInput);
    }

    try {
      final model = createModel(apiKey: apiKey);

      // Extract the last 5-10 messages for short-term memory
      final formattedHistory = formatHistory(
        history: history,
        currentUserId: currentUserId,
        maxMessages: historyLimit,
      );

      // Append current user prompt as the final turn
      final List<Content> prompt = [
        ...formattedHistory,
        Content.text(cleanInput),
      ];

      final response = await model.generateContent(prompt);
      final text = response.text?.trim();

      if (text != null && text.isNotEmpty) {
        return text;
      }

      return "I didn't receive a response from the service. Please try rephrasing your question.";
    } catch (e) {
      debugPrint('[GeminiSupportService] Error calling Gemini API: $e');
      final errStr = e.toString().toLowerCase();
      if (errStr.contains('api_key') || errStr.contains('unauthenticated') || errStr.contains('permission denied')) {
        return "Your Gemini API key appears invalid or expired. Please update it using the key icon at the top right.";
      }
      if (errStr.contains('quota') || errStr.contains('resource_exhausted')) {
        return "The Gemini quota limit was reached. Please try again in a moment.";
      }
      return "Unable to reach Gemini right now ($e). Please check your internet connection or try again later.";
    }
  }

  /// Intelligent offline fallback if no API key is yet configured
  String _generateOfflineFallback(String input) {
    final lower = input.toLowerCase();
    if (lower.contains('token') || lower.contains('ticket') || lower.contains('book')) {
      return "To book or track a ticket in QueueFlow, scan the center's QR code on the 'Scan' tab or browse available departments on the 'Home' screen. Your live position will update dynamically under 'Live Token'. (Note: To enable live Gemini AI chat, configure your Gemini API Key in the top right).";
    }
    if (lower.contains('wait') || lower.contains('time') || lower.contains('delay')) {
      return "Estimated wait times are computed live based on active counters, average service speed, and your current token position in the queue.";
    }
    if (lower.contains('swap') || lower.contains('trade')) {
      return "QueueFlow allows peer-to-peer queue position swaps when both participants agree. Check your active token details for swap options.";
    }
    if (lower.contains('notification') || lower.contains('alert')) {
      return "You can toggle push and app notifications on the Profile page under 'App Alerts' to get notified when your token is called.";
    }
    return "Welcome to QueueFlow Support! I'm your queue assistant. To enable full conversational AI with Gemini 1.5 Flash, tap the key icon above to provide your Gemini API key (or pass --dart-define=GEMINI_API_KEY). How can I assist you with your queue tickets today?";
  }
}

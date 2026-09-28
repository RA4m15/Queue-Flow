import 'package:flutter_test/flutter_test.dart';
import 'package:dash_chat_2/dash_chat_2.dart';
import 'package:user_app/services/gemini_support_service.dart';

void main() {
  group('GeminiSupportService Tests', () {
    late GeminiSupportService service;

    setUp(() {
      service = GeminiSupportService();
    });

    test('Strict System Instruction is defined properly', () {
      expect(GeminiSupportService.systemInstruction, contains('QueueFlow Assistant'));
      expect(GeminiSupportService.systemInstruction, contains('smart queue management platform'));
      expect(GeminiSupportService.systemInstruction, contains('concise'));
      expect(GeminiSupportService.systemInstruction, contains('support@queueflow.io'));
    });

    test('formatHistory formats and limits messages to last 5-10 turns', () {
      final user = ChatUser(id: 'u1', firstName: 'Alice');
      final bot = ChatUser(id: 'gemini_bot', firstName: 'Assistant');

      // Create 12 alternating messages (DashChat order: newest first at index 0)
      final List<ChatMessage> history = [];
      for (int i = 12; i >= 1; i--) {
        history.add(
          ChatMessage(
            user: (i % 2 == 1) ? user : bot,
            createdAt: DateTime.now().subtract(Duration(minutes: 13 - i)),
            text: 'Message $i',
          ),
        );
      }

      // Format with limit 8
      final formatted = service.formatHistory(
        history: history,
        currentUserId: 'u1',
        maxMessages: 8,
      );

      // Verify non-empty and starts with role 'user'
      expect(formatted.isNotEmpty, true);
      expect(formatted.first.role, 'user');
      expect(formatted.length, lessThanOrEqualTo(8));
    });

    test('formatHistory ignores leading model messages if conversation starts with greeting', () {
      final user = ChatUser(id: 'u1', firstName: 'Alice');
      final bot = ChatUser(id: 'gemini_bot', firstName: 'Assistant');

      final List<ChatMessage> history = [
        ChatMessage(user: user, createdAt: DateTime.now(), text: 'Second query'),
        ChatMessage(user: bot, createdAt: DateTime.now(), text: 'First answer'),
        ChatMessage(user: user, createdAt: DateTime.now(), text: 'First query'),
        ChatMessage(user: bot, createdAt: DateTime.now(), text: 'Initial welcome greeting'),
      ];

      final formatted = service.formatHistory(
        history: history,
        currentUserId: 'u1',
        maxMessages: 10,
      );

      // Must start with user role, skipping the initial bot welcome greeting
      expect(formatted.first.role, 'user');
      expect((formatted.first.parts.first as dynamic).text, 'First query');
    });

    test('Offline fallback returns helpful guidance when no API key configured', () async {
      final reply = await service.sendMessage(
        userText: 'How do I get a ticket?',
        history: [],
        currentUserId: 'u1',
      );

      expect(reply, contains('scan'));
      expect(reply, contains('ticket'));
      expect(reply, contains('Live Token'));
    });

    test('Offline fallback returns wait time information', () async {
      final reply = await service.sendMessage(
        userText: 'How long is the wait time?',
        history: [],
        currentUserId: 'u1',
      );

      expect(reply, contains('wait times'));
      expect(reply, contains('active counters'));
    });
  });
}

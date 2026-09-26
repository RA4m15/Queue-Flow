import 'package:intl/intl.dart';

class DateFormatter {
  DateFormatter._();

  static String formatDateTime(DateTime? dateTime) {
    if (dateTime == null) return '--';
    return DateFormat('MMM dd, yyyy • hh:mm a').format(dateTime.toLocal());
  }

  static String formatTimeOnly(DateTime? dateTime) {
    if (dateTime == null) return '--';
    return DateFormat('hh:mm a').format(dateTime.toLocal());
  }

  static String formatRelative(DateTime? dateTime) {
    if (dateTime == null) return '--';
    final now = DateTime.now();
    final diff = now.difference(dateTime.toLocal());

    if (diff.inSeconds < 60) return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    if (diff.inDays < 7) return '${diff.inDays}d ago';
    return DateFormat('MMM dd').format(dateTime.toLocal());
  }
}

class NotificationModel {
  const NotificationModel({
    required this.id,
    required this.userId,
    required this.type,
    required this.title,
    required this.body,
    required this.isRead,
    this.centerId,
    this.tokenId,
    this.readAt,
    this.createdAt,
  });

  final String id;
  final String userId;
  final String type;
  final String title;
  final String body;
  final bool isRead;
  final String? centerId;
  final String? tokenId;
  final DateTime? readAt;
  final DateTime? createdAt;

  factory NotificationModel.fromJson(Map<String, dynamic> json) {
    return NotificationModel(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      userId: (json['userId'] is Map ? json['userId']['_id'] : json['userId'] ?? '').toString(),
      type: (json['type'] ?? 'BROADCAST').toString(),
      title: (json['title'] ?? '').toString(),
      body: (json['body'] ?? '').toString(),
      isRead: json['isRead'] == true,
      centerId: json['centerId'] is Map ? json['centerId']['_id'] : json['centerId']?.toString(),
      tokenId: json['tokenId'] is Map ? json['tokenId']['_id'] : json['tokenId']?.toString(),
      readAt: json['readAt'] != null ? DateTime.tryParse(json['readAt'].toString()) : null,
      createdAt: json['createdAt'] != null ? DateTime.tryParse(json['createdAt'].toString()) : null,
    );
  }

  NotificationModel copyWith({
    String? id,
    String? userId,
    String? type,
    String? title,
    String? body,
    bool? isRead,
    String? centerId,
    String? tokenId,
    DateTime? readAt,
    DateTime? createdAt,
  }) {
    return NotificationModel(
      id: id ?? this.id,
      userId: userId ?? this.userId,
      type: type ?? this.type,
      title: title ?? this.title,
      body: body ?? this.body,
      isRead: isRead ?? this.isRead,
      centerId: centerId ?? this.centerId,
      tokenId: tokenId ?? this.tokenId,
      readAt: readAt ?? this.readAt,
      createdAt: createdAt ?? this.createdAt,
    );
  }
}

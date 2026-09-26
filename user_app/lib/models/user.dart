class AppUser {
  const AppUser({
    required this.id,
    required this.name,
    required this.email,
    required this.role,
    this.phone,
    this.fcmToken,
    this.preferences,
  });

  final String id;
  final String name;
  final String email;
  final String role;
  final String? phone;
  final String? fcmToken;
  final Map<String, dynamic>? preferences;

  bool get isCustomer => role.toUpperCase() == 'CUSTOMER';
  bool get isAdmin => role.toUpperCase() == 'ADMIN';

  factory AppUser.fromJson(Map<String, dynamic> json) {
    return AppUser(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      name: (json['name'] ?? '').toString(),
      email: (json['email'] ?? '').toString(),
      role: json['role']?.toString() ?? 'UNKNOWN',
      phone: json['phone']?.toString(),
      fcmToken: json['fcmToken']?.toString(),
      preferences: json['preferences'] is Map ? Map<String, dynamic>.from(json['preferences']) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'email': email,
      'role': role,
      'phone': phone,
      'fcmToken': fcmToken,
      'preferences': preferences,
    };
  }

  AppUser copyWith({
    String? id,
    String? name,
    String? email,
    String? role,
    String? phone,
    String? fcmToken,
    Map<String, dynamic>? preferences,
  }) {
    return AppUser(
      id: id ?? this.id,
      name: name ?? this.name,
      email: email ?? this.email,
      role: role ?? this.role,
      phone: phone ?? this.phone,
      fcmToken: fcmToken ?? this.fcmToken,
      preferences: preferences ?? this.preferences,
    );
  }
}

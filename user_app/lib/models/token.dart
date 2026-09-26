class TokenFeedback {
  const TokenFeedback({
    this.rating,
    this.comment,
    this.submittedAt,
  });

  final int? rating;
  final String? comment;
  final DateTime? submittedAt;

  factory TokenFeedback.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const TokenFeedback();
    return TokenFeedback(
      rating: (json['rating'] as num?)?.toInt(),
      comment: json['comment']?.toString(),
      submittedAt: json['submittedAt'] != null ? DateTime.tryParse(json['submittedAt'].toString()) : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'rating': rating,
        'comment': comment,
      };
}

class TokenModel {
  const TokenModel({
    required this.id,
    required this.tokenCode,
    required this.tokenNumber,
    required this.userId,
    required this.centerId,
    required this.serviceId,
    required this.status,
    this.centerName,
    this.serviceName,
    this.counterId,
    this.counterName,
    this.counterNumber,
    this.initialPosition,
    this.currentPosition,
    this.waitEstimateMinutes,
    this.qrData,
    this.calledAt,
    this.servingAt,
    this.completedAt,
    this.createdAt,
    this.actualServiceSeconds,
    this.feedback,
  });

  final String id;
  final String tokenCode;
  final int tokenNumber;
  final String userId;
  final String centerId;
  final String serviceId;
  final String status;
  final String? centerName;
  final String? serviceName;
  final String? counterId;
  final String? counterName;
  final int? counterNumber;
  final int? initialPosition;
  final int? currentPosition;
  final int? waitEstimateMinutes;
  final String? qrData;
  final DateTime? calledAt;
  final DateTime? servingAt;
  final DateTime? completedAt;
  final DateTime? createdAt;
  final int? actualServiceSeconds;
  final TokenFeedback? feedback;

  bool get isActive => ['WAITING', 'CALLED', 'SERVING'].contains(status.toUpperCase());
  bool get isWaiting => status.toUpperCase() == 'WAITING';
  bool get isCalled => status.toUpperCase() == 'CALLED';
  bool get isServing => status.toUpperCase() == 'SERVING';
  bool get isCompleted => status.toUpperCase() == 'COMPLETED';
  bool get canCancel => status.toUpperCase() == 'WAITING';
  bool get hasFeedback => feedback?.rating != null;

  factory TokenModel.fromJson(Map<String, dynamic> json) {
    // Service name extraction
    String sName = 'Service';
    String sId = '';
    final sObj = json['serviceId'];
    if (sObj is Map) {
      sId = (sObj['_id'] ?? sObj['id'] ?? '').toString();
      sName = (sObj['name'] ?? 'Service').toString();
    } else if (sObj != null) {
      sId = sObj.toString();
    }

    // Center name extraction
    String cName = 'Service Center';
    String cId = '';
    final cObj = json['centerId'];
    if (cObj is Map) {
      cId = (cObj['_id'] ?? cObj['id'] ?? '').toString();
      cName = (cObj['name'] ?? 'Service Center').toString();
    } else if (cObj != null) {
      cId = cObj.toString();
    }

    // Counter info extraction
    String? cntId;
    String? cntName;
    int? cntNum;
    final cntObj = json['counterId'];
    if (cntObj is Map) {
      cntId = (cntObj['_id'] ?? cntObj['id'] ?? '').toString();
      cntName = cntObj['name']?.toString();
      cntNum = (cntObj['number'] as num?)?.toInt();
    } else if (cntObj != null) {
      cntId = cntObj.toString();
    }

    return TokenModel(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      tokenCode: (json['tokenCode'] ?? '').toString(),
      tokenNumber: (json['tokenNumber'] as num?)?.toInt() ?? 0,
      userId: (json['userId'] is Map ? json['userId']['_id'] : json['userId'] ?? '').toString(),
      centerId: cId,
      centerName: cName,
      serviceId: sId,
      serviceName: sName,
      status: json['status']?.toString() ?? 'UNKNOWN',
      counterId: cntId,
      counterName: cntName,
      counterNumber: cntNum,
      initialPosition: (json['initialPosition'] as num?)?.toInt(),
      currentPosition: (json['currentPosition'] as num?)?.toInt(),
      waitEstimateMinutes: (json['waitEstimateMinutes'] as num?)?.toInt(),
      qrData: json['qrData']?.toString(),
      calledAt: json['calledAt'] != null ? DateTime.tryParse(json['calledAt'].toString()) : null,
      servingAt: json['servingAt'] != null ? DateTime.tryParse(json['servingAt'].toString()) : null,
      completedAt: json['completedAt'] != null ? DateTime.tryParse(json['completedAt'].toString()) : null,
      createdAt: json['createdAt'] != null ? DateTime.tryParse(json['createdAt'].toString()) : null,
      actualServiceSeconds: (json['actualServiceSeconds'] as num?)?.toInt(),
      feedback: json['feedback'] is Map ? TokenFeedback.fromJson(Map<String, dynamic>.from(json['feedback'])) : null,
    );
  }

  TokenModel copyWith({
    String? id,
    String? tokenCode,
    int? tokenNumber,
    String? userId,
    String? centerId,
    String? serviceId,
    String? status,
    String? centerName,
    String? serviceName,
    String? counterId,
    String? counterName,
    int? counterNumber,
    int? initialPosition,
    int? currentPosition,
    int? waitEstimateMinutes,
    String? qrData,
    DateTime? calledAt,
    DateTime? servingAt,
    DateTime? completedAt,
    DateTime? createdAt,
    int? actualServiceSeconds,
    TokenFeedback? feedback,
  }) {
    return TokenModel(
      id: id ?? this.id,
      tokenCode: tokenCode ?? this.tokenCode,
      tokenNumber: tokenNumber ?? this.tokenNumber,
      userId: userId ?? this.userId,
      centerId: centerId ?? this.centerId,
      serviceId: serviceId ?? this.serviceId,
      status: status ?? this.status,
      centerName: centerName ?? this.centerName,
      serviceName: serviceName ?? this.serviceName,
      counterId: counterId ?? this.counterId,
      counterName: counterName ?? this.counterName,
      counterNumber: counterNumber ?? this.counterNumber,
      initialPosition: initialPosition ?? this.initialPosition,
      currentPosition: currentPosition ?? this.currentPosition,
      waitEstimateMinutes: waitEstimateMinutes ?? this.waitEstimateMinutes,
      qrData: qrData ?? this.qrData,
      calledAt: calledAt ?? this.calledAt,
      servingAt: servingAt ?? this.servingAt,
      completedAt: completedAt ?? this.completedAt,
      createdAt: createdAt ?? this.createdAt,
      actualServiceSeconds: actualServiceSeconds ?? this.actualServiceSeconds,
      feedback: feedback ?? this.feedback,
    );
  }
}

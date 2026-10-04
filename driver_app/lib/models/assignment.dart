class Assignment {
  const Assignment({
    required this.deviceId,
    required this.vehicleId,
    required this.routeId,
  });

  final String deviceId;
  final String? vehicleId;
  final String? routeId;

  factory Assignment.fromJson(Map<String, dynamic> json) {
    final deviceId = json['device_id'];
    final vehicleId = json['vehicle_id'];
    final routeId = json['route_id'];
    if (deviceId is! String ||
        deviceId.isEmpty ||
        !json.containsKey('vehicle_id') ||
        (vehicleId != null && vehicleId is! String) ||
        !json.containsKey('route_id') ||
        (routeId != null && routeId is! String)) {
      throw const FormatException('Invalid device assignment response.');
    }

    return Assignment(
      deviceId: deviceId,
      vehicleId: vehicleId as String?,
      routeId: routeId as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'device_id': deviceId,
    'vehicle_id': vehicleId,
    'route_id': routeId,
  };
}
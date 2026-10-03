class DeviceSession {
  const DeviceSession({
    required this.deviceId,
    required this.credentialId,
    required this.credential,
  });

  final String deviceId;
  final String credentialId;
  final String credential;

  factory DeviceSession.fromJson(Map<String, dynamic> json) {
    final deviceId = json['device_id'];
    final credentialId = json['credential_id'];
    final credential = json['credential'];
    if (deviceId is! String ||
        deviceId.isEmpty ||
        credentialId is! String ||
        credentialId.isEmpty ||
        credential is! String ||
        credential.isEmpty) {
      throw const FormatException('Invalid device credential response.');
    }

    return DeviceSession(
      deviceId: deviceId,
      credentialId: credentialId,
      credential: credential,
    );
  }

  Map<String, dynamic> toJson() => {
    'device_id': deviceId,
    'credential_id': credentialId,
    'credential': credential,
  };
}

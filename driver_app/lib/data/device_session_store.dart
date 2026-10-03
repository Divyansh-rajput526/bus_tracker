import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/device_session.dart';

abstract interface class DeviceSessionStore {
  Future<DeviceSession?> read();

  Future<void> write(DeviceSession session);

  Future<void> delete();
}

class SecureDeviceSessionStore implements DeviceSessionStore {
  SecureDeviceSessionStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _sessionKey = 'device_session_v1';
  final FlutterSecureStorage _storage;

  @override
  Future<DeviceSession?> read() async {
    final encoded = await _storage.read(key: _sessionKey);
    if (encoded == null) return null;

    try {
      final decoded = jsonDecode(encoded);
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException();
      }
      return DeviceSession.fromJson(decoded);
    } on FormatException {
      throw const DeviceSessionStorageException(
        'Stored device credential is invalid.',
      );
    }
  }

  @override
  Future<void> write(DeviceSession session) =>
      _storage.write(key: _sessionKey, value: jsonEncode(session.toJson()));

  @override
  Future<void> delete() => _storage.delete(key: _sessionKey);
}

class DeviceSessionStorageException implements Exception {
  const DeviceSessionStorageException(this.message);

  final String message;
}

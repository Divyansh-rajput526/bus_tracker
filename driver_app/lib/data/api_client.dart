import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/api_config.dart';
import '../models/device_session.dart';

class ApiException implements Exception {
  const ApiException(this.message);

  final String message;

  @override
  String toString() => message;
}

enum DeviceClaimFailureKind {
  invalidOrUsedPairingCode,
  tooManyAttempts,
  serverFailure,
  rejected,
}

class DeviceClaimException implements Exception {
  const DeviceClaimException(this.kind);

  final DeviceClaimFailureKind kind;
}

class ApiClient {
  ApiClient({http.Client? client, Uri? baseUri})
    : _client = client ?? http.Client(),
      _baseUri = baseUri ?? Uri.parse(apiBaseUrl);

  final http.Client _client;
  final Uri _baseUri;

  Future<void> checkConnection() async {
    final response = await _get('routes');
    if (response.statusCode != 200) {
      throw ApiException('Backend returned HTTP ${response.statusCode}.');
    }

    final decoded = _decodeJson(response.body);
    if (decoded is! List ||
        decoded.any(
          (route) =>
              route is! Map<String, dynamic> ||
              route['route_id'] is! String ||
              route['route_name'] is! String,
        )) {
      throw const ApiException(
        'Backend returned an unexpected routes response.',
      );
    }
  }

  Future<DeviceSession> claimDevice(String pairingCode) async {
    final response = await _post(
      'devices/claim',
      body: jsonEncode({'pairing_code': pairingCode}),
    );
    if (response.statusCode != 200) {
      final kind = switch (response.statusCode) {
        401 => DeviceClaimFailureKind.invalidOrUsedPairingCode,
        429 => DeviceClaimFailureKind.tooManyAttempts,
        >= 500 => DeviceClaimFailureKind.serverFailure,
        _ => DeviceClaimFailureKind.rejected,
      };
      throw DeviceClaimException(kind);
    }

    final decoded = _decodeJson(response.body);
    if (decoded is! Map<String, dynamic>) {
      throw const ApiException(
        'Backend returned an unexpected device claim response.',
      );
    }
    try {
      return DeviceSession.fromJson(decoded);
    } on FormatException {
      throw const ApiException(
        'Backend returned an invalid device credential.',
      );
    }
  }

  Future<http.Response> _get(String path) async {
    try {
      return await _client.get(_baseUri.resolve(path));
    } on http.ClientException {
      throw const ApiException('Could not connect to the backend.');
    }
  }

  Future<http.Response> _post(String path, {required String body}) async {
    try {
      return await _client.post(
        _baseUri.resolve(path),
        headers: {'content-type': 'application/json'},
        body: body,
      );
    } on http.ClientException {
      throw const ApiException('Could not connect to the backend.');
    }
  }

  dynamic _decodeJson(String body) {
    try {
      return jsonDecode(body);
    } on FormatException {
      throw const ApiException('Backend returned invalid JSON.');
    }
  }

  void close() => _client.close();
}

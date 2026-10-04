import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/api_config.dart';
import '../models/assignment.dart';
import '../models/device_session.dart';

enum ApiFailureKind { network, invalidResponse, unexpectedResponse }

class ApiException implements Exception {
  const ApiException(
    this.message, {
    this.kind = ApiFailureKind.unexpectedResponse,
  });

  final String message;
  final ApiFailureKind kind;

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

class DeviceAssignmentHttpException implements Exception {
  const DeviceAssignmentHttpException(this.statusCode);

  final int statusCode;
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

  Future<Assignment> getDeviceAssignment(DeviceSession session) async {
    final response = await _get(
      'devices/assignment',
      headers: {'authorization': 'Bearer ${session.credential}'},
    );
    if (response.statusCode != 200) {
      throw DeviceAssignmentHttpException(response.statusCode);
    }

    final decoded = _decodeJson(response.body);
    if (decoded is! Map<String, dynamic>) {
      throw const ApiException(
        'Backend returned an unexpected device assignment response.',
      );
    }
    try {
      return Assignment.fromJson(decoded);
    } on FormatException {
      throw const ApiException(
        'Backend returned an unexpected device assignment response.',
      );
    }
  }

  Future<http.Response> _get(
    String path, {
    Map<String, String>? headers,
  }) async {
    try {
      return await _client.get(_baseUri.resolve(path), headers: headers);
    } on http.ClientException {
      throw const ApiException(
        'Could not connect to the backend.',
        kind: ApiFailureKind.network,
      );
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
      throw const ApiException(
        'Backend returned invalid JSON.',
        kind: ApiFailureKind.invalidResponse,
      );
    }
  }

  void close() => _client.close();
}

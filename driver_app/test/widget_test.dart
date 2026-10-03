import 'dart:convert';

import 'package:driver_app/data/api_client.dart';
import 'package:driver_app/data/device_session_store.dart';
import 'package:driver_app/main.dart';
import 'package:driver_app/models/device_session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _testSession = DeviceSession(
  deviceId: 'device-id-for-test',
  credentialId: 'credential-id-for-test',
  credential: 'credential-id-for-test.synthetic-secret',
);

void main() {
  test(
    'claim sends the backend request and parses its response fields',
    () async {
      final client = ApiClient(
        client: MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, '/devices/claim');
          expect(jsonDecode(request.body), {
            'pairing_code': 'admin-issued-code',
          });
          return http.Response(
            jsonEncode(_testSession.toJson()),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
        baseUri: Uri.parse('http://localhost:3000/'),
      );
      addTearDown(client.close);

      final session = await client.claimDevice('admin-issued-code');

      expect(session.deviceId, _testSession.deviceId);
      expect(session.credentialId, _testSession.credentialId);
      expect(session.credential, _testSession.credential);
    },
  );

  test(
    'claim maps the backend unauthorized response without guessing cause',
    () async {
      final error = await _claimFailure(401, 'Invalid or expired pairing code');

      expect(error.kind, DeviceClaimFailureKind.invalidOrUsedPairingCode);
    },
  );

  test('claim maps rate limit and server failures', () async {
    final rateLimit = await _claimFailure(429, 'Too many requests');
    final server = await _claimFailure(500, 'Database error');

    expect(rateLimit.kind, DeviceClaimFailureKind.tooManyAttempts);
    expect(server.kind, DeviceClaimFailureKind.serverFailure);
  });

  testWidgets('startup shows enrollment when no session is stored', (
    tester,
  ) async {
    final store = _MemorySessionStore();
    final apiClient = _apiClient((_) async => http.Response('[]', 200));
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      DriverApp(apiClient: apiClient, sessionStore: store),
    );
    await tester.pumpAndSettle();

    expect(find.text('Enroll device'), findsOneWidget);
    expect(find.byKey(const Key('pairing-code-field')), findsOneWidget);
  });

  testWidgets(
    'successful enrollment stores session and never displays credential',
    (tester) async {
      final store = _MemorySessionStore();
      final apiClient = _apiClient((request) async {
        if (request.url.path == '/devices/claim') {
          return http.Response(jsonEncode(_testSession.toJson()), 200);
        }
        return http.Response('[]', 200);
      });
      addTearDown(apiClient.close);

      await tester.pumpWidget(
        DriverApp(apiClient: apiClient, sessionStore: store),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('pairing-code-field')),
        'admin-issued-code',
      );
      await tester.tap(find.text('Claim device'));
      await tester.pumpAndSettle();

      expect(store.session?.credentialId, _testSession.credentialId);
      expect(find.text('Enrolled device'), findsOneWidget);
      expect(find.text(_testSession.deviceId), findsOneWidget);
      expect(find.text(_testSession.credentialId), findsOneWidget);
      expect(find.text(_testSession.credential), findsNothing);
    },
  );

  testWidgets(
    'invalid or already-used pairing code shows backend-safe message',
    (tester) async {
      final store = _MemorySessionStore();
      final apiClient = _apiClient(
        (_) async => http.Response('Invalid or expired pairing code', 401),
      );
      addTearDown(apiClient.close);

      await tester.pumpWidget(
        DriverApp(apiClient: apiClient, sessionStore: store),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('pairing-code-field')),
        'unusable-code',
      );
      await tester.tap(find.text('Claim device'));
      await tester.pumpAndSettle();

      expect(
        find.text('This pairing code is invalid, expired, or already used.'),
        findsOneWidget,
      );
    },
  );

  testWidgets('stored session is restored and can be cleared locally', (
    tester,
  ) async {
    final store = _MemorySessionStore()..session = _testSession;
    final apiClient = _apiClient((_) async => http.Response('[]', 200));
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      DriverApp(apiClient: apiClient, sessionStore: store),
    );
    await tester.pumpAndSettle();
    expect(find.text(_testSession.deviceId), findsOneWidget);

    await tester.tap(find.text('Clear local session'));
    await tester.pumpAndSettle();
    expect(find.textContaining('does not revoke'), findsNothing);
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();

    expect(store.session, isNull);
    expect(find.text('Enroll device'), findsOneWidget);
  });
}

ApiClient _apiClient(Future<http.Response> Function(http.Request) handler) =>
    ApiClient(
      client: MockClient(handler),
      baseUri: Uri.parse('http://localhost:3000/'),
    );

Future<DeviceClaimException> _claimFailure(int statusCode, String body) async {
  final client = _apiClient((_) async => http.Response(body, statusCode));
  addTearDown(client.close);

  try {
    await client.claimDevice('test-pairing-code');
  } on DeviceClaimException catch (error) {
    return error;
  }
  throw StateError('Expected a device claim failure.');
}

class _MemorySessionStore implements DeviceSessionStore {
  DeviceSession? session;

  @override
  Future<DeviceSession?> read() async => session;

  @override
  Future<void> write(DeviceSession value) async => session = value;

  @override
  Future<void> delete() async => session = null;
}

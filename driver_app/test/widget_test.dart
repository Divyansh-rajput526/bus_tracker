import 'dart:convert';

import 'package:driver_app/config/api_config.dart';
import 'package:driver_app/data/api_client.dart';
import 'package:driver_app/data/device_session_store.dart';
import 'package:driver_app/main.dart';
import 'package:driver_app/models/assignment.dart';
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
const _testAssignment = Assignment(
  deviceId: 'device-id-for-test',
  vehicleId: 'BUS-12',
  routeId: 'R04',
);
const _expectedApiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://127.0.0.1:8080',
);

void main() {
  test('API base URL defaults to port 8080 and supports overrides', () {
    expect(apiBaseUrl, _expectedApiBaseUrl);
  });

  test('assignment parses assigned vehicle and route fields', () {
    expect(
      Assignment.fromJson({
        'device_id': 'device-uuid',
        'vehicle_id': 'BUS-12',
        'route_id': 'R04',
      }).toJson(),
      {
        'device_id': 'device-uuid',
        'vehicle_id': 'BUS-12',
        'route_id': 'R04',
      },
    );
  });

  test('assignment parses null vehicle and route fields', () {
    expect(
      Assignment.fromJson({
        'device_id': 'device-uuid',
        'vehicle_id': null,
        'route_id': null,
      }).toJson(),
      {'device_id': 'device-uuid', 'vehicle_id': null, 'route_id': null},
    );
  });

  test('assignment API sends the stored Bearer credential', () async {
    final client = ApiClient(
      client: MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/devices/assignment');
        expect(
          request.headers['authorization'],
          'Bearer ${_testSession.credential}',
        );
        return http.Response(jsonEncode(_testAssignment.toJson()), 200);
      }),
      baseUri: Uri.parse('http://localhost:8080/'),
    );
    addTearDown(client.close);

    expect(
      (await client.getDeviceAssignment(_testSession)).toJson(),
      _testAssignment.toJson(),
    );
  });

  test('assignment API maps HTTP 401 distinctly', () async {
    final client = _apiClient(
      (_) async => http.Response('Invalid device credentials', 401),
    );
    addTearDown(client.close);

    await expectLater(
      client.getDeviceAssignment(_testSession),
      throwsA(
        isA<DeviceAssignmentHttpException>().having(
          (error) => error.statusCode,
          'statusCode',
          401,
        ),
      ),
    );
  });

  test('assignment API rejects malformed response fields', () async {
    final client = _apiClient(
      (_) async => http.Response(
        jsonEncode({
          'device_id': 'device-uuid',
          'vehicle_id': 42,
          'route_id': null,
        }),
        200,
      ),
    );
    addTearDown(client.close);

    await expectLater(
      client.getDeviceAssignment(_testSession),
      throwsA(isA<ApiException>()),
    );
  });

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
        baseUri: Uri.parse('http://localhost:8080/'),
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
        return http.Response(jsonEncode(_testAssignment.toJson()), 200);
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
      expect(find.text('Driver home'), findsOneWidget);
      expect(find.text(_testSession.deviceId), findsOneWidget);
      expect(find.text('BUS-12'), findsOneWidget);
      expect(find.text('R04'), findsOneWidget);
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

  testWidgets('canceling clear local session keeps the stored session', (
    tester,
  ) async {
    final store = _MemorySessionStore()..session = _testSession;
    final apiClient = _apiClient(
      (_) async => http.Response(jsonEncode(_testAssignment.toJson()), 200),
    );
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      DriverApp(apiClient: apiClient, sessionStore: store),
    );
    await tester.pumpAndSettle();
    expect(find.text(_testAssignment.deviceId), findsOneWidget);

    await tester.tap(find.text('Clear local session'));
    await tester.pumpAndSettle();
    expect(store.session, _testSession);
    expect(find.text('Clear local session?'), findsOneWidget);
    expect(
      find.text(
        'This will remove the device credential from this phone. To use the driver app again, you will need a new pairing code from an administrator.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(store.session, _testSession);
    expect(find.text('Driver home'), findsOneWidget);
    expect(find.text('Enroll device'), findsNothing);
  });

  testWidgets('confirming clear local session returns to enrollment', (
    tester,
  ) async {
    final store = _MemorySessionStore()..session = _testSession;
    final apiClient = _apiClient(
      (_) async => http.Response(jsonEncode(_testAssignment.toJson()), 200),
    );
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      DriverApp(apiClient: apiClient, sessionStore: store),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Clear local session'));
    await tester.pumpAndSettle();
    expect(store.session, _testSession);

    await tester.tap(find.text('Clear session'));
    await tester.pumpAndSettle();

    expect(store.session, isNull);
    expect(find.text('Enroll device'), findsOneWidget);
  });

  testWidgets('HTTP 401 clears the stored session and returns to enrollment', (
    tester,
  ) async {
    final store = _MemorySessionStore()..session = _testSession;
    final apiClient = _apiClient((request) async {
      expect(
        request.headers['authorization'],
        'Bearer ${_testSession.credential}',
      );
      return http.Response('Invalid device credentials', 401);
    });
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      DriverApp(apiClient: apiClient, sessionStore: store),
    );
    await tester.pumpAndSettle();

    expect(store.session, isNull);
    expect(find.text('Enroll device'), findsOneWidget);
    expect(find.text(_testSession.credential), findsNothing);
  });

  testWidgets('network failure has a distinct state and can be retried', (
    tester,
  ) async {
    final store = _MemorySessionStore()..session = _testSession;
    var requests = 0;
    final apiClient = _apiClient((_) async {
      requests++;
      throw http.ClientException('offline');
    });
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      DriverApp(apiClient: apiClient, sessionStore: store),
    );
    await tester.pumpAndSettle();

    expect(find.text('Network unavailable'), findsOneWidget);
    expect(find.textContaining('Device status: Unavailable'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(requests, 2);
  });

  testWidgets('server errors show a separate assignment failure state', (
    tester,
  ) async {
    final store = _MemorySessionStore()..session = _testSession;
    final apiClient = _apiClient(
      (_) async => http.Response('Database error', 503),
    );
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      DriverApp(apiClient: apiClient, sessionStore: store),
    );
    await tester.pumpAndSettle();

    expect(find.text('Server error'), findsOneWidget);
    expect(find.textContaining('HTTP 503'), findsOneWidget);
  });

  testWidgets('successful response with null assignment shows both empty states', (
    tester,
  ) async {
    final store = _MemorySessionStore()..session = _testSession;
    final apiClient = _apiClient(
      (_) async => http.Response(
        jsonEncode({
          'device_id': _testAssignment.deviceId,
          'vehicle_id': null,
          'route_id': null,
        }),
        200,
      ),
    );
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      DriverApp(apiClient: apiClient, sessionStore: store),
    );
    await tester.pumpAndSettle();

    expect(find.text('No vehicle assigned'), findsOneWidget);
    expect(find.text('No route assigned'), findsOneWidget);
  });
}

ApiClient _apiClient(Future<http.Response> Function(http.Request) handler) =>
    ApiClient(
      client: MockClient(handler),
      baseUri: Uri.parse('http://localhost:8080/'),
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

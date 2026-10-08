import 'dart:convert';

import 'package:driver_app/data/api_client.dart';
import 'package:driver_app/models/device_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = DeviceSession(
  deviceId: 'device-test',
  credentialId: 'credential-test',
  credential: 'secret-test-credential',
);

void main() {
  test(
    'sends the exact telemetry contract with Bearer authentication',
    () async {
      final timestamp = DateTime.utc(2026, 10, 5, 12, 13, 14);
      final client = _apiClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, '/update-location');
        expect(
          request.headers['authorization'],
          'Bearer secret-test-credential',
        );
        expect(request.headers['content-type'], 'application/json');
        expect(jsonDecode(request.body), {
          'vehicle_id': 'BUS-88',
          'route_id': 'R17',
          'latitude': 51.5074,
          'longitude': -0.1278,
          'accuracy_meters': 5.2,
          'device_timestamp': '2026-10-05T12:13:14.000Z',
        });
        return http.Response('Location updated', 200);
      });
      addTearDown(client.close);

      await client.sendLocationUpdate(
        session: _session,
        vehicleId: 'BUS-88',
        routeId: 'R17',
        latitude: 51.5074,
        longitude: -0.1278,
        accuracyMeters: 5.2,
        deviceTimestamp: timestamp,
      );
    },
  );

  test('accepts any successful 2xx telemetry response', () async {
    final client = _apiClient(
      (_) async => http.Response('Duplicate update ignored', 204),
    );
    addTearDown(client.close);

    await client.sendLocationUpdate(
      session: _session,
      vehicleId: 'BUS-88',
      routeId: 'R17',
      latitude: 51.5074,
      longitude: -0.1278,
      accuracyMeters: 5.2,
      deviceTimestamp: DateTime.utc(2026, 10, 5),
    );
  });

  test('reports telemetry HTTP 401 distinctly', () async {
    final client = _apiClient(
      (_) async => http.Response('Invalid device credentials', 401),
    );
    addTearDown(client.close);

    await expectLater(
      _sendLocation(client),
      throwsA(
        isA<DeviceTelemetryHttpException>().having(
          (error) => error.statusCode,
          'statusCode',
          401,
        ),
      ),
    );
  });

  test('reports other telemetry server errors distinctly', () async {
    final client = _apiClient(
      (_) async => http.Response('Database error', 503),
    );
    addTearDown(client.close);

    await expectLater(
      _sendLocation(client),
      throwsA(
        isA<DeviceTelemetryHttpException>().having(
          (error) => error.statusCode,
          'statusCode',
          503,
        ),
      ),
    );
  });

  test(
    'maps telemetry network failures without exposing credentials',
    () async {
      final client = _apiClient((_) async {
        throw http.ClientException('offline');
      });
      addTearDown(client.close);

      await expectLater(
        _sendLocation(client),
        throwsA(
          isA<ApiException>()
              .having((error) => error.kind, 'kind', ApiFailureKind.network)
              .having(
                (error) => error.toString(),
                'message',
                isNot(contains(_session.credential)),
              ),
        ),
      );
    },
  );

  test(
    'assignment response fields are used as telemetry identifiers',
    () async {
      final client = _apiClient((request) async {
        if (request.url.path == '/devices/assignment') {
          expect(request.method, 'GET');
          expect(
            request.headers['authorization'],
            'Bearer secret-test-credential',
          );
          return http.Response(
            jsonEncode({
              'device_id': 'device-test',
              'vehicle_id': 'assigned-vehicle-from-server',
              'route_id': 'assigned-route-from-server',
            }),
            200,
          );
        }

        expect(request.url.path, '/update-location');
        expect(jsonDecode(request.body), {
          'vehicle_id': 'assigned-vehicle-from-server',
          'route_id': 'assigned-route-from-server',
          'latitude': 1.0,
          'longitude': 2.0,
          'accuracy_meters': 5.2,
          'device_timestamp': '2026-10-05T12:13:14.000Z',
        });
        return http.Response('Location updated', 200);
      });
      addTearDown(client.close);

      final assignment = await client.getDeviceAssignment(_session);
      await client.sendLocationUpdate(
        session: _session,
        vehicleId: assignment.vehicleId!,
        routeId: assignment.routeId!,
        latitude: 1,
        longitude: 2,
        accuracyMeters: 5.2,
        deviceTimestamp: DateTime.utc(2026, 10, 5, 12, 13, 14),
      );
    },
  );
}

ApiClient _apiClient(Future<http.Response> Function(http.Request) handler) =>
    ApiClient(
      client: MockClient(handler),
      baseUri: Uri.parse('http://localhost:8080/'),
    );

Future<void> _sendLocation(ApiClient client) => client.sendLocationUpdate(
  session: _session,
  vehicleId: 'BUS-88',
  routeId: 'R17',
  latitude: 51.5074,
  longitude: -0.1278,
  accuracyMeters: 5.2,
  deviceTimestamp: DateTime.utc(2026, 10, 5, 12, 13, 14),
);

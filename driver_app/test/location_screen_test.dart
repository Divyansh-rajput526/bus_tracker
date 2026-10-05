import 'dart:async';
import 'dart:convert';

import 'package:driver_app/data/api_client.dart';
import 'package:driver_app/data/foreground_location_service.dart';
import 'package:driver_app/models/device_session.dart';
import 'package:driver_app/screens/location_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = DeviceSession(
  deviceId: 'device-test',
  credentialId: 'credential-test',
  credential: 'secret-test-credential',
);

void main() {
  testWidgets('shows current location and applies foreground updates', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      currentLocation: _sampleLocation(),
    );
    addTearDown(service.dispose);

    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(locationService: service)),
    );
    await tester.pumpAndSettle();

    expect(find.text('GPS status'), findsOneWidget);
    expect(find.text('Active'), findsOneWidget);
    expect(find.text('51.507400'), findsOneWidget);
    expect(find.text('-0.127800'), findsOneWidget);
    expect(find.text('5.2 m'), findsOneWidget);
    expect(find.text('2026-10-05 12:13:14'), findsOneWidget);

    service.updates.add(
      DriverLocation(
        latitude: 40.712800,
        longitude: -74.006000,
        accuracy: 3.4,
        timestamp: DateTime(2026, 10, 5, 12, 14),
      ),
    );
    await tester.pump();

    expect(find.text('40.712800'), findsOneWidget);
    expect(find.text('-74.006000'), findsOneWidget);
    expect(find.text('3.4 m'), findsOneWidget);
    expect(find.text('2026-10-05 12:14:00'), findsOneWidget);
  });

  testWidgets('loads assignment then uploads foreground GPS telemetry', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      currentLocation: _sampleLocation(),
    );
    addTearDown(service.dispose);
    var assignmentRequests = 0;
    var telemetryRequests = 0;
    final apiClient = _apiClient((request) async {
      if (request.url.path == '/devices/assignment') {
        assignmentRequests++;
        expect(request.method, 'GET');
        expect(
          request.headers['authorization'],
          'Bearer secret-test-credential',
        );
        return http.Response(
          jsonEncode({
            'device_id': 'device-test',
            'vehicle_id': 'assigned-bus-37',
            'route_id': 'assigned-route-12',
          }),
          200,
        );
      }

      telemetryRequests++;
      expect(request.method, 'POST');
      expect(request.url.path, '/update-location');
      expect(request.headers['authorization'], 'Bearer secret-test-credential');
      expect(request.headers['content-type'], 'application/json');
      expect(jsonDecode(request.body), {
        'vehicle_id': 'assigned-bus-37',
        'route_id': 'assigned-route-12',
        'latitude': 51.5074,
        'longitude': -0.1278,
        'device_timestamp': _sampleLocation().timestamp
            .toUtc()
            .toIso8601String(),
      });
      return http.Response('Location updated', 200);
    });
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      MaterialApp(
        home: LocationScreen(
          locationService: service,
          apiClient: apiClient,
          session: _session,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(assignmentRequests, 1);
    expect(telemetryRequests, 1);
    expect(find.text('Last upload successful'), findsOneWidget);
    expect(find.text(_session.credential), findsNothing);
  });

  testWidgets(
    'does not request assignment or send telemetry without a session',
    (tester) async {
      final service = _FakeForegroundLocationService(
        currentLocation: _sampleLocation(),
      );
      addTearDown(service.dispose);
      var requests = 0;
      final apiClient = _apiClient((_) async {
        requests++;
        return http.Response('', 200);
      });
      addTearDown(apiClient.close);

      await tester.pumpWidget(
        MaterialApp(
          home: LocationScreen(locationService: service, apiClient: apiClient),
        ),
      );
      await tester.pumpAndSettle();

      expect(requests, 0);
      expect(find.text('Not assigned'), findsOneWidget);
    },
  );

  testWidgets('does not upload when foreground location permission is denied', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      permission: DriverLocationPermissionStatus.denied,
      requestedPermission: DriverLocationPermissionStatus.denied,
    );
    addTearDown(service.dispose);
    var telemetryRequests = 0;
    final apiClient = _apiClient((request) async {
      if (request.url.path == '/devices/assignment') {
        return http.Response(
          jsonEncode({
            'device_id': 'device-test',
            'vehicle_id': 'BUS-19',
            'route_id': 'R11',
          }),
          200,
        );
      }
      telemetryRequests++;
      return http.Response('Location updated', 200);
    });
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      MaterialApp(
        home: LocationScreen(
          locationService: service,
          apiClient: apiClient,
          session: _session,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(telemetryRequests, 0);
    expect(find.text('Location permission denied'), findsOneWidget);
  });

  testWidgets('clears the session after telemetry receives HTTP 401', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      currentLocation: _sampleLocation(),
    );
    addTearDown(service.dispose);
    var clearSessionCalls = 0;
    final apiClient = _apiClient((request) async {
      if (request.url.path == '/devices/assignment') {
        return http.Response(
          jsonEncode({
            'device_id': 'device-test',
            'vehicle_id': 'BUS-19',
            'route_id': 'R11',
          }),
          200,
        );
      }
      return http.Response('Invalid device credentials', 401);
    });
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      MaterialApp(
        home: LocationScreen(
          locationService: service,
          apiClient: apiClient,
          session: _session,
          onUnauthorized: () async => clearSessionCalls++,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(clearSessionCalls, 1);
    expect(find.text('Active'), findsOneWidget);
    expect(find.text(_session.credential), findsNothing);
  });

  testWidgets('reports server failure without stopping the GPS screen', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      currentLocation: _sampleLocation(),
    );
    addTearDown(service.dispose);
    final apiClient = _apiClient((request) async {
      if (request.url.path == '/devices/assignment') {
        return http.Response(
          jsonEncode({
            'device_id': 'device-test',
            'vehicle_id': 'BUS-19',
            'route_id': 'R11',
          }),
          200,
        );
      }
      return http.Response('Database error', 503);
    });
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      MaterialApp(
        home: LocationScreen(
          locationService: service,
          apiClient: apiClient,
          session: _session,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Active'), findsOneWidget);
    expect(find.text('Upload failed'), findsOneWidget);
    expect(find.text('Location upload failed (HTTP 503).'), findsOneWidget);
  });

  testWidgets('reports network failure without stopping the GPS screen', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      currentLocation: _sampleLocation(),
    );
    addTearDown(service.dispose);
    final apiClient = _apiClient((request) async {
      if (request.url.path == '/devices/assignment') {
        return http.Response(
          jsonEncode({
            'device_id': 'device-test',
            'vehicle_id': 'BUS-19',
            'route_id': 'R11',
          }),
          200,
        );
      }
      throw http.ClientException('offline');
    });
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      MaterialApp(
        home: LocationScreen(
          locationService: service,
          apiClient: apiClient,
          session: _session,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Active'), findsOneWidget);
    expect(find.text('Upload failed'), findsOneWidget);
    expect(
      find.text('Could not upload location. Check the network connection.'),
      findsOneWidget,
    );
  });

  testWidgets('does not upload when the assignment has no vehicle or route', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      currentLocation: _sampleLocation(),
    );
    addTearDown(service.dispose);
    var telemetryRequests = 0;
    final apiClient = _apiClient((request) async {
      if (request.url.path == '/devices/assignment') {
        return http.Response(
          jsonEncode({
            'device_id': 'device-test',
            'vehicle_id': null,
            'route_id': null,
          }),
          200,
        );
      }
      telemetryRequests++;
      return http.Response('Location updated', 200);
    });
    addTearDown(apiClient.close);

    await tester.pumpWidget(
      MaterialApp(
        home: LocationScreen(
          locationService: service,
          apiClient: apiClient,
          session: _session,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(telemetryRequests, 0);
    expect(find.text('Not assigned'), findsOneWidget);
  });

  testWidgets('requests denied permission and shows denial', (tester) async {
    final service = _FakeForegroundLocationService(
      permission: DriverLocationPermissionStatus.denied,
      requestedPermission: DriverLocationPermissionStatus.denied,
    );
    addTearDown(service.dispose);

    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(locationService: service)),
    );
    await tester.pumpAndSettle();

    expect(service.requestPermissionCalls, 1);
    expect(find.text('Location permission denied'), findsOneWidget);
  });

  testWidgets('directs permanently denied permission to app settings', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      permission: DriverLocationPermissionStatus.permanentlyDenied,
    );
    addTearDown(service.dispose);

    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(locationService: service)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Location permission permanently denied'), findsOneWidget);
    await tester.tap(find.text('Open app settings'));
    await tester.pump();
    expect(service.openAppSettingsCalls, 1);
  });

  testWidgets('offers location settings when location services are disabled', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(locationEnabled: false);
    addTearDown(service.dispose);

    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(locationService: service)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Location services disabled'), findsOneWidget);
    expect(service.requestPermissionCalls, 0);
    await tester.tap(find.text('Open location settings'));
    await tester.pump();
    expect(service.openLocationSettingsCalls, 1);
  });

  testWidgets('shows a useful message when current location retrieval fails', (
    tester,
  ) async {
    final service = _FakeForegroundLocationService(
      currentLocationError: Exception('GPS unavailable'),
    );
    addTearDown(service.dispose);

    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(locationService: service)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Location error'), findsOneWidget);
    expect(
      find.text('Could not retrieve the phone location. Try again.'),
      findsOneWidget,
    );
    expect(find.text('Not available'), findsNWidgets(4));
  });
}

ApiClient _apiClient(Future<http.Response> Function(http.Request) handler) =>
    ApiClient(
      client: MockClient(handler),
      baseUri: Uri.parse('http://localhost:8080/'),
    );

DriverLocation _sampleLocation() => DriverLocation(
  latitude: 51.5074,
  longitude: -0.1278,
  accuracy: 5.2,
  timestamp: DateTime(2026, 10, 5, 12, 13, 14),
);

class _FakeForegroundLocationService implements ForegroundLocationService {
  _FakeForegroundLocationService({
    this.locationEnabled = true,
    this.permission = DriverLocationPermissionStatus.granted,
    this.requestedPermission = DriverLocationPermissionStatus.granted,
    this.currentLocation,
    this.currentLocationError,
  });

  final bool locationEnabled;
  final DriverLocationPermissionStatus permission;
  final DriverLocationPermissionStatus requestedPermission;
  final DriverLocation? currentLocation;
  final Exception? currentLocationError;
  final StreamController<DriverLocation> updates =
      StreamController<DriverLocation>.broadcast(sync: true);
  int requestPermissionCalls = 0;
  int openAppSettingsCalls = 0;
  int openLocationSettingsCalls = 0;

  Future<void> dispose() => updates.close();

  @override
  Future<bool> isLocationServiceEnabled() async => locationEnabled;

  @override
  Future<DriverLocationPermissionStatus> checkPermission() async => permission;

  @override
  Future<DriverLocationPermissionStatus> requestPermission() async {
    requestPermissionCalls++;
    return requestedPermission;
  }

  @override
  Future<DriverLocation> getCurrentLocation() async {
    if (currentLocationError case final error?) throw error;
    return currentLocation ?? _sampleLocation();
  }

  @override
  Stream<DriverLocation> getLocationUpdates() => updates.stream;

  @override
  Future<bool> openAppSettings() async {
    openAppSettingsCalls++;
    return true;
  }

  @override
  Future<bool> openLocationSettings() async {
    openLocationSettingsCalls++;
    return true;
  }
}

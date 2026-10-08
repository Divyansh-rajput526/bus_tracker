import 'dart:async';
import 'dart:convert';

import 'package:driver_app/data/api_client.dart';
import 'package:driver_app/data/foreground_location_service.dart';
import 'package:driver_app/data/tracking_controller.dart';
import 'package:driver_app/models/assignment.dart';
import 'package:driver_app/models/device_session.dart';
import 'package:driver_app/screens/assignment_screen.dart';
import 'package:driver_app/screens/location_screen.dart';
import 'package:driver_app/widgets/tracking_toggle.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = DeviceSession(
  deviceId: 'device-test',
  credentialId: 'credential-test',
  credential: 'secret-test-credential',
);

const _assignment = Assignment(
  deviceId: 'device-test',
  vehicleId: 'BUS-37',
  routeId: 'R12',
);

void main() {
  testWidgets('initial state is OFF and opening details does not start GPS', (
    tester,
  ) async {
    final fixture = _TrackingFixture();
    addTearDown(fixture.dispose);

    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );
    await tester.pumpAndSettle();

    expect(fixture.controller.state, LocationTrackingState.off);
    expect(fixture.locationService.streamRequests, 0);
    expect(fixture.telemetryRequests, 0);
    expect(find.text('Location Tracking - OFF'), findsOneWidget);
    expect(find.text('Start Tracking'), findsOneWidget);
  });

  testWidgets('assignment screen presents the tracking toggle', (tester) async {
    final fixture = _TrackingFixture();
    addTearDown(fixture.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: AssignmentScreen(
          session: _session,
          onClearSession: () async {},
          apiClient: fixture.apiClient,
          trackingController: fixture.controller,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Location Tracking - OFF'), findsOneWidget);
    expect(find.text('Start Tracking'), findsOneWidget);
    expect(find.text('Location Tracking Details'), findsOneWidget);
    expect(fixture.locationService.streamRequests, 0);
  });

  testWidgets('Start Tracking turns ON and uploads a valid GPS position', (
    tester,
  ) async {
    final gpsUpload = Completer<http.Response>();
    var uploadAttempt = 0;
    final fixture = _TrackingFixture(
      telemetryHandler: (_) {
        uploadAttempt++;
        return uploadAttempt == 1
            ? Future.value(http.Response('', 200))
            : gpsUpload.future;
      },
    );
    fixture.trackPendingResponse(gpsUpload);
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );

    await tester.tap(find.text('Start Tracking'));
    await fixture.waitForTelemetryRequest(tester, 1);
    await fixture.waitForTelemetryStatus(tester, 'Last upload successful');

    expect(fixture.controller.state, LocationTrackingState.on);
    expect(fixture.locationService.streamRequests, 1);
    expect(fixture.telemetryRequests, 1);
    expect(fixture.lastTelemetryPayload!['accuracy_meters'], 5.2);
    expect(fixture.lastTelemetryPayload!['vehicle_id'], 'BUS-37');
    expect(fixture.lastTelemetryPayload!['route_id'], 'R12');
    expect(find.text('Location Tracking - ON'), findsOneWidget);
    expect(find.text('Stop Tracking'), findsOneWidget);
    expect(fixture.locationService.activeStreams, 1);
    expect(fixture.controller.gpsFixesReceived, 0);
    expect(fixture.controller.successfulUploads, 1);
    expect(fixture.controller.failedUploads, 0);
    expect(fixture.controller.telemetryStatus, 'Last upload successful');
    expect(fixture.controller.lastTelemetryAttemptTimestamp, isNotNull);
    expect(fixture.controller.lastSuccessfulTelemetryTimestamp, isNotNull);
    expect(find.text('Last upload successful'), findsOneWidget);
    expect(find.text('GPS fixes'), findsOneWidget);

    final notifications = fixture.controllerNotifications;
    void listener() {
      fixture.controllerNotifications++;
    }

    fixture.controller.addListener(listener);
    fixture.locationService.latestStream.add(_sampleLocation(latitude: 40.7));
    await tester.pump();
    expect(
      fixture.controller.lastGpsFixTimestamp,
      _sampleLocation(latitude: 40.7).timestamp,
    );
    expect(fixture.controller.currentGpsAccuracy, 5.2);
    expect(fixture.controller.gpsFixesReceived, 1);
    await fixture.waitForTelemetryRequest(tester, 2);
    await fixture.waitForTelemetryStatus(tester, 'SENDING');
    expect(fixture.controller.telemetryStatus, 'SENDING');
    gpsUpload.complete(http.Response('', 200));
    await fixture.waitForTelemetryStatus(tester, 'Last upload successful');
    expect(fixture.controller.successfulUploads, 2);

    await tester.pump(const Duration(seconds: 1));
    expect(fixture.controllerNotifications, greaterThan(notifications));
    await tester.tap(find.text('Stop Tracking'));
    await tester.pump();
    expect(fixture.controller.state, LocationTrackingState.off);
    expect(fixture.locationService.activeStreams, 0);
    final notificationsAfterStop = fixture.controllerNotifications;
    await tester.pump(const Duration(seconds: 1));
    expect(fixture.controllerNotifications, notificationsAfterStop);
    fixture.controller.removeListener(listener);

    await tester.pumpWidget(const SizedBox.shrink());
    await fixture.dispose();
  });

  testWidgets('network failure keeps tracking ON and shows connection error', (
    tester,
  ) async {
    final fixture = _TrackingFixture(
      telemetryHandler: (_) async => throw http.ClientException('offline'),
    );
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );

    await _startTracking(tester);
    await fixture.waitForTelemetryRequest(tester, 1);
    await fixture.waitForTelemetryStatus(tester, 'CONNECTION ERROR');
    await tester.pump();

    expect(fixture.controller.state, LocationTrackingState.on);
    expect(fixture.locationService.activeStreams, 1);
    expect(fixture.controller.telemetryStatus, 'CONNECTION ERROR');
    expect(fixture.controller.failedUploads, 1);
    expect(fixture.controller.successfulUploads, 0);
    expect(fixture.controller.gpsFixesReceived, 1);
    expect(find.text('Location Tracking - ON'), findsOneWidget);
    expect(find.text('CONNECTION ERROR'), findsOneWidget);
  });

  testWidgets('multiple failed uploads keep tracking and retry on next fix', (
    tester,
  ) async {
    final fixture = _TrackingFixture(telemetryStatusCode: 503);
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );

    await _startTracking(tester);
    fixture.locationService.latestStream.add(_sampleLocation(latitude: 40.7));
    await fixture.waitForTelemetryRequest(tester, 2);
    await fixture.waitForTelemetryStatus(tester, 'CONNECTION ERROR');

    expect(fixture.telemetryRequests, 2);
    expect(fixture.controller.state, LocationTrackingState.on);
    expect(fixture.locationService.activeStreams, 1);
    expect(fixture.controller.telemetryStatus, 'CONNECTION ERROR');
    expect(find.text('Location Tracking - ON'), findsOneWidget);

    fixture.locationService.latestStream.add(_sampleLocation(latitude: 40.8));
    await fixture.waitForTelemetryRequest(tester, 3);
    await fixture.waitForTelemetryStatus(tester, 'CONNECTION ERROR');

    expect(fixture.telemetryRequests, 3);
    expect(fixture.controller.telemetryStatus, 'CONNECTION ERROR');

    fixture.locationService.latestStream.add(_sampleLocation(latitude: 40.9));
    await fixture.waitForTelemetryRequest(tester, 4);
    await fixture.waitForTelemetryStatus(tester, 'CONNECTION ERROR');

    expect(fixture.telemetryRequests, 4);
    expect(fixture.controller.telemetryStatus, 'CONNECTION ERROR');
    expect(fixture.controller.failedUploads, 4);
    expect(fixture.controller.gpsFixesReceived, 4);
  });

  testWidgets('successful upload clears a previous connection error', (
    tester,
  ) async {
    final fixture = _TrackingFixture(telemetryStatusCodes: [503, 200]);
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );

    await _startTracking(tester);
    await fixture.waitForTelemetryRequest(tester, 1);
    await fixture.waitForTelemetryStatus(tester, 'CONNECTION ERROR');
    expect(fixture.controller.telemetryStatus, 'CONNECTION ERROR');

    fixture.locationService.latestStream.add(_sampleLocation(latitude: 40.7));
    await fixture.waitForTelemetryRequest(tester, 2);
    await fixture.waitForTelemetryStatus(tester, 'Last upload successful');

    expect(fixture.telemetryRequests, 2);
    expect(fixture.controller.state, LocationTrackingState.on);
    expect(fixture.controller.telemetryStatus, 'Last upload successful');
    expect(fixture.controller.successfulUploads, 1);
    expect(fixture.controller.failedUploads, 1);
    expect(find.text('Last upload successful'), findsOneWidget);
    expect(find.text('CONNECTION ERROR'), findsNothing);
  });

  testWidgets('HTTP 4xx keeps tracking and reports request failure', (
    tester,
  ) async {
    final fixture = _TrackingFixture(telemetryStatusCode: 400);
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );

    await _startTracking(tester);
    await fixture.waitForTelemetryRequest(tester, 1);
    await fixture.waitForTelemetryStatus(tester, 'TELEMETRY REQUEST FAILED');
    await tester.pump();

    expect(fixture.controller.state, LocationTrackingState.on);
    expect(fixture.locationService.activeStreams, 1);
    expect(fixture.controller.telemetryStatus, 'TELEMETRY REQUEST FAILED');
    expect(fixture.controller.failedUploads, 1);
    expect(find.text('Location Tracking - ON'), findsOneWidget);
  });

  testWidgets('slow upload prevents duplicate simultaneous uploads', (
    tester,
  ) async {
    final firstRequest = Completer<http.Response>();
    final fixture = _TrackingFixture(
      telemetryHandler: (_) => firstRequest.future,
    );
    fixture.trackPendingResponse(firstRequest);
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );

    await _startTracking(tester);
    await fixture.waitForTelemetryRequest(tester, 1);
    await fixture.waitForTelemetryStatus(tester, 'SENDING');
    expect(fixture.telemetryRequests, 1);

    fixture.locationService.latestStream.add(_sampleLocation(latitude: 40.7));
    await tester.pump();

    expect(fixture.telemetryRequests, 1);
    expect(fixture.controller.state, LocationTrackingState.on);
    expect(fixture.controller.telemetryStatus, 'SENDING');

    firstRequest.complete(http.Response('', 200));
    await fixture.waitForTelemetryStatus(tester, 'Last upload successful');
    await tester.pump();
    expect(fixture.controller.telemetryStatus, 'Last upload successful');
  });

  testWidgets('Stop Tracking turns OFF and blocks later GPS uploads', (
    tester,
  ) async {
    final firstRequest = Completer<http.Response>();
    final fixture = _TrackingFixture(
      telemetryHandler: (_) => firstRequest.future,
    );
    fixture.trackPendingResponse(firstRequest);
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );
    await _startTracking(tester);
    await tester.pump();
    final requestsBeforeStop = fixture.telemetryRequests;

    await tester.tap(find.text('Stop Tracking'));
    await tester.pumpAndSettle();
    fixture.locationService.latestStream.add(_sampleLocation());
    await tester.pump();

    expect(fixture.controller.state, LocationTrackingState.off);
    expect(fixture.locationService.activeStreams, 0);
    expect(fixture.telemetryRequests, requestsBeforeStop);
    expect(find.text('Location Tracking - OFF'), findsOneWidget);

    firstRequest.complete(http.Response('', 200));
    await tester.pump();
    await tester.pump();
  });

  testWidgets('starting twice creates only one Geolocator stream', (
    tester,
  ) async {
    final fixture = _TrackingFixture();
    addTearDown(fixture.dispose);

    final firstStart = fixture.controller.startTracking();
    final secondStart = fixture.controller.startTracking();
    await Future.wait([firstStart, secondStart]);

    expect(fixture.locationService.streamRequests, 1);
    expect(fixture.locationService.activeStreams, 1);
  });

  test('stopping twice is harmless', () async {
    final fixture = _TrackingFixture();
    addTearDown(fixture.dispose);

    await fixture.controller.startTracking();
    await fixture.controller.stopTracking();
    await fixture.controller.stopTracking();

    expect(fixture.controller.state, LocationTrackingState.off);
    expect(fixture.locationService.activeStreams, 0);
  });

  test('permission denial and disabled services leave tracking OFF', () async {
    final denied = _TrackingFixture(
      permission: DriverLocationPermissionStatus.denied,
      requestedPermission: DriverLocationPermissionStatus.denied,
    );
    addTearDown(denied.dispose);
    await denied.controller.startTracking();
    expect(denied.controller.state, LocationTrackingState.off);
    expect(denied.locationService.streamRequests, 0);
    expect(denied.controller.errorMessage, 'Location permission was denied.');

    final disabled = _TrackingFixture(locationEnabled: false);
    addTearDown(disabled.dispose);
    await disabled.controller.startTracking();
    expect(disabled.controller.state, LocationTrackingState.off);
    expect(disabled.locationService.streamRequests, 0);
    expect(disabled.controller.errorMessage, 'Location services are disabled.');
  });

  testWidgets('stream failure reconnects while tracking remains ON', (
    tester,
  ) async {
    final fixture = _TrackingFixture(recoveryDelay: const Duration(seconds: 1));
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: TrackingToggle(controller: fixture.controller)),
    );
    await fixture.controller.startTracking();

    fixture.locationService.latestStream.addError(StateError('GPS stream'));
    await tester.pump();
    expect(fixture.controller.state, LocationTrackingState.reconnecting);
    expect(find.text('Location Tracking - RECONNECTING'), findsOneWidget);

    await tester.pump(const Duration(seconds: 1));
    await tester.pump();

    expect(fixture.controller.state, LocationTrackingState.on);
    expect(fixture.locationService.streamRequests, 2);
    expect(fixture.locationService.activeStreams, 1);
  });

  testWidgets('explicit Stop prevents stream recovery', (tester) async {
    final fixture = _TrackingFixture(recoveryDelay: const Duration(seconds: 1));
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: TrackingToggle(controller: fixture.controller)),
    );
    await fixture.controller.startTracking();

    fixture.locationService.latestStream.addError(StateError('GPS stream'));
    await tester.pump();
    await fixture.controller.stopTracking();
    await tester.pump(const Duration(seconds: 3));

    expect(fixture.controller.state, LocationTrackingState.off);
    expect(fixture.locationService.streamRequests, 1);
    expect(fixture.locationService.activeStreams, 0);
  });

  testWidgets('closing and reopening details does not change tracking state', (
    tester,
  ) async {
    final fixture = _TrackingFixture();
    addTearDown(fixture.dispose);
    await fixture.controller.startTracking();

    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );
    await tester.pumpAndSettle();
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await tester.pumpAndSettle();
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );
    await tester.pumpAndSettle();

    expect(fixture.controller.state, LocationTrackingState.on);
    expect(fixture.locationService.streamRequests, 1);
    expect(fixture.locationService.activeStreams, 1);
  });

  testWidgets('401 stops tracking and clears the local session', (
    tester,
  ) async {
    final fixture = _TrackingFixture(telemetryStatusCode: 401);
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      MaterialApp(home: LocationScreen(trackingController: fixture.controller)),
    );

    await tester.tap(find.text('Start Tracking'));
    await fixture.waitForTelemetryRequest(tester, 1);
    await fixture.waitForTelemetryStatus(tester, 'Last upload successful');
    await tester.pump();

    expect(fixture.telemetryRequests, 1);
    expect(fixture.controller.state, LocationTrackingState.off);
    expect(fixture.unauthorizedCalls, 1);
    expect(fixture.locationService.activeStreams, 0);
    expect(find.text(_session.credential), findsNothing);
  });
}

Future<void> _startTracking(WidgetTester tester) async {
  await tester.tap(find.text('Start Tracking'));
  await tester.pump();
}

DriverLocation _sampleLocation({
  double latitude = 51.5074,
  double accuracy = 5.2,
}) => DriverLocation(
  latitude: latitude,
  longitude: -0.1278,
  accuracy: accuracy,
  timestamp: DateTime.utc(2026, 10, 5, 12, 13, 14),
);

class _TrackingFixture {
  _TrackingFixture({
    bool locationEnabled = true,
    DriverLocationPermissionStatus permission =
        DriverLocationPermissionStatus.granted,
    DriverLocationPermissionStatus requestedPermission =
        DriverLocationPermissionStatus.granted,
    Duration recoveryDelay = const Duration(seconds: 2),
    int telemetryStatusCode = 200,
    List<int>? telemetryStatusCodes,
    Future<http.Response> Function(http.Request)? telemetryHandler,
  }) : locationService = _FakeForegroundLocationService(
         locationEnabled: locationEnabled,
         permission: permission,
         requestedPermission: requestedPermission,
       ) {
    apiClient = ApiClient(
      client: MockClient((request) async {
        if (request.url.path == '/devices/assignment') {
          return http.Response(
            jsonEncode({
              'device_id': 'device-test',
              'vehicle_id': 'BUS-37',
              'route_id': 'R12',
            }),
            200,
          );
        }
        telemetryRequests++;
        lastTelemetryPayload = jsonDecode(request.body) as Map<String, dynamic>;
        while (_telemetryRequests.isNotEmpty) {
          _telemetryRequests.removeAt(0).complete();
        }
        if (telemetryHandler != null) {
          return telemetryHandler(request);
        }
        final statusCode =
            telemetryStatusCodes?.elementAt(telemetryRequests - 1) ??
            telemetryStatusCode;
        return http.Response(
          statusCode == 401 ? 'Invalid device credentials' : '',
          statusCode,
        );
      }),
      baseUri: Uri.parse('http://localhost:8080/'),
    );
    controller =
        TrackingController(
            locationService: locationService,
            apiClient: apiClient,
            onUnauthorized: () async => unauthorizedCalls++,
            recoveryDelay: recoveryDelay,
          )
          ..setSession(_session)
          ..setAssignment(_assignment);
  }

  final _FakeForegroundLocationService locationService;
  late final ApiClient apiClient;
  late final TrackingController controller;
  int telemetryRequests = 0;
  int unauthorizedCalls = 0;
  int controllerNotifications = 0;
  Map<String, dynamic>? lastTelemetryPayload;
  final List<Completer<void>> _telemetryRequests = [];

  final List<Completer<http.Response>> _pendingResponses = [];
  bool _disposed = false;

  void trackPendingResponse(Completer<http.Response> response) {
    _pendingResponses.add(response);
  }

  Future<void> waitForTelemetryRequest(
    WidgetTester tester,
    int requestNumber,
  ) async {
    if (telemetryRequests >= requestNumber) return;
    await controller.startTracking();
    final completion = Completer<void>();
    _telemetryRequests.add(completion);
    await tester.pump();
    if (telemetryRequests < requestNumber) await completion.future;
  }

  Future<void> waitForTelemetryStatus(
    WidgetTester tester,
    String status,
  ) async {
    if (controller.telemetryStatus == status) return;
    final completion = Completer<void>();
    void listener() {
      if (controller.telemetryStatus == status) {
        controller.removeListener(listener);
        completion.complete();
      }
    }

    controller.addListener(listener);
    await tester.pump();
    await completion.future;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    for (final response in _pendingResponses) {
      if (!response.isCompleted) response.complete(http.Response('', 200));
    }
    await controller.stopTracking();
    controller.dispose();
    await locationService.dispose();
    apiClient.close();
  }
}

class _FakeForegroundLocationService implements ForegroundLocationService {
  _FakeForegroundLocationService({
    required this.locationEnabled,
    required this.permission,
    required this.requestedPermission,
  });

  final bool locationEnabled;
  final DriverLocationPermissionStatus permission;
  final DriverLocationPermissionStatus requestedPermission;
  final List<StreamController<DriverLocation>> _streams = [];
  int streamRequests = 0;
  int activeStreams = 0;

  StreamController<DriverLocation> get latestStream => _streams.last;

  Future<void> dispose() async {
    for (final stream in _streams) {
      final closed = Completer<void>();
      final drainSubscription = stream.stream.listen(
        (_) {},
        onDone: closed.complete,
      );
      await stream.close();
      await closed.future;
      await drainSubscription.cancel();
    }
  }

  @override
  Future<bool> isLocationServiceEnabled() async => locationEnabled;

  @override
  Future<DriverLocationPermissionStatus> checkPermission() async => permission;

  @override
  Future<DriverLocationPermissionStatus> requestPermission() async =>
      requestedPermission;

  @override
  Future<DriverLocation> getCurrentLocation() async => _sampleLocation();

  @override
  Stream<DriverLocation> getLocationUpdates() {
    streamRequests++;
    final stream = StreamController<DriverLocation>.broadcast(
      sync: true,
      onListen: () => activeStreams++,
      onCancel: () {
        activeStreams--;
      },
    );
    _streams.add(stream);
    return stream.stream;
  }

  @override
  Future<bool> openAppSettings() async => true;

  @override
  Future<bool> openLocationSettings() async => true;
}

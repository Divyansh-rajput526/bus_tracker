import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/assignment.dart';
import '../models/device_session.dart';
import 'api_client.dart';
import 'foreground_location_service.dart';

enum LocationTrackingState { off, starting, on, reconnecting }

class TrackingController extends ChangeNotifier {
  TrackingController({
    required ForegroundLocationService locationService,
    required ApiClient apiClient,
    required Future<void> Function() onUnauthorized,
    Duration recoveryDelay = const Duration(seconds: 2),
    Duration maximumRecoveryDelay = const Duration(seconds: 30),
  }) : _locationService = locationService,
       _apiClient = apiClient,
       _onUnauthorized = onUnauthorized,
       _recoveryDelay = recoveryDelay,
       _maximumRecoveryDelay = maximumRecoveryDelay;

  final ForegroundLocationService _locationService;
  final ApiClient _apiClient;
  final Future<void> Function() _onUnauthorized;
  final Duration _recoveryDelay;
  final Duration _maximumRecoveryDelay;

  DeviceSession? _session;
  Assignment? _assignment;
  StreamSubscription<DriverLocation>? _subscription;
  Future<void>? _startTask;
  Future<void>? _uploadTask;
  Timer? _diagnosticsTimer;
  bool _trackingRequested = false;
  bool _recoveryScheduled = false;
  bool _disposed = false;
  int _generation = 0;
  int _recoveryAttempt = 0;

  LocationTrackingState state = LocationTrackingState.off;
  DriverLocation? location;
  String gpsStatus = 'Location services not started';
  String telemetryStatus = 'Waiting for tracking to start';
  String? errorMessage;
  String? telemetryErrorMessage;
  DateTime? lastGpsFixTimestamp;
  DateTime? lastTelemetryAttemptTimestamp;
  DateTime? lastSuccessfulTelemetryTimestamp;
  double? currentGpsAccuracy;
  int gpsFixesReceived = 0;
  int successfulUploads = 0;
  int failedUploads = 0;

  bool get isTrackingRequested => _trackingRequested;

  void setSession(DeviceSession? session) {
    _session = session;
    if (session == null) {
      _assignment = null;
      unawaited(stopTracking());
    }
  }

  void setAssignment(Assignment assignment) {
    _assignment = assignment;
    if (_trackingRequested && location != null) {
      _startUpload(location!, _generation);
    }
  }

  Future<void> startTracking() {
    if (_trackingRequested) return _startTask ?? Future<void>.value();

    _trackingRequested = true;
    _recoveryAttempt = 0;
    final token = ++_generation;
    state = LocationTrackingState.starting;
    errorMessage = null;
    gpsFixesReceived = 0;
    successfulUploads = 0;
    failedUploads = 0;
    lastGpsFixTimestamp = null;
    lastTelemetryAttemptTimestamp = null;
    lastSuccessfulTelemetryTimestamp = null;
    currentGpsAccuracy = null;
    _diagnosticsTimer?.cancel();
    _diagnosticsTimer = Timer.periodic(
      const Duration(seconds: 1),
      (_) => notifyListeners(),
    );
    notifyListeners();

    final task = _start(token);
    _startTask = task;
    return task;
  }

  Future<void> _start(int token) async {
    try {
      if (_session == null ||
          _assignment?.vehicleId?.trim().isNotEmpty != true ||
          _assignment?.routeId?.trim().isNotEmpty != true) {
        _failStart(token, 'A vehicle and route assignment are required.');
        return;
      }
      if (!await _locationService.isLocationServiceEnabled()) {
        _failStart(token, 'Location services are disabled.');
        return;
      }
      if (!_isCurrent(token)) return;

      var permission = await _locationService.checkPermission();
      if (permission == DriverLocationPermissionStatus.denied) {
        permission = await _locationService.requestPermission();
      }
      if (!_isCurrent(token)) return;
      if (permission != DriverLocationPermissionStatus.granted) {
        _failStart(
          token,
          permission == DriverLocationPermissionStatus.permanentlyDenied
              ? 'Location permission is permanently denied. Enable it in app settings.'
              : 'Location permission was denied.',
        );
        return;
      }

      gpsStatus = 'Getting current location';
      notifyListeners();
      final currentLocation = await _locationService.getCurrentLocation();
      if (!_isCurrent(token)) return;
      location = currentLocation;
      await _subscribe(token);
      if (!_isCurrent(token)) return;
      gpsStatus = 'Active';
      notifyListeners();
      _startUpload(currentLocation, token);
    } on Exception {
      _failStart(token, 'Could not retrieve the phone location.');
    }
  }

  void _failStart(int token, String message) {
    if (!_isCurrent(token)) return;
    _trackingRequested = false;
    state = LocationTrackingState.off;
    gpsStatus = 'Location unavailable';
    errorMessage = message;
    notifyListeners();
  }

  Future<void> _subscribe(int token) async {
    if (!_isCurrent(token)) return;
    final previousSubscription = _subscription;
    _subscription = null;
    await previousSubscription?.cancel();
    if (!_isCurrent(token)) return;

    _subscription = _locationService.getLocationUpdates().listen(
      (position) => _handleLocation(position, token),
      onError: (Object error, StackTrace stackTrace) {
        _handleStreamFailure(token);
      },
      onDone: () => _handleStreamFailure(token),
      cancelOnError: true,
    );
    _recoveryScheduled = false;
    _recoveryAttempt = 0;
    state = LocationTrackingState.on;
    gpsStatus = 'Active';
    errorMessage = null;
    notifyListeners();
  }

  void _handleLocation(DriverLocation position, int token) {
    if (!_isCurrent(token)) return;
    location = position;
    lastGpsFixTimestamp = position.timestamp;
    currentGpsAccuracy = position.accuracy;
    gpsFixesReceived++;
    gpsStatus = 'Active';
    errorMessage = null;
    notifyListeners();
    if (_isValidLocation(position)) {
      _startUpload(position, token);
    } else {
      telemetryStatus = 'TELEMETRY REQUEST FAILED';
      telemetryErrorMessage = 'GPS returned an invalid position.';
      notifyListeners();
    }
  }

  void _startUpload(DriverLocation position, int token) {
    if (_uploadTask != null) return;
    final uploadTask = _uploadLocation(position, token);
    _uploadTask = uploadTask;
    uploadTask.whenComplete(() => _clearUploadTask(uploadTask));
  }

  void _clearUploadTask(Future<void> uploadTask) {
    if (identical(_uploadTask, uploadTask)) _uploadTask = null;
  }

  Future<void> _uploadLocation(DriverLocation position, int token) async {
    final session = _session;
    final assignment = _assignment;
    if (!_isCurrent(token) ||
        session == null ||
        assignment?.vehicleId?.trim().isNotEmpty != true ||
        assignment?.routeId?.trim().isNotEmpty != true ||
        !_isValidLocation(position)) {
      return;
    }

    telemetryStatus = 'SENDING';
    telemetryErrorMessage = null;
    lastTelemetryAttemptTimestamp = DateTime.now();
    notifyListeners();
    try {
      await _apiClient.sendLocationUpdate(
        session: session,
        vehicleId: assignment!.vehicleId!,
        routeId: assignment.routeId!,
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyMeters: position.accuracy,
        deviceTimestamp: position.timestamp,
      );
      if (!_isCurrent(token)) return;
      lastSuccessfulTelemetryTimestamp = DateTime.now();
      successfulUploads++;
      telemetryStatus = 'Last upload successful';
      notifyListeners();
    } on DeviceTelemetryHttpException catch (error) {
      failedUploads++;
      if (error.statusCode == 401) {
        if (!identical(session, _session)) return;
        await stopTracking();
        _session = null;
        _assignment = null;
        await _onUnauthorized();
      } else if (_isCurrent(token)) {
        final status = error.statusCode >= 500
            ? 'CONNECTION ERROR'
            : 'TELEMETRY REQUEST FAILED';
        _setTelemetryFailure(
          error.statusCode >= 500
              ? 'Could not upload location. Check the server connection.'
              : 'Location upload failed (HTTP ${error.statusCode}).',
          status,
        );
      }
    } on ApiException catch (error) {
      if (!_isCurrent(token)) return;
      _setTelemetryFailure(
        error.kind == ApiFailureKind.network
            ? 'Could not upload location. Check the network connection.'
            : 'Could not upload location.',
        'CONNECTION ERROR',
      );
    } on Exception {
      if (_isCurrent(token)) {
        _setTelemetryFailure('Could not upload location.', 'CONNECTION ERROR');
      }
    }
  }

  void _setTelemetryFailure(String message, String status) {
    telemetryStatus = status;
    telemetryErrorMessage = message;
    notifyListeners();
  }

  void _handleStreamFailure(int token) {
    if (!_isCurrent(token) || _recoveryScheduled) return;
    _subscription = null;
    _recoveryScheduled = true;
    state = LocationTrackingState.reconnecting;
    gpsStatus = 'Reconnecting';
    errorMessage = 'Location updates stopped unexpectedly. Reconnecting.';
    notifyListeners();
    unawaited(_recover(token));
  }

  Future<void> _recover(int token) async {
    while (_isCurrent(token)) {
      final multiplier = 1 << _recoveryAttempt.clamp(0, 4);
      final wait = _recoveryDelay * multiplier;
      await Future<void>.delayed(
        wait > _maximumRecoveryDelay ? _maximumRecoveryDelay : wait,
      );
      if (!_isCurrent(token)) return;

      try {
        if (!await _locationService.isLocationServiceEnabled()) {
          throw const _TrackingUnavailableException();
        }
        if (!_isCurrent(token)) return;
        final permission = await _locationService.checkPermission();
        if (permission != DriverLocationPermissionStatus.granted) {
          throw const _TrackingUnavailableException();
        }
        if (!_isCurrent(token)) return;
        await _subscribe(token);
        if (_isCurrent(token)) return;
      } on _TrackingUnavailableException {
        if (!_isCurrent(token)) return;
        _recoveryAttempt++;
        state = LocationTrackingState.reconnecting;
        gpsStatus = 'Reconnecting';
        errorMessage = 'Waiting for GPS availability before retrying.';
        notifyListeners();
      } on Exception {
        if (!_isCurrent(token)) return;
        _recoveryAttempt++;
        state = LocationTrackingState.reconnecting;
        gpsStatus = 'Reconnecting';
        errorMessage = 'Waiting for GPS availability before retrying.';
        notifyListeners();
      }
    }
  }

  Future<void> stopTracking() async {
    _trackingRequested = false;
    ++_generation;
    _recoveryScheduled = false;
    _startTask = null;
    _diagnosticsTimer?.cancel();
    _diagnosticsTimer = null;
    final subscription = _subscription;
    _subscription = null;
    state = LocationTrackingState.off;
    gpsStatus = 'Stopped';
    errorMessage = null;
    telemetryStatus = 'Waiting for tracking to start';
    telemetryErrorMessage = null;
    notifyListeners();
    await subscription?.cancel();
  }

  bool _isCurrent(int token) =>
      !_disposed && _trackingRequested && token == _generation;

  bool _isValidLocation(DriverLocation position) =>
      position.latitude.isFinite &&
      position.longitude.isFinite &&
      position.accuracy.isFinite &&
      position.accuracy >= 0 &&
      position.latitude >= -90 &&
      position.latitude <= 90 &&
      position.longitude >= -180 &&
      position.longitude <= 180;

  @override
  void dispose() {
    _disposed = true;
    _trackingRequested = false;
    ++_generation;
    _diagnosticsTimer?.cancel();
    _diagnosticsTimer = null;
    final subscription = _subscription;
    _subscription = null;
    unawaited(subscription?.cancel());
    super.dispose();
  }
}

class _TrackingUnavailableException implements Exception {
  const _TrackingUnavailableException();
}

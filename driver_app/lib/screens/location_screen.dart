import 'dart:async';

import 'package:flutter/material.dart';

import '../data/api_client.dart';
import '../data/foreground_location_service.dart';
import '../models/assignment.dart';
import '../models/device_session.dart';

enum _GpsStatus {
  checking,
  permissionDenied,
  permissionPermanentlyDenied,
  servicesDisabled,
  locating,
  active,
  error,
}

enum _TelemetryStatus {
  checkingAssignment,
  waitingForLocation,
  sending,
  successful,
  failed,
  notAssigned,
}

class LocationScreen extends StatefulWidget {
  const LocationScreen({
    super.key,
    this.locationService,
    this.apiClient,
    this.session,
    this.onUnauthorized,
  });

  final ForegroundLocationService? locationService;
  final ApiClient? apiClient;
  final DeviceSession? session;
  final Future<void> Function()? onUnauthorized;

  @override
  State<LocationScreen> createState() => _LocationScreenState();
}

class _LocationScreenState extends State<LocationScreen> {
  late final ApiClient _apiClient = widget.apiClient ?? ApiClient();
  late final ForegroundLocationService _locationService =
      widget.locationService ?? const GeolocatorForegroundLocationService();

  _GpsStatus _status = _GpsStatus.checking;
  _TelemetryStatus _telemetryStatus = _TelemetryStatus.checkingAssignment;
  DriverLocation? _location;
  String? _errorMessage;
  String? _telemetryErrorMessage;
  Assignment? _assignment;
  bool _assignmentResolved = false;
  StreamSubscription<DriverLocation>? _locationSubscription;

  @override
  void initState() {
    super.initState();
    unawaited(_loadAssignment());
    _startLocationUpdates();
  }

  @override
  void dispose() {
    _locationSubscription?.cancel();
    if (widget.apiClient == null) _apiClient.close();
    super.dispose();
  }

  Future<void> _loadAssignment() async {
    final session = widget.session;
    if (session == null) {
      if (mounted) {
        setState(() {
          _assignmentResolved = true;
          _telemetryStatus = _TelemetryStatus.notAssigned;
        });
      }
      return;
    }

    try {
      final assignment = await _apiClient.getDeviceAssignment(session);
      if (!mounted) return;
      setState(() {
        _assignment = assignment;
        _assignmentResolved = true;
        _telemetryStatus = _hasAssignment
            ? _TelemetryStatus.waitingForLocation
            : _TelemetryStatus.notAssigned;
      });
      final location = _location;
      if (_hasAssignment && location != null) {
        unawaited(_uploadLocation(location));
      }
    } on DeviceAssignmentHttpException catch (error) {
      if (error.statusCode == 401) {
        await _handleUnauthorized();
      } else {
        _setTelemetryFailure(
          'Could not load the device assignment (HTTP ${error.statusCode}).',
        );
      }
    } on ApiException catch (error) {
      _setTelemetryFailure(
        error.kind == ApiFailureKind.network
            ? 'Could not load the device assignment. Check the network connection.'
            : 'Could not load the device assignment.',
      );
    } on Exception {
      _setTelemetryFailure('Could not load the device assignment.');
    }
  }

  bool get _hasAssignment {
    final assignment = _assignment;
    return assignment != null &&
        assignment.vehicleId?.trim().isNotEmpty == true &&
        assignment.routeId?.trim().isNotEmpty == true;
  }

  bool _isValidLocation(DriverLocation location) =>
      location.latitude.isFinite &&
      location.longitude.isFinite &&
      location.latitude >= -90 &&
      location.latitude <= 90 &&
      location.longitude >= -180 &&
      location.longitude <= 180;

  void _handleLocation(DriverLocation location) {
    if (!mounted) return;
    if (!_isValidLocation(location)) {
      setState(() {
        _location = location;
        _telemetryStatus = _TelemetryStatus.failed;
        _telemetryErrorMessage = 'GPS returned an invalid position.';
      });
      return;
    }
    setState(() {
      _location = location;
      _status = _GpsStatus.active;
      _errorMessage = null;
    });
    if (_hasAssignment) unawaited(_uploadLocation(location));
  }

  Future<void> _uploadLocation(DriverLocation location) async {
    final session = widget.session;
    final assignment = _assignment;
    if (session == null ||
        assignment?.vehicleId?.trim().isNotEmpty != true ||
        assignment?.routeId?.trim().isNotEmpty != true ||
        !_isValidLocation(location)) {
      return;
    }

    setState(() {
      _telemetryStatus = _TelemetryStatus.sending;
      _telemetryErrorMessage = null;
    });
    try {
      await _apiClient.sendLocationUpdate(
        session: session,
        vehicleId: assignment!.vehicleId!,
        routeId: assignment.routeId!,
        latitude: location.latitude,
        longitude: location.longitude,
        deviceTimestamp: location.timestamp,
      );
      if (!mounted) return;
      setState(() => _telemetryStatus = _TelemetryStatus.successful);
    } on DeviceTelemetryHttpException catch (error) {
      if (error.statusCode == 401) {
        await _handleUnauthorized();
      } else {
        _setTelemetryFailure(
          'Location upload failed (HTTP ${error.statusCode}).',
        );
      }
    } on ApiException catch (error) {
      _setTelemetryFailure(
        error.kind == ApiFailureKind.network
            ? 'Could not upload location. Check the network connection.'
            : 'Could not upload location.',
      );
    } on Exception {
      _setTelemetryFailure('Could not upload location.');
    }
  }

  Future<void> _handleUnauthorized() async {
    final onUnauthorized = widget.onUnauthorized;
    if (onUnauthorized == null) {
      _setTelemetryFailure('Device session expired. Return to enrollment.');
      return;
    }
    try {
      await onUnauthorized();
      if (mounted) {
        setState(() {
          _telemetryStatus = _TelemetryStatus.notAssigned;
          _telemetryErrorMessage = null;
        });
      }
    } on Exception {
      _setTelemetryFailure('Could not clear the stored device session.');
    }
  }

  void _setTelemetryFailure(String message) {
    if (!mounted) return;
    setState(() {
      _assignmentResolved = true;
      _telemetryStatus = _TelemetryStatus.failed;
      _telemetryErrorMessage = message;
    });
  }

  Future<void> _startLocationUpdates() async {
    await _locationSubscription?.cancel();
    if (!mounted) return;
    setState(() {
      _status = _GpsStatus.checking;
      _errorMessage = null;
    });

    try {
      if (!await _locationService.isLocationServiceEnabled()) {
        if (mounted) setState(() => _status = _GpsStatus.servicesDisabled);
        return;
      }

      var permission = await _locationService.checkPermission();
      if (permission == DriverLocationPermissionStatus.denied) {
        permission = await _locationService.requestPermission();
      }
      if (!mounted) return;
      if (permission == DriverLocationPermissionStatus.denied) {
        setState(() => _status = _GpsStatus.permissionDenied);
        return;
      }
      if (permission == DriverLocationPermissionStatus.permanentlyDenied) {
        setState(() => _status = _GpsStatus.permissionPermanentlyDenied);
        return;
      }

      setState(() => _status = _GpsStatus.locating);
      final currentLocation = await _locationService.getCurrentLocation();
      if (!mounted) return;
      setState(() {
        _location = currentLocation;
        _status = _GpsStatus.active;
      });
      if (_isValidLocation(currentLocation) && _hasAssignment) {
        unawaited(_uploadLocation(currentLocation));
      }

      _locationSubscription = _locationService.getLocationUpdates().listen(
        _handleLocation,
        onError: (Object error) {
          if (!mounted) return;
          setState(() {
            _status = _GpsStatus.error;
            _errorMessage = 'Location updates stopped because of an error.';
          });
        },
      );
    } on Exception {
      if (!mounted) return;
      setState(() {
        _status = _GpsStatus.error;
        _errorMessage = 'Could not retrieve the phone location. Try again.';
      });
    }
  }

  Future<void> _openSettings({required bool locationSettings}) async {
    try {
      final opened = locationSettings
          ? await _locationService.openLocationSettings()
          : await _locationService.openAppSettings();
      if (!opened && mounted) {
        setState(() {
          _status = _GpsStatus.error;
          _errorMessage = 'Could not open settings. Please open them manually.';
        });
      }
    } on Exception {
      if (!mounted) return;
      setState(() {
        _status = _GpsStatus.error;
        _errorMessage = 'Could not open settings. Please open them manually.';
      });
    }
  }

  String get _statusLabel => switch (_status) {
    _GpsStatus.checking => 'Checking GPS permission...',
    _GpsStatus.permissionDenied => 'Location permission denied',
    _GpsStatus.permissionPermanentlyDenied =>
      'Location permission permanently denied',
    _GpsStatus.servicesDisabled => 'Location services disabled',
    _GpsStatus.locating => 'Getting current location...',
    _GpsStatus.active => 'Active',
    _GpsStatus.error => 'Location error',
  };

  String get _telemetryStatusLabel {
    if (widget.session == null ||
        (_assignmentResolved && !_hasAssignment) ||
        _telemetryStatus == _TelemetryStatus.notAssigned) {
      return 'Not assigned';
    }
    return switch (_telemetryStatus) {
      _TelemetryStatus.checkingAssignment => 'Checking assignment...',
      _TelemetryStatus.waitingForLocation => 'Waiting for GPS position',
      _TelemetryStatus.sending => 'Sending',
      _TelemetryStatus.successful => 'Last upload successful',
      _TelemetryStatus.failed => 'Upload failed',
      _TelemetryStatus.notAssigned => 'Not assigned',
    };
  }

  Widget? _buildAction() => switch (_status) {
    _GpsStatus.permissionDenied => FilledButton.icon(
      onPressed: _startLocationUpdates,
      icon: const Icon(Icons.location_searching),
      label: const Text('Try location permission again'),
    ),
    _GpsStatus.permissionPermanentlyDenied => FilledButton.icon(
      onPressed: () => _openSettings(locationSettings: false),
      icon: const Icon(Icons.settings),
      label: const Text('Open app settings'),
    ),
    _GpsStatus.servicesDisabled => FilledButton.icon(
      onPressed: () => _openSettings(locationSettings: true),
      icon: const Icon(Icons.settings),
      label: const Text('Open location settings'),
    ),
    _GpsStatus.error => OutlinedButton.icon(
      onPressed: _startLocationUpdates,
      icon: const Icon(Icons.refresh),
      label: const Text('Retry location'),
    ),
    _GpsStatus.active => OutlinedButton.icon(
      onPressed: _startLocationUpdates,
      icon: const Icon(Icons.refresh),
      label: const Text('Restart location updates'),
    ),
    _GpsStatus.checking || _GpsStatus.locating => null,
  };

  @override
  Widget build(BuildContext context) {
    final action = _buildAction();
    return Scaffold(
      appBar: AppBar(title: const Text('GPS location')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          _LocationValue(label: 'GPS status', value: _statusLabel),
          const SizedBox(height: 12),
          _LocationValue(
            label: 'Telemetry status',
            value: _telemetryStatusLabel,
          ),
          if (_errorMessage case final message?) ...[
            const SizedBox(height: 8),
            Text(
              message,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
          if (_telemetryErrorMessage case final message?) ...[
            const SizedBox(height: 8),
            Text(
              message,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
          const Divider(height: 32),
          _LocationValue(
            label: 'Latitude',
            value: _location == null
                ? 'Not available'
                : _location!.latitude.toStringAsFixed(6),
          ),
          const SizedBox(height: 20),
          _LocationValue(
            label: 'Longitude',
            value: _location == null
                ? 'Not available'
                : _location!.longitude.toStringAsFixed(6),
          ),
          const SizedBox(height: 20),
          _LocationValue(
            label: 'Accuracy',
            value: _location == null
                ? 'Not available'
                : '${_location!.accuracy.toStringAsFixed(1)} m',
          ),
          const SizedBox(height: 20),
          _LocationValue(
            label: 'Last update time',
            value: _location == null
                ? 'Not available'
                : _formatTimestamp(_location!.timestamp),
          ),
          const SizedBox(height: 32),
          if (action != null)
            Align(alignment: Alignment.centerLeft, child: action),
          const SizedBox(height: 20),
          Text(
            'Location is collected and uploaded only while this screen is open.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }

  String _formatTimestamp(DateTime timestamp) {
    final local = timestamp.toLocal();
    String twoDigits(int value) => value.toString().padLeft(2, '0');

    return '${local.year}-${twoDigits(local.month)}-${twoDigits(local.day)} '
        '${twoDigits(local.hour)}:${twoDigits(local.minute)}:'
        '${twoDigits(local.second)}';
  }
}

class _LocationValue extends StatelessWidget {
  const _LocationValue({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: Theme.of(context).textTheme.labelLarge),
      const SizedBox(height: 4),
      SelectableText(value, style: Theme.of(context).textTheme.bodyLarge),
    ],
  );
}

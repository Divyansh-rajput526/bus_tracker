import 'package:flutter/material.dart';

import 'data/api_client.dart';
import 'data/device_session_store.dart';
import 'data/foreground_location_service.dart';
import 'data/tracking_controller.dart';
import 'models/device_session.dart';
import 'screens/assignment_screen.dart';
import 'screens/device_enrollment_screen.dart';

void main() {
  runApp(const DriverApp());
}

class DriverApp extends StatelessWidget {
  const DriverApp({
    super.key,
    this.apiClient,
    this.sessionStore,
    this.locationService,
  });

  final ApiClient? apiClient;
  final DeviceSessionStore? sessionStore;
  final ForegroundLocationService? locationService;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Driver App',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
      ),
      home: _DriverHome(
        apiClient: apiClient ?? ApiClient(),
        sessionStore: sessionStore ?? SecureDeviceSessionStore(),
        locationService:
            locationService ?? const GeolocatorForegroundLocationService(),
      ),
    );
  }
}

class _DriverHome extends StatefulWidget {
  const _DriverHome({
    required this.apiClient,
    required this.sessionStore,
    required this.locationService,
  });

  final ApiClient apiClient;
  final DeviceSessionStore sessionStore;
  final ForegroundLocationService locationService;

  @override
  State<_DriverHome> createState() => _DriverHomeState();
}

class _DriverHomeState extends State<_DriverHome> {
  late final TrackingController _trackingController = TrackingController(
    locationService: widget.locationService,
    apiClient: widget.apiClient,
    onUnauthorized: _clearSession,
  );
  DeviceSession? _session;
  bool _isLoading = true;
  bool _hasStorageError = false;

  @override
  void initState() {
    super.initState();
    _restoreSession();
  }

  @override
  void dispose() {
    _trackingController.dispose();
    super.dispose();
  }

  Future<void> _restoreSession() async {
    setState(() {
      _isLoading = true;
      _hasStorageError = false;
    });
    try {
      final session = await widget.sessionStore.read();
      if (!mounted) return;
      setState(() {
        _session = session;
        _isLoading = false;
      });
      _trackingController.setSession(session);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _hasStorageError = true;
        _isLoading = false;
      });
    }
  }

  Future<void> _saveSession(DeviceSession session) async {
    await widget.sessionStore.write(session);
    if (!mounted) return;
    _trackingController.setSession(session);
    setState(() => _session = session);
  }

  Future<void> _clearSession() async {
    await _trackingController.stopTracking();
    _trackingController.setSession(null);
    await widget.sessionStore.delete();
    if (!mounted) return;
    setState(() => _session = null);
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_hasStorageError) {
      return Scaffold(
        appBar: AppBar(title: const Text('Driver app')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('Secure storage is unavailable.'),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _restoreSession,
                  child: const Text('Retry'),
                ),
              ],
            ),
          ),
        ),
      );
    }
    final session = _session;
    if (session == null) {
      return DeviceEnrollmentScreen(
        apiClient: widget.apiClient,
        onEnrolled: _saveSession,
      );
    }
    return AssignmentScreen(
      apiClient: widget.apiClient,
      session: session,
      onClearSession: _clearSession,
      trackingController: _trackingController,
    );
  }
}

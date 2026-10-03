import 'package:flutter/material.dart';

import 'data/api_client.dart';
import 'data/device_session_store.dart';
import 'models/device_session.dart';
import 'screens/device_enrollment_screen.dart';
import 'screens/status_screen.dart';

void main() {
  runApp(const DriverApp());
}

class DriverApp extends StatelessWidget {
  const DriverApp({super.key, this.apiClient, this.sessionStore});

  final ApiClient? apiClient;
  final DeviceSessionStore? sessionStore;

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
      ),
    );
  }
}

class _DriverHome extends StatefulWidget {
  const _DriverHome({required this.apiClient, required this.sessionStore});

  final ApiClient apiClient;
  final DeviceSessionStore sessionStore;

  @override
  State<_DriverHome> createState() => _DriverHomeState();
}

class _DriverHomeState extends State<_DriverHome> {
  DeviceSession? _session;
  bool _isLoading = true;
  bool _hasStorageError = false;

  @override
  void initState() {
    super.initState();
    _restoreSession();
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
    setState(() => _session = session);
  }

  Future<void> _clearSession() async {
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
    return StatusScreen(
      apiClient: widget.apiClient,
      session: session,
      onClearSession: _clearSession,
    );
  }
}

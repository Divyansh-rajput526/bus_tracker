import 'package:flutter/material.dart';

import '../data/api_client.dart';
import '../models/assignment.dart';
import '../models/device_session.dart';

enum _AssignmentViewState {
  loading,
  assigned,
  noAssignment,
  networkFailure,
  serverFailure,
  responseFailure,
  sessionFailure,
}

class AssignmentScreen extends StatefulWidget {
  const AssignmentScreen({
    super.key,
    required this.session,
    required this.onClearSession,
    this.apiClient,
  });

  final DeviceSession session;
  final Future<void> Function() onClearSession;
  final ApiClient? apiClient;

  @override
  State<AssignmentScreen> createState() => _AssignmentScreenState();
}

class _AssignmentScreenState extends State<AssignmentScreen> {
  late final ApiClient _apiClient = widget.apiClient ?? ApiClient();

  _AssignmentViewState _viewState = _AssignmentViewState.loading;
  Assignment? _assignment;
  String? _failureMessage;
  bool _isLoading = false;
  bool _isClearing = false;

  @override
  void initState() {
    super.initState();
    _refreshAssignment();
  }

  @override
  void dispose() {
    if (widget.apiClient == null) _apiClient.close();
    super.dispose();
  }

  Future<void> _refreshAssignment() async {
    setState(() {
      _viewState = _AssignmentViewState.loading;
      _failureMessage = null;
      _isLoading = true;
    });
    try {
      final assignment = await _apiClient.getDeviceAssignment(widget.session);
      if (!mounted) return;
      setState(() {
        _assignment = assignment;
        _viewState = assignment.vehicleId == null && assignment.routeId == null
            ? _AssignmentViewState.noAssignment
            : _AssignmentViewState.assigned;
      });
    } on DeviceAssignmentHttpException catch (error) {
      if (error.statusCode == 401) {
        try {
          await widget.onClearSession();
        } catch (_) {
          if (!mounted) return;
          setState(() {
            _viewState = _AssignmentViewState.sessionFailure;
            _failureMessage = 'Could not clear the stored device session.';
          });
        }
      } else if (mounted) {
        setState(() {
          _viewState = error.statusCode >= 500
              ? _AssignmentViewState.serverFailure
              : _AssignmentViewState.responseFailure;
          _failureMessage = error.statusCode >= 500
              ? 'The backend could not load this assignment (HTTP ${error.statusCode}).'
              : 'The backend rejected the assignment request (HTTP ${error.statusCode}).';
        });
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _viewState = error.kind == ApiFailureKind.network
            ? _AssignmentViewState.networkFailure
            : _AssignmentViewState.responseFailure;
        _failureMessage = error.kind == ApiFailureKind.network
            ? 'Could not connect to the backend.'
            : 'The backend returned an unexpected assignment response.';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _viewState = _AssignmentViewState.networkFailure;
        _failureMessage = 'Could not load the device assignment.';
      });
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _confirmClearSession() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear local session?'),
        content: const Text(
          'This will remove the device credential from this phone. To use the driver app again, you will need a new pairing code from an administrator.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Clear session'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _isClearing = true);
    try {
      await widget.onClearSession();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _viewState = _AssignmentViewState.sessionFailure;
        _failureMessage = 'Could not clear the local session.';
      });
    } finally {
      if (mounted) setState(() => _isClearing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final content = switch (_viewState) {
      _AssignmentViewState.loading => _buildLoading(),
      _AssignmentViewState.assigned || _AssignmentViewState.noAssignment =>
        _buildAssignment(),
      _ => _buildFailure(),
    };

    return Scaffold(
      appBar: AppBar(
        title: const Text('Driver home'),
        actions: [
          IconButton(
            tooltip: 'Refresh assignment',
            onPressed: _isLoading ? null : _refreshAssignment,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: content,
    );
  }

  Widget _buildLoading() => const Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        CircularProgressIndicator(),
        SizedBox(height: 16),
        Text('Loading assignment...'),
      ],
    ),
  );

  Widget _buildAssignment() {
    final assignment = _assignment!;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        _AssignmentValue(label: 'Device status', value: 'Active'),
        const Divider(height: 32),
        _AssignmentValue(label: 'Device ID', value: assignment.deviceId),
        const SizedBox(height: 20),
        _AssignmentValue(
          label: 'Vehicle ID',
          value: assignment.vehicleId ?? 'No vehicle assigned',
        ),
        const SizedBox(height: 20),
        _AssignmentValue(
          label: 'Route ID',
          value: assignment.routeId ?? 'No route assigned',
        ),
        const SizedBox(height: 32),
        OutlinedButton.icon(
          onPressed: _isClearing ? null : _confirmClearSession,
          icon: const Icon(Icons.delete_outline),
          label: Text(_isClearing ? 'Clearing...' : 'Clear local session'),
        ),
      ],
    );
  }

  Widget _buildFailure() {
    final (title, icon, status) = switch (_viewState) {
      _AssignmentViewState.networkFailure => (
        'Network unavailable',
        Icons.wifi_off,
        'Unavailable',
      ),
      _AssignmentViewState.serverFailure => (
        'Server error',
        Icons.cloud_off,
        'Unavailable',
      ),
      _AssignmentViewState.sessionFailure => (
        'Session unavailable',
        Icons.lock_outline,
        'Needs attention',
      ),
      _ => (
        'Could not load assignment',
        Icons.error_outline,
        'Unavailable',
      ),
    };

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 36),
            const SizedBox(height: 16),
            Text(title, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(_failureMessage ?? 'Try again.'),
            const SizedBox(height: 20),
            OutlinedButton.icon(
              onPressed: _isLoading ? null : _refreshAssignment,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
            const SizedBox(height: 12),
            Text('Device status: $status'),
          ],
        ),
      ),
    );
  }
}

class _AssignmentValue extends StatelessWidget {
  const _AssignmentValue({required this.label, required this.value});

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
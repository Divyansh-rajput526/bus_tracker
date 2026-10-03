import 'package:flutter/material.dart';

import '../data/api_client.dart';
import '../models/device_session.dart';

class StatusScreen extends StatefulWidget {
  const StatusScreen({
    super.key,
    required this.session,
    required this.onClearSession,
    this.apiClient,
  });

  final DeviceSession session;
  final Future<void> Function() onClearSession;
  final ApiClient? apiClient;

  @override
  State<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends State<StatusScreen> {
  late final ApiClient _apiClient = widget.apiClient ?? ApiClient();

  String _connectionStatus = 'Checking';
  String? _connectionError;
  String? _clearError;
  bool _isChecking = false;
  bool _isClearing = false;

  @override
  void initState() {
    super.initState();
    _refreshStatus();
  }

  @override
  void dispose() {
    if (widget.apiClient == null) _apiClient.close();
    super.dispose();
  }

  Future<void> _refreshStatus() async {
    setState(() => _isChecking = true);
    await _checkBackend();
    if (mounted) setState(() => _isChecking = false);
  }

  Future<void> _checkBackend() async {
    try {
      await _apiClient.checkConnection();
      if (!mounted) return;
      setState(() {
        _connectionStatus = 'Connected';
        _connectionError = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _connectionStatus = 'Unavailable';
        _connectionError = error.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _connectionStatus = 'Unavailable';
        _connectionError = 'Could not check the backend connection.';
      });
    }
  }

  Future<void> _confirmClearSession() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear local session?'),
        content: const Text(
          'This removes the credential from this device only. The server credential remains active until an administrator revokes it.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() {
      _isClearing = true;
      _clearError = null;
    });
    try {
      await widget.onClearSession();
    } catch (_) {
      if (!mounted) return;
      setState(() => _clearError = 'Could not clear the local session.');
    } finally {
      if (mounted) setState(() => _isClearing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Enrolled device'),
        actions: [
          IconButton(
            tooltip: 'Refresh status',
            onPressed: _isChecking ? null : _refreshStatus,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          _StatusRow(label: 'Backend connection', value: _connectionStatus),
          if (_connectionError case final error?) _StatusError(message: error),
          const Divider(height: 32),
          _StatusRow(label: 'Enrollment', value: 'Complete'),
          const SizedBox(height: 20),
          Text('Device ID', style: Theme.of(context).textTheme.labelLarge),
          SelectableText(widget.session.deviceId),
          const SizedBox(height: 12),
          Text('Credential ID', style: Theme.of(context).textTheme.labelLarge),
          SelectableText(widget.session.credentialId),
          const SizedBox(height: 24),
          OutlinedButton.icon(
            onPressed: _isClearing ? null : _confirmClearSession,
            icon: const Icon(Icons.delete_outline),
            label: Text(_isClearing ? 'Clearing...' : 'Clear local session'),
          ),
          if (_clearError case final error?) _StatusError(message: error),
        ],
      ),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: Theme.of(context).textTheme.titleMedium),
        Text(value, style: Theme.of(context).textTheme.bodyLarge),
      ],
    );
  }
}

class _StatusError extends StatelessWidget {
  const _StatusError({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Text(
      message,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );
}

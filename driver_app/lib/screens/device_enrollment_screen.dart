import 'package:flutter/material.dart';

import '../data/api_client.dart';
import '../models/device_session.dart';

class DeviceEnrollmentScreen extends StatefulWidget {
  const DeviceEnrollmentScreen({
    super.key,
    required this.apiClient,
    required this.onEnrolled,
  });

  final ApiClient apiClient;
  final Future<void> Function(DeviceSession session) onEnrolled;

  @override
  State<DeviceEnrollmentScreen> createState() => _DeviceEnrollmentScreenState();
}

class _DeviceEnrollmentScreenState extends State<DeviceEnrollmentScreen> {
  final _pairingCodeController = TextEditingController();
  bool _isSubmitting = false;
  String? _errorMessage;

  @override
  void dispose() {
    _pairingCodeController.dispose();
    super.dispose();
  }

  Future<void> _claimDevice() async {
    final pairingCode = _pairingCodeController.text.trim();
    if (pairingCode.isEmpty || _isSubmitting) return;

    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });
    try {
      final session = await widget.apiClient.claimDevice(pairingCode);
      await widget.onEnrolled(session);
    } on DeviceClaimException catch (error) {
      if (!mounted) return;
      setState(() => _errorMessage = _messageForFailure(error.kind));
    } on ApiException {
      if (!mounted) return;
      setState(
        () => _errorMessage =
            'Could not connect to the backend. Check the connection and try again.',
      );
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _errorMessage =
            'The device could not be enrolled or its credential could not be saved securely. Ask an administrator for help.';
      });
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  String _messageForFailure(DeviceClaimFailureKind kind) => switch (kind) {
    DeviceClaimFailureKind.invalidOrUsedPairingCode =>
      'This pairing code is invalid, expired, or already used.',
    DeviceClaimFailureKind.tooManyAttempts =>
      'Too many enrollment attempts. Wait a minute and try again.',
    DeviceClaimFailureKind.serverFailure =>
      'The backend could not complete enrollment. Try again later.',
    DeviceClaimFailureKind.rejected =>
      'The backend rejected this enrollment request. Check the pairing code and try again.',
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Enroll device')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Text('Enter the pairing code provided by your administrator.'),
          const SizedBox(height: 20),
          TextField(
            key: const Key('pairing-code-field'),
            controller: _pairingCodeController,
            enabled: !_isSubmitting,
            autocorrect: false,
            enableSuggestions: false,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _claimDevice(),
            decoration: const InputDecoration(
              labelText: 'Pairing code',
              border: OutlineInputBorder(),
            ),
          ),
          if (_errorMessage case final message?) ...[
            const SizedBox(height: 16),
            Text(
              message,
              key: const Key('enrollment-error'),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _isSubmitting ? null : _claimDevice,
            icon: _isSubmitting
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.phonelink_lock),
            label: Text(_isSubmitting ? 'Enrolling...' : 'Claim device'),
          ),
        ],
      ),
    );
  }
}

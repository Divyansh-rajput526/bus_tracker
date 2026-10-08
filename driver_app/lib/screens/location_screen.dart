import 'package:flutter/material.dart';

import '../data/tracking_controller.dart';
import '../widgets/tracking_toggle.dart';

class LocationScreen extends StatelessWidget {
  const LocationScreen({super.key, required this.trackingController});

  final TrackingController trackingController;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Location Tracking')),
    body: AnimatedBuilder(
      animation: trackingController,
      builder: (context, _) {
        final location = trackingController.location;
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            TrackingToggle(controller: trackingController),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'GPS status',
              value: trackingController.gpsStatus,
            ),
            const SizedBox(height: 12),
            _LocationValue(
              label: 'Telemetry status',
              value: trackingController.telemetryStatus,
            ),
            if (trackingController.telemetryErrorMessage
                case final message?) ...[
              const SizedBox(height: 8),
              Text(
                message,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Last GPS update',
              value: _ageLabel(
                trackingController.lastGpsFixTimestamp,
                'Waiting for GPS update...',
              ),
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Last upload attempt',
              value: _ageLabel(
                trackingController.lastTelemetryAttemptTimestamp,
                'Not attempted',
              ),
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Last successful upload',
              value: _ageLabel(
                trackingController.lastSuccessfulTelemetryTimestamp,
                'Not successful',
              ),
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Accuracy',
              value: trackingController.currentGpsAccuracy == null
                  ? 'Not available'
                  : '${trackingController.currentGpsAccuracy!.toStringAsFixed(1)} m',
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'GPS fixes',
              value: trackingController.gpsFixesReceived.toString(),
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Successful uploads',
              value: trackingController.successfulUploads.toString(),
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Failed uploads',
              value: trackingController.failedUploads.toString(),
            ),
            const Divider(height: 32),
            _LocationValue(
              label: 'Latitude',
              value: location == null
                  ? 'Not available'
                  : location.latitude.toStringAsFixed(6),
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Longitude',
              value: location == null
                  ? 'Not available'
                  : location.longitude.toStringAsFixed(6),
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Accuracy',
              value: location == null
                  ? 'Not available'
                  : '${location.accuracy.toStringAsFixed(1)} m',
            ),
            const SizedBox(height: 20),
            _LocationValue(
              label: 'Last update time',
              value: location == null
                  ? 'Not available'
                  : _formatTimestamp(location.timestamp),
            ),
          ],
        );
      },
    ),
  );

  String _ageLabel(DateTime? timestamp, String unavailable) {
    if (timestamp == null) return unavailable;

    final age = DateTime.now().difference(timestamp);
    if (age < const Duration(seconds: 1)) return 'now';
    if (age < const Duration(minutes: 1)) {
      return '${age.inSeconds}s ago';
    }
    return '${age.inMinutes}m ago';
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

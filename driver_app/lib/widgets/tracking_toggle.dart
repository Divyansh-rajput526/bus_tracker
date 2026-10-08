import 'dart:async';

import 'package:flutter/material.dart';

import '../data/tracking_controller.dart';

class TrackingToggle extends StatelessWidget {
  const TrackingToggle({super.key, required this.controller});

  final TrackingController controller;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final trackingState = controller.state;
      final isOn =
          trackingState == LocationTrackingState.on ||
          trackingState == LocationTrackingState.reconnecting;
      final isStarting = trackingState == LocationTrackingState.starting;
      final statusLabel = switch (trackingState) {
        LocationTrackingState.on => 'Location Tracking - ON',
        LocationTrackingState.reconnecting =>
          'Location Tracking - RECONNECTING',
        LocationTrackingState.off ||
        LocationTrackingState.starting => 'Location Tracking - OFF',
      };

      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(statusLabel, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          FilledButton.icon(
            style: FilledButton.styleFrom(
              backgroundColor: isOn ? Colors.red : Colors.green,
              foregroundColor: Colors.white,
            ),
            onPressed: isStarting
                ? null
                : () {
                    if (isOn) {
                      unawaited(controller.stopTracking());
                    } else {
                      unawaited(controller.startTracking());
                    }
                  },
            icon: Icon(isOn ? Icons.stop : Icons.play_arrow),
            label: Text(isOn ? 'Stop Tracking' : 'Start Tracking'),
          ),
          if (controller.errorMessage case final error?) ...[
            const SizedBox(height: 8),
            Text(
              error,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
        ],
      );
    },
  );
}

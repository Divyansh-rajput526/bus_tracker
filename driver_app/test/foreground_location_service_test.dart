import 'package:driver_app/data/foreground_location_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

void main() {
  test('foreground Android stream uses explicit high accuracy settings', () {
    final settings =
        GeolocatorForegroundLocationService.foregroundLocationSettings;

    expect(settings, isA<AndroidSettings>());
    expect(settings.accuracy, LocationAccuracy.high);
    expect(settings.distanceFilter, 0);
    expect(settings.intervalDuration, const Duration(seconds: 2));
    expect(settings.foregroundNotificationConfig, isNull);
  });

  test('foreground location settings remain foreground-only', () {
    final settings =
        GeolocatorForegroundLocationService.foregroundLocationSettings;

    expect(settings.forceLocationManager, isFalse);
    expect(settings.foregroundNotificationConfig, isNull);
  });
}

import 'package:geolocator/geolocator.dart';

enum DriverLocationPermissionStatus { granted, denied, permanentlyDenied }

class DriverLocation {
  const DriverLocation({
    required this.latitude,
    required this.longitude,
    required this.accuracy,
    required this.timestamp,
  });

  final double latitude;
  final double longitude;
  final double accuracy;
  final DateTime timestamp;
}

abstract interface class ForegroundLocationService {
  Future<bool> isLocationServiceEnabled();

  Future<DriverLocationPermissionStatus> checkPermission();

  Future<DriverLocationPermissionStatus> requestPermission();

  Future<DriverLocation> getCurrentLocation();

  Stream<DriverLocation> getLocationUpdates();

  Future<bool> openAppSettings();

  Future<bool> openLocationSettings();
}

class GeolocatorForegroundLocationService implements ForegroundLocationService {
  const GeolocatorForegroundLocationService();

  static final AndroidSettings foregroundLocationSettings = AndroidSettings(
    accuracy: LocationAccuracy.high,
    distanceFilter: 0,
    intervalDuration: const Duration(seconds: 2),
  );

  @override
  Future<bool> isLocationServiceEnabled() =>
      Geolocator.isLocationServiceEnabled();

  @override
  Future<DriverLocationPermissionStatus> checkPermission() async =>
      _mapPermission(await Geolocator.checkPermission());

  @override
  Future<DriverLocationPermissionStatus> requestPermission() async =>
      _mapPermission(await Geolocator.requestPermission());

  @override
  Future<DriverLocation> getCurrentLocation() async => _mapPosition(
    await Geolocator.getCurrentPosition(
      locationSettings: foregroundLocationSettings,
    ),
  );

  @override
  Stream<DriverLocation> getLocationUpdates() => Geolocator.getPositionStream(
    locationSettings: foregroundLocationSettings,
  ).map(_mapPosition);

  @override
  Future<bool> openAppSettings() => Geolocator.openAppSettings();

  @override
  Future<bool> openLocationSettings() => Geolocator.openLocationSettings();

  DriverLocationPermissionStatus _mapPermission(LocationPermission permission) {
    if (permission == LocationPermission.whileInUse ||
        permission == LocationPermission.always) {
      return DriverLocationPermissionStatus.granted;
    }
    if (permission == LocationPermission.deniedForever) {
      return DriverLocationPermissionStatus.permanentlyDenied;
    }
    return DriverLocationPermissionStatus.denied;
  }

  DriverLocation _mapPosition(Position position) => DriverLocation(
    latitude: position.latitude,
    longitude: position.longitude,
    accuracy: position.accuracy,
    timestamp: position.timestamp,
  );
}

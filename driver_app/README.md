# Driver App

Flutter driver app foundation for the vehicle-tracking backend.

## Backend URL

The API root is configured in `lib/config/api_config.dart` and can be overridden
at build or run time:

```sh
flutter run --dart-define=API_BASE_URL=https://your-api.example
```

For the Android emulator, use `http://10.0.2.2:8080` to reach a backend running
on the host machine. The initial screen checks `GET /routes`, the backend's
public JSON endpoint. Device enrollment is initiated by an administrator; the
driver app's claim client uses `POST /devices/claim` with a `pairing_code`.

Claimed credentials are stored by `flutter_secure_storage` using the native
platform secure storage. No credential or token is included in the source.

## Foreground GPS

After enrollment, open **View GPS location** from Driver home to grant location
permission and view the phone's current coordinates, accuracy, and last update
time. While the GPS location screen is open, the app loads the device's current
vehicle and route assignment and uploads each valid foreground GPS position to
`POST /update-location` using the stored device credential. Upload status is
shown on the GPS screen. The app does not request background location access or
retry telemetry while offline.

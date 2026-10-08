export function getDisplaySpeed(status, reportedSpeed) {
  if (status === "Stale" || status === "Offline") {
    return 0;
  }

  return Number(reportedSpeed);
}

export function formatVehicleSpeed(speed) {
  return Number.isFinite(speed)
    ? `${speed.toFixed(1)} km/h`
    : "Unavailable";
}

function haversineDistanceKm(
  latitude1,
  longitude1,
  latitude2,
  longitude2
) {
  const earthRadiusKm = 6371;
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLatitude = toRadians(latitude2 - latitude1);
  const dLongitude = toRadians(longitude2 - longitude1);
  const lat1 = toRadians(latitude1);
  const lat2 = toRadians(latitude2);
  const a =
    Math.sin(dLatitude / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLongitude / 2) ** 2;
  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return earthRadiusKm * c;
}

export function calculateApproximateEtaMinutes(
  vehicle,
  stop,
  status
) {
  if (!vehicle || !stop || status !== "Active") {
    return null;
  }

  const vehicleLatitude = Number(vehicle.latitude);
  const vehicleLongitude = Number(vehicle.longitude);
  const stopLatitude = Number(stop.latitude);
  const stopLongitude = Number(stop.longitude);
  const speed = Number(vehicle.speed);

  if (
    !Number.isFinite(vehicleLatitude) ||
    !Number.isFinite(vehicleLongitude) ||
    !Number.isFinite(stopLatitude) ||
    !Number.isFinite(stopLongitude) ||
    !Number.isFinite(speed) ||
    speed < 2
  ) {
    return null;
  }

  const distanceKm = haversineDistanceKm(
    vehicleLatitude,
    vehicleLongitude,
    stopLatitude,
    stopLongitude
  );
  const minutes = (distanceKm / speed) * 60;

  if (!Number.isFinite(minutes)) {
    return null;
  }

  return {
    minutes: Math.max(0, minutes),
    distanceKm,
  };
}

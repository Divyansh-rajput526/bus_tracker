export function isDeviceExpired(expiresAt, now = new Date()) {
  if (!expiresAt) {
    return false;
  }
  const expTime = new Date(expiresAt).getTime();
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(expTime) && expTime <= nowTime;
}

export function formatDeviceExpiry(expiresAt, now = new Date()) {
  if (!expiresAt) {
    return "No expiry set";
  }

  const expDate = new Date(expiresAt);
  const expTime = expDate.getTime();
  if (!Number.isFinite(expTime)) {
    return "Invalid date";
  }

  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const diffMs = expTime - nowTime;

  const timeString = expDate.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  if (diffMs <= 0) {
    return `Expired at ${timeString}`;
  }

  const remainingTotalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(remainingTotalSeconds / 60);
  const seconds = remainingTotalSeconds % 60;

  if (minutes > 0) {
    return `Expires in ${minutes}m ${seconds}s (at ${timeString})`;
  }
  return `Expires in ${seconds}s (at ${timeString})`;
}

export function getDeviceStatusBadge(device, now = new Date()) {
  if (!device) {
    return {
      label: "Unknown",
      color: "#6c757d",
      bg: "rgba(108, 117, 125, 0.12)",
      border: "rgba(108, 117, 125, 0.25)",
    };
  }

  if (device.status === "revoked") {
    return {
      label: "Revoked",
      color: "#6c757d",
      bg: "rgba(108, 117, 125, 0.12)",
      border: "rgba(108, 117, 125, 0.25)",
    };
  }

  if (device.status === "active") {
    return {
      label: "Active",
      color: "#28a745",
      bg: "rgba(40, 167, 69, 0.12)",
      border: "rgba(40, 167, 69, 0.25)",
    };
  }

  if (device.status === "pending") {
    if (isDeviceExpired(device.pairing_expires_at, now)) {
      return {
        label: "Expired Pairing",
        color: "#dc3545",
        bg: "rgba(220, 53, 69, 0.12)",
        border: "rgba(220, 53, 69, 0.25)",
      };
    }
    return {
      label: "Pending Claim",
      color: "#e67e22",
      bg: "rgba(230, 126, 34, 0.12)",
      border: "rgba(230, 126, 34, 0.25)",
    };
  }

  return {
    label: device.status,
    color: "#6c757d",
    bg: "rgba(108, 117, 125, 0.12)",
    border: "rgba(108, 117, 125, 0.25)",
  };
}

export function getVehicleStatusBadge(status) {
  const normalized = (status || "").toLowerCase();
  switch (normalized) {
    case "active":
      return {
        label: "Active",
        color: "#28a745",
        bg: "rgba(40, 167, 69, 0.12)",
        border: "rgba(40, 167, 69, 0.25)",
      };
    case "pending":
      return {
        label: "Pending",
        color: "#e67e22",
        bg: "rgba(230, 126, 34, 0.12)",
        border: "rgba(230, 126, 34, 0.25)",
      };
    case "deactivated":
      return {
        label: "Deactivated",
        color: "#dc3545",
        bg: "rgba(220, 53, 69, 0.12)",
        border: "rgba(220, 53, 69, 0.25)",
      };
    case "retired":
      return {
        label: "Retired",
        color: "#6c757d",
        bg: "rgba(108, 117, 125, 0.12)",
        border: "rgba(108, 117, 125, 0.25)",
      };
    default:
      return {
        label: status || "Unknown",
        color: "#6c757d",
        bg: "rgba(108, 117, 125, 0.12)",
        border: "rgba(108, 117, 125, 0.25)",
      };
  }
}

export function getVehicleDeviceRule(vehicle, devices = [], now = new Date()) {
  if (!vehicle) {
    return { canEnroll: false, message: "No vehicle selected." };
  }

  const vStatus = (vehicle.status || "").toLowerCase();
  if (vStatus === "deactivated" || vStatus === "retired") {
    return {
      canEnroll: false,
      reason: "vehicle_inactive",
      message: `Vehicle is ${vStatus} and cannot enroll new devices. Only active or pending vehicles can pair devices.`,
    };
  }

  const activeDevice = devices.find((d) => d.status === "active");
  if (activeDevice) {
    return {
      canEnroll: false,
      reason: "active_exists",
      activeDevice,
      message: `Vehicle already has an active device ("${activeDevice.device_label}"). Only one active or pending device can exist for a vehicle. Revoke the active device first.`,
    };
  }

  const pendingDevice = devices.find(
    (d) => d.status === "pending" && !isDeviceExpired(d.pairing_expires_at, now)
  );
  if (pendingDevice) {
    return {
      canEnroll: false,
      reason: "pending_exists",
      pendingDevice,
      message: `Vehicle already has a pending device enrollment ("${pendingDevice.device_label}"). Only one active or pending device can exist for a vehicle. Revoke the pending device first or wait for expiry.`,
    };
  }

  return { canEnroll: true };
}

export function isValidCoordinate(latitude, longitude) {
  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined ||
    typeof latitude === "boolean" ||
    typeof longitude === "boolean"
  ) {
    return false;
  }
  if (typeof latitude === "string" && latitude.trim() === "") {
    return false;
  }
  if (typeof longitude === "string" && longitude.trim() === "") {
    return false;
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90.0 &&
    lat <= 90.0 &&
    lng >= -180.0 &&
    lng <= 180.0
  );
}

export function formatAdminError(error) {
  if (!error) {
    return "An unknown error occurred.";
  }

  if (error.isUnauthorized || error.status === 401) {
    return "Unauthorized: Invalid or expired admin token. Please verify your token and sign in again.";
  }

  const rawMsg = error.message || "";
  const lowerMsg = rawMsg.toLowerCase();

  if (error.isConflict || error.status === 409) {
    if (lowerMsg.includes("pending")) {
      return "Cannot enroll device: a device enrollment is already pending for this vehicle. Revoke the existing pending device first.";
    }
    if (lowerMsg.includes("not available for enrollment")) {
      return "Cannot enroll device: this vehicle is not in a valid state for enrollment.";
    }
    if (lowerMsg.includes("vehicle already exists")) {
      return "Cannot create vehicle: a vehicle with this ID already exists.";
    }
    if (lowerMsg.includes("route already exists")) {
      return "Cannot create route: a route with this ID already exists.";
    }
    if (lowerMsg.includes("cannot delete route with active vehicles")) {
      return "Cannot delete route: one or more active vehicles are currently assigned to this route.";
    }
    if (lowerMsg.includes("stop already exists")) {
      return "Cannot create stop: a stop with this ID already exists on this route.";
    }
    if (lowerMsg.includes("not available for assignment")) {
      return "Cannot assign route: vehicle is deactivated or retired.";
    }
    return `Conflict: ${rawMsg || "The requested operation conflicts with existing records."}`;
  }

  if (error.status === 404) {
    if (lowerMsg.includes("vehicle")) return "Vehicle does not exist.";
    if (lowerMsg.includes("route")) return "Route does not exist.";
    if (lowerMsg.includes("stop")) return "Stop does not exist.";
    if (lowerMsg.includes("device")) return "Device does not exist.";
    return "Requested vehicle, route, or stop was not found.";
  }

  if (error.status === 400) {
    if (lowerMsg.includes("coordinates")) {
      return "Invalid stop coordinates: latitude must be between -90 and 90, longitude between -180 and 180.";
    }
    if (lowerMsg.includes("sequence")) {
      return `Invalid stop sequence: ${rawMsg}`;
    }
    return rawMsg || "Invalid request parameters.";
  }

  return rawMsg || "An unexpected error occurred.";
}

export function filterVehiclesByStatus(vehicles = [], statusFilter = "active_deactivated") {
  if (!Array.isArray(vehicles)) return [];
  return vehicles.filter((v) => {
    const status = (v?.status || "").toLowerCase();
    switch (statusFilter) {
      case "active":
        return status === "active";
      case "deactivated":
        return status === "deactivated";
      case "retired":
        return status === "retired";
      case "all":
        return true;
      case "active_deactivated":
      default:
        return status !== "retired";
    }
  });
}

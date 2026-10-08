export const ADMIN_TOKEN_STORAGE_KEY = "bus_tracker_admin_token";

export function getStoredAdminToken() {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredAdminToken(token) {
  try {
    if (token && token.trim()) {
      sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token.trim());
    } else {
      sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors in restricted browser contexts
  }
}

export function clearStoredAdminToken() {
  try {
    sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

async function handleResponse(response) {
  if (response.status === 401) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(errorText || "Invalid or unauthorized admin token");
    error.status = 401;
    error.isUnauthorized = true;
    throw error;
  }

  if (response.status === 409) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(
      errorText || "The requested operation conflicts with existing backend records."
    );
    error.status = 409;
    error.isConflict = true;
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(errorText || `Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

/* =========================================================
   Vehicle Endpoints
   ========================================================= */

export async function fetchAdminVehicles(token, apiBaseUrl = "http://localhost:8080") {
  const response = await fetch(`${apiBaseUrl}/admin/vehicles`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      Accept: "application/json",
    },
  });
  return handleResponse(response);
}

export async function createAdminVehicle(
  token,
  vehicleId,
  displayName,
  apiBaseUrl = "http://localhost:8080"
) {
  const payload = {
    vehicle_id: vehicleId.trim(),
  };
  if (displayName && displayName.trim()) {
    payload.display_name = displayName.trim();
  }

  const response = await fetch(`${apiBaseUrl}/admin/vehicles`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
}

export async function updateVehicleStatus(
  token,
  vehicleId,
  status,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(
    `${apiBaseUrl}/admin/vehicles/${encodeURIComponent(vehicleId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ status: status.trim() }),
    }
  );
  return handleResponse(response);
}

export async function deleteAdminVehicle(
  token,
  vehicleId,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(
    `${apiBaseUrl}/admin/vehicles/${encodeURIComponent(vehicleId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/json",
      },
    }
  );
  return handleResponse(response);
}

export async function assignVehicleRoute(
  token,
  vehicleId,
  routeId,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(
    `${apiBaseUrl}/admin/vehicles/${encodeURIComponent(vehicleId)}/route-assignments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ route_id: routeId.trim() }),
    }
  );
  return handleResponse(response);
}

/* =========================================================
   Device Endpoints
   ========================================================= */

export async function fetchVehicleDevices(token, vehicleId, apiBaseUrl = "http://localhost:8080") {
  const response = await fetch(
    `${apiBaseUrl}/admin/vehicles/${encodeURIComponent(vehicleId)}/devices`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/json",
      },
    }
  );
  return handleResponse(response);
}

export async function createDeviceEnrollment(
  token,
  vehicleId,
  deviceLabel,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(
    `${apiBaseUrl}/admin/vehicles/${encodeURIComponent(vehicleId)}/devices`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ device_label: deviceLabel.trim() }),
    }
  );
  return handleResponse(response);
}

export async function revokeDevice(token, deviceId, apiBaseUrl = "http://localhost:8080") {
  const response = await fetch(
    `${apiBaseUrl}/admin/devices/${encodeURIComponent(deviceId)}/revoke`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
      },
    }
  );
  return handleResponse(response);
}

/* =========================================================
   Route Endpoints
   ========================================================= */

export async function fetchRoutes(apiBaseUrl = "http://localhost:8080") {
  const response = await fetch(`${apiBaseUrl}/routes`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  return handleResponse(response);
}

export async function createAdminRoute(
  token,
  routeId,
  routeName,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(`${apiBaseUrl}/admin/routes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      route_id: routeId.trim(),
      route_name: routeName.trim(),
    }),
  });
  return handleResponse(response);
}

export async function updateAdminRoute(
  token,
  routeId,
  routeName,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(`${apiBaseUrl}/admin/routes/${encodeURIComponent(routeId)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      route_name: routeName.trim(),
    }),
  });
  return handleResponse(response);
}

export async function deleteAdminRoute(token, routeId, apiBaseUrl = "http://localhost:8080") {
  const response = await fetch(`${apiBaseUrl}/admin/routes/${encodeURIComponent(routeId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
    },
  });
  return handleResponse(response);
}

/* =========================================================
   Stop Endpoints
   ========================================================= */

export async function fetchRouteStops(routeId, apiBaseUrl = "http://localhost:8080") {
  const response = await fetch(`${apiBaseUrl}/routes/${encodeURIComponent(routeId)}/stops`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  return handleResponse(response);
}

export async function createAdminStop(
  token,
  routeId,
  stopData,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(`${apiBaseUrl}/admin/routes/${encodeURIComponent(routeId)}/stops`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      stop_id: stopData.stop_id.trim(),
      stop_name: stopData.stop_name.trim(),
      latitude: Number(stopData.latitude),
      longitude: Number(stopData.longitude),
      sequence: Number(stopData.sequence),
    }),
  });
  return handleResponse(response);
}

export async function updateAdminStop(
  token,
  routeId,
  stopId,
  stopData,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(
    `${apiBaseUrl}/admin/routes/${encodeURIComponent(routeId)}/stops/${encodeURIComponent(stopId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        stop_name: stopData.stop_name.trim(),
        latitude: Number(stopData.latitude),
        longitude: Number(stopData.longitude),
        sequence: Number(stopData.sequence),
      }),
    }
  );
  return handleResponse(response);
}

export async function deleteAdminStop(
  token,
  routeId,
  stopId,
  apiBaseUrl = "http://localhost:8080"
) {
  const response = await fetch(
    `${apiBaseUrl}/admin/routes/${encodeURIComponent(routeId)}/stops/${encodeURIComponent(stopId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
      },
    }
  );
  return handleResponse(response);
}

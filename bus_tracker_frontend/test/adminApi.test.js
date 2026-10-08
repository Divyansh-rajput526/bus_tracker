import assert from "node:assert/strict";
import test from "node:test";

import {
  assignVehicleRoute,
  clearStoredAdminToken,
  createAdminRoute,
  createAdminStop,
  createAdminVehicle,
  createDeviceEnrollment,
  deleteAdminRoute,
  deleteAdminStop,
  deleteAdminVehicle,
  fetchAdminVehicles,
  fetchRoutes,
  fetchRouteStops,
  fetchVehicleDevices,
  getStoredAdminToken,
  revokeDevice,
  setStoredAdminToken,
  updateAdminRoute,
  updateAdminStop,
  updateVehicleStatus,
} from "../src/adminApi.js";

// Mock sessionStorage in Node test environment if not present
if (typeof globalThis.sessionStorage === "undefined") {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

test("adminApi sessionStorage token management stores and clears tokens", () => {
  clearStoredAdminToken();
  assert.equal(getStoredAdminToken(), "");

  setStoredAdminToken("secret-admin-token-123");
  assert.equal(getStoredAdminToken(), "secret-admin-token-123");

  clearStoredAdminToken();
  assert.equal(getStoredAdminToken(), "");
});

test("fetchAdminVehicles sends Bearer token in Authorization header", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders = null;
  let capturedUrl = "";

  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      json: async () => [{ vehicle_id: "BUS-101", status: "active" }],
    };
  };

  try {
    const vehicles = await fetchAdminVehicles("my-test-token", "http://test-server:8080");
    assert.equal(capturedUrl, "http://test-server:8080/admin/vehicles");
    assert.equal(capturedHeaders.Authorization, "Bearer my-test-token");
    assert.equal(vehicles.length, 1);
    assert.equal(vehicles[0].vehicle_id, "BUS-101");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createAdminVehicle sends POST with vehicle_id and display_name", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  let capturedUrl = "";

  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 201,
      json: async () => ({
        vehicle_id: "BUS-102",
        display_name: "Campus Shuttler",
        status: "pending",
      }),
    };
  };

  try {
    const created = await createAdminVehicle(
      "admin-token",
      "BUS-102",
      "Campus Shuttler",
      "http://test-server:8080"
    );
    assert.equal(capturedUrl, "http://test-server:8080/admin/vehicles");
    assert.equal(capturedBody.vehicle_id, "BUS-102");
    assert.equal(capturedBody.display_name, "Campus Shuttler");
    assert.equal(created.vehicle_id, "BUS-102");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("updateVehicleStatus sends PATCH to vehicle lifecycle endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let capturedMethod = "";
  let capturedUrl = "";
  let capturedBody = null;

  globalThis.fetch = async (url, options) => {
    capturedMethod = options.method;
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        vehicle_id: "BUS-101",
        status: "deactivated",
      }),
    };
  };

  try {
    const updated = await updateVehicleStatus(
      "admin-token",
      "BUS-101",
      "deactivated",
      "http://test-server:8080"
    );
    assert.equal(capturedMethod, "PATCH");
    assert.equal(capturedUrl, "http://test-server:8080/admin/vehicles/BUS-101");
    assert.equal(capturedBody.status, "deactivated");
    assert.equal(updated.status, "deactivated");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deleteAdminVehicle sends DELETE to vehicle endpoint and handles 204 No Content", async () => {
  const originalFetch = globalThis.fetch;
  let capturedMethod = "";
  let capturedUrl = "";
  let capturedAuth = "";

  globalThis.fetch = async (url, options) => {
    capturedMethod = options.method;
    capturedUrl = url;
    capturedAuth = options.headers?.Authorization;
    return {
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("No JSON body in 204");
      },
    };
  };

  try {
    const result = await deleteAdminVehicle(
      "admin-token",
      "BUS-101",
      "http://test-server:8080"
    );
    assert.equal(capturedMethod, "DELETE");
    assert.equal(capturedUrl, "http://test-server:8080/admin/vehicles/BUS-101");
    assert.equal(capturedAuth, "Bearer admin-token");
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assignVehicleRoute sends POST to route-assignments endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = null;

  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        vehicle_id: "BUS-101",
        route_id: "R02",
      }),
    };
  };

  try {
    const assigned = await assignVehicleRoute(
      "admin-token",
      "BUS-101",
      "R02",
      "http://test-server:8080"
    );
    assert.equal(capturedUrl, "http://test-server:8080/admin/vehicles/BUS-101/route-assignments");
    assert.equal(capturedBody.route_id, "R02");
    assert.equal(assigned.route_id, "R02");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("route CRUD methods format and send expected requests", async () => {
  const originalFetch = globalThis.fetch;

  // 1. fetchRoutes
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://test-server:8080/routes");
    return {
      ok: true,
      status: 200,
      json: async () => [{ route_id: "R01", route_name: "Loop", stops: [] }],
    };
  };
  const routes = await fetchRoutes("http://test-server:8080");
  assert.equal(routes.length, 1);

  // 2. createAdminRoute
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://test-server:8080/admin/routes");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.route_id, "R02");
    assert.equal(body.route_name, "Express");
    return {
      ok: true,
      status: 201,
      json: async () => ({ route_id: "R02", route_name: "Express", stops: [] }),
    };
  };
  const created = await createAdminRoute("admin-token", "R02", "Express", "http://test-server:8080");
  assert.equal(created.route_id, "R02");

  // 3. updateAdminRoute
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://test-server:8080/admin/routes/R02");
    assert.equal(options.method, "PUT");
    const body = JSON.parse(options.body);
    assert.equal(body.route_name, "Updated Express");
    return {
      ok: true,
      status: 200,
      json: async () => ({ route_id: "R02", route_name: "Updated Express", stops: [] }),
    };
  };
  const updated = await updateAdminRoute("admin-token", "R02", "Updated Express", "http://test-server:8080");
  assert.equal(updated.route_name, "Updated Express");

  // 4. deleteAdminRoute
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://test-server:8080/admin/routes/R02");
    assert.equal(options.method, "DELETE");
    return { ok: true, status: 204 };
  };
  const deleted = await deleteAdminRoute("admin-token", "R02", "http://test-server:8080");
  assert.equal(deleted, null);

  globalThis.fetch = originalFetch;
});

test("stop CRUD methods format and send expected requests", async () => {
  const originalFetch = globalThis.fetch;

  // 1. fetchRouteStops
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://test-server:8080/routes/R01/stops");
    return {
      ok: true,
      status: 200,
      json: async () => [
        { stop_id: "ST-01", stop_name: "Stop 1", latitude: 27.24, longitude: 77.84, sequence: 1 },
      ],
    };
  };
  const stops = await fetchRouteStops("R01", "http://test-server:8080");
  assert.equal(stops.length, 1);

  // 2. createAdminStop
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://test-server:8080/admin/routes/R01/stops");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.stop_id, "ST-02");
    assert.equal(body.latitude, 27.25);
    return {
      ok: true,
      status: 201,
      json: async () => ({ stop_id: "ST-02", stop_name: "Stop 2", latitude: 27.25, longitude: 77.85, sequence: 2 }),
    };
  };
  const createdStop = await createAdminStop(
    "admin-token",
    "R01",
    { stop_id: "ST-02", stop_name: "Stop 2", latitude: "27.25", longitude: "77.85", sequence: "2" },
    "http://test-server:8080"
  );
  assert.equal(createdStop.stop_id, "ST-02");

  // 3. updateAdminStop (for editing or reordering)
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://test-server:8080/admin/routes/R01/stops/ST-02");
    assert.equal(options.method, "PUT");
    const body = JSON.parse(options.body);
    assert.equal(body.sequence, 1);
    return {
      ok: true,
      status: 200,
      json: async () => ({ stop_id: "ST-02", stop_name: "Stop 2", latitude: 27.25, longitude: 77.85, sequence: 1 }),
    };
  };
  const updatedStop = await updateAdminStop(
    "admin-token",
    "R01",
    "ST-02",
    { stop_name: "Stop 2", latitude: 27.25, longitude: 77.85, sequence: 1 },
    "http://test-server:8080"
  );
  assert.equal(updatedStop.sequence, 1);

  // 4. deleteAdminStop
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://test-server:8080/admin/routes/R01/stops/ST-02");
    assert.equal(options.method, "DELETE");
    return { ok: true, status: 204 };
  };
  const deletedStop = await deleteAdminStop("admin-token", "R01", "ST-02", "http://test-server:8080");
  assert.equal(deletedStop, null);

  globalThis.fetch = originalFetch;
});

test("fetchVehicleDevices requests vehicle-scoped devices endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          device_id: "11111111-2222-3333-4444-555555555555",
          device_label: "Tablet 1",
          status: "active",
        },
      ],
    };
  };

  try {
    const devices = await fetchVehicleDevices(
      "admin-token",
      "BUS-101",
      "http://test-server:8080"
    );
    assert.equal(capturedUrl, "http://test-server:8080/admin/vehicles/BUS-101/devices");
    assert.equal(devices[0].device_label, "Tablet 1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createDeviceEnrollment sends POST with device_label and handles 409 Conflict", async () => {
  const originalFetch = globalThis.fetch;

  // Test successful enrollment
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).device_label, "Test Device");
    return {
      ok: true,
      status: 201,
      json: async () => ({
        device_id: "test-device-uuid",
        pairing_code: "PAIR1234",
        expires_at: "2026-10-08T12:10:00Z",
      }),
    };
  };

  try {
    const result = await createDeviceEnrollment(
      "admin-token",
      "BUS-101",
      "Test Device",
      "http://test-server:8080"
    );
    assert.equal(result.pairing_code, "PAIR1234");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Test 409 conflict
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    text: async () => "Device enrollment already pending",
  });

  try {
    await assert.rejects(
      async () => {
        await createDeviceEnrollment(
          "admin-token",
          "BUS-101",
          "Test Device",
          "http://test-server:8080"
        );
      },
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.isConflict, true);
        assert.equal(err.message, "Device enrollment already pending");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("revokeDevice sends POST to revoke endpoint and handles 204 No Content", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer admin-token");
    return {
      ok: true,
      status: 204,
    };
  };

  try {
    const result = await revokeDevice(
      "admin-token",
      "device-uuid-123",
      "http://test-server:8080"
    );
    assert.equal(capturedUrl, "http://test-server:8080/admin/devices/device-uuid-123/revoke");
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adminApi handles 401 Unauthorized by flagging error with isUnauthorized", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "Invalid admin token",
  });

  try {
    await assert.rejects(
      async () => {
        await fetchAdminVehicles("bad-token", "http://test-server:8080");
      },
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.isUnauthorized, true);
        assert.equal(err.message, "Invalid admin token");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

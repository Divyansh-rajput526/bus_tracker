import assert from "node:assert/strict";
import test from "node:test";

import {
  filterVehiclesByStatus,
  formatAdminError,
  formatDeviceExpiry,
  getDeviceStatusBadge,
  getVehicleDeviceRule,
  getVehicleStatusBadge,
  isDeviceExpired,
  isValidCoordinate,
} from "../src/adminPresentation.js";

test("isDeviceExpired correctly checks if a timestamp is in the past", () => {
  const baseTime = new Date("2026-10-08T12:00:00Z");
  const pastTime = new Date("2026-10-08T11:59:00Z");
  const futureTime = new Date("2026-10-08T12:10:00Z");

  assert.equal(isDeviceExpired(pastTime.toISOString(), baseTime), true);
  assert.equal(isDeviceExpired(futureTime.toISOString(), baseTime), false);
  assert.equal(isDeviceExpired(null, baseTime), false);
});

test("formatDeviceExpiry formats countdown for pending pairings and expired state", () => {
  const baseTime = new Date("2026-10-08T12:00:00Z");
  const futureTime = new Date("2026-10-08T12:08:30Z");
  const pastTime = new Date("2026-10-08T11:50:00Z");

  const formattedFuture = formatDeviceExpiry(futureTime.toISOString(), baseTime);
  assert.match(formattedFuture, /Expires in 8m 30s/);

  const formattedPast = formatDeviceExpiry(pastTime.toISOString(), baseTime);
  assert.match(formattedPast, /Expired at/);

  assert.equal(formatDeviceExpiry(null, baseTime), "No expiry set");
});

test("getDeviceStatusBadge accurately categorizes active, pending, expired, and revoked devices", () => {
  const now = new Date("2026-10-08T12:00:00Z");

  const active = getDeviceStatusBadge({ status: "active" }, now);
  assert.equal(active.label, "Active");
  assert.equal(active.color, "#28a745");

  const pendingValid = getDeviceStatusBadge(
    { status: "pending", pairing_expires_at: "2026-10-08T12:10:00Z" },
    now
  );
  assert.equal(pendingValid.label, "Pending Claim");

  const pendingExpired = getDeviceStatusBadge(
    { status: "pending", pairing_expires_at: "2026-10-08T11:59:00Z" },
    now
  );
  assert.equal(pendingExpired.label, "Expired Pairing");

  const revoked = getDeviceStatusBadge({ status: "revoked" }, now);
  assert.equal(revoked.label, "Revoked");
});

test("getVehicleStatusBadge returns appropriate badge for vehicle states", () => {
  assert.equal(getVehicleStatusBadge("active").label, "Active");
  assert.equal(getVehicleStatusBadge("pending").label, "Pending");
  assert.equal(getVehicleStatusBadge("deactivated").label, "Deactivated");
  assert.equal(getVehicleStatusBadge("retired").label, "Retired");
});

test("isValidCoordinate validates geographic coordinates within acceptable bounds", () => {
  assert.equal(isValidCoordinate(27.24, 77.84), true);
  assert.equal(isValidCoordinate(-90.0, -180.0), true);
  assert.equal(isValidCoordinate(90.0, 180.0), true);
  assert.equal(isValidCoordinate(0, 0), true);

  assert.equal(isValidCoordinate(90.01, 77.84), false);
  assert.equal(isValidCoordinate(-90.01, 77.84), false);
  assert.equal(isValidCoordinate(27.24, 180.01), false);
  assert.equal(isValidCoordinate(27.24, -180.01), false);
  assert.equal(isValidCoordinate(NaN, 77.84), false);
  assert.equal(isValidCoordinate(27.24, Infinity), false);
  assert.equal(isValidCoordinate("", ""), false);
});

test("getVehicleDeviceRule enforces one active or pending device rule per vehicle independently", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const vehicle1 = { vehicle_id: "BUS-101", status: "active" };
  const vehicle2 = { vehicle_id: "BUS-102", status: "active" };

  const vehicle1Devices = [
    { device_id: "d1", device_label: "Device A", status: "active" },
  ];
  const vehicle2Devices = [];

  // Vehicle 1 already has active device -> cannot enroll
  const ruleVehicle1 = getVehicleDeviceRule(vehicle1, vehicle1Devices, now);
  assert.equal(ruleVehicle1.canEnroll, false);
  assert.equal(ruleVehicle1.reason, "active_exists");

  // Vehicle 2 has NO active device -> CAN enroll independently!
  const ruleVehicle2 = getVehicleDeviceRule(vehicle2, vehicle2Devices, now);
  assert.equal(ruleVehicle2.canEnroll, true);

  // Cannot enroll when pending device exists
  const ruleWithPending = getVehicleDeviceRule(
    vehicle2,
    [
      {
        device_id: "d2",
        device_label: "Device B",
        status: "pending",
        pairing_expires_at: "2026-10-08T12:10:00Z",
      },
    ],
    now
  );
  assert.equal(ruleWithPending.canEnroll, false);
  assert.equal(ruleWithPending.reason, "pending_exists");

  // Can enroll if previous pending device is already expired
  const ruleWithExpiredPending = getVehicleDeviceRule(
    vehicle2,
    [
      {
        device_id: "d3",
        device_label: "Device C",
        status: "pending",
        pairing_expires_at: "2026-10-08T11:50:00Z",
      },
    ],
    now
  );
  assert.equal(ruleWithExpiredPending.canEnroll, true);

  // Can enroll if previous devices are all revoked
  const ruleWithRevoked = getVehicleDeviceRule(
    vehicle2,
    [{ device_id: "d4", device_label: "Old Device", status: "revoked" }],
    now
  );
  assert.equal(ruleWithRevoked.canEnroll, true);

  // Cannot enroll if vehicle is deactivated or retired
  const deactivatedVehicle = { vehicle_id: "BUS-999", status: "deactivated" };
  const ruleDeactivated = getVehicleDeviceRule(deactivatedVehicle, [], now);
  assert.equal(ruleDeactivated.canEnroll, false);
  assert.equal(ruleDeactivated.reason, "vehicle_inactive");

  const retiredVehicle = { vehicle_id: "BUS-888", status: "retired" };
  const ruleRetired = getVehicleDeviceRule(retiredVehicle, [], now);
  assert.equal(ruleRetired.canEnroll, false);
  assert.equal(ruleRetired.reason, "vehicle_inactive");
});

test("formatAdminError presents clear user-facing messages for vehicles, routes, and stops", () => {
  const unauthorizedError = { status: 401, isUnauthorized: true };
  assert.match(formatAdminError(unauthorizedError), /Unauthorized: Invalid or expired admin token/);

  const conflictPendingError = {
    status: 409,
    isConflict: true,
    message: "Device enrollment already pending",
  };
  assert.match(formatAdminError(conflictPendingError), /Cannot enroll device: a device enrollment is already pending/);

  const vehicleExistsError = {
    status: 409,
    isConflict: true,
    message: "Vehicle already exists",
  };
  assert.match(formatAdminError(vehicleExistsError), /Cannot create vehicle: a vehicle with this ID already exists/);

  const routeExistsError = {
    status: 409,
    isConflict: true,
    message: "Route already exists",
  };
  assert.match(formatAdminError(routeExistsError), /Cannot create route: a route with this ID already exists/);

  const routeActiveVehiclesError = {
    status: 409,
    isConflict: true,
    message: "Cannot delete route with active vehicles",
  };
  assert.match(formatAdminError(routeActiveVehiclesError), /Cannot delete route: one or more active vehicles/);

  const stopCoordsError = {
    status: 400,
    message: "Invalid stop coordinates",
  };
  assert.match(formatAdminError(stopCoordsError), /Invalid stop coordinates/);

  const notFoundError = { status: 404, message: "Route does not exist" };
  assert.match(formatAdminError(notFoundError), /Route does not exist/);
});

test("filterVehiclesByStatus filters vehicles correctly by lifecycle status", () => {
  const sampleVehicles = [
    { vehicle_id: "BUS-1", status: "active" },
    { vehicle_id: "BUS-2", status: "deactivated" },
    { vehicle_id: "BUS-3", status: "retired" },
    { vehicle_id: "BUS-4", status: "pending" },
  ];

  // Default / active_deactivated hides retired vehicles and shows active, deactivated, and pending
  const defaultList = filterVehiclesByStatus(sampleVehicles, "active_deactivated");
  assert.equal(defaultList.length, 3);
  assert.deepEqual(
    defaultList.map((v) => v.vehicle_id),
    ["BUS-1", "BUS-2", "BUS-4"]
  );

  // All includes retired
  const allList = filterVehiclesByStatus(sampleVehicles, "all");
  assert.equal(allList.length, 4);

  // Active only
  const activeList = filterVehiclesByStatus(sampleVehicles, "active");
  assert.deepEqual(
    activeList.map((v) => v.vehicle_id),
    ["BUS-1"]
  );

  // Deactivated only
  const deactivatedList = filterVehiclesByStatus(sampleVehicles, "deactivated");
  assert.deepEqual(
    deactivatedList.map((v) => v.vehicle_id),
    ["BUS-2"]
  );

  // Retired only
  const retiredList = filterVehiclesByStatus(sampleVehicles, "retired");
  assert.deepEqual(
    retiredList.map((v) => v.vehicle_id),
    ["BUS-3"]
  );

  // Non-array input safety
  assert.deepEqual(filterVehiclesByStatus(null), []);
  assert.deepEqual(filterVehiclesByStatus(undefined), []);
});


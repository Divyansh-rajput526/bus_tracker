import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateApproximateEtaMinutes,
  formatVehicleSpeed,
  getDisplaySpeed,
} from "../src/vehiclePresentation.js";

test("active vehicles display their reported speed", () => {
  const speed = getDisplaySpeed("Active", 42.36);

  assert.equal(formatVehicleSpeed(speed), "42.4 km/h");
});

test("stale vehicles display zero speed", () => {
  const speed = getDisplaySpeed("Stale", 42.36);

  assert.equal(formatVehicleSpeed(speed), "0.0 km/h");
});

test("offline vehicles display zero speed", () => {
  const speed = getDisplaySpeed("Offline", 42.36);

  assert.equal(formatVehicleSpeed(speed), "0.0 km/h");
});

test("stale vehicles do not produce an ETA from their last reported speed", () => {
  const eta = calculateApproximateEtaMinutes(
    {
      latitude: 27.239337,
      longitude: 77.84,
      speed: 42.36,
    },
    {
      latitude: 27.25,
      longitude: 77.85,
    },
    "Stale"
  );

  assert.equal(eta, null);
});

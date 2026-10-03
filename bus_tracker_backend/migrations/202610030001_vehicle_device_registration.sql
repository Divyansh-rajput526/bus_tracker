ALTER TABLE vehicles
    ADD COLUMN vehicle_pk uuid DEFAULT gen_random_uuid(),
    ADD COLUMN status varchar(24) NOT NULL DEFAULT 'legacy_unverified',
    ADD COLUMN display_name varchar(128),
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN deactivated_at timestamptz;

ALTER TABLE vehicles ALTER COLUMN vehicle_pk SET NOT NULL;
ALTER TABLE vehicles
    ADD CONSTRAINT vehicles_vehicle_pk_key UNIQUE (vehicle_pk),
    ADD CONSTRAINT vehicles_status_check
        CHECK (status IN ('pending', 'active', 'deactivated', 'retired', 'legacy_unverified')),
    ADD CONSTRAINT vehicles_display_name_nonempty
        CHECK (display_name IS NULL OR length(btrim(display_name)) > 0);

ALTER TABLE vehicle_current_state ADD COLUMN vehicle_pk uuid;
UPDATE vehicle_current_state AS state
SET vehicle_pk = vehicle.vehicle_pk
FROM vehicles AS vehicle
WHERE vehicle.vehicle_id = state.vehicle_id;
ALTER TABLE vehicle_current_state ALTER COLUMN vehicle_pk SET NOT NULL;
ALTER TABLE vehicle_current_state
    ADD CONSTRAINT vehicle_current_state_vehicle_pk_fkey
        FOREIGN KEY (vehicle_pk) REFERENCES vehicles(vehicle_pk),
    ADD COLUMN last_device_pk uuid;

ALTER TABLE vehicle_telemetry ADD COLUMN vehicle_pk uuid;
UPDATE vehicle_telemetry AS telemetry
SET vehicle_pk = vehicle.vehicle_pk
FROM vehicles AS vehicle
WHERE vehicle.vehicle_id = telemetry.vehicle_id;
ALTER TABLE vehicle_telemetry ALTER COLUMN vehicle_pk SET NOT NULL;
ALTER TABLE vehicle_telemetry
    ADD CONSTRAINT vehicle_telemetry_vehicle_pk_fkey
        FOREIGN KEY (vehicle_pk) REFERENCES vehicles(vehicle_pk),
    ADD COLUMN device_pk uuid;

ALTER TABLE vehicle_current_state
    DROP CONSTRAINT vehicle_current_state_vehicle_id_fkey,
    DROP CONSTRAINT vehicle_current_state_pkey,
    DROP COLUMN vehicle_id,
    ADD CONSTRAINT vehicle_current_state_pkey PRIMARY KEY (vehicle_pk);

ALTER TABLE vehicle_telemetry
    DROP CONSTRAINT vehicle_telemetry_vehicle_id_fkey,
    DROP COLUMN vehicle_id;

ALTER TABLE vehicles DROP CONSTRAINT vehicles_pkey;
ALTER TABLE vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (vehicle_pk),
    ADD CONSTRAINT vehicles_vehicle_id_key UNIQUE (vehicle_id);

CREATE TABLE tracking_devices (
    device_pk uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_pk uuid NOT NULL REFERENCES vehicles(vehicle_pk),
    device_label varchar(128) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'pending',
    pairing_code_hash bytea,
    pairing_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activated_at timestamptz,
    revoked_at timestamptz,
    last_seen_at timestamptz,
    CONSTRAINT tracking_devices_label_nonempty CHECK (length(btrim(device_label)) > 0),
    CONSTRAINT tracking_devices_status_check CHECK (status IN ('pending', 'active', 'revoked')),
    CONSTRAINT tracking_devices_pairing_hash_length
        CHECK (pairing_code_hash IS NULL OR octet_length(pairing_code_hash) = 32),
    CONSTRAINT tracking_devices_pairing_fields_check
        CHECK ((pairing_code_hash IS NULL) = (pairing_expires_at IS NULL))
);

ALTER TABLE vehicle_current_state
    ADD CONSTRAINT vehicle_current_state_last_device_fkey
        FOREIGN KEY (last_device_pk) REFERENCES tracking_devices(device_pk);
ALTER TABLE vehicle_telemetry
    ADD CONSTRAINT vehicle_telemetry_device_fkey
        FOREIGN KEY (device_pk) REFERENCES tracking_devices(device_pk);

CREATE UNIQUE INDEX tracking_devices_one_active_per_vehicle_idx
    ON tracking_devices (vehicle_pk)
    WHERE status = 'active';
CREATE UNIQUE INDEX tracking_devices_one_pending_per_vehicle_idx
    ON tracking_devices (vehicle_pk)
    WHERE status = 'pending';
CREATE INDEX tracking_devices_vehicle_idx ON tracking_devices (vehicle_pk, created_at DESC);
CREATE INDEX tracking_devices_pairing_hash_idx
    ON tracking_devices (pairing_code_hash)
    WHERE status = 'pending' AND pairing_code_hash IS NOT NULL;

CREATE TABLE device_credentials (
    credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_pk uuid NOT NULL REFERENCES tracking_devices(device_pk),
    secret_hash bytea NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz,
    revoked_at timestamptz,
    last_used_at timestamptz,
    CONSTRAINT device_credentials_hash_length CHECK (octet_length(secret_hash) = 32),
    CONSTRAINT device_credentials_expiry_check
        CHECK (expires_at IS NULL OR expires_at > issued_at)
);

CREATE UNIQUE INDEX device_credentials_one_live_per_device_idx
    ON device_credentials (device_pk)
    WHERE revoked_at IS NULL;
CREATE INDEX device_credentials_device_idx ON device_credentials (device_pk);

CREATE TABLE vehicle_route_assignments (
    assignment_pk bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_pk uuid NOT NULL REFERENCES vehicles(vehicle_pk),
    route_pk bigint NOT NULL REFERENCES routes(route_pk),
    assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    assigned_by varchar(128),
    CONSTRAINT vehicle_route_assignment_time_check
        CHECK (ended_at IS NULL OR ended_at > assigned_at)
);

CREATE UNIQUE INDEX vehicle_route_assignments_current_vehicle_idx
    ON vehicle_route_assignments (vehicle_pk)
    WHERE ended_at IS NULL;
CREATE INDEX vehicle_route_assignments_route_idx
    ON vehicle_route_assignments (route_pk, ended_at);

CREATE INDEX vehicle_current_state_active_idx
    ON vehicle_current_state (server_timestamp DESC, vehicle_pk);
CREATE INDEX vehicle_telemetry_vehicle_device_timestamp_idx
    ON vehicle_telemetry (vehicle_pk, device_timestamp DESC);
CREATE INDEX vehicle_telemetry_device_timestamp_idx
    ON vehicle_telemetry (device_timestamp DESC);
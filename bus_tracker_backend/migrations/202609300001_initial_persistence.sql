CREATE TABLE routes (
    route_pk bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id varchar(64) NOT NULL,
    route_name varchar(128) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CONSTRAINT routes_route_id_nonempty CHECK (length(btrim(route_id)) > 0),
    CONSTRAINT routes_route_name_nonempty CHECK (length(btrim(route_name)) > 0)
);

CREATE UNIQUE INDEX routes_active_route_id_idx
    ON routes (route_id)
    WHERE deleted_at IS NULL;

CREATE TABLE stops (
    route_pk bigint NOT NULL REFERENCES routes(route_pk),
    stop_id varchar(64) NOT NULL,
    stop_name varchar(128) NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    sequence integer NOT NULL,
    CONSTRAINT stops_pk PRIMARY KEY (route_pk, stop_id),
    CONSTRAINT stops_route_sequence_unique UNIQUE (route_pk, sequence)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT stops_stop_id_nonempty CHECK (length(btrim(stop_id)) > 0),
    CONSTRAINT stops_stop_name_nonempty CHECK (length(btrim(stop_name)) > 0),
    CONSTRAINT stops_latitude_range CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT stops_longitude_range CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT stops_sequence_positive CHECK (sequence > 0)
);

CREATE TABLE vehicles (
    vehicle_id varchar(64) PRIMARY KEY,
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT vehicles_vehicle_id_nonempty CHECK (length(btrim(vehicle_id)) > 0)
);

CREATE TABLE vehicle_current_state (
    vehicle_id varchar(64) PRIMARY KEY REFERENCES vehicles(vehicle_id),
    route_pk bigint NOT NULL REFERENCES routes(route_pk),
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    speed_kmh double precision NOT NULL,
    device_timestamp timestamptz NOT NULL,
    server_timestamp timestamptz NOT NULL,
    CONSTRAINT current_state_latitude_range CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT current_state_longitude_range CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT current_state_speed_nonnegative CHECK (speed_kmh >= 0)
);

CREATE INDEX vehicle_current_state_route_idx
    ON vehicle_current_state (route_pk, server_timestamp DESC);
CREATE INDEX vehicle_current_state_active_idx
    ON vehicle_current_state (server_timestamp DESC, vehicle_id);

CREATE TABLE vehicle_telemetry (
    telemetry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id varchar(64) NOT NULL REFERENCES vehicles(vehicle_id),
    route_pk bigint NOT NULL REFERENCES routes(route_pk),
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    speed_kmh double precision NOT NULL,
    device_timestamp timestamptz NOT NULL,
    server_timestamp timestamptz NOT NULL,
    CONSTRAINT telemetry_latitude_range CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT telemetry_longitude_range CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT telemetry_speed_nonnegative CHECK (speed_kmh >= 0)
);

CREATE INDEX vehicle_telemetry_vehicle_device_time_idx
    ON vehicle_telemetry (vehicle_id, device_timestamp DESC);
CREATE INDEX vehicle_telemetry_route_server_time_idx
    ON vehicle_telemetry (route_pk, server_timestamp DESC);
CREATE INDEX vehicle_telemetry_device_time_idx
    ON vehicle_telemetry (device_timestamp DESC);
CREATE INDEX vehicle_telemetry_server_time_idx
    ON vehicle_telemetry (server_timestamp DESC);

INSERT INTO routes (route_id, route_name)
VALUES ('R01', 'Route 01'), ('R02', 'Route 02')
ON CONFLICT (route_id) WHERE deleted_at IS NULL DO NOTHING;

INSERT INTO stops (route_pk, stop_id, stop_name, latitude, longitude, sequence)
SELECT routes.route_pk, seed.stop_id, seed.stop_name, seed.latitude, seed.longitude, seed.sequence
FROM routes
JOIN (VALUES
    ('R01', 'S01', 'Stop A', 27.239337::double precision, 77.840000::double precision, 1),
    ('R01', 'S02', 'Stop B', 27.244000::double precision, 77.845000::double precision, 2),
    ('R01', 'S03', 'Stop C', 27.249000::double precision, 77.850000::double precision, 3),
    ('R02', 'S04', 'Stop D', 27.235000::double precision, 77.835000::double precision, 1),
    ('R02', 'S05', 'Stop E', 27.230000::double precision, 77.840000::double precision, 2),
    ('R02', 'S06', 'Stop F', 27.225000::double precision, 77.845000::double precision, 3)
) AS seed(route_id, stop_id, stop_name, latitude, longitude, sequence)
    ON seed.route_id = routes.route_id
WHERE routes.deleted_at IS NULL
ON CONFLICT (route_pk, stop_id) DO NOTHING;
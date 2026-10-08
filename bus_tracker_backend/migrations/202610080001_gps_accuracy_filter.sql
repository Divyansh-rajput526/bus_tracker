ALTER TABLE vehicle_telemetry
    ADD COLUMN accuracy_meters double precision,
    ADD CONSTRAINT telemetry_accuracy_meters_check
        CHECK (accuracy_meters IS NULL OR accuracy_meters BETWEEN 0 AND 100000);

ALTER TABLE vehicle_current_state
    ADD COLUMN accuracy_meters double precision,
    ADD COLUMN movement_latitude double precision,
    ADD COLUMN movement_longitude double precision,
    ADD COLUMN movement_accuracy_meters double precision,
    ADD COLUMN movement_device_timestamp timestamptz;

UPDATE vehicle_current_state
SET movement_latitude = latitude,
    movement_longitude = longitude,
    movement_device_timestamp = device_timestamp;

ALTER TABLE vehicle_current_state
    ALTER COLUMN movement_latitude SET NOT NULL,
    ALTER COLUMN movement_longitude SET NOT NULL,
    ALTER COLUMN movement_device_timestamp SET NOT NULL,
    ADD CONSTRAINT current_state_accuracy_meters_check
        CHECK (accuracy_meters IS NULL OR accuracy_meters BETWEEN 0 AND 100000),
    ADD CONSTRAINT current_state_movement_accuracy_meters_check
        CHECK (movement_accuracy_meters IS NULL OR movement_accuracy_meters BETWEEN 0 AND 100000),
    ADD CONSTRAINT current_state_movement_latitude_range
        CHECK (movement_latitude BETWEEN -90 AND 90),
    ADD CONSTRAINT current_state_movement_longitude_range
        CHECK (movement_longitude BETWEEN -180 AND 180);

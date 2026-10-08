use super::*;
use sqlx::postgres::PgPoolOptions;

fn test_update(vehicle_id: &str, route_id: &str, timestamp: DateTime<Utc>) -> LocationUpdate {
    LocationUpdate {
        vehicle_id: vehicle_id.to_string(),
        route_id: route_id.to_string(),
        latitude: 27.24,
        longitude: 77.84,
        accuracy_meters: 5.0,
        device_timestamp: timestamp,
    }
}

fn location_update_at(
    route_id: &str,
    timestamp: DateTime<Utc>,
    latitude: f64,
    accuracy_meters: f64,
) -> LocationUpdate {
    LocationUpdate {
        vehicle_id: "BUS-1".to_string(),
        route_id: route_id.to_string(),
        latitude,
        longitude: 77.84,
        accuracy_meters,
        device_timestamp: timestamp,
    }
}

fn speed_state(
    route_id: &str,
    latest_latitude: f64,
    latest_accuracy_meters: Option<f64>,
    latest_timestamp: DateTime<Utc>,
    speed_kmh: f64,
    movement_latitude: f64,
    movement_accuracy_meters: Option<f64>,
    movement_timestamp: DateTime<Utc>,
) -> CurrentVehicleState {
    CurrentVehicleState {
        route_id: route_id.to_string(),
        latitude: latest_latitude,
        longitude: 77.84,
        accuracy_meters: latest_accuracy_meters,
        speed_kmh,
        device_timestamp: latest_timestamp,
        movement_latitude,
        movement_longitude: 77.84,
        movement_accuracy_meters,
        movement_device_timestamp: movement_timestamp,
    }
}

fn state_after_calculation(
    payload: &LocationUpdate,
    calculation: &SpeedCalculation,
) -> CurrentVehicleState {
    speed_state(
        &payload.route_id,
        payload.latitude,
        Some(payload.accuracy_meters),
        payload.device_timestamp,
        calculation.speed_kmh,
        calculation.movement_anchor.latitude,
        calculation.movement_anchor.accuracy_meters,
        calculation.movement_anchor.device_timestamp,
    )
}

async fn write_update(
    database: &Database,
    credential_id: Uuid,
    secret_hash: &[u8],
    payload: &LocationUpdate,
) -> Result<bool, LocationWriteError<(StatusCode, &'static str)>> {
    let vehicle_id = payload.vehicle_id.trim().to_uppercase();
    let route_id = payload.route_id.trim().to_uppercase();
    let server_timestamp = Utc::now();
    database
        .record_location(
            credential_id,
            secret_hash,
            &vehicle_id,
            &route_id,
            payload.latitude,
            payload.longitude,
            payload.accuracy_meters,
            payload.device_timestamp,
            server_timestamp,
            |previous| {
                validate_location_update(&vehicle_id, &route_id, payload, server_timestamp)?;
                calculate_speed(previous, &route_id, payload)
            },
        )
        .await
}

fn meters_to_latitude_degrees(meters: f64) -> f64 {
    meters / 111_195.0
}

#[test]
fn accuracy_aware_speed_filter_ignores_stationary_jitter() {
    let timestamp = Utc::now();
    let previous = speed_state(
        "R01",
        27.24,
        Some(5.0),
        timestamp,
        0.0,
        27.24,
        Some(5.0),
        timestamp,
    );
    let jittered = location_update_at(
        "R01",
        timestamp + chrono::Duration::seconds(5),
        27.24 + meters_to_latitude_degrees(4.0),
        5.0,
    );

    let calculation = calculate_speed(Some(&previous), "R01", &jittered)
        .unwrap()
        .unwrap();

    assert_eq!(calculation.speed_kmh, 0.0);
    assert_eq!(calculation.movement_anchor.latitude, 27.24);
    assert_eq!(calculation.movement_anchor.device_timestamp, timestamp);
}

#[test]
fn accuracy_aware_speed_filter_calculates_significant_movement() {
    let timestamp = Utc::now();
    let previous = speed_state(
        "R01",
        27.24,
        Some(5.0),
        timestamp,
        0.0,
        27.24,
        Some(5.0),
        timestamp,
    );
    let moved = location_update_at(
        "R01",
        timestamp + chrono::Duration::seconds(10),
        27.24 + meters_to_latitude_degrees(100.0),
        5.0,
    );

    let calculation = calculate_speed(Some(&previous), "R01", &moved)
        .unwrap()
        .unwrap();

    assert!((calculation.speed_kmh - 12.6).abs() < 0.2);
    assert_eq!(calculation.movement_anchor.latitude, moved.latitude);
    assert_eq!(
        calculation.movement_anchor.device_timestamp,
        moved.device_timestamp
    );
}

#[test]
fn slow_movement_accumulates_across_noisy_fixes() {
    let timestamp = Utc::now();
    let mut previous = speed_state(
        "R01",
        27.24,
        Some(5.0),
        timestamp,
        0.0,
        27.24,
        Some(5.0),
        timestamp,
    );
    let mut latest_calculation = None;

    for (seconds, distance_meters) in [(5, 5.0), (10, 10.0), (15, 15.0)] {
        let payload = location_update_at(
            "R01",
            timestamp + chrono::Duration::seconds(seconds),
            27.24 + meters_to_latitude_degrees(distance_meters),
            5.0,
        );
        let calculation = calculate_speed(Some(&previous), "R01", &payload)
            .unwrap()
            .unwrap();
        previous = state_after_calculation(&payload, &calculation);
        latest_calculation = Some(calculation);
    }

    let calculation = latest_calculation.unwrap();
    assert!(calculation.speed_kmh > 0.0);
    assert!((calculation.speed_kmh - 1.26).abs() < 0.2);
    assert_eq!(
        calculation.movement_anchor.device_timestamp,
        timestamp + chrono::Duration::seconds(15)
    );
}

#[test]
fn poor_accuracy_does_not_turn_noise_into_a_large_speed() {
    let timestamp = Utc::now();
    let previous = speed_state(
        "R01",
        27.24,
        Some(100.0),
        timestamp,
        0.0,
        27.24,
        Some(100.0),
        timestamp,
    );
    let noisy = location_update_at(
        "R01",
        timestamp + chrono::Duration::seconds(1),
        27.24 + meters_to_latitude_degrees(100.0),
        100.0,
    );

    let calculation = calculate_speed(Some(&previous), "R01", &noisy)
        .unwrap()
        .unwrap();

    assert_eq!(calculation.speed_kmh, 0.0);
    assert_eq!(calculation.movement_anchor.latitude, 27.24);
}

#[test]
fn route_change_resets_speed_and_movement_anchor() {
    let timestamp = Utc::now();
    let previous = speed_state(
        "R01",
        27.24,
        Some(5.0),
        timestamp,
        30.0,
        27.24,
        Some(5.0),
        timestamp,
    );
    let changed_route =
        location_update_at("R02", timestamp + chrono::Duration::seconds(5), 27.25, 5.0);

    let calculation = calculate_speed(Some(&previous), "R02", &changed_route)
        .unwrap()
        .unwrap();

    assert_eq!(calculation.speed_kmh, 0.0);
    assert_eq!(calculation.movement_anchor.latitude, changed_route.latitude);
    assert_eq!(
        calculation.movement_anchor.device_timestamp,
        changed_route.device_timestamp
    );
}

#[test]
fn speed_interval_safeguards_are_preserved() {
    let timestamp = Utc::now();
    let previous = speed_state(
        "R01",
        27.24,
        Some(5.0),
        timestamp,
        20.0,
        27.24,
        Some(5.0),
        timestamp,
    );
    let too_soon = location_update_at(
        "R01",
        timestamp + chrono::Duration::milliseconds(MIN_SPEED_INTERVAL_MILLISECONDS - 1),
        27.25,
        5.0,
    );
    let short_result = calculate_speed(Some(&previous), "R01", &too_soon)
        .unwrap()
        .unwrap();
    assert_eq!(short_result.speed_kmh, 20.0);
    assert_eq!(short_result.movement_anchor.latitude, 27.24);

    let too_late = location_update_at(
        "R01",
        timestamp + chrono::Duration::seconds(MAX_SPEED_INTERVAL_SECONDS + 1),
        27.25,
        5.0,
    );
    let long_result = calculate_speed(Some(&previous), "R01", &too_late)
        .unwrap()
        .unwrap();
    assert_eq!(long_result.speed_kmh, 0.0);
    assert_eq!(long_result.movement_anchor.latitude, too_late.latitude);

    let excessive_speed = location_update_at(
        "R01",
        timestamp + chrono::Duration::seconds(1),
        27.24 + meters_to_latitude_degrees(1000.0),
        1.0,
    );
    let excessive_result = calculate_speed(Some(&previous), "R01", &excessive_speed)
        .unwrap()
        .unwrap();
    assert_eq!(excessive_result.speed_kmh, 20.0);
    assert_eq!(
        excessive_result.movement_anchor.latitude,
        excessive_speed.latitude
    );
}

async fn issue_test_device(
    database: &Database,
    vehicle_id: &str,
    device_label: &str,
    expires_at: DateTime<Utc>,
) -> Result<(Uuid, Uuid, [u8; 32], [u8; 32]), StoreError> {
    let pairing_secret = generate_random_secret().expect("operating system RNG available");
    let pairing_hash = hash_secret(&pairing_secret);
    let device_id = database
        .create_device_enrollment(vehicle_id, device_label, &pairing_hash, expires_at)
        .await?;
    let credential_id = Uuid::new_v4();
    let credential_secret = generate_random_secret().expect("operating system RNG available");
    let credential_hash = hash_secret(&credential_secret);
    database
        .claim_device(&pairing_hash, credential_id, &credential_hash)
        .await?;
    Ok((device_id, credential_id, credential_secret, credential_hash))
}

fn device_credential_headers(credential_id: Uuid, secret: &[u8]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let token = format!("{credential_id}.{}", URL_SAFE_NO_PAD.encode(secret));
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    headers
}

#[test]
fn device_credential_parser_and_timestamp_validation() {
    let secret = [17_u8; 32];
    let credential_id = Uuid::new_v4();
    let token = format!("{credential_id}.{}", URL_SAFE_NO_PAD.encode(secret));
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    let (parsed_id, parsed_hash) = parse_device_credential(&headers).unwrap();
    assert_eq!(parsed_id, credential_id);
    assert_eq!(parsed_hash, hash_secret(&secret));

    headers.insert(header::AUTHORIZATION, "Bearer malformed".parse().unwrap());
    assert_eq!(
        parse_device_credential(&headers).unwrap_err().0,
        StatusCode::UNAUTHORIZED
    );

    let now = Utc::now();
    let valid = test_update("BUS-1", "R01", now);
    assert!(validate_location_update("BUS-1", "R01", &valid, now).is_ok());

    let future = test_update(
        "BUS-1",
        "R01",
        now + chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS + 1),
    );
    assert_eq!(
        validate_location_update("BUS-1", "R01", &future, now)
            .unwrap_err()
            .1,
        "Device timestamp is too far in the future"
    );

    let old = test_update(
        "BUS-1",
        "R01",
        now - chrono::Duration::seconds(MAX_PAST_DEVICE_TIMESTAMP_AGE_SECONDS + 1),
    );
    assert_eq!(
        validate_location_update("BUS-1", "R01", &old, now)
            .unwrap_err()
            .1,
        "Device timestamp is too old"
    );

    let invalid_coordinates = LocationUpdate {
        latitude: f64::NAN,
        ..valid.clone()
    };
    assert_eq!(
        validate_location_update("BUS-1", "R01", &invalid_coordinates, now)
            .unwrap_err()
            .1,
        "Invalid coordinates"
    );

    let invalid_accuracy = LocationUpdate {
        accuracy_meters: f64::NAN,
        ..valid.clone()
    };
    assert_eq!(
        validate_location_update("BUS-1", "R01", &invalid_accuracy, now)
            .unwrap_err()
            .1,
        "Invalid GPS accuracy"
    );

    for accuracy_meters in [-1.0, MAX_GPS_ACCURACY_METERS + 1.0, f64::INFINITY] {
        let invalid_accuracy = LocationUpdate {
            accuracy_meters,
            ..valid.clone()
        };
        assert_eq!(
            validate_location_update("BUS-1", "R01", &invalid_accuracy, now)
                .unwrap_err()
                .1,
            "Invalid GPS accuracy"
        );
    }

    let accepted_accuracy = serde_json::from_value::<LocationUpdate>(serde_json::json!({
        "vehicle_id": "BUS-1",
        "route_id": "R01",
        "latitude": 27.24,
        "longitude": 77.84,
        "accuracy_meters": 4.75,
        "device_timestamp": now,
    }))
    .unwrap();
    assert_eq!(accepted_accuracy.accuracy_meters, 4.75);
}

#[tokio::test]
async fn rate_limits_are_bounded_by_ip_and_category() {
    let limiter = RateLimiter::default();
    let ip = "192.0.2.10".parse().unwrap();
    assert!(limiter.allow(ip, "claim", 2).await);
    assert!(limiter.allow(ip, "claim", 2).await);
    assert!(!limiter.allow(ip, "claim", 2).await);
    assert!(limiter.allow(ip, "telemetry", 1).await);
    assert!(
        limiter
            .allow("192.0.2.11".parse().unwrap(), "claim", 1)
            .await
    );
}

#[test]
fn coordinate_validation_and_admin_auth_checks() {
    assert!(valid_coordinates(27.24, 77.84));
    assert!(valid_coordinates(-90.0, -180.0));
    assert!(valid_coordinates(90.0, 180.0));
    assert!(!valid_coordinates(90.01, 77.84));
    assert!(!valid_coordinates(-90.01, 77.84));
    assert!(!valid_coordinates(27.24, 180.01));
    assert!(!valid_coordinates(27.24, -180.01));
    assert!(!valid_coordinates(f64::NAN, 77.84));
    assert!(!valid_coordinates(27.24, f64::INFINITY));

    let headers = HeaderMap::new();
    let err = authorize_admin(&headers).unwrap_err();
    assert!(err.0 == StatusCode::INTERNAL_SERVER_ERROR || err.0 == StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL to name a disposable PostgreSQL database"]
async fn postgres_registration_authorization_and_telemetry_flow() {
    let database_url = std::env::var("TEST_DATABASE_URL")
        .expect("set TEST_DATABASE_URL to a disposable PostgreSQL database");
    let test_database_name = database_url.rsplit('/').next().unwrap_or_default();
    assert!(
        test_database_name.contains("test"),
        "TEST_DATABASE_URL must target a database whose name contains 'test'"
    );

    let database = Database::connect(&database_url)
        .await
        .expect("migrations apply to the disposable test database");
    let inspection_pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .unwrap();
    sqlx::query(
        "TRUNCATE vehicle_telemetry, vehicle_current_state, device_credentials,
                  tracking_devices, vehicle_route_assignments, vehicles
         RESTART IDENTITY CASCADE",
    )
    .execute(&inspection_pool)
    .await
    .unwrap();

    let vehicle = database
        .register_vehicle("TEST-BUS-1", Some("Test bus"))
        .await
        .unwrap();
    assert_eq!(vehicle.status, "pending");
    assert!(matches!(
        database.register_vehicle("TEST-BUS-1", None).await,
        Err(StoreError::Conflict)
    ));
    assert!(
        database
            .admin_vehicle("TEST-BUS-1")
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(database.admin_vehicles().await.unwrap().len(), 1);

    database
        .assign_route("TEST-BUS-1", "R01")
        .await
        .expect("pending vehicle can receive its route assignment before activation");

    let expired_pairing_secret = generate_random_secret().unwrap();
    let expired_pairing_hash = hash_secret(&expired_pairing_secret);
    database
        .create_device_enrollment(
            "TEST-BUS-1",
            "expired device",
            &expired_pairing_hash,
            Utc::now() - chrono::Duration::seconds(1),
        )
        .await
        .unwrap();
    assert!(matches!(
        database
            .claim_device(
                &expired_pairing_hash,
                Uuid::new_v4(),
                &hash_secret(b"unused"),
            )
            .await,
        Err(StoreError::PairingInvalid)
    ));

    let pairing_secret = generate_random_secret().unwrap();
    let pairing_hash = hash_secret(&pairing_secret);
    let device_id = database
        .create_device_enrollment(
            "TEST-BUS-1",
            "primary device",
            &pairing_hash,
            Utc::now() + chrono::Duration::minutes(10),
        )
        .await
        .unwrap();
    let credential_id = Uuid::new_v4();
    let credential_secret = generate_random_secret().unwrap();
    let credential_hash = hash_secret(&credential_secret);
    assert_eq!(
        database
            .claim_device(&pairing_hash, credential_id, &credential_hash)
            .await
            .unwrap(),
        device_id
    );
    assert!(matches!(
        database
            .claim_device(&pairing_hash, Uuid::new_v4(), &hash_secret(b"second claim"),)
            .await,
        Err(StoreError::PairingInvalid)
    ));
    database
        .update_vehicle("TEST-BUS-1", "active", None)
        .await
        .unwrap();

    let devices = database
        .vehicle_devices("TEST-BUS-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].device_id, device_id);
    assert_eq!(devices[0].device_label, "primary device");
    assert_eq!(devices[0].status, "active");

    let assignment = get_device_assignment(
        State(AppState {
            database: database.clone(),
            rate_limiter: RateLimiter::default(),
        }),
        device_credential_headers(credential_id, &credential_secret),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(
        serde_json::to_value(assignment).unwrap(),
        serde_json::json!({
            "device_id": device_id,
            "vehicle_id": "TEST-BUS-1",
            "route_id": "R01"
        })
    );
    assert_eq!(
        get_device_assignment(
            State(AppState {
                database: database.clone(),
                rate_limiter: RateLimiter::default(),
            }),
            device_credential_headers(Uuid::new_v4(), b"invalid credential"),
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::UNAUTHORIZED
    );

    database.register_vehicle("TEST-BUS-3", None).await.unwrap();
    let (unassigned_device_id, unassigned_credential_id, unassigned_secret, _) = issue_test_device(
        &database,
        "TEST-BUS-3",
        "unassigned device",
        Utc::now() + chrono::Duration::minutes(10),
    )
    .await
    .unwrap();
    database
        .update_vehicle("TEST-BUS-3", "active", None)
        .await
        .unwrap();

    let bus1_devices = database
        .vehicle_devices("TEST-BUS-1")
        .await
        .unwrap()
        .unwrap();
    let bus3_devices = database
        .vehicle_devices("TEST-BUS-3")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bus1_devices.len(), 1);
    assert_eq!(bus1_devices[0].device_id, device_id);
    assert_eq!(bus1_devices[0].status, "active");
    assert_eq!(bus3_devices.len(), 1);
    assert_eq!(bus3_devices[0].device_id, unassigned_device_id);
    assert_eq!(bus3_devices[0].status, "active");
    let assignment = get_device_assignment(
        State(AppState {
            database: database.clone(),
            rate_limiter: RateLimiter::default(),
        }),
        device_credential_headers(unassigned_credential_id, &unassigned_secret),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(
        serde_json::to_value(assignment).unwrap(),
        serde_json::json!({
            "device_id": unassigned_device_id,
            "vehicle_id": null,
            "route_id": null
        })
    );

    let first_timestamp = Utc::now();
    let first = test_update("TEST-BUS-1", "R01", first_timestamp);
    assert!(
        write_update(&database, credential_id, &credential_hash, &first)
            .await
            .unwrap()
    );
    assert!(
        !write_update(&database, credential_id, &credential_hash, &first)
            .await
            .unwrap()
    );

    let body_mismatch = test_update(
        "OTHER-BUS",
        "R01",
        first_timestamp + chrono::Duration::seconds(1),
    );
    assert!(matches!(
        write_update(&database, credential_id, &credential_hash, &body_mismatch).await,
        Err(LocationWriteError::Unauthorized)
    ));
    assert!(matches!(
        write_update(
            &database,
            Uuid::new_v4(),
            &hash_secret(b"unregistered credential"),
            &test_update(
                "TEST-BUS-1",
                "R01",
                first_timestamp + chrono::Duration::seconds(1)
            ),
        )
        .await,
        Err(LocationWriteError::Unauthorized)
    ));
    assert!(matches!(
        write_update(
            &database,
            credential_id,
            &credential_hash,
            &test_update(
                "TEST-BUS-1",
                "R02",
                first_timestamp + chrono::Duration::seconds(1)
            ),
        )
        .await,
        Err(LocationWriteError::RouteAssignmentMismatch)
    ));

    let mut stale = test_update(
        "TEST-BUS-1",
        "R01",
        first_timestamp - chrono::Duration::seconds(1),
    );
    assert!(matches!(
        write_update(&database, credential_id, &credential_hash, &stale).await,
        Err(LocationWriteError::Domain((
            StatusCode::BAD_REQUEST,
            "Device timestamp is older than previous update"
        )))
    ));
    stale.device_timestamp =
        Utc::now() + chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS + 1);
    assert!(matches!(
        write_update(&database, credential_id, &credential_hash, &stale).await,
        Err(LocationWriteError::Domain((
            StatusCode::BAD_REQUEST,
            "Device timestamp is too far in the future"
        )))
    ));

    database.assign_route("TEST-BUS-1", "R02").await.unwrap();
    let changed_route = test_update(
        "TEST-BUS-1",
        "R02",
        first_timestamp + chrono::Duration::seconds(2),
    );
    assert!(
        write_update(&database, credential_id, &credential_hash, &changed_route)
            .await
            .unwrap()
    );
    let locations = database.locations().await.unwrap();
    assert_eq!(locations[0].route_id, "R02");
    assert_eq!(locations[0].speed, 0.0);
    let (telemetry_accuracy, current_accuracy, movement_accuracy): (
        Option<f64>,
        Option<f64>,
        Option<f64>,
    ) = sqlx::query_as(
        "SELECT telemetry.accuracy_meters, state.accuracy_meters,
                state.movement_accuracy_meters
         FROM vehicle_telemetry AS telemetry
         JOIN vehicle_current_state AS state ON state.vehicle_pk = telemetry.vehicle_pk
         WHERE telemetry.vehicle_pk = (
             SELECT vehicle_pk FROM vehicles WHERE vehicle_id = 'TEST-BUS-1'
         )
         ORDER BY telemetry.telemetry_id DESC LIMIT 1",
    )
    .fetch_one(&inspection_pool)
    .await
    .unwrap();
    assert_eq!(telemetry_accuracy, Some(5.0));
    assert_eq!(current_accuracy, Some(5.0));
    assert_eq!(movement_accuracy, Some(5.0));

    let before_state: DateTime<Utc> = sqlx::query_scalar(
        "SELECT server_timestamp FROM vehicle_current_state
         WHERE vehicle_pk = (SELECT vehicle_pk FROM vehicles WHERE vehicle_id = 'TEST-BUS-1')",
    )
    .fetch_one(&inspection_pool)
    .await
    .unwrap();
    let before_count: i64 = sqlx::query_scalar("SELECT count(*) FROM vehicle_telemetry")
        .fetch_one(&inspection_pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE FUNCTION fail_test_telemetry_insert() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced telemetry failure'; END $$",
    )
    .execute(&inspection_pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER test_fail_telemetry_insert BEFORE INSERT ON vehicle_telemetry
         FOR EACH ROW EXECUTE FUNCTION fail_test_telemetry_insert()",
    )
    .execute(&inspection_pool)
    .await
    .unwrap();
    assert!(matches!(
        write_update(
            &database,
            credential_id,
            &credential_hash,
            &test_update(
                "TEST-BUS-1",
                "R02",
                first_timestamp + chrono::Duration::seconds(3),
            ),
        )
        .await,
        Err(LocationWriteError::Database(_))
    ));
    sqlx::query("DROP TRIGGER test_fail_telemetry_insert ON vehicle_telemetry")
        .execute(&inspection_pool)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION fail_test_telemetry_insert()")
        .execute(&inspection_pool)
        .await
        .unwrap();
    let after_state: DateTime<Utc> = sqlx::query_scalar(
        "SELECT server_timestamp FROM vehicle_current_state
         WHERE vehicle_pk = (SELECT vehicle_pk FROM vehicles WHERE vehicle_id = 'TEST-BUS-1')",
    )
    .fetch_one(&inspection_pool)
    .await
    .unwrap();
    let after_count: i64 = sqlx::query_scalar("SELECT count(*) FROM vehicle_telemetry")
        .fetch_one(&inspection_pool)
        .await
        .unwrap();
    assert_eq!(after_state, before_state);
    assert_eq!(after_count, before_count);

    database.revoke_device(device_id).await.unwrap();
    assert_eq!(
        get_device_assignment(
            State(AppState {
                database: database.clone(),
                rate_limiter: RateLimiter::default(),
            }),
            device_credential_headers(credential_id, &credential_secret),
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert!(matches!(
        write_update(
            &database,
            credential_id,
            &credential_hash,
            &test_update(
                "TEST-BUS-1",
                "R02",
                first_timestamp + chrono::Duration::seconds(4),
            ),
        )
        .await,
        Err(LocationWriteError::Unauthorized)
    ));

    database.register_vehicle("TEST-BUS-2", None).await.unwrap();
    database.assign_route("TEST-BUS-2", "R01").await.unwrap();
    let (_, inactive_credential_id, _, inactive_credential_hash) = issue_test_device(
        &database,
        "TEST-BUS-2",
        "inactive vehicle device",
        Utc::now() + chrono::Duration::minutes(10),
    )
    .await
    .unwrap();
    database
        .update_vehicle("TEST-BUS-2", "active", None)
        .await
        .unwrap();
    database
        .update_vehicle("TEST-BUS-2", "deactivated", None)
        .await
        .unwrap();
    assert!(matches!(
        write_update(
            &database,
            inactive_credential_id,
            &inactive_credential_hash,
            &test_update("TEST-BUS-2", "R01", Utc::now()),
        )
        .await,
        Err(LocationWriteError::Unauthorized)
    ));

    // Verify deletion of TEST-BUS-1 cleanly purges related data and does not impact TEST-BUS-2 or TEST-BUS-3
    database.delete_vehicle("TEST-BUS-1").await.unwrap();
    assert!(
        database
            .admin_vehicle("TEST-BUS-1")
            .await
            .unwrap()
            .is_none()
    );

    // Verify orphaned records count is 0 in all child tables
    let orphan_states: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vehicle_current_state WHERE vehicle_pk NOT IN (SELECT vehicle_pk FROM vehicles)",
    )
    .fetch_one(&inspection_pool)
    .await
    .unwrap();
    assert_eq!(orphan_states, 0);

    let orphan_telemetry: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vehicle_telemetry WHERE vehicle_pk NOT IN (SELECT vehicle_pk FROM vehicles)",
    )
    .fetch_one(&inspection_pool)
    .await
    .unwrap();
    assert_eq!(orphan_telemetry, 0);

    let orphan_assignments: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vehicle_route_assignments WHERE vehicle_pk NOT IN (SELECT vehicle_pk FROM vehicles)",
    )
    .fetch_one(&inspection_pool)
    .await
    .unwrap();
    assert_eq!(orphan_assignments, 0);

    let orphan_devices: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM tracking_devices WHERE vehicle_pk NOT IN (SELECT vehicle_pk FROM vehicles)",
    )
    .fetch_one(&inspection_pool)
    .await
    .unwrap();
    assert_eq!(orphan_devices, 0);

    let orphan_credentials: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM device_credentials WHERE device_pk NOT IN (SELECT device_pk FROM tracking_devices)",
    )
    .fetch_one(&inspection_pool)
    .await
    .unwrap();
    assert_eq!(orphan_credentials, 0);

    // Verify TEST-BUS-2 and TEST-BUS-3 are completely unaffected
    assert!(
        database
            .admin_vehicle("TEST-BUS-2")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        database
            .admin_vehicle("TEST-BUS-3")
            .await
            .unwrap()
            .is_some()
    );
    let bus3_devices = database
        .vehicle_devices("TEST-BUS-3")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bus3_devices.len(), 1);

    // Deleting a non-existent vehicle returns VehicleNotFound
    assert!(matches!(
        database.delete_vehicle("NON-EXISTENT-BUS").await,
        Err(StoreError::VehicleNotFound)
    ));

    // Retired vehicles remain deletable
    database
        .update_vehicle("TEST-BUS-2", "retired", None)
        .await
        .unwrap();
    database.delete_vehicle("TEST-BUS-2").await.unwrap();
    assert!(
        database
            .admin_vehicle("TEST-BUS-2")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        database
            .admin_vehicle("TEST-BUS-3")
            .await
            .unwrap()
            .is_some()
    );

    inspection_pool.close().await;
    database.close().await;
}

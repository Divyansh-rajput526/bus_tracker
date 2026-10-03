use super::*;
use sqlx::postgres::PgPoolOptions;

fn test_update(vehicle_id: &str, route_id: &str, timestamp: DateTime<Utc>) -> LocationUpdate {
    LocationUpdate {
        vehicle_id: vehicle_id.to_string(),
        route_id: route_id.to_string(),
        latitude: 27.24,
        longitude: 77.84,
        device_timestamp: timestamp,
    }
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
            payload.device_timestamp,
            server_timestamp,
            |previous| {
                validate_location_update(&vehicle_id, &route_id, payload, server_timestamp)?;
                calculate_speed(previous, &route_id, payload)
            },
        )
        .await
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
        ..valid
    };
    assert_eq!(
        validate_location_update("BUS-1", "R01", &invalid_coordinates, now)
            .unwrap_err()
            .1,
        "Invalid coordinates"
    );
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

    inspection_pool.close().await;
    database.close().await;
}

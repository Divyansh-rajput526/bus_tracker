use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    routing::{get, post, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

mod db;
use db::{
    AdminDevice, AdminVehicle, CurrentVehicleState, Database, DeviceCredentialError,
    LocationWriteError, StoreError,
};

#[cfg(test)]
mod tests;

// ========================================================
// Configuration / safety limits
// ========================================================

const MAX_ACTIVE_VEHICLES: usize = 10_000;
const MAX_FUTURE_CLOCK_SKEW_SECONDS: i64 = 30;
const MAX_PAST_DEVICE_TIMESTAMP_AGE_SECONDS: i64 = 24 * 60 * 60;
const MIN_SPEED_INTERVAL_MILLISECONDS: i64 = 250;
const MAX_SPEED_INTERVAL_SECONDS: i64 = 120;
const MAX_REASONABLE_SPEED_KMH: f64 = 180.0;
const SPEED_SMOOTHING_ALPHA: f64 = 0.35;
// A reported uncertainty radius above 100 km is unusable for vehicle telemetry.
const MAX_GPS_ACCURACY_METERS: f64 = 100_000.0;
// Require movement to exceed twice the root-sum-square of both uncertainty radii.
const GPS_UNCERTAINTY_MULTIPLIER: f64 = 2.0;
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;

// ========================================================
// Incoming vehicle telemetry
// ========================================================

#[derive(Debug, Deserialize, Clone)]
struct LocationUpdate {
    vehicle_id: String,
    route_id: String,
    latitude: f64,
    longitude: f64,
    accuracy_meters: f64,

    // Time when the GPS measurement was taken.
    // Used for speed calculation only.
    device_timestamp: DateTime<Utc>,
}

// ========================================================
// Public vehicle data
// ========================================================

#[derive(Debug, Serialize, Clone)]
struct VehicleLocation {
    vehicle_id: String,
    route_id: String,
    latitude: f64,
    longitude: f64,

    // Calculated by the backend.
    // Speed is in km/h.
    speed: f64,

    // Server-authoritative timestamp.
    timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub(crate) struct MovementAnchor {
    pub(crate) latitude: f64,
    pub(crate) longitude: f64,
    pub(crate) accuracy_meters: Option<f64>,
    pub(crate) device_timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub(crate) struct SpeedCalculation {
    pub(crate) speed_kmh: f64,
    pub(crate) movement_anchor: MovementAnchor,
}

// ========================================================
// Stop
// ========================================================

#[derive(Debug, Serialize, Clone)]
struct Stop {
    stop_id: String,
    stop_name: String,
    latitude: f64,
    longitude: f64,
    sequence: u32,
}

// ========================================================
// Route
// ========================================================

#[derive(Debug, Serialize, Clone)]
struct Route {
    route_id: String,
    route_name: String,
    stops: Vec<Stop>,
}

// ========================================================
// Admin request structures
// ========================================================

#[derive(Debug, Deserialize)]
struct CreateRouteRequest {
    route_id: String,
    route_name: String,
}

#[derive(Debug, Deserialize)]
struct UpdateRouteRequest {
    route_name: String,
}

#[derive(Debug, Deserialize)]
struct CreateStopRequest {
    stop_id: String,
    stop_name: String,
    latitude: f64,
    longitude: f64,
    sequence: u32,
}

#[derive(Debug, Deserialize)]
struct UpdateStopRequest {
    stop_name: String,
    latitude: f64,
    longitude: f64,
    sequence: u32,
}

#[derive(Debug, Deserialize)]
struct CreateVehicleRequest {
    vehicle_id: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateVehicleRequest {
    status: String,
}

#[derive(Debug, Deserialize)]
struct AssignRouteRequest {
    route_id: String,
}

#[derive(Debug, Deserialize)]
struct CreateDeviceRequest {
    device_label: String,
}

#[derive(Debug, Deserialize)]
struct ClaimDeviceRequest {
    pairing_code: String,
}

#[derive(Debug, Serialize)]
struct DeviceEnrollmentResponse {
    device_id: Uuid,
    pairing_code: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct DeviceClaimResponse {
    device_id: Uuid,
    credential_id: Uuid,
    credential: String,
}

// ========================================================
// Application state
// ========================================================

#[derive(Clone)]
struct AppState {
    database: Database,
    rate_limiter: RateLimiter,
}

#[derive(Clone, Default)]
struct RateLimiter {
    buckets: Arc<Mutex<HashMap<(IpAddr, &'static str), RateWindow>>>,
}

struct RateWindow {
    started_at: Instant,
    requests: u32,
}

impl RateLimiter {
    async fn allow(&self, remote_ip: IpAddr, category: &'static str, limit: u32) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().await;
        buckets.retain(|_, bucket| now.duration_since(bucket.started_at) < Duration::from_secs(60));
        let key = (remote_ip, category);
        if !buckets.contains_key(&key) && buckets.len() >= 10_000 {
            return false;
        }
        let bucket = buckets.entry(key).or_insert(RateWindow {
            started_at: now,
            requests: 0,
        });
        if now.duration_since(bucket.started_at) >= Duration::from_secs(60) {
            bucket.started_at = now;
            bucket.requests = 0;
        }
        if bucket.requests >= limit {
            return false;
        }
        bucket.requests += 1;
        true
    }
}

// ========================================================
// Main
// ========================================================

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL")?;
    let database = Database::connect(&database_url).await?;
    let state = AppState {
        database,
        rate_limiter: RateLimiter::default(),
    };

    // ----------------------------------------------------
    // Build router
    // ----------------------------------------------------

    let app = Router::new()
        // ============================
        // Public vehicle endpoints
        // ============================
        .route("/update-location", post(update_location))
        .route("/get-locations", get(get_locations))
        // ============================
        // Public route endpoints
        // ============================
        .route("/routes", get(get_routes))
        .route("/routes/{route_id}/stops", get(get_route_stops))
        // ============================
        // Admin route endpoints
        // ============================
        .route("/admin/routes", post(create_route))
        .route(
            "/admin/routes/{route_id}",
            put(update_route).delete(delete_route),
        )
        .route("/admin/vehicles", get(get_vehicles).post(create_vehicle))
        .route(
            "/admin/vehicles/{vehicle_id}",
            get(get_vehicle)
                .patch(update_vehicle)
                .delete(delete_vehicle),
        )
        .route(
            "/admin/vehicles/{vehicle_id}/devices",
            get(get_vehicle_devices).post(create_device_enrollment),
        )
        .route(
            "/admin/vehicles/{vehicle_id}/route-assignments",
            post(assign_vehicle_route),
        )
        .route("/admin/devices/{device_id}/revoke", post(revoke_device))
        .route("/devices/claim", post(claim_device))
        .route("/devices/assignment", get(get_device_assignment))
        // ============================
        // Admin stop endpoints
        // ============================
        .route("/admin/routes/{route_id}/stops", post(create_stop))
        .route(
            "/admin/routes/{route_id}/stops/{stop_id}",
            put(update_stop).delete(delete_stop),
        )
        // Keep request bodies appropriately small.
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        // Restrict browser access to the local frontend by default.
        // Set FRONTEND_ORIGIN for another trusted frontend origin.
        .layer(build_cors_layer())
        .with_state(state);

    // ----------------------------------------------------
    // Start server
    // ----------------------------------------------------

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;

    println!("🚀 Server running on http://localhost:8080");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

// ========================================================
// Vehicle location handler
// ========================================================

async fn update_location(
    State(state): State<AppState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LocationUpdate>,
) -> Result<&'static str, (StatusCode, &'static str)> {
    if !state
        .rate_limiter
        .allow(remote.ip(), "telemetry", 120)
        .await
    {
        return Err((StatusCode::TOO_MANY_REQUESTS, "Too many requests"));
    }
    let (credential_id, secret_hash) = parse_device_credential(&headers)?;
    let vehicle_id = payload.vehicle_id.trim().to_uppercase();
    let route_id = payload.route_id.trim().to_uppercase();
    let server_timestamp = Utc::now();

    match state
        .database
        .record_location(
            credential_id,
            &secret_hash,
            &vehicle_id,
            &route_id,
            payload.latitude,
            payload.longitude,
            payload.accuracy_meters,
            payload.device_timestamp,
            server_timestamp,
            |previous| {
                validate_location_update(&vehicle_id, &route_id, &payload, server_timestamp)?;
                calculate_speed(previous, &route_id, &payload)
            },
        )
        .await
    {
        Ok(true) => Ok("Location updated"),
        Ok(false) => Ok("Duplicate update ignored"),
        Err(LocationWriteError::Domain(error)) => Err(error),
        Err(LocationWriteError::Unauthorized) => {
            Err((StatusCode::UNAUTHORIZED, "Invalid device credentials"))
        }
        Err(LocationWriteError::RouteAssignmentMismatch) => Err((
            StatusCode::FORBIDDEN,
            "Vehicle is not assigned to this route",
        )),
        Err(LocationWriteError::Capacity) => Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Active vehicle limit reached",
        )),
        Err(LocationWriteError::Database(error)) => {
            eprintln!("Location persistence failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
    }
}

fn validate_location_update(
    vehicle_id: &str,
    route_id: &str,
    payload: &LocationUpdate,
    server_timestamp: DateTime<Utc>,
) -> Result<(), (StatusCode, &'static str)> {
    if vehicle_id.is_empty() || vehicle_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle ID"));
    }
    if route_id.is_empty() || route_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid route ID"));
    }
    if !payload.latitude.is_finite()
        || !payload.longitude.is_finite()
        || !(-90.0..=90.0).contains(&payload.latitude)
        || !(-180.0..=180.0).contains(&payload.longitude)
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid coordinates"));
    }
    if !payload.accuracy_meters.is_finite()
        || !(0.0..=MAX_GPS_ACCURACY_METERS).contains(&payload.accuracy_meters)
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid GPS accuracy"));
    }
    let latest_allowed_device_time =
        server_timestamp + chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS);
    if payload.device_timestamp > latest_allowed_device_time {
        return Err((
            StatusCode::BAD_REQUEST,
            "Device timestamp is too far in the future",
        ));
    }
    let earliest_allowed_device_time =
        server_timestamp - chrono::Duration::seconds(MAX_PAST_DEVICE_TIMESTAMP_AGE_SECONDS);
    if payload.device_timestamp < earliest_allowed_device_time {
        return Err((StatusCode::BAD_REQUEST, "Device timestamp is too old"));
    }
    Ok(())
}

fn calculate_speed(
    previous: Option<&CurrentVehicleState>,
    route_id: &str,
    payload: &LocationUpdate,
) -> Result<Option<SpeedCalculation>, (StatusCode, &'static str)> {
    let current_anchor = || MovementAnchor {
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracy_meters: Some(payload.accuracy_meters),
        device_timestamp: payload.device_timestamp,
    };
    let Some(previous) = previous else {
        return Ok(Some(SpeedCalculation {
            speed_kmh: 0.0,
            movement_anchor: current_anchor(),
        }));
    };

    if payload.device_timestamp == previous.device_timestamp {
        if previous.route_id == route_id
            && previous.latitude == payload.latitude
            && previous.longitude == payload.longitude
        {
            return Ok(None);
        }
        return Err((StatusCode::BAD_REQUEST, "Conflicting duplicate timestamp"));
    }

    if payload.device_timestamp < previous.device_timestamp {
        return Err((
            StatusCode::BAD_REQUEST,
            "Device timestamp is older than previous update",
        ));
    }

    if previous.route_id != route_id {
        return Ok(Some(SpeedCalculation {
            speed_kmh: 0.0,
            movement_anchor: current_anchor(),
        }));
    }

    let sample_elapsed_seconds = payload
        .device_timestamp
        .signed_duration_since(previous.device_timestamp);
    let sample_elapsed_seconds = sample_elapsed_seconds
        .to_std()
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid device timestamp interval"))?
        .as_secs_f64();

    if sample_elapsed_seconds <= 0.0 {
        return Err((StatusCode::BAD_REQUEST, "Invalid device timestamp interval"));
    }
    if sample_elapsed_seconds < (MIN_SPEED_INTERVAL_MILLISECONDS as f64 / 1000.0) {
        return Ok(Some(SpeedCalculation {
            speed_kmh: previous.speed_kmh,
            movement_anchor: previous.movement_anchor(),
        }));
    }

    let elapsed_seconds = payload
        .device_timestamp
        .signed_duration_since(previous.movement_device_timestamp)
        .to_std()
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid device timestamp interval"))?
        .as_secs_f64();
    if elapsed_seconds <= 0.0 {
        return Err((StatusCode::BAD_REQUEST, "Invalid device timestamp interval"));
    }
    if elapsed_seconds > MAX_SPEED_INTERVAL_SECONDS as f64 {
        return Ok(Some(SpeedCalculation {
            speed_kmh: 0.0,
            movement_anchor: current_anchor(),
        }));
    }

    let distance_km = haversine_distance_km(
        previous.movement_latitude,
        previous.movement_longitude,
        payload.latitude,
        payload.longitude,
    );
    let previous_accuracy = previous
        .movement_accuracy_meters
        .or(previous.accuracy_meters)
        .unwrap_or(payload.accuracy_meters);
    let combined_uncertainty_meters = GPS_UNCERTAINTY_MULTIPLIER
        * (previous_accuracy.powi(2) + payload.accuracy_meters.powi(2)).sqrt();
    let distance_meters = distance_km * 1000.0;
    if distance_meters <= combined_uncertainty_meters {
        return Ok(Some(SpeedCalculation {
            speed_kmh: previous.speed_kmh,
            movement_anchor: previous.movement_anchor(),
        }));
    }

    let raw_speed = distance_km / (elapsed_seconds / 3600.0);
    if !raw_speed.is_finite() {
        return Err((StatusCode::BAD_REQUEST, "Unable to calculate speed"));
    }
    if raw_speed > MAX_REASONABLE_SPEED_KMH {
        return Ok(Some(SpeedCalculation {
            speed_kmh: previous.speed_kmh,
            movement_anchor: current_anchor(),
        }));
    }

    Ok(Some(SpeedCalculation {
        speed_kmh: SPEED_SMOOTHING_ALPHA * raw_speed
            + (1.0 - SPEED_SMOOTHING_ALPHA) * previous.speed_kmh,
        movement_anchor: current_anchor(),
    }))
}

// ========================================================
// Get all active vehicles
// ========================================================

async fn get_locations(
    State(state): State<AppState>,
) -> Result<Json<Vec<VehicleLocation>>, StatusCode> {
    state.database.locations().await.map(Json).map_err(|error| {
        eprintln!("Location query failed: {error}");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

// ========================================================
// Get all routes
// ========================================================

async fn get_routes(State(state): State<AppState>) -> Result<Json<Vec<Route>>, StatusCode> {
    state.database.routes().await.map(Json).map_err(|error| {
        eprintln!("Route query failed: {error}");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

// ========================================================
// Get stops for a route
// ========================================================

async fn get_route_stops(
    State(state): State<AppState>,
    Path(route_id): Path<String>,
) -> Result<Json<Vec<Stop>>, StatusCode> {
    let normalized_route_id = route_id.trim().to_uppercase();

    state
        .database
        .route_stops(&normalized_route_id)
        .await
        .map_err(|error| {
            eprintln!("Stop query failed: {error}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn create_vehicle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateVehicleRequest>,
) -> Result<(StatusCode, Json<AdminVehicle>), (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    let vehicle_id = payload.vehicle_id.trim().to_uppercase();
    let display_name = payload.display_name.map(|name| name.trim().to_string());

    if vehicle_id.is_empty() || vehicle_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle ID"));
    }
    if display_name
        .as_ref()
        .is_some_and(|name| name.is_empty() || name.len() > 128)
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle name"));
    }
    let display_name = display_name.filter(|name| !name.is_empty());

    match state
        .database
        .register_vehicle(&vehicle_id, display_name.as_deref())
        .await
    {
        Ok(vehicle) => Ok((StatusCode::CREATED, Json(vehicle))),
        Err(StoreError::Conflict) => Err((StatusCode::CONFLICT, "Vehicle already exists")),
        Err(StoreError::Database(error)) => {
            eprintln!("Vehicle registration failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

async fn get_vehicles(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminVehicle>>, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    state
        .database
        .admin_vehicles()
        .await
        .map(Json)
        .map_err(|error| {
            eprintln!("Vehicle list query failed: {error}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error")
        })
}

async fn get_vehicle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(vehicle_id): Path<String>,
) -> Result<Json<AdminVehicle>, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    let vehicle_id = vehicle_id.trim().to_uppercase();
    match state.database.admin_vehicle(&vehicle_id).await {
        Ok(Some(vehicle)) => Ok(Json(vehicle)),
        Ok(None) => Err((StatusCode::NOT_FOUND, "Vehicle does not exist")),
        Err(error) => {
            eprintln!("Vehicle query failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
    }
}

async fn update_vehicle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(vehicle_id): Path<String>,
    Json(payload): Json<UpdateVehicleRequest>,
) -> Result<Json<AdminVehicle>, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    let vehicle_id = vehicle_id.trim().to_uppercase();
    let status = payload.status.trim().to_lowercase();
    if !matches!(
        status.as_str(),
        "pending" | "active" | "deactivated" | "retired"
    ) {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle status"));
    }

    match state
        .database
        .update_vehicle(&vehicle_id, &status, None)
        .await
    {
        Ok(vehicle) => Ok(Json(vehicle)),
        Err(StoreError::VehicleNotFound) => Err((StatusCode::NOT_FOUND, "Vehicle does not exist")),
        Err(StoreError::Database(error)) => {
            eprintln!("Vehicle update failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

async fn delete_vehicle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(vehicle_id): Path<String>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    let vehicle_id = vehicle_id.trim().to_uppercase();
    if vehicle_id.is_empty() || vehicle_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle ID"));
    }

    match state.database.delete_vehicle(&vehicle_id).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(StoreError::VehicleNotFound) => Err((StatusCode::NOT_FOUND, "Vehicle does not exist")),
        Err(StoreError::Database(error)) => {
            eprintln!("Vehicle deletion failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

async fn assign_vehicle_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(vehicle_id): Path<String>,
    Json(payload): Json<AssignRouteRequest>,
) -> Result<Json<AdminVehicle>, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    let vehicle_id = vehicle_id.trim().to_uppercase();
    let route_id = payload.route_id.trim().to_uppercase();
    if vehicle_id.is_empty() || vehicle_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle ID"));
    }
    if route_id.is_empty() || route_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid route ID"));
    }
    match state.database.assign_route(&vehicle_id, &route_id).await {
        Ok(()) => match state.database.admin_vehicle(&vehicle_id).await {
            Ok(Some(vehicle)) => Ok(Json(vehicle)),
            Ok(None) => Err((StatusCode::NOT_FOUND, "Vehicle does not exist")),
            Err(error) => {
                eprintln!("Vehicle assignment query failed: {error}");
                Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
            }
        },
        Err(StoreError::VehicleNotFound) => Err((StatusCode::NOT_FOUND, "Vehicle does not exist")),
        Err(StoreError::InvalidVehicleStatus) => Err((
            StatusCode::CONFLICT,
            "Vehicle is not available for assignment",
        )),
        Err(StoreError::RouteNotFound) => Err((StatusCode::NOT_FOUND, "Route does not exist")),
        Err(StoreError::Database(error)) => {
            eprintln!("Vehicle route assignment failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

async fn get_vehicle_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(vehicle_id): Path<String>,
) -> Result<Json<Vec<AdminDevice>>, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    let vehicle_id = vehicle_id.trim().to_uppercase();
    if vehicle_id.is_empty() || vehicle_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle ID"));
    }
    match state.database.vehicle_devices(&vehicle_id).await {
        Ok(Some(devices)) => Ok(Json(devices)),
        Ok(None) => Err((StatusCode::NOT_FOUND, "Vehicle does not exist")),
        Err(error) => {
            eprintln!("Vehicle devices query failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
    }
}

async fn create_device_enrollment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(vehicle_id): Path<String>,
    Json(payload): Json<CreateDeviceRequest>,
) -> Result<(StatusCode, Json<DeviceEnrollmentResponse>), (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    let vehicle_id = vehicle_id.trim().to_uppercase();
    let device_label = payload.device_label.trim();
    if vehicle_id.is_empty() || vehicle_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle ID"));
    }
    if device_label.is_empty() || device_label.len() > 128 {
        return Err((StatusCode::BAD_REQUEST, "Invalid device label"));
    }

    let pairing_bytes = generate_random_secret().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Credential generation failed",
        )
    })?;
    let pairing_code = URL_SAFE_NO_PAD.encode(pairing_bytes);
    let pairing_code_hash = hash_secret(&pairing_bytes);
    let expires_at = Utc::now() + chrono::Duration::minutes(10);
    let device_id = match state
        .database
        .create_device_enrollment(&vehicle_id, device_label, &pairing_code_hash, expires_at)
        .await
    {
        Ok(device_id) => device_id,
        Err(StoreError::VehicleNotFound) => {
            return Err((StatusCode::NOT_FOUND, "Vehicle does not exist"));
        }
        Err(StoreError::InvalidVehicleStatus) => {
            return Err((
                StatusCode::CONFLICT,
                "Vehicle is not available for enrollment",
            ));
        }
        Err(StoreError::DeviceAlreadyActive) => {
            return Err((StatusCode::CONFLICT, "Device enrollment already pending"));
        }
        Err(StoreError::Database(error)) => {
            eprintln!("Device enrollment failed: {error}");
            return Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"));
        }
        Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    };

    Ok((
        StatusCode::CREATED,
        Json(DeviceEnrollmentResponse {
            device_id,
            pairing_code,
            expires_at,
        }),
    ))
}

async fn claim_device(
    State(state): State<AppState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(payload): Json<ClaimDeviceRequest>,
) -> Result<Json<DeviceClaimResponse>, (StatusCode, &'static str)> {
    if !state
        .rate_limiter
        .allow(remote.ip(), "device_claim", 10)
        .await
    {
        return Err((StatusCode::TOO_MANY_REQUESTS, "Too many requests"));
    }
    let pairing_bytes = URL_SAFE_NO_PAD
        .decode(payload.pairing_code.trim())
        .ok()
        .filter(|bytes| bytes.len() == 32)
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid or expired pairing code"))?;
    let pairing_code_hash = hash_secret(&pairing_bytes);

    let secret_bytes = generate_random_secret().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Credential generation failed",
        )
    })?;
    let secret_hash = hash_secret(&secret_bytes);
    let credential_id = Uuid::new_v4();

    let device_id = match state
        .database
        .claim_device(&pairing_code_hash, credential_id, &secret_hash)
        .await
    {
        Ok(device_id) => device_id,
        Err(StoreError::PairingInvalid | StoreError::DeviceAlreadyActive) => {
            return Err((StatusCode::UNAUTHORIZED, "Invalid or expired pairing code"));
        }
        Err(StoreError::Database(error)) => {
            eprintln!("Device claim failed: {error}");
            return Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"));
        }
        Err(_) => return Err((StatusCode::UNAUTHORIZED, "Invalid or expired pairing code")),
    };

    Ok(Json(DeviceClaimResponse {
        device_id,
        credential_id,
        credential: format!("{credential_id}.{}", URL_SAFE_NO_PAD.encode(secret_bytes)),
    }))
}

async fn revoke_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;
    let device_id = Uuid::parse_str(&device_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "Device does not exist"))?;
    match state.database.revoke_device(device_id).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(StoreError::VehicleNotFound) => Err((StatusCode::NOT_FOUND, "Device does not exist")),
        Err(StoreError::Database(error)) => {
            eprintln!("Device revocation failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

fn generate_random_secret() -> Result<[u8; 32], rand::Error> {
    let mut bytes = [0; 32];
    OsRng.try_fill_bytes(&mut bytes)?;
    Ok(bytes)
}

fn hash_secret(secret: &[u8]) -> [u8; 32] {
    Sha256::digest(secret).into()
}

// ========================================================
// Admin: Create route
// ========================================================

async fn create_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateRouteRequest>,
) -> Result<(StatusCode, Json<Route>), (StatusCode, &'static str)> {
    authorize_admin(&headers)?;

    let route_id = payload.route_id.trim().to_uppercase();
    let route_name = payload.route_name.trim().to_string();

    if route_id.is_empty() || route_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid route ID"));
    }

    if route_name.is_empty() || route_name.len() > 128 {
        return Err((StatusCode::BAD_REQUEST, "Invalid route name"));
    }

    match state.database.create_route(&route_id, &route_name).await {
        Ok(route) => Ok((StatusCode::CREATED, Json(route))),
        Err(StoreError::Conflict) => Err((StatusCode::CONFLICT, "Route already exists")),
        Err(StoreError::Database(error)) => {
            eprintln!("Route creation failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

// ========================================================
// Admin: Update route
// ========================================================

async fn update_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(route_id): Path<String>,
    Json(payload): Json<UpdateRouteRequest>,
) -> Result<Json<Route>, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;

    let normalized_route_id = route_id.trim().to_uppercase();
    let route_name = payload.route_name.trim().to_string();

    if route_name.is_empty() || route_name.len() > 128 {
        return Err((StatusCode::BAD_REQUEST, "Invalid route name"));
    }

    match state
        .database
        .update_route(&normalized_route_id, &route_name)
        .await
    {
        Ok(route) => Ok(Json(route)),
        Err(StoreError::RouteNotFound) => Err((StatusCode::NOT_FOUND, "Route does not exist")),
        Err(StoreError::Database(error)) => {
            eprintln!("Route update failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

// ========================================================
// Admin: Delete route
// ========================================================

async fn delete_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(route_id): Path<String>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;

    let normalized_route_id = route_id.trim().to_uppercase();

    match state.database.delete_route(&normalized_route_id).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(StoreError::RouteNotFound) => Err((StatusCode::NOT_FOUND, "Route does not exist")),
        Err(StoreError::ActiveVehicles) => Err((
            StatusCode::CONFLICT,
            "Cannot delete route with active vehicles",
        )),
        Err(StoreError::Database(error)) => {
            eprintln!("Route deletion failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

// ========================================================
// Admin: Create stop
// ========================================================

async fn create_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(route_id): Path<String>,
    Json(payload): Json<CreateStopRequest>,
) -> Result<(StatusCode, Json<Stop>), (StatusCode, &'static str)> {
    authorize_admin(&headers)?;

    let normalized_route_id = route_id.trim().to_uppercase();
    let stop_id = payload.stop_id.trim().to_uppercase();
    let stop_name = payload.stop_name.trim().to_string();

    if normalized_route_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Invalid route ID"));
    }

    if stop_id.is_empty() || stop_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid stop ID"));
    }

    if stop_name.is_empty() || stop_name.len() > 128 {
        return Err((StatusCode::BAD_REQUEST, "Invalid stop name"));
    }

    if !valid_coordinates(payload.latitude, payload.longitude) {
        return Err((StatusCode::BAD_REQUEST, "Invalid stop coordinates"));
    }

    let stop = Stop {
        stop_id,
        stop_name,
        latitude: payload.latitude,
        longitude: payload.longitude,
        sequence: payload.sequence,
    };

    match state
        .database
        .create_stop(&normalized_route_id, &stop)
        .await
    {
        Ok(created_stop) => Ok((StatusCode::CREATED, Json(created_stop))),
        Err(StoreError::RouteNotFound) => Err((StatusCode::NOT_FOUND, "Route does not exist")),
        Err(StoreError::Conflict) => Err((StatusCode::CONFLICT, "Stop already exists")),
        Err(StoreError::InvalidSequence) => Err((
            StatusCode::BAD_REQUEST,
            "Sequence must be between 1 and the next available position",
        )),
        Err(StoreError::Database(error)) => {
            eprintln!("Stop creation failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

// ========================================================
// Admin: Update stop
// ========================================================

async fn update_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((route_id, stop_id)): Path<(String, String)>,
    Json(payload): Json<UpdateStopRequest>,
) -> Result<Json<Stop>, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;

    let normalized_route_id = route_id.trim().to_uppercase();
    let normalized_stop_id = stop_id.trim().to_uppercase();
    let stop_name = payload.stop_name.trim().to_string();

    if stop_name.is_empty() || stop_name.len() > 128 {
        return Err((StatusCode::BAD_REQUEST, "Invalid stop name"));
    }

    if !valid_coordinates(payload.latitude, payload.longitude) {
        return Err((StatusCode::BAD_REQUEST, "Invalid stop coordinates"));
    }

    let updated_stop = Stop {
        stop_id: normalized_stop_id.clone(),
        stop_name,
        latitude: payload.latitude,
        longitude: payload.longitude,
        sequence: payload.sequence,
    };
    match state
        .database
        .update_stop(&normalized_route_id, &normalized_stop_id, &updated_stop)
        .await
    {
        Ok(stop) => Ok(Json(stop)),
        Err(StoreError::RouteNotFound) => Err((StatusCode::NOT_FOUND, "Route does not exist")),
        Err(StoreError::StopNotFound) => Err((StatusCode::NOT_FOUND, "Stop does not exist")),
        Err(StoreError::InvalidSequence) => Err((
            StatusCode::BAD_REQUEST,
            "Sequence must be within the route stop range",
        )),
        Err(StoreError::Database(error)) => {
            eprintln!("Stop update failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

// ========================================================
// Admin: Delete stop
// ========================================================

async fn delete_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((route_id, stop_id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    authorize_admin(&headers)?;

    let normalized_route_id = route_id.trim().to_uppercase();
    let normalized_stop_id = stop_id.trim().to_uppercase();

    match state
        .database
        .delete_stop(&normalized_route_id, &normalized_stop_id)
        .await
    {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(StoreError::RouteNotFound) => Err((StatusCode::NOT_FOUND, "Route does not exist")),
        Err(StoreError::StopNotFound) => Err((StatusCode::NOT_FOUND, "Stop does not exist")),
        Err(StoreError::Database(error)) => {
            eprintln!("Stop deletion failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error")),
    }
}

async fn get_device_assignment(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<db::DeviceAssignment>, (StatusCode, &'static str)> {
    let (credential_id, secret_hash) = parse_device_credential(&headers)?;
    match state
        .database
        .device_assignment(credential_id, &secret_hash, Utc::now())
        .await
    {
        Ok(assignment) => Ok(Json(assignment)),
        Err(DeviceCredentialError::Unauthorized) => {
            Err((StatusCode::UNAUTHORIZED, "Invalid device credentials"))
        }
        Err(DeviceCredentialError::Database(error)) => {
            eprintln!("Device assignment query failed: {error}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
        }
    }
}

// ========================================================
// Helpers
// ========================================================

fn authorize_admin(headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
    let expected_token = std::env::var("ADMIN_TOKEN").map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "ADMIN_TOKEN is not configured",
        )
    })?;

    if expected_token.is_empty() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "ADMIN_TOKEN is not configured",
        ));
    }

    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing authorization"))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid authorization format"))?;

    if !constant_time_token_matches(&expected_token, token) {
        return Err((StatusCode::UNAUTHORIZED, "Invalid admin token"));
    }

    Ok(())
}

fn parse_device_credential(
    headers: &HeaderMap,
) -> Result<(Uuid, [u8; 32]), (StatusCode, &'static str)> {
    let invalid = (StatusCode::UNAUTHORIZED, "Invalid device credentials");
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(invalid)?;
    let (credential_id, secret) = token.split_once('.').ok_or(invalid)?;
    let credential_id = Uuid::parse_str(credential_id).map_err(|_| invalid)?;
    let secret = URL_SAFE_NO_PAD.decode(secret).map_err(|_| invalid)?;
    if secret.len() != 32 {
        return Err(invalid);
    }
    Ok((credential_id, hash_secret(&secret)))
}

fn build_cors_layer() -> CorsLayer {
    let configured_origins =
        std::env::var("FRONTEND_ORIGINS").or_else(|_| std::env::var("FRONTEND_ORIGIN"));

    let allowed_origins: Vec<HeaderValue> = match configured_origins {
        Ok(origins) => origins
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter_map(|value| HeaderValue::from_str(value).ok())
            .collect(),
        Err(_) => vec![HeaderValue::from_static("http://localhost:5173")],
    };

    CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

fn constant_time_token_matches(expected: &str, provided: &str) -> bool {
    let expected_bytes = expected.as_bytes();
    let provided_bytes = provided.as_bytes();
    let comparison_length = expected_bytes.len().max(provided_bytes.len());
    let mut difference = expected_bytes.len() ^ provided_bytes.len();

    for index in 0..comparison_length {
        let expected_byte = expected_bytes.get(index).copied().unwrap_or(0);
        let provided_byte = provided_bytes.get(index).copied().unwrap_or(0);
        difference |= usize::from(expected_byte ^ provided_byte);
    }

    difference == 0
}

fn valid_coordinates(latitude: f64, longitude: f64) -> bool {
    latitude.is_finite()
        && longitude.is_finite()
        && (-90.0..=90.0).contains(&latitude)
        && (-180.0..=180.0).contains(&longitude)
}

// ========================================================
// Haversine distance
// ========================================================

fn haversine_distance_km(latitude1: f64, longitude1: f64, latitude2: f64, longitude2: f64) -> f64 {
    const EARTH_RADIUS_KM: f64 = 6371.0;

    let lat1 = latitude1.to_radians();
    let lat2 = latitude2.to_radians();

    let delta_lat = (latitude2 - latitude1).to_radians();

    let delta_lon = (longitude2 - longitude1).to_radians();

    let a =
        (delta_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);

    let a = a.clamp(0.0, 1.0);

    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

    EARTH_RADIUS_KM * c
}

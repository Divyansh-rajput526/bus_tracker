use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    routing::{get, post, put},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

// ========================================================
// Configuration / safety limits
// ========================================================

const MAX_ACTIVE_VEHICLES: usize = 10_000;
const MAX_FUTURE_CLOCK_SKEW_SECONDS: i64 = 30;
const MIN_SPEED_INTERVAL_MILLISECONDS: i64 = 250;
const MAX_SPEED_INTERVAL_SECONDS: i64 = 120;
const MAX_REASONABLE_SPEED_KMH: f64 = 180.0;
const SPEED_SMOOTHING_ALPHA: f64 = 0.35;
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;

// ========================================================
// Incoming vehicle telemetry
// ========================================================

#[derive(Debug, Deserialize)]
struct LocationUpdate {
    vehicle_id: String,
    route_id: String,
    latitude: f64,
    longitude: f64,

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

// ========================================================
// Internal tracked vehicle state
// ========================================================

#[derive(Debug, Clone)]
struct VehicleState {
    current: VehicleLocation,
    device_timestamp: DateTime<Utc>,
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

// ========================================================
// Shared state
// ========================================================

// Async-aware lock so state access does not block Tokio worker threads.
type SharedVehicleState = Arc<RwLock<HashMap<String, VehicleState>>>;
type SharedRouteState = Arc<RwLock<HashMap<String, Route>>>;

// ========================================================
// Application state
// ========================================================

#[derive(Clone)]
struct AppState {
    vehicle_store: SharedVehicleState,
    route_store: SharedRouteState,
}

// ========================================================
// Main
// ========================================================

#[tokio::main]
async fn main() {
    let vehicle_store: SharedVehicleState = Arc::new(RwLock::new(HashMap::new()));

    // Sample routes are loaded initially.
    // Later these can be replaced by database-backed data.
    let route_store: SharedRouteState = Arc::new(RwLock::new(create_sample_routes()));

    let state = AppState {
        vehicle_store,
        route_store,
    };

    // ----------------------------------------------------
    // Background cleanup task
    // ----------------------------------------------------

    let cleanup_store = Arc::clone(&state.vehicle_store);

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));

        loop {
            interval.tick().await;

            let cutoff = Utc::now() - chrono::Duration::minutes(10);

            let mut lock = cleanup_store.write().await;

            let initial_count = lock.len();

            lock.retain(|_, vehicle| vehicle.current.timestamp > cutoff);

            let removed = initial_count - lock.len();

            if removed > 0 {
                println!("🧹 Pruned {removed} inactive vehicle(s) ");
            }
        }
    });

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

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();

    println!("🚀 Server running on http://localhost:8080");

    axum::serve(listener, app).await.unwrap();
}

// ========================================================
// Vehicle location handler
// ========================================================

async fn update_location(
    State(state): State<AppState>,
    Json(payload): Json<LocationUpdate>,
) -> Result<&'static str, (StatusCode, &'static str)> {
    let vehicle_id = payload.vehicle_id.trim().to_uppercase();

    let route_id = payload.route_id.trim().to_uppercase();

    // ----------------------------------------------------
    // Validate IDs
    // ----------------------------------------------------

    if vehicle_id.is_empty() || vehicle_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid vehicle ID"));
    }

    if route_id.is_empty() || route_id.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "Invalid route ID"));
    }

    // ----------------------------------------------------
    // Validate coordinates
    // ----------------------------------------------------

    if !payload.latitude.is_finite()
        || !payload.longitude.is_finite()
        || !(-90.0..=90.0).contains(&payload.latitude)
        || !(-180.0..=180.0).contains(&payload.longitude)
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid coordinates"));
    }

    // ----------------------------------------------------
    // Server-authoritative time + device clock guard
    // ----------------------------------------------------

    let server_timestamp = Utc::now();
    let latest_allowed_device_time =
        server_timestamp + chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS);

    if payload.device_timestamp > latest_allowed_device_time {
        return Err((
            StatusCode::BAD_REQUEST,
            "Device timestamp is too far in the future",
        ));
    }

    // ----------------------------------------------------
    // Lock order rule:
    // vehicle_store -> route_store
    //
    // Any operation that needs both stores follows the same
    // order. This prevents the route-validation/delete TOCTOU
    // race that existed when the stores were locked separately.
    // ----------------------------------------------------

    let mut vehicle_lock = state.vehicle_store.write().await;

    // Limit the number of distinct active vehicle IDs.
    if !vehicle_lock.contains_key(&vehicle_id) && vehicle_lock.len() >= MAX_ACTIVE_VEHICLES {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Active vehicle limit reached",
        ));
    }

    let route_lock = state.route_store.read().await;

    // The route cannot be deleted between this validation and
    // the vehicle insertion because update_location holds the
    // vehicle write lock and delete_route acquires vehicle read
    // before route write.
    if !route_lock.contains_key(&route_id) {
        return Err((StatusCode::BAD_REQUEST, "Route does not exist"));
    }

    let mut calculated_speed = 0.0;

    if let Some(previous) = vehicle_lock.get(&vehicle_id) {
        // Exact same timestamp + same measurement means a retry
        // of the same packet. Ignore it safely.
        if payload.device_timestamp == previous.device_timestamp {
            if previous.current.route_id == route_id
                && previous.current.latitude == payload.latitude
                && previous.current.longitude == payload.longitude
            {
                return Ok("Duplicate update ignored");
            }

            return Err((StatusCode::BAD_REQUEST, "Conflicting duplicate timestamp"));
        }

        // Older packets must never overwrite newer state.
        if payload.device_timestamp < previous.device_timestamp {
            return Err((
                StatusCode::BAD_REQUEST,
                "Device timestamp is older than previous update",
            ));
        }

        // ------------------------------------------------
        // Route changes reset the speed baseline.
        // ------------------------------------------------

        if previous.current.route_id != route_id {
            calculated_speed = 0.0;
        } else {
            let elapsed_duration = payload
                .device_timestamp
                .signed_duration_since(previous.device_timestamp);

            let elapsed_seconds = elapsed_duration
                .to_std()
                .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid device timestamp interval"))?
                .as_secs_f64();

            if elapsed_seconds <= 0.0 {
                return Err((StatusCode::BAD_REQUEST, "Invalid device timestamp interval"));
            }

            // If updates arrive too quickly for a meaningful
            // GPS-based speed estimate, keep the previous speed.
            if elapsed_seconds < (MIN_SPEED_INTERVAL_MILLISECONDS as f64 / 1000.0) {
                calculated_speed = previous.current.speed;
            }
            // A very large gap is treated as a new speed baseline.
            else if elapsed_seconds > MAX_SPEED_INTERVAL_SECONDS as f64 {
                calculated_speed = 0.0;
            } else {
                let distance_km = haversine_distance_km(
                    previous.current.latitude,
                    previous.current.longitude,
                    payload.latitude,
                    payload.longitude,
                );

                let elapsed_hours = elapsed_seconds / 3600.0;

                let raw_speed = distance_km / elapsed_hours;

                if !raw_speed.is_finite() {
                    return Err((StatusCode::BAD_REQUEST, "Unable to calculate speed"));
                }

                // GPS jitter can create impossible velocity spikes.
                // Keep the previous stable speed rather than storing
                // an implausible measurement.
                if raw_speed > MAX_REASONABLE_SPEED_KMH {
                    calculated_speed = previous.current.speed;
                } else {
                    // Light exponential smoothing reduces GPS noise
                    // without requiring a larger history buffer.
                    calculated_speed = SPEED_SMOOTHING_ALPHA * raw_speed
                        + (1.0 - SPEED_SMOOTHING_ALPHA) * previous.current.speed;
                }
            }
        }
    }

    drop(route_lock);

    // ----------------------------------------------------
    // Create public vehicle record
    // ----------------------------------------------------

    let record = VehicleLocation {
        vehicle_id: vehicle_id.clone(),
        route_id,
        latitude: payload.latitude,
        longitude: payload.longitude,
        speed: calculated_speed,
        timestamp: server_timestamp,
    };

    // ----------------------------------------------------
    // Store latest vehicle state
    // ----------------------------------------------------

    vehicle_lock.insert(
        vehicle_id,
        VehicleState {
            current: record,
            device_timestamp: payload.device_timestamp,
        },
    );

    Ok("Location updated")
}

// ========================================================
// Get all active vehicles
// ========================================================

async fn get_locations(
    State(state): State<AppState>,
) -> Result<Json<Vec<VehicleLocation>>, StatusCode> {
    let lock = state.vehicle_store.read().await;

    let mut vehicles: Vec<VehicleLocation> = lock
        .values()
        .map(|vehicle| vehicle.current.clone())
        .collect();

    vehicles.sort_by(|a, b| a.vehicle_id.cmp(&b.vehicle_id));

    Ok(Json(vehicles))
}

// ========================================================
// Get all routes
// ========================================================

async fn get_routes(State(state): State<AppState>) -> Result<Json<Vec<Route>>, StatusCode> {
    let lock = state.route_store.read().await;

    let mut routes: Vec<Route> = lock.values().cloned().collect();

    for route in &mut routes {
        route.stops.sort_by_key(|stop| stop.sequence);
    }

    routes.sort_by(|a, b| a.route_id.cmp(&b.route_id));

    Ok(Json(routes))
}

// ========================================================
// Get stops for a route
// ========================================================

async fn get_route_stops(
    State(state): State<AppState>,
    Path(route_id): Path<String>,
) -> Result<Json<Vec<Stop>>, StatusCode> {
    let normalized_route_id = route_id.trim().to_uppercase();

    let lock = state.route_store.read().await;

    match lock.get(&normalized_route_id) {
        Some(route) => {
            let mut stops = route.stops.clone();
            stops.sort_by_key(|stop| stop.sequence);
            Ok(Json(stops))
        }
        None => Err(StatusCode::NOT_FOUND),
    }
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

    let mut lock = state.route_store.write().await;

    if lock.contains_key(&route_id) {
        return Err((StatusCode::CONFLICT, "Route already exists"));
    }

    let route = Route {
        route_id: route_id.clone(),
        route_name,
        stops: Vec::new(),
    };

    lock.insert(route_id, route.clone());

    Ok((StatusCode::CREATED, Json(route)))
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

    let mut lock = state.route_store.write().await;

    let route = lock
        .get_mut(&normalized_route_id)
        .ok_or((StatusCode::NOT_FOUND, "Route does not exist"))?;

    route.route_name = route_name;

    Ok(Json(route.clone()))
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

    // Lock order: vehicle_store -> route_store.
    // This matches update_location.
    let vehicle_lock = state.vehicle_store.read().await;
    let mut route_lock = state.route_store.write().await;

    if !route_lock.contains_key(&normalized_route_id) {
        return Err((StatusCode::NOT_FOUND, "Route does not exist"));
    }

    let has_active_vehicle = vehicle_lock
        .values()
        .any(|vehicle| vehicle.current.route_id == normalized_route_id);

    if has_active_vehicle {
        return Err((
            StatusCode::CONFLICT,
            "Cannot delete route with active vehicles",
        ));
    }

    route_lock.remove(&normalized_route_id);

    Ok(StatusCode::NO_CONTENT)
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

    let mut lock = state.route_store.write().await;

    let route = lock
        .get_mut(&normalized_route_id)
        .ok_or((StatusCode::NOT_FOUND, "Route does not exist"))?;

    if route.stops.iter().any(|stop| stop.stop_id == stop_id) {
        return Err((StatusCode::CONFLICT, "Stop already exists"));
    }

    let next_sequence = route.stops.len() as u32 + 1;

    if payload.sequence == 0 || payload.sequence > next_sequence {
        return Err((
            StatusCode::BAD_REQUEST,
            "Sequence must be between 1 and the next available position",
        ));
    }

    let stop = Stop {
        stop_id,
        stop_name,
        latitude: payload.latitude,
        longitude: payload.longitude,
        sequence: payload.sequence,
    };

    let insert_index = (payload.sequence - 1) as usize;

    route.stops.insert(insert_index, stop.clone());
    normalize_stop_sequences(route);

    let created_stop = route.stops[insert_index].clone();

    Ok((StatusCode::CREATED, Json(created_stop)))
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

    let mut lock = state.route_store.write().await;

    let route = lock
        .get_mut(&normalized_route_id)
        .ok_or((StatusCode::NOT_FOUND, "Route does not exist"))?;

    let stop_index = route
        .stops
        .iter()
        .position(|stop| stop.stop_id == normalized_stop_id)
        .ok_or((StatusCode::NOT_FOUND, "Stop does not exist"))?;

    if payload.sequence == 0 || payload.sequence > route.stops.len() as u32 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Sequence must be within the route stop range",
        ));
    }

    // Remove the stop, update it, and insert it at the
    // requested position. This naturally shifts the other
    // stops and avoids sequence collisions.
    let mut stop = route.stops.remove(stop_index);

    stop.stop_name = stop_name;
    stop.latitude = payload.latitude;
    stop.longitude = payload.longitude;
    stop.sequence = payload.sequence;

    let insert_index = (payload.sequence - 1) as usize;

    route.stops.insert(insert_index, stop);
    normalize_stop_sequences(route);

    let updated_stop = route.stops[insert_index].clone();

    Ok(Json(updated_stop))
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

    let mut lock = state.route_store.write().await;

    let route = lock
        .get_mut(&normalized_route_id)
        .ok_or((StatusCode::NOT_FOUND, "Route does not exist"))?;

    let original_len = route.stops.len();

    route
        .stops
        .retain(|stop| stop.stop_id != normalized_stop_id);

    if route.stops.len() == original_len {
        return Err((StatusCode::NOT_FOUND, "Stop does not exist"));
    }

    // Close any sequence gap created by deletion.
    normalize_stop_sequences(route);

    Ok(StatusCode::NO_CONTENT)
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

    if token != expected_token {
        return Err((StatusCode::UNAUTHORIZED, "Invalid admin token"));
    }

    Ok(())
}

fn build_cors_layer() -> CorsLayer {
    let origin_string =
        std::env::var("FRONTEND_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".to_string());

    let origin = origin_string
        .parse::<HeaderValue>()
        .unwrap_or_else(|_| HeaderValue::from_static("http://localhost:5173"));

    CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

fn valid_coordinates(latitude: f64, longitude: f64) -> bool {
    latitude.is_finite()
        && longitude.is_finite()
        && (-90.0..=90.0).contains(&latitude)
        && (-180.0..=180.0).contains(&longitude)
}

fn normalize_stop_sequences(route: &mut Route) {
    route.stops.sort_by_key(|stop| stop.sequence);

    for (index, stop) in route.stops.iter_mut().enumerate() {
        stop.sequence = (index + 1) as u32;
    }
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

// ========================================================
// Sample route data
// ========================================================

fn create_sample_routes() -> HashMap<String, Route> {
    let mut routes = HashMap::new();

    let route_01 = Route {
        route_id: "R01".to_string(),
        route_name: "Route 01".to_string(),
        stops: vec![
            Stop {
                stop_id: "S01".to_string(),
                stop_name: "Stop A".to_string(),
                latitude: 27.239337,
                longitude: 77.840000,
                sequence: 1,
            },
            Stop {
                stop_id: "S02".to_string(),
                stop_name: "Stop B".to_string(),
                latitude: 27.244000,
                longitude: 77.845000,
                sequence: 2,
            },
            Stop {
                stop_id: "S03".to_string(),
                stop_name: "Stop C".to_string(),
                latitude: 27.249000,
                longitude: 77.850000,
                sequence: 3,
            },
        ],
    };

    let route_02 = Route {
        route_id: "R02".to_string(),
        route_name: "Route 02".to_string(),
        stops: vec![
            Stop {
                stop_id: "S04".to_string(),
                stop_name: "Stop D".to_string(),
                latitude: 27.235000,
                longitude: 77.835000,
                sequence: 1,
            },
            Stop {
                stop_id: "S05".to_string(),
                stop_name: "Stop E".to_string(),
                latitude: 27.230000,
                longitude: 77.840000,
                sequence: 2,
            },
            Stop {
                stop_id: "S06".to_string(),
                stop_name: "Stop F".to_string(),
                latitude: 27.225000,
                longitude: 77.845000,
                sequence: 3,
            },
        ],
    };

    routes.insert(route_01.route_id.clone(), route_01);

    routes.insert(route_02.route_id.clone(), route_02);

    routes
}

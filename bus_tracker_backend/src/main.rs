use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tower_http::cors::CorsLayer;

#[derive(Debug, Deserialize)]
struct LocationUpdate {
    bus_id: String,
    latitude: f64,
    longitude: f64,
    // speed in km/h
    speed: f64,
}

#[derive(Debug, Serialize, Clone)]
struct BusLocation {
    bus_id: String,
    latitude: f64,
    longitude: f64,
    // speed in km/h
    speed: f64,
    timestamp: DateTime<Utc>,
}

type SharedState = Arc<RwLock<HashMap<String, BusLocation>>>;

#[tokio::main]
async fn main() {
    let bus_store: SharedState = Arc::new(RwLock::new(HashMap::new()));

    // 1. Spawn background cleanup task
    let cleanup_store = Arc::clone(&bus_store);
    tokio::spawn(async move {
        // Runs every 30 seconds
        let mut interval = tokio::time::interval(Duration::from_secs(30));

        loop {
            interval.tick().await;

            let cutoff = Utc::now() - chrono::Duration::minutes(10);

            if let Ok(mut lock) = cleanup_store.write() {
                let initial_count = lock.len();
                // Retain only buses that sent updates after the cutoff time
                lock.retain(|_, bus| bus.timestamp > cutoff);
                let removed = initial_count - lock.len();

                if removed > 0 {
                    println!("🧹 Pruned {removed} inactive bus(es) (older than 10 minutes)");
                }
            }
        }
    });

    // 2. Build the router
    let app = Router::new()
        .route("/update-location", post(update_location))
        .route("/get-locations", get(get_locations))
        .layer(CorsLayer::permissive())
        .with_state(bus_store);

    // 3. Start server
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    println!("🚀 Server running on http://localhost:8080");
    axum::serve(listener, app).await.unwrap();
}

async fn update_location(
    State(state): State<SharedState>,
    Json(payload): Json<LocationUpdate>,
) -> impl IntoResponse {
    // 1. Bus ID validation
    let trimmed_bus_id = payload.bus_id.trim();
    if trimmed_bus_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Invalid bus ID");
    }

    // 2. Coordinates, speed, and finite value validation
    if !payload.latitude.is_finite()
        || !payload.longitude.is_finite()
        || !payload.speed.is_finite()
        || !(-90.0..=90.0).contains(&payload.latitude)
        || !(-180.0..=180.0).contains(&payload.longitude)
        || payload.speed < 0.0
    {
        return (StatusCode::BAD_REQUEST, "Invalid telemetry data");
    }

    let record = BusLocation {
        bus_id: trimmed_bus_id.to_string(),
        latitude: payload.latitude,
        longitude: payload.longitude,
        speed: payload.speed,
        timestamp: Utc::now(),
    };

    let mut lock = state.write().unwrap();
    lock.insert(trimmed_bus_id.to_string(), record);

    (StatusCode::OK, "Location updated")
}

async fn get_locations(State(state): State<SharedState>) -> Json<Vec<BusLocation>> {
    let lock = state.read().unwrap();
    Json(lock.values().cloned().collect())
}

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool, postgres::PgPoolOptions};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{Route, Stop, VehicleLocation};

#[derive(Clone)]
pub struct Database {
    pool: PgPool,
}

#[derive(Debug, FromRow, Clone)]
pub struct CurrentVehicleState {
    pub route_id: String,
    pub latitude: f64,
    pub longitude: f64,
    pub speed_kmh: f64,
    pub device_timestamp: DateTime<Utc>,
}

#[derive(Debug)]
pub enum StoreError {
    Database(sqlx::Error),
    VehicleNotFound,
    InvalidVehicleStatus,
    PairingInvalid,
    DeviceAlreadyActive,
    RouteNotFound,
    StopNotFound,
    Conflict,
    InvalidSequence,
    ActiveVehicles,
}

#[derive(Debug, FromRow, serde::Serialize)]
pub struct AdminVehicle {
    pub vehicle_id: String,
    pub status: String,
    pub display_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub deactivated_at: Option<DateTime<Utc>>,
    pub route_id: Option<String>,
    pub active_device_count: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct DeviceAssignment {
    pub device_id: Uuid,
    pub vehicle_id: Option<String>,
    pub route_id: Option<String>,
}

#[derive(Debug)]
pub enum DeviceCredentialError {
    Database(sqlx::Error),
    Unauthorized,
}

fn device_credential_is_valid(
    stored_secret_hash: &[u8],
    revoked_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    device_status: &str,
    vehicle_status: &str,
    provided_secret_hash: &[u8],
    now: DateTime<Utc>,
) -> bool {
    let hash_matches: bool = stored_secret_hash.ct_eq(provided_secret_hash).into();
    hash_matches
        && revoked_at.is_none()
        && expires_at.is_none_or(|expires_at| expires_at > now)
        && device_status == "active"
        && vehicle_status == "active"
}

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

#[derive(Debug)]
pub enum LocationWriteError<E> {
    Database(sqlx::Error),
    Domain(E),
    Capacity,
    Unauthorized,
    RouteAssignmentMismatch,
}

impl Database {
    pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(20)
            .connect(database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn device_assignment(
        &self,
        credential_id: Uuid,
        provided_secret_hash: &[u8],
        now: DateTime<Utc>,
    ) -> Result<DeviceAssignment, DeviceCredentialError> {
        let credential = sqlx::query_as::<
            _,
            (
                Vec<u8>,
                Option<DateTime<Utc>>,
                Option<DateTime<Utc>>,
                Uuid,
                String,
                String,
                Option<String>,
                Option<String>,
            ),
        >(
            "SELECT credential.secret_hash, credential.revoked_at, credential.expires_at,
                    device.device_pk, device.status, vehicle.status,
                    CASE WHEN route.route_pk IS NULL THEN NULL ELSE vehicle.vehicle_id END,
                    route.route_id
             FROM device_credentials AS credential
             JOIN tracking_devices AS device ON device.device_pk = credential.device_pk
             JOIN vehicles AS vehicle ON vehicle.vehicle_pk = device.vehicle_pk
             LEFT JOIN vehicle_route_assignments AS assignment
               ON assignment.vehicle_pk = vehicle.vehicle_pk AND assignment.ended_at IS NULL
             LEFT JOIN routes AS route
               ON route.route_pk = assignment.route_pk AND route.deleted_at IS NULL
             WHERE credential.credential_id = $1",
        )
        .bind(credential_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(DeviceCredentialError::Database)?
        .ok_or(DeviceCredentialError::Unauthorized)?;

        if !device_credential_is_valid(
            &credential.0,
            credential.1,
            credential.2,
            &credential.4,
            &credential.5,
            provided_secret_hash,
            now,
        ) {
            return Err(DeviceCredentialError::Unauthorized);
        }

        Ok(DeviceAssignment {
            device_id: credential.3,
            vehicle_id: credential.6,
            route_id: credential.7,
        })
    }

    #[cfg(test)]
    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn record_location<E, F>(
        &self,
        credential_id: Uuid,
        provided_secret_hash: &[u8],
        body_vehicle_id: &str,
        route_id: &str,
        latitude: f64,
        longitude: f64,
        device_timestamp: DateTime<Utc>,
        server_timestamp: DateTime<Utc>,
        calculate_speed: F,
    ) -> Result<bool, LocationWriteError<E>>
    where
        F: FnOnce(Option<&CurrentVehicleState>) -> Result<Option<f64>, E>,
    {
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(LocationWriteError::Database)?;

        let credential = sqlx::query_as::<
            _,
            (
                Vec<u8>,
                Option<DateTime<Utc>>,
                Option<DateTime<Utc>>,
                Uuid,
                String,
                Uuid,
                String,
                String,
            ),
        >(
            "SELECT credential.secret_hash, credential.revoked_at, credential.expires_at,
                    device.device_pk, device.status, vehicle.vehicle_pk,
                    vehicle.vehicle_id, vehicle.status
             FROM device_credentials AS credential
             JOIN tracking_devices AS device ON device.device_pk = credential.device_pk
             JOIN vehicles AS vehicle ON vehicle.vehicle_pk = device.vehicle_pk
             WHERE credential.credential_id = $1
             FOR UPDATE OF vehicle, device, credential",
        )
        .bind(credential_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(LocationWriteError::Database)?
        .ok_or(LocationWriteError::Unauthorized)?;
        if !device_credential_is_valid(
            &credential.0,
            credential.1,
            credential.2,
            &credential.4,
            &credential.7,
            provided_secret_hash,
            server_timestamp,
        ) {
            return Err(LocationWriteError::Unauthorized);
        }
        if credential.6 != body_vehicle_id {
            return Err(LocationWriteError::Unauthorized);
        }
        let device_pk = credential.3;
        let vehicle_pk = credential.5;

        let assignment = sqlx::query_as::<_, (i64, String)>(
            "SELECT assignment.route_pk, route.route_id
             FROM vehicle_route_assignments AS assignment
             JOIN routes AS route ON route.route_pk = assignment.route_pk
             WHERE assignment.vehicle_pk = $1 AND assignment.ended_at IS NULL
               AND route.deleted_at IS NULL
             FOR SHARE OF assignment, route",
        )
        .bind(vehicle_pk)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(LocationWriteError::Database)?
        .ok_or(LocationWriteError::RouteAssignmentMismatch)?;
        if assignment.1 != route_id {
            return Err(LocationWriteError::RouteAssignmentMismatch);
        }
        let route_pk = assignment.0;

        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)")
            .bind(vehicle_pk)
            .execute(&mut *transaction)
            .await
            .map_err(LocationWriteError::Database)?;

        let previous = sqlx::query_as::<_, CurrentVehicleState>(
            "SELECT route.route_id, state.latitude, state.longitude,
                    state.speed_kmh, state.device_timestamp
             FROM vehicle_current_state AS state
             JOIN routes AS route ON route.route_pk = state.route_pk
                         WHERE state.vehicle_pk = $1
               AND state.server_timestamp > $2 - interval '10 minutes'",
        )
        .bind(vehicle_pk)
        .bind(server_timestamp)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(LocationWriteError::Database)?;

        if previous.is_none() {
            sqlx::query("SELECT pg_advisory_xact_lock(17012026, 1)")
                .execute(&mut *transaction)
                .await
                .map_err(LocationWriteError::Database)?;
            let active_count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM vehicle_current_state WHERE server_timestamp > $1 - interval '10 minutes'",
            )
            .bind(server_timestamp)
            .fetch_one(&mut *transaction)
            .await
            .map_err(LocationWriteError::Database)?;
            if active_count >= crate::MAX_ACTIVE_VEHICLES as i64 {
                return Err(LocationWriteError::Capacity);
            }
        }

        let Some(speed) = calculate_speed(previous.as_ref()).map_err(LocationWriteError::Domain)?
        else {
            transaction
                .rollback()
                .await
                .map_err(LocationWriteError::Database)?;
            return Ok(false);
        };

        sqlx::query("UPDATE device_credentials SET last_used_at = $2 WHERE credential_id = $1")
            .bind(credential_id)
            .bind(server_timestamp)
            .execute(&mut *transaction)
            .await
            .map_err(LocationWriteError::Database)?;
        sqlx::query("UPDATE tracking_devices SET last_seen_at = $2 WHERE device_pk = $1")
            .bind(device_pk)
            .bind(server_timestamp)
            .execute(&mut *transaction)
            .await
            .map_err(LocationWriteError::Database)?;

        sqlx::query(
            "INSERT INTO vehicle_telemetry
                 (vehicle_pk, device_pk, route_pk, latitude, longitude, speed_kmh, device_timestamp, server_timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(vehicle_pk)
        .bind(device_pk)
        .bind(route_pk)
        .bind(latitude)
        .bind(longitude)
        .bind(speed)
        .bind(device_timestamp)
        .bind(server_timestamp)
        .execute(&mut *transaction)
        .await
        .map_err(LocationWriteError::Database)?;

        sqlx::query(
            "INSERT INTO vehicle_current_state
                 (vehicle_pk, last_device_pk, route_pk, latitude, longitude, speed_kmh, device_timestamp, server_timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (vehicle_pk) DO UPDATE SET
                 last_device_pk = EXCLUDED.last_device_pk,
                 route_pk = EXCLUDED.route_pk,
                 latitude = EXCLUDED.latitude,
                 longitude = EXCLUDED.longitude,
                 speed_kmh = EXCLUDED.speed_kmh,
                 device_timestamp = EXCLUDED.device_timestamp,
                 server_timestamp = EXCLUDED.server_timestamp",
        )
        .bind(vehicle_pk)
        .bind(device_pk)
        .bind(route_pk)
        .bind(latitude)
        .bind(longitude)
        .bind(speed)
        .bind(device_timestamp)
        .bind(server_timestamp)
        .execute(&mut *transaction)
        .await
        .map_err(LocationWriteError::Database)?;

        transaction
            .commit()
            .await
            .map_err(LocationWriteError::Database)?;
        Ok(true)
    }

    pub async fn locations(&self) -> Result<Vec<VehicleLocation>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (String, String, f64, f64, f64, DateTime<Utc>)>(
            "SELECT vehicle.vehicle_id, route.route_id, state.latitude, state.longitude,
                    state.speed_kmh, state.server_timestamp
             FROM vehicle_current_state AS state
                 JOIN vehicles AS vehicle ON vehicle.vehicle_pk = state.vehicle_pk
             JOIN routes AS route ON route.route_pk = state.route_pk
                         WHERE vehicle.status = 'active'
                             AND state.server_timestamp > $1 - interval '10 minutes'
             ORDER BY vehicle.vehicle_id",
        )
        .bind(Utc::now())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(
                |(vehicle_id, route_id, latitude, longitude, speed, timestamp)| VehicleLocation {
                    vehicle_id,
                    route_id,
                    latitude,
                    longitude,
                    speed,
                    timestamp,
                },
            )
            .collect())
    }

    pub async fn routes(&self) -> Result<Vec<Route>, sqlx::Error> {
        let rows = sqlx::query_as::<
            _,
            (
                String,
                String,
                Option<String>,
                Option<String>,
                Option<f64>,
                Option<f64>,
                Option<i32>,
            ),
        >(
            "SELECT route.route_id, route.route_name,
                    stop.stop_id, stop.stop_name, stop.latitude, stop.longitude, stop.sequence
             FROM routes AS route
             LEFT JOIN stops AS stop ON stop.route_pk = route.route_pk
             WHERE route.deleted_at IS NULL
             ORDER BY route.route_id, stop.sequence",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut routes: Vec<Route> = Vec::new();
        for (route_id, route_name, stop_id, stop_name, latitude, longitude, sequence) in rows {
            if routes.last().map(|route| route.route_id.as_str()) != Some(route_id.as_str()) {
                routes.push(Route {
                    route_id,
                    route_name,
                    stops: Vec::new(),
                });
            }
            if let (
                Some(stop_id),
                Some(stop_name),
                Some(latitude),
                Some(longitude),
                Some(sequence),
            ) = (stop_id, stop_name, latitude, longitude, sequence)
            {
                routes
                    .last_mut()
                    .expect("route was just inserted")
                    .stops
                    .push(Stop {
                        stop_id,
                        stop_name,
                        latitude,
                        longitude,
                        sequence: sequence as u32,
                    });
            }
        }
        Ok(routes)
    }

    pub async fn route_stops(&self, route_id: &str) -> Result<Option<Vec<Stop>>, sqlx::Error> {
        let route_pk = sqlx::query_scalar::<_, i64>(
            "SELECT route_pk FROM routes WHERE route_id = $1 AND deleted_at IS NULL",
        )
        .bind(route_id)
        .fetch_optional(&self.pool)
        .await?;
        match route_pk {
            Some(route_pk) => Ok(Some(Self::load_stops(&self.pool, route_pk).await?)),
            None => Ok(None),
        }
    }

    async fn load_stops(pool: &PgPool, route_pk: i64) -> Result<Vec<Stop>, sqlx::Error> {
        sqlx::query_as::<_, (String, String, f64, f64, i32)>(
            "SELECT stop_id, stop_name, latitude, longitude, sequence
             FROM stops WHERE route_pk = $1 ORDER BY sequence",
        )
        .bind(route_pk)
        .fetch_all(pool)
        .await
        .map(|rows| {
            rows.into_iter()
                .map(|(stop_id, stop_name, latitude, longitude, sequence)| Stop {
                    stop_id,
                    stop_name,
                    latitude,
                    longitude,
                    sequence: sequence as u32,
                })
                .collect()
        })
    }

    pub async fn create_route(
        &self,
        route_id: &str,
        route_name: &str,
    ) -> Result<Route, StoreError> {
        let inserted = sqlx::query_scalar::<_, i64>(
            "INSERT INTO routes (route_id, route_name) VALUES ($1, $2)
             ON CONFLICT (route_id) WHERE deleted_at IS NULL DO NOTHING RETURNING route_pk",
        )
        .bind(route_id)
        .bind(route_name)
        .fetch_optional(&self.pool)
        .await?;
        if inserted.is_none() {
            return Err(StoreError::Conflict);
        }
        Ok(Route {
            route_id: route_id.to_string(),
            route_name: route_name.to_string(),
            stops: Vec::new(),
        })
    }

    pub async fn update_route(
        &self,
        route_id: &str,
        route_name: &str,
    ) -> Result<Route, StoreError> {
        let row = sqlx::query_as::<_, (i64, String)>(
            "UPDATE routes SET route_name = $2, updated_at = clock_timestamp()
             WHERE route_id = $1 AND deleted_at IS NULL RETURNING route_pk, route_id",
        )
        .bind(route_id)
        .bind(route_name)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::RouteNotFound)?;
        Ok(Route {
            route_id: row.1,
            route_name: route_name.to_string(),
            stops: Self::load_stops(&self.pool, row.0).await?,
        })
    }

    pub async fn delete_route(&self, route_id: &str) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let route_pk = sqlx::query_scalar::<_, i64>(
            "SELECT route_pk FROM routes WHERE route_id = $1 AND deleted_at IS NULL FOR UPDATE",
        )
        .bind(route_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::RouteNotFound)?;
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM vehicle_current_state
               WHERE route_pk = $1 AND server_timestamp > $2 - interval '10 minutes')",
        )
        .bind(route_pk)
        .bind(Utc::now())
        .fetch_one(&mut *tx)
        .await?;
        if active {
            return Err(StoreError::ActiveVehicles);
        }
        sqlx::query("UPDATE routes SET deleted_at = clock_timestamp(), updated_at = clock_timestamp() WHERE route_pk = $1")
            .bind(route_pk)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn active_route_pk(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        route_id: &str,
        lock: bool,
    ) -> Result<i64, StoreError> {
        let query = if lock {
            "SELECT route_pk FROM routes WHERE route_id = $1 AND deleted_at IS NULL FOR UPDATE"
        } else {
            "SELECT route_pk FROM routes WHERE route_id = $1 AND deleted_at IS NULL"
        };
        sqlx::query_scalar(query)
            .bind(route_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(StoreError::RouteNotFound)
    }

    pub async fn create_stop(&self, route_id: &str, stop: &Stop) -> Result<Stop, StoreError> {
        let mut tx = self.pool.begin().await?;
        let route_pk = Self::active_route_pk(&mut tx, route_id, true).await?;
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM stops WHERE route_pk = $1 AND stop_id = $2)",
        )
        .bind(route_pk)
        .bind(&stop.stop_id)
        .fetch_one(&mut *tx)
        .await?;
        if duplicate {
            return Err(StoreError::Conflict);
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM stops WHERE route_pk = $1")
            .bind(route_pk)
            .fetch_one(&mut *tx)
            .await?;
        if stop.sequence == 0 || i64::from(stop.sequence) > count + 1 {
            return Err(StoreError::InvalidSequence);
        }
        sqlx::query(
            "UPDATE stops SET sequence = sequence + 1 WHERE route_pk = $1 AND sequence >= $2",
        )
        .bind(route_pk)
        .bind(stop.sequence as i32)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO stops (route_pk, stop_id, stop_name, latitude, longitude, sequence) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(route_pk).bind(&stop.stop_id).bind(&stop.stop_name).bind(stop.latitude).bind(stop.longitude).bind(stop.sequence as i32).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(stop.clone())
    }

    pub async fn update_stop(
        &self,
        route_id: &str,
        stop_id: &str,
        update: &Stop,
    ) -> Result<Stop, StoreError> {
        let mut tx = self.pool.begin().await?;
        let route_pk = Self::active_route_pk(&mut tx, route_id, true).await?;
        let old_sequence = sqlx::query_scalar::<_, i32>(
            "SELECT sequence FROM stops WHERE route_pk = $1 AND stop_id = $2",
        )
        .bind(route_pk)
        .bind(stop_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::StopNotFound)?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM stops WHERE route_pk = $1")
            .bind(route_pk)
            .fetch_one(&mut *tx)
            .await?;
        if update.sequence == 0 || i64::from(update.sequence) > count {
            return Err(StoreError::InvalidSequence);
        }
        let new_sequence = update.sequence as i32;
        if new_sequence < old_sequence {
            sqlx::query("UPDATE stops SET sequence = sequence + 1 WHERE route_pk = $1 AND sequence >= $2 AND sequence < $3")
                .bind(route_pk).bind(new_sequence).bind(old_sequence).execute(&mut *tx).await?;
        } else if new_sequence > old_sequence {
            sqlx::query("UPDATE stops SET sequence = sequence - 1 WHERE route_pk = $1 AND sequence > $2 AND sequence <= $3")
                .bind(route_pk).bind(old_sequence).bind(new_sequence).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE stops SET stop_name = $3, latitude = $4, longitude = $5, sequence = $6 WHERE route_pk = $1 AND stop_id = $2")
            .bind(route_pk).bind(stop_id).bind(&update.stop_name).bind(update.latitude).bind(update.longitude).bind(new_sequence).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(update.clone())
    }

    pub async fn delete_stop(&self, route_id: &str, stop_id: &str) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let route_pk = Self::active_route_pk(&mut tx, route_id, true).await?;
        let sequence = sqlx::query_scalar::<_, i32>(
            "DELETE FROM stops WHERE route_pk = $1 AND stop_id = $2 RETURNING sequence",
        )
        .bind(route_pk)
        .bind(stop_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::StopNotFound)?;
        sqlx::query(
            "UPDATE stops SET sequence = sequence - 1 WHERE route_pk = $1 AND sequence > $2",
        )
        .bind(route_pk)
        .bind(sequence)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn register_vehicle(
        &self,
        vehicle_id: &str,
        display_name: Option<&str>,
    ) -> Result<AdminVehicle, StoreError> {
        let inserted = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO vehicles (vehicle_id, status, display_name)
             VALUES ($1, 'pending', $2)
             ON CONFLICT (vehicle_id) DO NOTHING
             RETURNING vehicle_pk",
        )
        .bind(vehicle_id)
        .bind(display_name)
        .fetch_optional(&self.pool)
        .await?;
        if inserted.is_none() {
            return Err(StoreError::Conflict);
        }
        self.admin_vehicle(vehicle_id)
            .await?
            .ok_or(StoreError::VehicleNotFound)
    }

    pub async fn admin_vehicles(&self) -> Result<Vec<AdminVehicle>, sqlx::Error> {
        sqlx::query_as::<_, AdminVehicle>(
            "SELECT vehicle.vehicle_id, vehicle.status, vehicle.display_name,
                    vehicle.created_at, vehicle.deactivated_at, route.route_id,
                    count(device.device_pk) FILTER (WHERE device.status = 'active') AS active_device_count
             FROM vehicles AS vehicle
             LEFT JOIN vehicle_route_assignments AS assignment
               ON assignment.vehicle_pk = vehicle.vehicle_pk AND assignment.ended_at IS NULL
             LEFT JOIN routes AS route ON route.route_pk = assignment.route_pk
             LEFT JOIN tracking_devices AS device ON device.vehicle_pk = vehicle.vehicle_pk
             GROUP BY vehicle.vehicle_pk, route.route_id
             ORDER BY vehicle.vehicle_id",
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn admin_vehicle(
        &self,
        vehicle_id: &str,
    ) -> Result<Option<AdminVehicle>, sqlx::Error> {
        sqlx::query_as::<_, AdminVehicle>(
            "SELECT vehicle.vehicle_id, vehicle.status, vehicle.display_name,
                    vehicle.created_at, vehicle.deactivated_at, route.route_id,
                    count(device.device_pk) FILTER (WHERE device.status = 'active') AS active_device_count
             FROM vehicles AS vehicle
             LEFT JOIN vehicle_route_assignments AS assignment
               ON assignment.vehicle_pk = vehicle.vehicle_pk AND assignment.ended_at IS NULL
             LEFT JOIN routes AS route ON route.route_pk = assignment.route_pk
             LEFT JOIN tracking_devices AS device ON device.vehicle_pk = vehicle.vehicle_pk
             WHERE vehicle.vehicle_id = $1
             GROUP BY vehicle.vehicle_pk, route.route_id",
        )
        .bind(vehicle_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn update_vehicle(
        &self,
        vehicle_id: &str,
        status: &str,
        display_name: Option<&str>,
    ) -> Result<AdminVehicle, StoreError> {
        let mut tx = self.pool.begin().await?;
        let existing = sqlx::query_as::<_, (Uuid, String)>(
            "SELECT vehicle_pk, status FROM vehicles WHERE vehicle_id = $1 FOR UPDATE",
        )
        .bind(vehicle_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::VehicleNotFound)?;
        if existing.1 == "retired" && status != "retired" {
            return Err(StoreError::InvalidVehicleStatus);
        }
        sqlx::query(
            "UPDATE vehicles
             SET status = $2, display_name = COALESCE($3, display_name),
                 updated_at = clock_timestamp(),
                 deactivated_at = CASE
                     WHEN $2 IN ('deactivated', 'retired')
                         THEN COALESCE(deactivated_at, clock_timestamp())
                     ELSE NULL
                 END
             WHERE vehicle_pk = $1",
        )
        .bind(existing.0)
        .bind(status)
        .bind(display_name)
        .execute(&mut *tx)
        .await?;
        if matches!(status, "deactivated" | "retired") {
            sqlx::query(
                "UPDATE tracking_devices
                 SET status = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp()),
                     pairing_code_hash = NULL, pairing_expires_at = NULL
                 WHERE vehicle_pk = $1 AND status <> 'revoked'",
            )
            .bind(existing.0)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE device_credentials
                 SET revoked_at = COALESCE(revoked_at, clock_timestamp())
                 WHERE device_pk IN (SELECT device_pk FROM tracking_devices WHERE vehicle_pk = $1)
                   AND revoked_at IS NULL",
            )
            .bind(existing.0)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.admin_vehicle(vehicle_id)
            .await?
            .ok_or(StoreError::VehicleNotFound)
    }

    pub async fn create_device_enrollment(
        &self,
        vehicle_id: &str,
        device_label: &str,
        pairing_code_hash: &[u8],
        pairing_expires_at: DateTime<Utc>,
    ) -> Result<Uuid, StoreError> {
        let mut tx = self.pool.begin().await?;
        let vehicle = sqlx::query_as::<_, (Uuid, String)>(
            "SELECT vehicle_pk, status FROM vehicles WHERE vehicle_id = $1 FOR UPDATE",
        )
        .bind(vehicle_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::VehicleNotFound)?;
        if !matches!(vehicle.1.as_str(), "pending" | "active") {
            return Err(StoreError::InvalidVehicleStatus);
        }
        sqlx::query(
            "UPDATE tracking_devices
             SET status = 'revoked', revoked_at = clock_timestamp(),
                 pairing_code_hash = NULL, pairing_expires_at = NULL
             WHERE vehicle_pk = $1 AND status = 'pending'
               AND pairing_expires_at <= clock_timestamp()",
        )
        .bind(vehicle.0)
        .execute(&mut *tx)
        .await?;
        let pending_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM tracking_devices
             WHERE vehicle_pk = $1 AND status = 'pending')",
        )
        .bind(vehicle.0)
        .fetch_one(&mut *tx)
        .await?;
        if pending_exists {
            return Err(StoreError::DeviceAlreadyActive);
        }
        let device_pk = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO tracking_devices
                 (vehicle_pk, device_label, pairing_code_hash, pairing_expires_at)
             VALUES ($1, $2, $3, $4)
             RETURNING device_pk",
        )
        .bind(vehicle.0)
        .bind(device_label)
        .bind(pairing_code_hash)
        .bind(pairing_expires_at)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(device_pk)
    }

    pub async fn claim_device(
        &self,
        pairing_code_hash: &[u8],
        credential_id: Uuid,
        secret_hash: &[u8],
    ) -> Result<Uuid, StoreError> {
        let mut tx = self.pool.begin().await?;
        let device = sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT device_pk, vehicle_pk FROM tracking_devices
             WHERE pairing_code_hash = $1 AND status = 'pending'
               AND pairing_expires_at > clock_timestamp()",
        )
        .bind(pairing_code_hash)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::PairingInvalid)?;

        let vehicle_status: String =
            sqlx::query_scalar("SELECT status FROM vehicles WHERE vehicle_pk = $1 FOR UPDATE")
                .bind(device.1)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(StoreError::PairingInvalid)?;
        if !matches!(vehicle_status.as_str(), "pending" | "active") {
            return Err(StoreError::PairingInvalid);
        }
        let pending_device = sqlx::query_scalar::<_, Uuid>(
            "SELECT device_pk FROM tracking_devices
             WHERE device_pk = $1 AND pairing_code_hash = $2
               AND status = 'pending' AND pairing_expires_at > clock_timestamp()
             FOR UPDATE",
        )
        .bind(device.0)
        .bind(pairing_code_hash)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::PairingInvalid)?;

        let already_active: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM tracking_devices
             WHERE vehicle_pk = $1 AND status = 'active')",
        )
        .bind(device.1)
        .fetch_one(&mut *tx)
        .await?;
        if already_active {
            return Err(StoreError::DeviceAlreadyActive);
        }

        sqlx::query(
            "UPDATE tracking_devices
             SET status = 'active', activated_at = clock_timestamp(),
                 pairing_code_hash = NULL, pairing_expires_at = NULL
             WHERE device_pk = $1",
        )
        .bind(pending_device)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO device_credentials (credential_id, device_pk, secret_hash)
             VALUES ($1, $2, $3)",
        )
        .bind(credential_id)
        .bind(pending_device)
        .bind(secret_hash)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(pending_device)
    }

    pub async fn revoke_device(&self, device_pk: Uuid) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let vehicle_pk = sqlx::query_scalar::<_, Uuid>(
            "SELECT vehicle_pk FROM tracking_devices WHERE device_pk = $1",
        )
        .bind(device_pk)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::VehicleNotFound)?;
        sqlx::query("SELECT vehicle_pk FROM vehicles WHERE vehicle_pk = $1 FOR UPDATE")
            .bind(vehicle_pk)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(StoreError::VehicleNotFound)?;
        sqlx::query("SELECT device_pk FROM tracking_devices WHERE device_pk = $1 FOR UPDATE")
            .bind(device_pk)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(StoreError::VehicleNotFound)?;
        let revoked = sqlx::query(
            "UPDATE tracking_devices
             SET status = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp()),
                 pairing_code_hash = NULL, pairing_expires_at = NULL
             WHERE device_pk = $1 AND status <> 'revoked'",
        )
        .bind(device_pk)
        .execute(&mut *tx)
        .await?;
        if revoked.rows_affected() == 0 {
            return Err(StoreError::VehicleNotFound);
        }
        sqlx::query(
            "UPDATE device_credentials
             SET revoked_at = COALESCE(revoked_at, clock_timestamp())
             WHERE device_pk = $1 AND revoked_at IS NULL",
        )
        .bind(device_pk)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn assign_route(&self, vehicle_id: &str, route_id: &str) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let vehicle = sqlx::query_as::<_, (Uuid, String)>(
            "SELECT vehicle_pk, status FROM vehicles WHERE vehicle_id = $1 FOR UPDATE",
        )
        .bind(vehicle_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::VehicleNotFound)?;
        if !matches!(vehicle.1.as_str(), "pending" | "active") {
            return Err(StoreError::InvalidVehicleStatus);
        }
        let route_pk = sqlx::query_scalar::<_, i64>(
            "SELECT route_pk FROM routes WHERE route_id = $1 AND deleted_at IS NULL FOR SHARE",
        )
        .bind(route_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::RouteNotFound)?;
        let current = sqlx::query_as::<_, (i64, i64)>(
            "SELECT assignment_pk, route_pk FROM vehicle_route_assignments
             WHERE vehicle_pk = $1 AND ended_at IS NULL FOR UPDATE",
        )
        .bind(vehicle.0)
        .fetch_optional(&mut *tx)
        .await?;
        if current.is_some_and(|(_, current_route_pk)| current_route_pk == route_pk) {
            tx.commit().await?;
            return Ok(());
        }
        if let Some((assignment_pk, _)) = current {
            sqlx::query(
                "UPDATE vehicle_route_assignments SET ended_at = clock_timestamp()
                 WHERE assignment_pk = $1",
            )
            .bind(assignment_pk)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            "INSERT INTO vehicle_route_assignments (vehicle_pk, route_pk)
             VALUES ($1, $2)",
        )
        .bind(vehicle.0)
        .bind(route_pk)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

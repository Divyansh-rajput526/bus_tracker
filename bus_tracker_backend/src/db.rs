use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool, postgres::PgPoolOptions};

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
    RouteNotFound,
    StopNotFound,
    Conflict,
    InvalidSequence,
    ActiveVehicles,
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
    RouteNotFound,
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

    pub async fn record_location<E, F>(
        &self,
        vehicle_id: &str,
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

        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
            .bind(vehicle_id)
            .execute(&mut *transaction)
            .await
            .map_err(LocationWriteError::Database)?;

        let route = sqlx::query_as::<_, (i64,)>(
            "SELECT route_pk FROM routes WHERE route_id = $1 AND deleted_at IS NULL FOR SHARE",
        )
        .bind(route_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(LocationWriteError::Database)?
        .ok_or(LocationWriteError::RouteNotFound)?;
        let route_pk = route.0;

        let previous = sqlx::query_as::<_, CurrentVehicleState>(
            "SELECT route.route_id, state.latitude, state.longitude,
                    state.speed_kmh, state.device_timestamp
             FROM vehicle_current_state AS state
             JOIN routes AS route ON route.route_pk = state.route_pk
             WHERE state.vehicle_id = $1
               AND state.server_timestamp > $2 - interval '10 minutes'",
        )
        .bind(vehicle_id)
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

        sqlx::query(
            "INSERT INTO vehicles (vehicle_id) VALUES ($1) ON CONFLICT (vehicle_id) DO NOTHING",
        )
        .bind(vehicle_id)
        .execute(&mut *transaction)
        .await
        .map_err(LocationWriteError::Database)?;

        sqlx::query(
            "INSERT INTO vehicle_current_state
                 (vehicle_id, route_pk, latitude, longitude, speed_kmh, device_timestamp, server_timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (vehicle_id) DO UPDATE SET
                 route_pk = EXCLUDED.route_pk,
                 latitude = EXCLUDED.latitude,
                 longitude = EXCLUDED.longitude,
                 speed_kmh = EXCLUDED.speed_kmh,
                 device_timestamp = EXCLUDED.device_timestamp,
                 server_timestamp = EXCLUDED.server_timestamp",
        )
        .bind(vehicle_id)
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
            "INSERT INTO vehicle_telemetry
                 (vehicle_id, route_pk, latitude, longitude, speed_kmh, device_timestamp, server_timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(vehicle_id)
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
            "SELECT state.vehicle_id, route.route_id, state.latitude, state.longitude,
                    state.speed_kmh, state.server_timestamp
             FROM vehicle_current_state AS state
             JOIN routes AS route ON route.route_pk = state.route_pk
             WHERE state.server_timestamp > $1 - interval '10 minutes'
             ORDER BY state.vehicle_id",
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
}

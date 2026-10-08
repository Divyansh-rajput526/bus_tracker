import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  CircleMarker,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";
import {
  calculateApproximateEtaMinutes,
  formatVehicleSpeed,
  getDisplaySpeed,
} from "./vehiclePresentation.js";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim() || "http://localhost:8080";

const LOCATIONS_URL = `${API_BASE_URL}/get-locations`;
const ROUTES_URL = `${API_BASE_URL}/routes`;

const MAP_CENTER = [27.239337, 77.84];
const MAP_ZOOM = 13;

const FOLLOW_ZOOM = 15;

const POLLING_INTERVAL = 2000;
const REQUEST_TIMEOUT = 5000;

/*
 * Vehicle freshness thresholds.
 *
 * These are frontend display thresholds only.
 * The backend remains responsible for deciding which
 * vehicles are retained in the tracking store.
 */
const ACTIVE_THRESHOLD_SECONDS = 15;
const STALE_THRESHOLD_SECONDS = 60;
const MAX_FUTURE_TIMESTAMP_SECONDS = 30;
const CONNECTION_STALE_THRESHOLD_MS =
  REQUEST_TIMEOUT + POLLING_INTERVAL;
const CONNECTION_OFFLINE_THRESHOLD_MS =
  CONNECTION_STALE_THRESHOLD_MS * 2;

const vehicleIcon = new L.Icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});


/*
 * =========================================================
 * Utility helpers
 * =========================================================
 */

function formatTimeAgo(timestamp, now) {
  const ageSeconds = getTimestampAgeSeconds(timestamp, now);

  if (ageSeconds === null) {
    return "Unknown";
  }

  const wholeAgeSeconds = Math.floor(ageSeconds);

  if (wholeAgeSeconds < 5) {
    return "Just now";
  }

  if (wholeAgeSeconds < 60) {
    return `${wholeAgeSeconds}s ago`;
  }

  const minutes = Math.floor(wholeAgeSeconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);

  return `${days}d ago`;
}


function getTimestampAgeSeconds(timestamp, now) {
  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp).getTime();

  if (!Number.isFinite(parsed)) {
    return null;
  }

  const ageSeconds = (now - parsed) / 1000;

  if (ageSeconds < -MAX_FUTURE_TIMESTAMP_SECONDS) {
    return null;
  }

  return Math.max(0, ageSeconds);
}


function getVehicleStatus(timestamp, now) {
  const ageSeconds = getTimestampAgeSeconds(timestamp, now);

  if (ageSeconds === null) {
    return "Unknown";
  }

  if (ageSeconds <= ACTIVE_THRESHOLD_SECONDS) {
    return "Active";
  }

  if (ageSeconds <= STALE_THRESHOLD_SECONDS) {
    return "Stale";
  }

  return "Offline";
}


function getDisplayConnectionState(
  connectionState,
  lastSuccessfulSync,
  now
) {
  if (!lastSuccessfulSync) {
    return connectionState;
  }

  const syncAge = now - lastSuccessfulSync;

  if (syncAge > CONNECTION_OFFLINE_THRESHOLD_MS) {
    return "offline";
  }

  if (
    syncAge > CONNECTION_STALE_THRESHOLD_MS ||
    connectionState === "offline"
  ) {
    return "reconnecting";
  }

  return "live";
}


function getStatusColor(status) {
  switch (status) {
    case "Active":
      return "#198754";

    case "Stale":
      return "#d97706";

    case "Offline":
      return "#dc3545";

    default:
      return "#6c757d";
  }
}


function normalizeRouteKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function markProgrammaticMove(ref, durationMs = 1200) {
  ref.current = Math.max(ref.current, Date.now() + durationMs);
}


/*
 * =========================================================
 * RouteCenter
 * =========================================================
 *
 * Re-centers only after an explicit route search.
 *
 * Polling updates do not trigger another fitBounds().
 * Vehicle selection does not trigger a refit.
 * Stop selection does not trigger a refit.
 */
function RouteCenter({
  vehicles,
  stops,
  searchRequestId,
  disabled,
  programmaticMoveRef,
}) {
  const map = useMap();
  const lastHandledRequest = useRef(0);

  useEffect(() => {
    if (disabled || searchRequestId === 0) {
      return;
    }

    if (lastHandledRequest.current === searchRequestId) {
      return;
    }

    const vehicleCoords = vehicles
      .map((vehicle) => [
        Number(vehicle.latitude),
        Number(vehicle.longitude),
      ])
      .filter(
        ([latitude, longitude]) =>
          Number.isFinite(latitude) && Number.isFinite(longitude)
      );

    const stopCoords = stops
      .map((stop) => [
        Number(stop.latitude),
        Number(stop.longitude),
      ])
      .filter(
        ([latitude, longitude]) =>
          Number.isFinite(latitude) && Number.isFinite(longitude)
      );

    const coords = [
      ...vehicleCoords,
      ...stopCoords,
    ];

    if (coords.length === 0) {
      return;
    }

    markProgrammaticMove(programmaticMoveRef);

    if (coords.length === 1) {
      map.setView(
        coords[0],
        Math.max(map.getZoom(), FOLLOW_ZOOM),
        { animate: true }
      );
    } else {
      map.fitBounds(coords, {
        padding: [50, 50],
        maxZoom: 15,
        animate: true,
      });
    }

    lastHandledRequest.current = searchRequestId;
  }, [vehicles, stops, searchRequestId, disabled, map, programmaticMoveRef]);

  return null;
}




/*
 * =========================================================
 * FollowVehicle
 * =========================================================
 *
 * Important behavior:
 *
 * 1. Selecting a vehicle does not move the map.
 * 2. The first telemetry update after selection starts
 *    following.
 * 3. Polling does not reset following state.
 * 4. Manually dragging/zooming disables following.
 * 5. Pressing Resume Following does not unexpectedly
 *    refit the map.
 *
 * Use the Recenter button for an immediate explicit move.
 */
function FollowVehicle({
  vehicle,
  enabled,
  onFollowingChange,
  programmaticMoveRef,
}) {
  const map = useMap();
  const vehicleId = vehicle?.vehicle_id;

  const previousVehicleId = useRef(null);
  const previousEnabled = useRef(enabled);
  const userInteracting = useRef(false);

  useEffect(() => {
    const handleInteractionStart = () => {
      if (Date.now() < programmaticMoveRef.current) {
        return;
      }

      userInteracting.current = true;

      if (enabled) {
        onFollowingChange(false);
      }
    };

    map.on("dragstart", handleInteractionStart);
    map.on("zoomstart", handleInteractionStart);

    return () => {
      map.off("dragstart", handleInteractionStart);
      map.off("zoomstart", handleInteractionStart);
    };
  }, [map, enabled, onFollowingChange, programmaticMoveRef]);

  useEffect(() => {
    if (!vehicleId) {
      previousVehicleId.current = null;
      previousEnabled.current = enabled;
      return;
    }

    if (!enabled) {
      previousVehicleId.current = vehicleId;
      previousEnabled.current = false;
      return;
    }

    const vehicleChanged = previousVehicleId.current !== vehicleId;
    const followingResumed =
      previousVehicleId.current === vehicleId &&
      previousEnabled.current === false;

    previousVehicleId.current = vehicleId;
    previousEnabled.current = true;

    // Selecting a vehicle preserves the current map position.
    if (vehicleChanged) {
      userInteracting.current = false;
      return;
    }

    // Resuming following immediately recenters, even if the vehicle is stopped.
    if (followingResumed) {
      userInteracting.current = false;
    }

    if (userInteracting.current && !followingResumed) {
      return;
    }

    const latitude = Number(vehicle.latitude);
    const longitude = Number(vehicle.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }

    markProgrammaticMove(programmaticMoveRef);

    map.panTo([latitude, longitude], {
      animate: true,
      duration: 0.8,
    });
  }, [
    vehicle?.latitude,
    vehicle?.longitude,
    vehicle?.timestamp,
    vehicleId,
    enabled,
    map,
    programmaticMoveRef,
  ]);

  useEffect(() => {
    if (!vehicleId) {
      previousVehicleId.current = null;
      previousEnabled.current = false;
      userInteracting.current = false;
    }
  }, [vehicleId]);

  return null;
}




/*
 * =========================================================
 * MapController
 * =========================================================
 *
 * Handles explicit user-requested recentering.
 *
 * This is intentionally separate from selection so the map
 * remains stable when a vehicle or stop is selected.
 */
function MapController({
  selectedVehicle,
  vehicles,
  stops,
  recenterRequestId,
  programmaticMoveRef,
}) {
  const map = useMap();
  const lastHandledRequest = useRef(0);

  useEffect(() => {
    if (
      recenterRequestId === 0 ||
      lastHandledRequest.current === recenterRequestId
    ) {
      return;
    }

    lastHandledRequest.current = recenterRequestId;

    if (selectedVehicle) {
      const latitude = Number(selectedVehicle.latitude);
      const longitude = Number(selectedVehicle.longitude);

      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        markProgrammaticMove(programmaticMoveRef);

        map.setView(
          [latitude, longitude],
          Math.max(map.getZoom(), FOLLOW_ZOOM),
          { animate: true }
        );

        lastHandledRequest.current = recenterRequestId;
      }

      return;
    }

    const vehicleCoords = vehicles
      .map((vehicle) => [
        Number(vehicle.latitude),
        Number(vehicle.longitude),
      ])
      .filter(
        ([latitude, longitude]) =>
          Number.isFinite(latitude) && Number.isFinite(longitude)
      );

    const stopCoords = stops
      .map((stop) => [
        Number(stop.latitude),
        Number(stop.longitude),
      ])
      .filter(
        ([latitude, longitude]) =>
          Number.isFinite(latitude) && Number.isFinite(longitude)
      );

    const coords =
      vehicleCoords.length > 0 ? vehicleCoords : stopCoords;

    if (coords.length === 0) {
      return;
    }

    markProgrammaticMove(programmaticMoveRef);

    if (coords.length === 1) {
      map.setView(
        coords[0],
        Math.max(map.getZoom(), FOLLOW_ZOOM),
        { animate: true }
      );
    } else {
      map.fitBounds(coords, {
        padding: [50, 50],
        maxZoom: 15,
        animate: true,
      });
    }

    lastHandledRequest.current = recenterRequestId;
  }, [
    recenterRequestId,
    selectedVehicle,
    vehicles,
    stops,
    map,
    programmaticMoveRef,
  ]);

  return null;
}




function FocusStop({ stop, programmaticMoveRef }) {
  const map = useMap();

  useEffect(() => {
    if (!stop) {
      return;
    }

    const latitude = Number(stop.latitude);
    const longitude = Number(stop.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }

    markProgrammaticMove(programmaticMoveRef);
    map.panTo([latitude, longitude], {
      animate: true,
      duration: 0.8,
    });
  }, [stop, map, programmaticMoveRef]);

  return null;
}


/*
 * =========================================================
 * StatusBadge
 * =========================================================
 */
function StatusBadge({ status }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 8px",
        borderRadius: "999px",
        fontSize: "12px",
        fontWeight: 600,
        color: getStatusColor(status),
        background: `${getStatusColor(
          status
        )}18`,
        border: `1px solid ${getStatusColor(
          status
        )}35`,
      }}
    >
      {status}
    </span>
  );
}


/*
 * =========================================================
 * App
 * =========================================================
 */
export default function App() {
  const [vehicles, setVehicles] = useState([]);

  const [routes, setRoutes] = useState([]);

  const [routeId, setRouteId] =
    useState("");

  const [searchRoute, setSearchRoute] =
    useState("");

  /*
   * Only increments after an explicit Search action.
   */
  const [
    searchRequestId,
    setSearchRequestId,
  ] = useState(0);

  /*
   * Explicit user-requested map recenter.
   */
  const [
    recenterRequestId,
    setRecenterRequestId,
  ] = useState(0);

  const [
    selectedVehicleId,
    setSelectedVehicleId,
  ] = useState("");

  const selectedVehicleIdRef =
    useRef("");

  const [
    selectedStop,
    setSelectedStop,
  ] = useState(null);

  const [routePanelOpen, setRoutePanelOpen] =
    useState(true);

  const [stops, setStops] =
    useState([]);

  const [error, setError] =
    useState(null);

  const [stopError, setStopError] =
    useState(null);

  const [
    locationsLoading,
    setLocationsLoading,
  ] = useState(true);

  const [
    stopsLoading,
    setStopsLoading,
  ] = useState(false);

  const [
    followingVehicle,
    setFollowingVehicle,
  ] = useState(true);

  const [
    connectionState,
    setConnectionState,
  ] = useState("connecting");

  const [
    lastSuccessfulSync,
    setLastSuccessfulSync,
  ] = useState(null);

  /*
   * Re-render once per second so relative times and
   * vehicle freshness stay current.
   */
  const [now, setNow] =
    useState(() => Date.now());

  const consecutiveFailures =
    useRef(0);

  const programmaticMoveRef =
    useRef(0);


  /*
   * =======================================================
   * Clock
   * =======================================================
   */
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, []);


  /*
   * =======================================================
   * Fetch routes
   * =======================================================
   *
   * Used for route suggestions and route names.
   */
  useEffect(() => {
    const controller =
      new AbortController();

    const fetchRoutes = async () => {
      try {
        const response = await fetch(
          ROUTES_URL,
          {
            signal:
              controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error(
            `Unable to load routes. HTTP ${response.status}`
          );
        }

        const data =
          await response.json();

        if (!Array.isArray(data)) {
          throw new Error(
            "Invalid route data received from server."
          );
        }

        setRoutes(data);
      } catch (err) {
        if (
          err?.name ===
          "AbortError"
        ) {
          return;
        }

        /*
         * Route suggestions are helpful but should not
         * prevent the main tracking map from working.
         */
      }
    };

    fetchRoutes();

    return () => {
      controller.abort();
    };
  }, []);


  /*
   * =======================================================
   * Vehicle polling
   * =======================================================
   */
  useEffect(() => {
    let cancelled = false;
    let timerId = null;
    let pollAbortController = null;

    const fetchLocations = async () => {
      pollAbortController = new AbortController();
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        pollAbortController?.abort();
      }, REQUEST_TIMEOUT);

      try {
        const response = await fetch(LOCATIONS_URL, {
          signal: pollAbortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Server returned HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
          throw new Error("Invalid location data received from server.");
        }

        if (cancelled) {
          return;
        }

        const selectedId =
          selectedVehicleIdRef.current;

        if (
          selectedId &&
          !data.some(
            (vehicle) =>
              String(vehicle.vehicle_id) ===
              String(selectedId)
          )
        ) {
          selectedVehicleIdRef.current = "";
          setSelectedVehicleId("");
          setFollowingVehicle(false);
        }

        setVehicles(data);
        setError(null);
        setConnectionState("live");
        setLastSuccessfulSync(Date.now());
        consecutiveFailures.current = 0;
      } catch (err) {
        if (cancelled) {
          return;
        }

        consecutiveFailures.current += 1;

        if (consecutiveFailures.current >= 3) {
          setConnectionState("offline");
        } else {
          setConnectionState("reconnecting");
        }

        if (timedOut) {
          setError("Vehicle location request timed out.");
        } else if (err?.name === "AbortError") {
          setError("Vehicle location request was cancelled.");
        } else {
          setError(err?.message || "Unable to fetch vehicle locations.");
        }
      } finally {
        clearTimeout(timeoutId);

        if (!cancelled) {
          setLocationsLoading(false);
          timerId = setTimeout(fetchLocations, POLLING_INTERVAL);
        }
      }
    };

    fetchLocations();

    return () => {
      cancelled = true;

      if (pollAbortController) {
        pollAbortController.abort();
      }

      if (timerId) {
        clearTimeout(timerId);
      }
    };
  }, []);

  /*
   * =======================================================
   * Fetch stops when searched route changes
   * =======================================================
   */
  useEffect(() => {
    if (!searchRoute) {
      return;
    }

    const controller =
      new AbortController();

    const fetchStops =
      async () => {
        setStopsLoading(true);
        setStopError(null);

        try {
          const response =
            await fetch(
              `${API_BASE_URL}/routes/${encodeURIComponent(
                searchRoute
              )}/stops`,
              {
                signal:
                  controller.signal,
              }
            );

          if (!response.ok) {
            if (
              response.status ===
              404
            ) {
              throw new Error(
                "Route does not exist."
              );
            }

            throw new Error(
              `Unable to fetch stops. HTTP ${response.status}`
            );
          }

          const data =
            await response.json();

          if (!Array.isArray(data)) {
            throw new Error(
              "Invalid stop data received from server."
            );
          }

          setStops(data);
          setSelectedStop(null);
        } catch (err) {
          if (
            err?.name ===
            "AbortError"
          ) {
            return;
          }

          setStops([]);
          setSelectedStop(
            null
          );

          setStopError(
            err?.message ||
              "Unable to load route stops."
          );
        } finally {
          if (
            !controller.signal
              .aborted
          ) {
            setStopsLoading(
              false
            );
          }
        }
      };

    fetchStops();

    return () => {
      controller.abort();
    };
  }, [searchRoute]);


  /*
   * =======================================================
   * Derived route data
   * =======================================================
   */

  const selectedRoute =
    routes.find(
      (route) =>
        normalizeRouteKey(route.route_id) ===
        normalizeRouteKey(searchRoute)
    ) || null;


  /*
   * =======================================================
   * Filter vehicles by route
   * =======================================================
   */
  const filteredVehicles =
    searchRoute
      ? vehicles.filter(
          (vehicle) =>
            normalizeRouteKey(vehicle.route_id) ===
            normalizeRouteKey(searchRoute)
        )
      : vehicles;


  /*
   * =======================================================
   * Selected vehicle
   * =======================================================
   */
  const selectedVehicle =
    filteredVehicles.find(
      (vehicle) =>
        String(vehicle.vehicle_id) ===
        String(selectedVehicleId)
    ) || null;


  /*
   * =======================================================
   * Visible vehicles
   * =======================================================
   */
  const visibleVehicles = vehicles;


  /*
   * =======================================================
   * Sorted stops
   * =======================================================
   */
  const sortedStops = stops
    .slice()
    .sort(
      (a, b) =>
        Number(a.sequence) -
        Number(b.sequence)
    );


  const selectedVehicleIdForRender =
    selectedVehicle ? selectedVehicleId : "";

  /*
   * =======================================================
   * Search route
   * =======================================================
   */
  const handleSearch =
    (event) => {
      event.preventDefault();

      const normalizedRoute =
        routeId.trim();

      selectedVehicleIdRef.current = "";
      setSelectedVehicleId("");
      setSelectedStop(null);
      setStops([]);
      setStopError(null);
      setFollowingVehicle(true);

      if (!normalizedRoute) {
        setStopsLoading(false);
        setSearchRoute("");
        return;
      }

      setSearchRequestId(
        (current) => current + 1
      );

      setSearchRoute(normalizedRoute);
    };


  /*
   * =======================================================
   * Clear search
   * =======================================================
   */
  const clearSearch = () => {
    setRouteId("");
    setSearchRoute("");
    selectedVehicleIdRef.current = "";
    setSelectedVehicleId("");
    setSelectedStop(null);
    setStops([]);
    setStopError(null);
    setStopsLoading(false);
    setFollowingVehicle(true);

    /*
     * Intentionally do not change searchRequestId.
     */
  };


  /*
   * =======================================================
   * Select vehicle
   * =======================================================
   *
   * Selection itself remains map-stable.
   */
  const selectVehicle =
    (vehicleId) => {
      selectedVehicleIdRef.current = vehicleId;
      setSelectedVehicleId(
        vehicleId
      );

      setSelectedStop(null);

      setFollowingVehicle(
        Boolean(vehicleId)
      );
    };


  const handleVehicleSelection =
    (event) => {
      selectVehicle(
        event.target.value
      );
    };


  /*
   * =======================================================
   * Select stop
   * =======================================================
   *
   * Stop selection highlights the stop, closes the panel,
   * and FocusStop moves the map to it.
   */
  const selectStop = (stopId) => {
    if (!stopId) {
      setSelectedStop(null);
      return;
    }

    const stop =
      stops.find(
        (item) =>
          String(item.stop_id) ===
          String(stopId)
      );

    setSelectedStop(stop || null);
  };


  const handleStopSelection =
    (event) => {
      selectStop(
        event.target.value
      );
    };


  /*
   * =======================================================
   * Follow toggle
   * =======================================================
   */
  const toggleFollowing = () => {
    setFollowingVehicle((current) => !current);
  };


  /*
   * =======================================================
   * Explicit map recenter
   * =======================================================
   */
  const handleRecenter = () => {
    setRecenterRequestId(
      (current) => current + 1
    );
  };


  /*
   * =======================================================
   * Selected vehicle information
   * =======================================================
   */

  const selectedVehicleStatus =
    selectedVehicle
      ? getVehicleStatus(
          selectedVehicle.timestamp,
          now
        )
      : null;

  const selectedSpeed = getDisplaySpeed(
    selectedVehicleStatus,
    selectedVehicle?.speed
  );
  const selectedSpeedDisplay = formatVehicleSpeed(selectedSpeed);

  const selectedVehicleLastUpdate =
    selectedVehicle
      ? formatTimeAgo(
          selectedVehicle.timestamp,
          now
        )
      : null;

  const etaData = calculateApproximateEtaMinutes(
    selectedVehicle,
    selectedStop,
    selectedVehicleStatus
  );

  const etaUnavailableMessage =
    selectedVehicleStatus === "Stale" ||
    selectedVehicleStatus === "Offline" ||
    selectedVehicleStatus === "Unknown"
      ? "ETA unavailable because the vehicle data is not current."
      : "ETA unavailable while the vehicle is stationary or its speed is unavailable.";


  /*
   * =======================================================
   * Connection label
   * =======================================================
   */
  const displayConnectionState =
    getDisplayConnectionState(
      connectionState,
      lastSuccessfulSync,
      now
    );

  const connectionLabel =
    displayConnectionState ===
    "live"
      ? "Live"
      : displayConnectionState ===
        "reconnecting"
      ? "Reconnecting"
      : displayConnectionState ===
        "offline"
      ? "Connection lost"
      : "Connecting";


  /*
   * =======================================================
   * Render
   * =======================================================
   */
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#f5f6f8",
      }}
    >
      <style>
        {`
          .top-control-panel {
            padding: 12px 16px;
            background: #ffffff;
            border-bottom: 1px solid #ddd;
            z-index: 1100;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 10px;
          }

          .search-form {
            display: flex;
            gap: 8px;
            align-items: center;
          }

          .control-input,
          .control-select {
            padding: 8px 10px;
            border: 1px solid #ccc;
            border-radius: 6px;
            background: #ffffff;
            font-size: 14px;
            outline: none;
          }

          .control-input {
            min-width: 190px;
          }

          .control-select {
            min-width: 210px;
          }

          .control-input:focus,
          .control-select:focus {
            border-color: #666;
          }

          .control-button {
            padding: 8px 14px;
            border: 1px solid #ccc;
            border-radius: 6px;
            background: #ffffff;
            cursor: pointer;
            font-size: 14px;
          }

          .control-button.primary {
            border-color: #222;
            background: #222;
            color: #ffffff;
          }

          .map-panel {
            position: absolute;
            left: 16px;
            top: 16px;
            width: 315px;
            max-height: calc(100% - 32px);
            overflow-y: auto;
            z-index: 1000;
            background: rgba(255, 255, 255, 0.97);
            border-radius: 10px;
            box-shadow: 0 3px 15px rgba(0, 0, 0, 0.18);
            padding: 14px;
          }

          .map-panel h3 {
            margin: 0 0 10px;
            font-size: 15px;
          }

          .map-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 10px;
          }

          .map-panel-header h3 {
            margin: 0;
          }

          .panel-toggle {
            padding: 5px 8px;
            border: 1px solid #ccc;
            border-radius: 5px;
            background: #ffffff;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
          }

          .vehicle-card {
            border: 1px solid #e1e1e1;
            border-radius: 8px;
            padding: 10px;
            margin-bottom: 8px;
            background: #ffffff;
          }

          .vehicle-card.selected {
            border-color: #333;
          }

          .vehicle-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 6px;
          }

          .vehicle-card-title {
            font-weight: 600;
            font-size: 14px;
          }

          .vehicle-card-meta {
            font-size: 12px;
            color: #666;
            line-height: 1.5;
          }

          .vehicle-card-actions {
            display: flex;
            gap: 6px;
            margin-top: 8px;
          }

          .small-button {
            padding: 6px 9px;
            border: 1px solid #ccc;
            border-radius: 5px;
            background: #ffffff;
            cursor: pointer;
            font-size: 12px;
          }

          .small-button.primary {
            border-color: #222;
            background: #222;
            color: #ffffff;
          }

          .stop-row {
            width: 100%;
            text-align: left;
            border: none;
            border-bottom: 1px solid #eee;
            padding: 8px 4px;
            background: transparent;
            cursor: pointer;
            font-size: 13px;
          }

          .stop-row:last-child {
            border-bottom: none;
          }

          .stop-row.selected {
            font-weight: 600;
            background: #f2f2f2;
            border-radius: 5px;
          }

          .stop-sequence {
            display: inline-block;
            width: 24px;
            color: #777;
          }

          .connection-indicator {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            padding: 6px 10px;
            border-radius: 999px;
            border: 1px solid #ddd;
            font-size: 13px;
            background: #ffffff;
          }

          .connection-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #6c757d;
          }

          .connection-dot.live {
            background: #198754;
          }

          .connection-dot.reconnecting {
            background: #d97706;
          }

          .connection-dot.offline {
            background: #dc3545;
          }

          .info-panel {
            position: absolute;
            right: 16px;
            bottom: 16px;
            width: 280px;
            z-index: 1000;
            background: rgba(255, 255, 255, 0.97);
            border-radius: 10px;
            box-shadow: 0 3px 15px rgba(0, 0, 0, 0.18);
            padding: 14px;
          }

          .info-row {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            padding: 6px 0;
            font-size: 13px;
            border-bottom: 1px solid #eee;
          }

          .info-row:last-child {
            border-bottom: none;
          }

          .info-label {
            color: #666;
          }

          .info-value {
            font-weight: 600;
            text-align: right;
          }

          .eta-box {
            margin-top: 10px;
            padding: 10px;
            border-radius: 7px;
            background: #f5f5f5;
          }

          .eta-title {
            font-size: 12px;
            color: #666;
            margin-bottom: 4px;
          }

          .eta-value {
            font-size: 20px;
            font-weight: 700;
          }

          .empty-state {
            color: #666;
            font-size: 13px;
            line-height: 1.5;
          }

          .status-message {
            margin-left: auto;
            font-size: 13px;
            color: #666;
          }

          @media (max-width: 768px) {
            .top-control-panel {
              padding: 10px;
            }

            .search-form {
              width: 100%;
            }

            .control-input {
              min-width: 0;
              flex: 1;
            }

            .control-select {
              min-width: 0;
              max-width: 100%;
            }

            .status-message {
              width: 100%;
              margin-left: 0;
            }

            .map-panel {
              left: 10px;
              right: 10px;
              top: auto;
              top: 10px;
              bottom: auto;
              width: auto;
              max-height: 42%;
            }

            .info-panel {
              left: 10px;
              right: 10px;
              bottom: 10px;
              width: auto;
              max-width: none;
            }
          }
        `}
      </style>


      {/* =================================================
          Top control panel
         ================================================= */}
      <div className="top-control-panel">
        <form
          onSubmit={handleSearch}
          className="search-form"
        >
          <input
            type="text"
            value={routeId}
            onChange={(event) =>
              setRouteId(
                event.target.value
              )
            }
            list="route-suggestions"
            placeholder="Enter route ID"
            className="control-input"
          />

          <datalist id="route-suggestions">
            {routes.map((route) => (
              <option
                key={route.route_id}
                value={route.route_id}
              >
                {route.route_name}
              </option>
            ))}
          </datalist>

          <button
            type="submit"
            className="control-button primary"
          >
            Search
          </button>
        </form>


        {searchRoute && (
          <button
            type="button"
            onClick={clearSearch}
            className="control-button"
          >
            Clear
          </button>
        )}


        {searchRoute && (
          <select
            value={selectedVehicleIdForRender}
            onChange={
              handleVehicleSelection
            }
            className="control-select"
          >
            <option value="">
              Select vehicle
            </option>

            {filteredVehicles.map(
              (vehicle) => (
                <option
                  key={
                    vehicle.vehicle_id
                  }
                  value={
                    vehicle.vehicle_id
                  }
                >
                  {vehicle.vehicle_id}
                </option>
              )
            )}
          </select>
        )}


        {searchRoute &&
          !stopsLoading &&
          stops.length > 0 && (
            <select
              value={
                selectedStop?.stop_id ||
                ""
              }
              onChange={
                handleStopSelection
              }
              className="control-select"
            >
              <option value="">
                Select stop
              </option>

              {sortedStops.map(
                (stop) => (
                  <option
                    key={stop.stop_id}
                    value={stop.stop_id}
                  >
                    {stop.stop_name}
                  </option>
                )
              )}
            </select>
          )}


        {selectedVehicle && (
          <button
            type="button"
            onClick={
              toggleFollowing
            }
            className="control-button"
          >
            {followingVehicle
              ? "Following Vehicle"
              : "Resume Following"}
          </button>
        )}


        <div className="connection-indicator">
          <span
            className={`connection-dot ${displayConnectionState}`}
          />
          <span>
            {connectionLabel}
          </span>
        </div>


        {lastSuccessfulSync && (
          <span className="status-message">
            Server sync:{" "}
            {formatTimeAgo(
              new Date(
                lastSuccessfulSync
              ).toISOString(),
              now
            )}
          </span>
        )}
      </div>


      {/* =================================================
          Map
         ================================================= */}
      <div
        style={{
          flex: 1,
          position: "relative",
        }}
      >
        <MapContainer
          center={MAP_CENTER}
          zoom={MAP_ZOOM}
          style={{
            width: "100%",
            height: "100%",
          }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />


          <RouteCenter
            vehicles={filteredVehicles}
            stops={sortedStops}
            searchRequestId={searchRequestId}
            disabled={Boolean(selectedVehicle)}
            programmaticMoveRef={programmaticMoveRef}
          />


          <MapController
            selectedVehicle={selectedVehicle}
            vehicles={visibleVehicles}
            stops={sortedStops}
            recenterRequestId={recenterRequestId}
            programmaticMoveRef={programmaticMoveRef}
          />


          <FollowVehicle
            vehicle={selectedVehicle}
            enabled={Boolean(selectedVehicle) && followingVehicle}
            onFollowingChange={setFollowingVehicle}
            programmaticMoveRef={programmaticMoveRef}
          />

          <FocusStop
            stop={selectedStop}
            programmaticMoveRef={programmaticMoveRef}
          />


          {visibleVehicles.map(
            (vehicle) => {
              const latitude =
                Number(
                  vehicle.latitude
                );

              const longitude =
                Number(
                  vehicle.longitude
                );

              if (
                !Number.isFinite(
                  latitude
                ) ||
                !Number.isFinite(
                  longitude
                )
              ) {
                return null;
              }

              const status =
                getVehicleStatus(
                  vehicle.timestamp,
                  now
                );

              const isSelected =
                String(vehicle.vehicle_id) ===
                String(selectedVehicleId);

              const vehicleSpeed = getDisplaySpeed(
                status,
                vehicle.speed
              );

              return (
                <Marker
                  key={
                    vehicle.vehicle_id
                  }
                  position={[
                    latitude,
                    longitude,
                  ]}
                  icon={vehicleIcon}
                >
                  <Popup>
                    <div
                      style={{
                        minWidth:
                          "180px",
                      }}
                    >
                      <div>
                        <strong>
                          Vehicle:
                        </strong>{" "}
                        {
                          vehicle.vehicle_id
                        }
                      </div>

                      <div>
                        <strong>
                          Route:
                        </strong>{" "}
                        {
                          vehicle.route_id
                        }
                      </div>

                      <div
                        style={{
                          marginTop:
                            "6px",
                        }}
                      >
                        <StatusBadge
                          status={
                            status
                          }
                        />
                      </div>

                      <div
                        style={{
                          marginTop:
                            "6px",
                        }}
                      >
                        <strong>
                          Speed:
                        </strong>{" "}
                        {formatVehicleSpeed(vehicleSpeed)}
                      </div>

                      <div>
                        <strong>
                          Updated:
                        </strong>{" "}
                        {formatTimeAgo(
                          vehicle.timestamp,
                          now
                        )}
                      </div>

                      {!isSelected && (
                        <button
                          type="button"
                          onClick={() =>
                            selectVehicle(
                              vehicle.vehicle_id
                            )
                          }
                          style={{
                            marginTop:
                              "8px",
                            padding:
                              "6px 9px",
                            border:
                              "1px solid #ccc",
                            borderRadius:
                              "5px",
                            background:
                              "#fff",
                            cursor:
                              "pointer",
                          }}
                        >
                          Track Vehicle
                        </button>
                      )}
                    </div>
                  </Popup>
                </Marker>
              );
            }
          )}


          {sortedStops.map((stop) => {
            const latitude = Number(stop.latitude);
            const longitude = Number(stop.longitude);

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
              return null;
            }

            const isSelected =
              String(selectedStop?.stop_id) === String(stop.stop_id);

            return (
              <CircleMarker
                key={stop.stop_id}
                center={[latitude, longitude]}
                radius={isSelected ? 10 : 6}
                pathOptions={{
                  color: isSelected ? "#0070f3" : "#555555",
                  fillColor: isSelected ? "#3291ff" : "#aaaaaa",
                  fillOpacity: isSelected ? 0.9 : 0.6,
                  weight: isSelected ? 3 : 1,
                }}
                eventHandlers={{
                  click: () => selectStop(stop.stop_id),
                }}
              >
                <Popup>
                  <div>
                    <strong>{stop.stop_name}</strong>
                    <div style={{ marginTop: "5px" }}>
                      Stop {stop.sequence}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>


        {/* =================================================
            Left-side route / vehicle panel
           ================================================= */}
        {searchRoute && (
          <div className="map-panel">
            <div className="map-panel-header">
              <h3>
                {selectedRoute
                  ? selectedRoute.route_name
                  : searchRoute}
              </h3>

              <button
                type="button"
                className="panel-toggle"
                onClick={() =>
                  setRoutePanelOpen((current) => !current)
                }
                aria-expanded={routePanelOpen}
                aria-label={
                  routePanelOpen
                    ? "Collapse route panel"
                    : "Expand route panel"
                }
              >
                {routePanelOpen ? "Hide" : "Show"}
              </button>
            </div>

            {routePanelOpen && (
              <>

            <div
              style={{
                fontSize:
                  "12px",
                color: "#666",
                marginBottom:
                  "12px",
              }}
            >
              Route:{" "}
              <strong>
                {searchRoute}
              </strong>
            </div>


            {locationsLoading && (
              <div className="empty-state">
                Loading vehicle
                locations...
              </div>
            )}


            {!locationsLoading &&
              error && (
                <div
                  className="empty-state"
                  style={{
                    color:
                      "#dc3545",
                    marginBottom:
                      "10px",
                  }}
                >
                  {error}
                </div>
              )}


            {!locationsLoading &&
              filteredVehicles.length ===
                0 &&
              !error && (
                <div className="empty-state">
                  No active vehicles
                  found on this route.
                </div>
              )}


            {filteredVehicles.length >
              0 && (
                <>
                  <div
                    style={{
                      fontSize:
                        "12px",
                      color:
                        "#666",
                      marginBottom:
                        "8px",
                    }}
                  >
                    {
                      filteredVehicles.length
                    }{" "}
                    active vehicle
                    {filteredVehicles.length !==
                    1
                      ? "s"
                      : ""}
                  </div>

                  {filteredVehicles.map(
                    (vehicle) => {
                      const status =
                        getVehicleStatus(
                          vehicle.timestamp,
                          now
                        );

                      const speed = getDisplaySpeed(
                        status,
                        vehicle.speed
                      );

                      const isSelected =
                        String(vehicle.vehicle_id) ===
                        String(selectedVehicleId);

                      return (
                        <div
                          key={
                            vehicle.vehicle_id
                          }
                          className={`vehicle-card ${
                            isSelected
                              ? "selected"
                              : ""
                          }`}
                        >
                          <div className="vehicle-card-header">
                            <div className="vehicle-card-title">
                              {
                                vehicle.vehicle_id
                              }
                            </div>

                            <StatusBadge
                              status={
                                status
                              }
                            />
                          </div>

                          <div className="vehicle-card-meta">
                            Speed:{" "}
                            {formatVehicleSpeed(speed)}
                          </div>

                          <div className="vehicle-card-meta">
                            Updated:{" "}
                            {formatTimeAgo(
                              vehicle.timestamp,
                              now
                            )}
                          </div>

                          <div className="vehicle-card-actions">
                            <button
                              type="button"
                              className={`small-button ${
                                isSelected
                                  ? "primary"
                                  : ""
                              }`}
                              onClick={() =>
                                selectVehicle(
                                  vehicle.vehicle_id
                                )
                              }
                            >
                              {isSelected
                                ? "Selected"
                                : "Track"}
                            </button>
                          </div>
                        </div>
                      );
                    }
                  )}
                </>
              )}


            {sortedStops.length >
              0 && (
                <div
                  style={{
                    marginTop:
                      "14px",
                  }}
                >
                  <h3>
                    Route Stops
                  </h3>

                  {stopError && (
                    <div
                      className="empty-state"
                      style={{
                        color:
                          "#dc3545",
                        marginBottom:
                          "8px",
                      }}
                    >
                      {stopError}
                    </div>
                  )}

                  {sortedStops.map(
                    (stop) => {
                      const isSelected =
                        String(selectedStop?.stop_id) ===
                        String(stop.stop_id);

                      return (
                        <button
                          key={
                            stop.stop_id
                          }
                          type="button"
                          className={`stop-row ${
                            isSelected
                              ? "selected"
                              : ""
                          }`}
                          onClick={() =>
                            selectStop(
                              stop.stop_id
                            )
                          }
                        >
                          <span className="stop-sequence">
                            {
                              stop.sequence
                            }.
                          </span>

                          {
                            stop.stop_name
                          }
                        </button>
                      );
                    }
                  )}
                </div>
              )}


            {selectedStop && (
              <div
                style={{
                  marginTop:
                    "12px",
                  padding:
                    "10px",
                  border:
                    "1px solid #ddd",
                  borderRadius:
                    "7px",
                  background:
                    "#fafafa",
                }}
              >
                <div
                  style={{
                    fontSize:
                      "12px",
                    color:
                      "#666",
                    marginBottom:
                      "4px",
                  }}
                >
                  Selected stop
                </div>

                <div
                  style={{
                    fontWeight:
                      600,
                  }}
                >
                  {
                    selectedStop.stop_name
                  }
                </div>

                <div
                  style={{
                    fontSize:
                      "12px",
                    color:
                      "#666",
                    marginTop:
                      "3px",
                  }}
                >
                  Stop{" "}
                  {
                    selectedStop.sequence
                  }
                </div>
              </div>
            )}
              </>
            )}
          </div>
        )}


        {/* =================================================
            Explicit map control
           ================================================= */}
        {(selectedVehicle ||
          visibleVehicles.length >
            0) && (
          <button
            type="button"
            onClick={
              handleRecenter
            }
            className="control-button"
            style={{
              position:
                "absolute",
              right: "16px",
              top: "16px",
              zIndex: 1000,
              boxShadow:
                "0 2px 8px rgba(0,0,0,0.15)",
            }}
          >
            {selectedVehicle
              ? "Recenter Vehicle"
              : "Fit Vehicles"}
          </button>
        )}


        {/* =================================================
            Selected vehicle information
           ================================================= */}
        {selectedVehicle && (
          <div className="info-panel">
            <div
              style={{
                display:
                  "flex",
                justifyContent:
                  "space-between",
                alignItems:
                  "center",
                gap: "8px",
                marginBottom:
                  "8px",
              }}
            >
              <strong>
                {
                  selectedVehicle.vehicle_id
                }
              </strong>

              <StatusBadge
                status={
                  selectedVehicleStatus
                }
              />
            </div>

            <div
              style={{
                fontSize:
                  "12px",
                color:
                  "#666",
                marginBottom:
                  "6px",
              }}
            >
              Route:{" "}
              {
                selectedVehicle.route_id
              }
            </div>


            <div className="info-row">
              <span className="info-label">
                Speed
              </span>

              <span className="info-value">
                {selectedSpeedDisplay}
              </span>
            </div>


            <div className="info-row">
              <span className="info-label">
                Last update
              </span>

              <span className="info-value">
                {
                  selectedVehicleLastUpdate
                }
              </span>
            </div>


            <div className="info-row">
              <span className="info-label">
                Following
              </span>

              <span className="info-value">
                {followingVehicle
                  ? "Yes"
                  : "No"}
              </span>
            </div>


            {selectedStop && (
              <div className="eta-box">
                <div className="eta-title">
                  Approximate ETA to
                  {" "}
                  {
                    selectedStop.stop_name
                  }
                </div>

                {etaData ? (
                  <>
                    <div className="eta-value">
                      {etaData.minutes <
                      1
                        ? "Under 1 min"
                        : `${Math.round(
                            etaData.minutes
                          )} min`}
                    </div>

                    <div
                      style={{
                        fontSize:
                          "12px",
                        color:
                          "#666",
                        marginTop:
                          "3px",
                      }}
                    >
                      About{" "}
                      {etaData.distanceKm.toFixed(
                        2
                      )} km away
                    </div>
                  </>
                ) : (
                  <div
                    style={{
                      fontSize:
                        "13px",
                      color:
                        "#666",
                    }}
                  >
                    {etaUnavailableMessage}
                  </div>
                )}

                {etaData &&
                  selectedVehicleStatus === "Stale" && (
                    <div
                      style={{
                        fontSize:
                          "12px",
                        color:
                          "#a15c00",
                        marginTop:
                          "6px",
                      }}
                    >
                      Vehicle data is stale; this estimate may be outdated.
                    </div>
                  )}

                <div
                  style={{
                    fontSize:
                      "11px",
                    color:
                      "#888",
                    marginTop:
                      "6px",
                  }}
                >
                  ETA is based on
                  current speed
                  and straight-line
                  distance.
                </div>
              </div>
            )}
          </div>
        )}


        {/* =================================================
            General errors when no route is selected
           ================================================= */}
        {!searchRoute &&
          error && (
            <div
              style={{
                position:
                  "absolute",
                left: "16px",
                top: "16px",
                zIndex: 1000,
                background:
                  "#ffffff",
                padding:
                  "10px 12px",
                borderRadius:
                  "7px",
                boxShadow:
                  "0 2px 10px rgba(0,0,0,0.15)",
                color:
                  "#dc3545",
                maxWidth:
                  "320px",
                fontSize:
                  "13px",
              }}
            >
              {error}
            </div>
          )}
      </div>
    </div>
  );
}

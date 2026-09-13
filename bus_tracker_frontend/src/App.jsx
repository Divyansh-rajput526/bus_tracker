import { useEffect, useState, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "./fix-icon";

const API_URL = "http://localhost:8080/get-locations";
const MAP_CENTER = [27.239337, 77.84];
const MAP_ZOOM = 13;
const POLLING_INTERVAL = 2000;

// Helper to center the map on actual buses once loaded
function AutoCenter({ buses }) {
  const map = useMap();
  const hasCentered = useRef(false);

  useEffect(() => {
    if (!hasCentered.current && buses.length > 0) {
      const bounds = buses.map((b) => [b.latitude, b.longitude]);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
      hasCentered.current = true;
    }
  }, [buses, map]);

  return null;
}

export default function App() {
  const [buses, setBuses] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;
    let timerId = null;

    const fetchLocations = async () => {
      try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error("Backend connection failed");
        const data = await response.json();

        if (isMounted) {
          setBuses(data);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message);
        }
      } finally {
        // Schedule next call only after current request completes
        if (isMounted) {
          timerId = setTimeout(fetchLocations, POLLING_INTERVAL);
        }
      }
    };

    fetchLocations();

    return () => {
      isMounted = false;
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      {/* Floating Status Bar */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 60,
          zIndex: 1000,
          background: "white",
          padding: "8px 16px",
          borderRadius: 8,
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          fontFamily: "system-ui, sans-serif",
          fontSize: "14px",
        }}
      >
        <strong>Active Buses:</strong> {buses.length}
        {error && <span style={{ color: "crimson", marginLeft: 10 }}>({error})</span>}
      </div>

      <MapContainer
        center={MAP_CENTER}
        zoom={MAP_ZOOM}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <AutoCenter buses={buses} />

        {buses.map((bus) => (
          <Marker key={bus.bus_id} position={[bus.latitude, bus.longitude]}>
            <Popup>
              <div style={{ fontFamily: "system-ui, sans-serif" }}>
                <h4 style={{ margin: "0 0 6px" }}>🚌 Bus: {bus.bus_id}</h4>
                <p style={{ margin: "2px 0" }}>
                  <strong>Speed:</strong> {bus.speed.toFixed(1)} km/h
                </p>
                <p style={{ margin: "2px 0", color: "#666", fontSize: "12px" }}>
                  Last ping: {new Date(bus.timestamp).toLocaleTimeString()}
                </p>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
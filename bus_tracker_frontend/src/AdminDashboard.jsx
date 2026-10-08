import { useEffect, useState, useTransition } from "react";
import {
  assignVehicleRoute,
  clearStoredAdminToken,
  createAdminRoute,
  createAdminStop,
  createAdminVehicle,
  createDeviceEnrollment,
  deleteAdminRoute,
  deleteAdminStop,
  deleteAdminVehicle,
  fetchAdminVehicles,
  fetchRoutes,
  fetchRouteStops,
  fetchVehicleDevices,
  getStoredAdminToken,
  revokeDevice,
  setStoredAdminToken,
  updateAdminRoute,
  updateAdminStop,
  updateVehicleStatus,
} from "./adminApi.js";
import {
  filterVehiclesByStatus,
  formatAdminError,
  formatDeviceExpiry,
  getDeviceStatusBadge,
  getVehicleDeviceRule,
  getVehicleStatusBadge,
  isDeviceExpired,
  isValidCoordinate,
} from "./adminPresentation.js";

export default function AdminDashboard({ onBackToMap, apiBaseUrl }) {
  // Navigation tabs: "vehicles" | "routes"
  const [activeTab, setActiveTab] = useState("vehicles");

  // Authentication state
  const [token, setToken] = useState(() => getStoredAdminToken());
  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Global routes list (used in both vehicles tab for assignment and routes tab)
  const [allRoutes, setAllRoutes] = useState([]);

  // =========================================================
  // Vehicles State
  // =========================================================
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [vehiclesError, setVehiclesError] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [vehicleStatusFilter, setVehicleStatusFilter] = useState("active_deactivated");

  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [devices, setDevices] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState("");

  // Create vehicle modal state
  const [showCreateVehicleModal, setShowCreateVehicleModal] = useState(false);
  const [newVehicleId, setNewVehicleId] = useState("");
  const [newVehicleName, setNewVehicleName] = useState("");
  const [createVehicleLoading, setCreateVehicleLoading] = useState(false);
  const [createVehicleError, setCreateVehicleError] = useState("");

  // Vehicle lifecycle update state
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleMessage, setLifecycleMessage] = useState(null); // { type: 'success' | 'error', text: '' }

  // Vehicle deletion modal state
  const [vehicleToDelete, setVehicleToDelete] = useState(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleteVehicleLoading, setDeleteVehicleLoading] = useState(false);
  const [deleteVehicleError, setDeleteVehicleError] = useState("");

  // Vehicle route assignment state
  const [selectedRouteOverride, setSelectedRouteOverride] = useState(null);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignMessage, setAssignMessage] = useState(null);

  // Device enrollment state
  const [deviceLabelInput, setDeviceLabelInput] = useState("");
  const [enrollLoading, setEnrollLoading] = useState(false);
  const [enrollError, setEnrollError] = useState("");

  // Newly enrolled pairing result modal
  const [newEnrollment, setNewEnrollment] = useState(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Device revocation modal
  const [deviceToRevoke, setDeviceToRevoke] = useState(null);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  // Vehicle retirement confirmation modal
  const [confirmRetireVehicle, setConfirmRetireVehicle] = useState(false);

  // =========================================================
  // Routes & Stops State
  // =========================================================
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routesError, setRoutesError] = useState("");
  const [routeFilterQuery, setRouteFilterQuery] = useState("");

  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [stops, setStops] = useState([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopsError, setStopsError] = useState("");

  // Create route modal
  const [showCreateRouteModal, setShowCreateRouteModal] = useState(false);
  const [newRouteId, setNewRouteId] = useState("");
  const [newRouteName, setNewRouteName] = useState("");
  const [createRouteLoading, setCreateRouteLoading] = useState(false);
  const [createRouteError, setCreateRouteError] = useState("");

  // Edit route modal
  const [showEditRouteModal, setShowEditRouteModal] = useState(false);
  const [editRouteName, setEditRouteName] = useState("");
  const [editRouteLoading, setEditRouteLoading] = useState(false);
  const [editRouteError, setEditRouteError] = useState("");

  // Delete route confirmation modal
  const [showDeleteRouteModal, setShowDeleteRouteModal] = useState(false);
  const [deleteRouteLoading, setDeleteRouteLoading] = useState(false);
  const [deleteRouteError, setDeleteRouteError] = useState("");

  // Stop Create / Edit modal
  const [stopModalMode, setStopModalMode] = useState(null); // 'create' | 'edit' | null
  const [stopFormId, setStopFormId] = useState("");
  const [stopFormName, setStopFormName] = useState("");
  const [stopFormLat, setStopFormLat] = useState("");
  const [stopFormLng, setStopFormLng] = useState("");
  const [stopFormSequence, setStopFormSequence] = useState(1);
  const [stopFormLoading, setStopFormLoading] = useState(false);
  const [stopFormError, setStopFormError] = useState("");

  // Delete stop modal
  const [stopToDelete, setStopToDelete] = useState(null);
  const [deleteStopLoading, setDeleteStopLoading] = useState(false);
  const [deleteStopError, setDeleteStopError] = useState("");

  const [, startTransition] = useTransition();

  const handleUnauthorized = (err) => {
    setStoredAdminToken("");
    setToken("");
    setAuthError(formatAdminError(err));
  };

  // =========================================================
  // Authentication
  // =========================================================
  const handleSignIn = async (e) => {
    if (e) e.preventDefault();
    const candidate = tokenInput.trim();
    if (!candidate) {
      setAuthError("Please enter an admin token.");
      return;
    }

    setAuthLoading(true);
    setAuthError("");

    try {
      const data = await fetchAdminVehicles(candidate, apiBaseUrl);
      setStoredAdminToken(candidate);
      setToken(candidate);
      setVehicles(data);
      if (data.length > 0) {
        setSelectedVehicleId(data[0].vehicle_id);
      }
      // Load routes
      const rList = await fetchRoutes(apiBaseUrl);
      setAllRoutes(rList || []);
      if (rList && rList.length > 0) {
        setSelectedRouteId(rList[0].route_id);
      }
    } catch (err) {
      setAuthError(formatAdminError(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = () => {
    clearStoredAdminToken();
    setToken("");
    setVehicles([]);
    setDevices([]);
    setSelectedVehicleId("");
    setAllRoutes([]);
    setSelectedRouteId("");
    setStops([]);
    setAuthError("");
  };

  // =========================================================
  // Data Loaders
  // =========================================================
  const loadVehicles = async (overrideToken = token) => {
    if (!overrideToken) return;
    setVehiclesLoading(true);
    setVehiclesError("");
    try {
      const list = await fetchAdminVehicles(overrideToken, apiBaseUrl);
      setVehicles(list);
      setSelectedVehicleId((prev) => {
        if (!prev) {
          return list.length > 0 ? list[0].vehicle_id : "";
        }
        const stillExists = list.some((v) => v.vehicle_id === prev);
        if (stillExists) return prev;
        return list.length > 0 ? list[0].vehicle_id : "";
      });
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setVehiclesError(formatAdminError(err));
      }
    } finally {
      setVehiclesLoading(false);
    }
  };

  const loadRoutes = async () => {
    setRoutesLoading(true);
    setRoutesError("");
    try {
      const list = await fetchRoutes(apiBaseUrl);
      setAllRoutes(list || []);
      if (list && list.length > 0 && !selectedRouteId) {
        setSelectedRouteId(list[0].route_id);
      }
    } catch (err) {
      setRoutesError(formatAdminError(err));
    } finally {
      setRoutesLoading(false);
    }
  };

  const loadDevices = async (vehicleId = selectedVehicleId) => {
    if (!token || !vehicleId) {
      setDevices([]);
      return;
    }
    setDevicesLoading(true);
    setDevicesError("");
    try {
      const list = await fetchVehicleDevices(token, vehicleId, apiBaseUrl);
      setDevices(list || []);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setDevicesError(formatAdminError(err));
      }
    } finally {
      setDevicesLoading(false);
    }
  };

  const loadStops = async (routeId = selectedRouteId) => {
    if (!routeId) {
      setStops([]);
      return;
    }
    setStopsLoading(true);
    setStopsError("");
    try {
      const list = await fetchRouteStops(routeId, apiBaseUrl);
      setStops(list || []);
    } catch (err) {
      setStopsError(formatAdminError(err));
    } finally {
      setStopsLoading(false);
    }
  };

  // Initial load when token is present
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    (async () => {
      try {
        const [vList, rList] = await Promise.all([
          fetchAdminVehicles(token, apiBaseUrl),
          fetchRoutes(apiBaseUrl).catch(() => []),
        ]);
        if (!cancelled) {
          setVehicles(vList || []);
          if (vList && vList.length > 0) {
            setSelectedVehicleId((prev) => prev || vList[0].vehicle_id);
          }
          setAllRoutes(rList || []);
          if (rList && rList.length > 0) {
            setSelectedRouteId((prev) => prev || rList[0].route_id);
          }
        }
      } catch (err) {
        if (!cancelled) {
          if (err.isUnauthorized || err.status === 401) {
            handleUnauthorized(err);
          } else {
            setVehiclesError(formatAdminError(err));
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, apiBaseUrl]);

  // Load devices on vehicle change
  useEffect(() => {
    if (!token || !selectedVehicleId) return;
    let cancelled = false;

    (async () => {
      try {
        const list = await fetchVehicleDevices(token, selectedVehicleId, apiBaseUrl);
        if (!cancelled) {
          setDevices(list || []);
        }
      } catch (err) {
        if (!cancelled) {
          if (err.isUnauthorized || err.status === 401) {
            handleUnauthorized(err);
          } else {
            setDevicesError(formatAdminError(err));
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedVehicleId, token, apiBaseUrl]);

  // Load stops on route change
  useEffect(() => {
    if (!selectedRouteId) return;
    let cancelled = false;

    (async () => {
      try {
        const list = await fetchRouteStops(selectedRouteId, apiBaseUrl);
        if (!cancelled) {
          setStops(list || []);
        }
      } catch (err) {
        if (!cancelled) {
          setStopsError(formatAdminError(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedRouteId, apiBaseUrl]);

  // =========================================================
  // Vehicle Actions
  // =========================================================
  const handleCreateVehicle = async (e) => {
    if (e) e.preventDefault();
    const vId = newVehicleId.trim().toUpperCase();
    if (!vId) {
      setCreateVehicleError("Vehicle ID is required.");
      return;
    }

    setCreateVehicleLoading(true);
    setCreateVehicleError("");
    try {
      const created = await createAdminVehicle(
        token,
        vId,
        newVehicleName.trim() || null,
        apiBaseUrl
      );
      setShowCreateVehicleModal(false);
      setNewVehicleId("");
      setNewVehicleName("");
      await loadVehicles(token);
      setSelectedVehicleId(created.vehicle_id);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setCreateVehicleError(formatAdminError(err));
      }
    } finally {
      setCreateVehicleLoading(false);
    }
  };

  const handleUpdateVehicleStatus = async (newStatus) => {
    if (!selectedVehicleId) return;
    setLifecycleLoading(true);
    setLifecycleMessage(null);
    try {
      const updated = await updateVehicleStatus(token, selectedVehicleId, newStatus, apiBaseUrl);
      setLifecycleMessage({
        type: "success",
        text: `Vehicle status successfully updated to "${updated.status}".`,
      });
      if (newStatus === "retired") {
        setNewEnrollment(null);
      }
      await loadVehicles(token);
      await loadDevices(selectedVehicleId);
      setConfirmRetireVehicle(false);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setLifecycleMessage({
          type: "error",
          text: formatAdminError(err),
        });
      }
    } finally {
      setLifecycleLoading(false);
    }
  };

  const handleDeleteVehicle = async (e) => {
    if (e) e.preventDefault();
    if (!vehicleToDelete) return;

    if (deleteConfirmInput.trim().toUpperCase() !== vehicleToDelete.vehicle_id.toUpperCase()) {
      setDeleteVehicleError(`Please type "${vehicleToDelete.vehicle_id}" exactly to confirm deletion.`);
      return;
    }

    setDeleteVehicleLoading(true);
    setDeleteVehicleError("");
    try {
      await deleteAdminVehicle(token, vehicleToDelete.vehicle_id, apiBaseUrl);
      const deletedId = vehicleToDelete.vehicle_id;
      setVehicleToDelete(null);
      setDeleteConfirmInput("");
      setLifecycleMessage({
        type: "success",
        text: `Vehicle "${deletedId}" was permanently deleted.`,
      });
      if (selectedVehicleId === deletedId) {
        setSelectedVehicleId("");
      }
      await loadVehicles(token);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setDeleteVehicleError(formatAdminError(err));
      }
    } finally {
      setDeleteVehicleLoading(false);
    }
  };

  const handleAssignRoute = async (e) => {
    if (e) e.preventDefault();
    if (!selectedRouteForAssign) {
      setAssignMessage({ type: "error", text: "Please select a route to assign." });
      return;
    }

    setAssignLoading(true);
    setAssignMessage(null);
    try {
      await assignVehicleRoute(token, selectedVehicleId, selectedRouteForAssign, apiBaseUrl);
      setAssignMessage({
        type: "success",
        text: `Vehicle ${selectedVehicleId} successfully assigned to route ${selectedRouteForAssign}.`,
      });
      await loadVehicles(token);
      setSelectedRouteOverride(null);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setAssignMessage({
          type: "error",
          text: formatAdminError(err),
        });
      }
    } finally {
      setAssignLoading(false);
    }
  };

  // Device actions
  const handleEnrollDevice = async (e) => {
    if (e) e.preventDefault();
    if (!deviceLabelInput.trim()) {
      setEnrollError("Device label is required.");
      return;
    }

    setEnrollLoading(true);
    setEnrollError("");
    try {
      const result = await createDeviceEnrollment(
        token,
        selectedVehicleId,
        deviceLabelInput.trim(),
        apiBaseUrl
      );
      setNewEnrollment(result);
      setCopiedCode(false);
      setDeviceLabelInput("");
      await loadDevices(selectedVehicleId);
      await loadVehicles(token);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setEnrollError(formatAdminError(err));
      }
    } finally {
      setEnrollLoading(false);
    }
  };

  const handleConfirmRevoke = async () => {
    if (!deviceToRevoke) return;
    setRevokeLoading(true);
    setRevokeError("");
    try {
      await revokeDevice(token, deviceToRevoke.device_id, apiBaseUrl);
      setDeviceToRevoke(null);
      await loadDevices(selectedVehicleId);
      await loadVehicles(token);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setRevokeError(formatAdminError(err));
      }
    } finally {
      setRevokeLoading(false);
    }
  };

  const handleCopyCode = async (code) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 3000);
      }
    } catch {
      // Fallback
    }
  };

  // =========================================================
  // Route Actions
  // =========================================================
  const handleCreateRoute = async (e) => {
    if (e) e.preventDefault();
    const rId = newRouteId.trim().toUpperCase();
    const rName = newRouteName.trim();
    if (!rId) {
      setCreateRouteError("Route ID is required.");
      return;
    }
    if (!rName) {
      setCreateRouteError("Route name is required.");
      return;
    }

    setCreateRouteLoading(true);
    setCreateRouteError("");
    try {
      const created = await createAdminRoute(token, rId, rName, apiBaseUrl);
      setShowCreateRouteModal(false);
      setNewRouteId("");
      setNewRouteName("");
      await loadRoutes();
      setSelectedRouteId(created.route_id);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setCreateRouteError(formatAdminError(err));
      }
    } finally {
      setCreateRouteLoading(false);
    }
  };

  const handleUpdateRouteName = async (e) => {
    if (e) e.preventDefault();
    if (!editRouteName.trim()) {
      setEditRouteError("Route name cannot be empty.");
      return;
    }

    setEditRouteLoading(true);
    setEditRouteError("");
    try {
      await updateAdminRoute(token, selectedRouteId, editRouteName.trim(), apiBaseUrl);
      setShowEditRouteModal(false);
      await loadRoutes();
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setEditRouteError(formatAdminError(err));
      }
    } finally {
      setEditRouteLoading(false);
    }
  };

  const handleDeleteRoute = async () => {
    if (!selectedRouteId) return;
    setDeleteRouteLoading(true);
    setDeleteRouteError("");
    try {
      await deleteAdminRoute(token, selectedRouteId, apiBaseUrl);
      setShowDeleteRouteModal(false);
      setSelectedRouteId("");
      await loadRoutes();
      await loadVehicles(token);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setDeleteRouteError(formatAdminError(err));
      }
    } finally {
      setDeleteRouteLoading(false);
    }
  };

  // =========================================================
  // Stop Actions
  // =========================================================
  const openCreateStopModal = () => {
    setStopModalMode("create");
    setStopFormId("");
    setStopFormName("");
    setStopFormLat("");
    setStopFormLng("");
    setStopFormSequence(stops.length + 1);
    setStopFormError("");
  };

  const openEditStopModal = (stop) => {
    setStopModalMode("edit");
    setStopFormId(stop.stop_id);
    setStopFormName(stop.stop_name);
    setStopFormLat(String(stop.latitude));
    setStopFormLng(String(stop.longitude));
    setStopFormSequence(stop.sequence);
    setStopFormError("");
  };

  const handleSaveStop = async (e) => {
    if (e) e.preventDefault();
    const sId = stopFormId.trim().toUpperCase();
    const sName = stopFormName.trim();
    const lat = parseFloat(stopFormLat);
    const lng = parseFloat(stopFormLng);
    const seq = parseInt(stopFormSequence, 10);

    if (!sId) {
      setStopFormError("Stop ID is required.");
      return;
    }
    if (!sName) {
      setStopFormError("Stop Name is required.");
      return;
    }
    if (!isValidCoordinate(lat, lng)) {
      setStopFormError("Invalid coordinates: Latitude must be between -90 and 90, Longitude between -180 and 180.");
      return;
    }
    if (isNaN(seq) || seq < 1) {
      setStopFormError("Sequence must be a positive number.");
      return;
    }

    setStopFormLoading(true);
    setStopFormError("");

    try {
      const stopData = {
        stop_id: sId,
        stop_name: sName,
        latitude: lat,
        longitude: lng,
        sequence: seq,
      };

      if (stopModalMode === "create") {
        await createAdminStop(token, selectedRouteId, stopData, apiBaseUrl);
      } else {
        await updateAdminStop(token, selectedRouteId, sId, stopData, apiBaseUrl);
      }

      setStopModalMode(null);
      await loadStops(selectedRouteId);
      await loadRoutes();
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setStopFormError(formatAdminError(err));
      }
    } finally {
      setStopFormLoading(false);
    }
  };

  const handleMoveStop = async (stop, direction) => {
    const targetSeq = direction === "up" ? stop.sequence - 1 : stop.sequence + 1;
    if (targetSeq < 1 || targetSeq > stops.length) return;

    try {
      await updateAdminStop(
        token,
        selectedRouteId,
        stop.stop_id,
        {
          stop_name: stop.stop_name,
          latitude: stop.latitude,
          longitude: stop.longitude,
          sequence: targetSeq,
        },
        apiBaseUrl
      );
      await loadStops(selectedRouteId);
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setStopsError(formatAdminError(err));
      }
    }
  };

  const handleDeleteStop = async () => {
    if (!stopToDelete) return;
    setDeleteStopLoading(true);
    setDeleteStopError("");
    try {
      await deleteAdminStop(token, selectedRouteId, stopToDelete.stop_id, apiBaseUrl);
      setStopToDelete(null);
      await loadStops(selectedRouteId);
      await loadRoutes();
    } catch (err) {
      if (err.isUnauthorized || err.status === 401) {
        handleUnauthorized(err);
      } else {
        setDeleteStopError(formatAdminError(err));
      }
    } finally {
      setDeleteStopLoading(false);
    }
  };

  // Filtered views
  const selectedVehicle = vehicles.find((v) => v.vehicle_id === selectedVehicleId);
  const selectedRouteForAssign =
    selectedRouteOverride !== null
      ? selectedRouteOverride
      : selectedVehicle?.route_id || "";
  const activeDevice = devices.find((d) => d.status === "active");
  const pendingDevice = devices.find(
    (d) => d.status === "pending" && !isDeviceExpired(d.pairing_expires_at)
  );
  const revokedDevices = devices.filter(
    (d) => d.status === "revoked" || (d.status === "pending" && isDeviceExpired(d.pairing_expires_at))
  );
  const enrollmentRule = getVehicleDeviceRule(selectedVehicle, devices);

  // Status counts for vehicles
  const countAll = vehicles.length;
  const countActive = vehicles.filter((v) => (v.status || "").toLowerCase() === "active").length;
  const countDeactivated = vehicles.filter((v) => (v.status || "").toLowerCase() === "deactivated").length;
  const countRetired = vehicles.filter((v) => (v.status || "").toLowerCase() === "retired").length;
  const countActiveAndDeactivated = vehicles.filter((v) => {
    const s = (v.status || "").toLowerCase();
    return s !== "retired";
  }).length;

  const statusFilteredVehicles = filterVehiclesByStatus(vehicles, vehicleStatusFilter);
  const filteredVehicles = statusFilteredVehicles.filter((v) => {
    if (!filterQuery.trim()) return true;
    const q = filterQuery.toLowerCase();
    return (
      v.vehicle_id.toLowerCase().includes(q) ||
      (v.display_name && v.display_name.toLowerCase().includes(q)) ||
      (v.route_id && v.route_id.toLowerCase().includes(q))
    );
  });

  const selectedRoute = allRoutes.find((r) => r.route_id === selectedRouteId);
  const filteredRoutes = allRoutes.filter((r) => {
    if (!routeFilterQuery.trim()) return true;
    const q = routeFilterQuery.toLowerCase();
    return (
      r.route_id.toLowerCase().includes(q) ||
      r.route_name.toLowerCase().includes(q)
    );
  });

  /*
   * =========================================================
   * Render Sign In View if not authenticated
   * =========================================================
   */
  if (!token) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "#f4f6f9",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            padding: "12px 20px",
            background: "#ffffff",
            borderBottom: "1px solid #ddd",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "18px", fontWeight: "bold" }}>Vehicle Tracker</span>
            <span
              style={{
                fontSize: "12px",
                background: "#222",
                color: "#fff",
                padding: "2px 8px",
                borderRadius: "4px",
                fontWeight: 600,
              }}
            >
              ADMIN
            </span>
          </div>

          <button
            type="button"
            onClick={onBackToMap}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "7px 14px",
              fontSize: "13px",
              cursor: "pointer",
              borderRadius: "6px",
              border: "1px solid #ccc",
              background: "#ffffff",
            }}
          >
            ← Back to Live Map
          </button>
        </div>

        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "420px",
              background: "#ffffff",
              padding: "32px 28px",
              borderRadius: "12px",
              boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
              border: "1px solid #e1e4e8",
            }}
          >
            <div style={{ textAlign: "center", marginBottom: "24px" }}>
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "50%",
                  background: "#f0f2f5",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "24px",
                  marginBottom: "12px",
                }}
              >
                🔐
              </div>
              <h2 style={{ margin: "0 0 6px", fontSize: "20px", color: "#111" }}>
                Admin Authentication
              </h2>
              <p style={{ margin: 0, fontSize: "13px", color: "#666", lineHeight: 1.5 }}>
                Enter your administrative bearer token to access vehicle, device, and route management.
              </p>
            </div>

            {authError && (
              <div
                style={{
                  background: "#fff2f2",
                  border: "1px solid #ffc9c9",
                  color: "#d32f2f",
                  padding: "10px 12px",
                  borderRadius: "6px",
                  fontSize: "13px",
                  marginBottom: "18px",
                  lineHeight: 1.4,
                }}
              >
                {authError}
              </div>
            )}

            <form onSubmit={handleSignIn}>
              <div style={{ marginBottom: "18px" }}>
                <label
                  htmlFor="admin-token-input"
                  style={{
                    display: "block",
                    fontSize: "13px",
                    fontWeight: 600,
                    marginBottom: "6px",
                    color: "#333",
                  }}
                >
                  Admin Token
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    id="admin-token-input"
                    type={showToken ? "text" : "password"}
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Paste ADMIN_TOKEN"
                    autoComplete="off"
                    autoFocus
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "10px 42px 10px 12px",
                      borderRadius: "6px",
                      border: "1px solid #ccc",
                      fontSize: "14px",
                      fontFamily: "monospace",
                      outline: "none",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    style={{
                      position: "absolute",
                      right: "8px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      fontSize: "13px",
                      color: "#666",
                      padding: "4px",
                    }}
                    title={showToken ? "Hide token" : "Show token"}
                  >
                    {showToken ? "🙈" : "👁️"}
                  </button>
                </div>
                <div style={{ fontSize: "11px", color: "#888", marginTop: "5px" }}>
                  Token will only be stored in your browser session storage.
                </div>
              </div>

              <button
                type="submit"
                disabled={authLoading}
                style={{
                  width: "100%",
                  padding: "10px 16px",
                  background: authLoading ? "#666" : "#222",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "14px",
                  fontWeight: 600,
                  cursor: authLoading ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                }}
              >
                {authLoading ? "Validating token..." : "Sign In to Admin Portal"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  /*
   * =========================================================
   * Render Authenticated Admin Dashboard
   * =========================================================
   */
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#f4f6f9",
        overflow: "hidden",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      {/* Top Navbar */}
      <header
        style={{
          padding: "10px 20px",
          background: "#ffffff",
          borderBottom: "1px solid #ddd",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <button
            type="button"
            onClick={onBackToMap}
            style={{
              padding: "6px 12px",
              fontSize: "13px",
              cursor: "pointer",
              borderRadius: "6px",
              border: "1px solid #ccc",
              background: "#ffffff",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            ← Live Map
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "17px", fontWeight: "bold" }}>Vehicle Tracker</span>
            <span
              style={{
                fontSize: "11px",
                background: "#222",
                color: "#fff",
                padding: "2px 7px",
                borderRadius: "4px",
                fontWeight: 600,
                letterSpacing: "0.5px",
              }}
            >
              ADMIN
            </span>
          </div>

          {/* Section Navigation Tabs */}
          <nav style={{ display: "flex", gap: "6px", marginLeft: "12px" }}>
            <button
              type="button"
              onClick={() => setActiveTab("vehicles")}
              style={{
                padding: "6px 14px",
                fontSize: "13px",
                fontWeight: 600,
                borderRadius: "6px",
                border: "1px solid",
                borderColor: activeTab === "vehicles" ? "#222" : "#ddd",
                background: activeTab === "vehicles" ? "#222" : "#ffffff",
                color: activeTab === "vehicles" ? "#ffffff" : "#444",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                transition: "all 0.15s ease",
              }}
            >
              <span>🚍</span> Vehicles
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("routes")}
              style={{
                padding: "6px 14px",
                fontSize: "13px",
                fontWeight: 600,
                borderRadius: "6px",
                border: "1px solid",
                borderColor: activeTab === "routes" ? "#222" : "#ddd",
                background: activeTab === "routes" ? "#222" : "#ffffff",
                color: activeTab === "routes" ? "#ffffff" : "#444",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                transition: "all 0.15s ease",
              }}
            >
              <span>🗺️</span> Routes
            </button>
          </nav>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              fontSize: "12px",
              color: "#555",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: "#28a745",
              }}
            />
            Session Active
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              cursor: "pointer",
              borderRadius: "6px",
              border: "1px solid #dc3545",
              color: "#dc3545",
              background: "#ffffff",
              fontWeight: 500,
            }}
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Main Content Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* =========================================================
            TAB 1: VEHICLES MANAGEMENT
           ========================================================= */}
        {activeTab === "vehicles" && (
          <>
            {/* Left Column: Vehicles List */}
            <aside
              style={{
                width: "360px",
                minWidth: "300px",
                background: "#ffffff",
                borderRight: "1px solid #e1e4e8",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div style={{ padding: "14px 16px", borderBottom: "1px solid #eee" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "10px",
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "15px", color: "#222" }}>
                    Vehicles ({vehicles.length})
                  </h3>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      onClick={() => setShowCreateVehicleModal(true)}
                      style={{
                        padding: "5px 10px",
                        fontSize: "12px",
                        fontWeight: 600,
                        borderRadius: "5px",
                        border: "1px solid #222",
                        background: "#222",
                        color: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      + New Vehicle
                    </button>
                    <button
                      type="button"
                      onClick={() => loadVehicles(token)}
                      disabled={vehiclesLoading}
                      style={{
                        padding: "5px 8px",
                        fontSize: "12px",
                        borderRadius: "5px",
                        border: "1px solid #ccc",
                        background: "#ffffff",
                        cursor: vehiclesLoading ? "wait" : "pointer",
                      }}
                      title="Refresh vehicles"
                    >
                      ↻
                    </button>
                  </div>
                </div>

                <input
                  type="text"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="Search by ID, name, or route..."
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 10px",
                    borderRadius: "6px",
                    border: "1px solid #ccc",
                    fontSize: "13px",
                    outline: "none",
                  }}
                />

                {/* Status Filter Pills */}
                <div style={{ marginTop: "10px", display: "flex", flexWrap: "wrap", gap: "4px" }}>
                  {[
                    { id: "active_deactivated", label: "Active & Deact.", title: "Active and Deactivated vehicles (Default)", count: countActiveAndDeactivated },
                    { id: "all", label: "All", title: "All vehicles including retired", count: countAll },
                    { id: "active", label: "Active", title: "Active vehicles only", count: countActive },
                    { id: "deactivated", label: "Deact.", title: "Deactivated vehicles only", count: countDeactivated },
                    { id: "retired", label: "Retired", title: "Retired vehicles only", count: countRetired },
                  ].map((filterTab) => {
                    const isCurrent = vehicleStatusFilter === filterTab.id;
                    return (
                      <button
                        key={filterTab.id}
                        type="button"
                        onClick={() => setVehicleStatusFilter(filterTab.id)}
                        title={filterTab.title}
                        style={{
                          padding: "3px 8px",
                          fontSize: "11px",
                          fontWeight: isCurrent ? 600 : 400,
                          borderRadius: "999px",
                          border: isCurrent ? "1px solid #111" : "1px solid #ddd",
                          background: isCurrent ? "#111" : "#f8f9fa",
                          color: isCurrent ? "#fff" : "#444",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        <span>{filterTab.label}</span>
                        <span
                          style={{
                            fontSize: "10px",
                            opacity: isCurrent ? 0.85 : 0.65,
                            background: isCurrent ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.06)",
                            padding: "0 4px",
                            borderRadius: "999px",
                          }}
                        >
                          {filterTab.count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Obvious indicator to show retired vehicles when hidden by default */}
                {vehicleStatusFilter === "active_deactivated" && countRetired > 0 && (
                  <div
                    style={{
                      marginTop: "8px",
                      padding: "4px 8px",
                      borderRadius: "6px",
                      background: "#f3f4f6",
                      fontSize: "11px",
                      color: "#6b7280",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span>{countRetired} retired vehicle{countRetired > 1 ? "s" : ""} hidden</span>
                    <button
                      type="button"
                      onClick={() => setVehicleStatusFilter("retired")}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#2563eb",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                        padding: 0,
                        textDecoration: "underline",
                      }}
                    >
                      Show Retired
                    </button>
                  </div>
                )}
              </div>

              {/* Vehicles List Body */}
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
                {vehiclesError && (
                  <div
                    style={{
                      background: "#fff2f2",
                      border: "1px solid #ffc9c9",
                      color: "#d32f2f",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      fontSize: "12px",
                      marginBottom: "10px",
                    }}
                  >
                    {vehiclesError}
                  </div>
                )}

                {vehiclesLoading && vehicles.length === 0 ? (
                  <div style={{ padding: "30px 10px", textAlign: "center", fontSize: "13px", color: "#888" }}>
                    Loading vehicles...
                  </div>
                ) : filteredVehicles.length === 0 ? (
                  <div style={{ padding: "30px 10px", textAlign: "center", fontSize: "13px", color: "#888" }}>
                    {filterQuery
                      ? "No matching vehicles found."
                      : vehicleStatusFilter === "retired"
                      ? "No retired vehicles."
                      : vehicleStatusFilter === "active"
                      ? "No active vehicles."
                      : vehicleStatusFilter === "deactivated"
                      ? "No deactivated vehicles."
                      : "No vehicles registered."}
                  </div>
                ) : (
                  filteredVehicles.map((vehicle) => {
                    const isSelected = vehicle.vehicle_id === selectedVehicleId;
                    const statusBadge = getVehicleStatusBadge(vehicle.status);
                    const hasActiveDevice = vehicle.active_device_count > 0;

                    return (
                      <div
                        key={vehicle.vehicle_id}
                        onClick={() => {
                          startTransition(() => {
                            setSelectedVehicleId(vehicle.vehicle_id);
                            setEnrollError("");
                            setDeviceLabelInput("");
                            setNewEnrollment(null);
                            setLifecycleMessage(null);
                            setAssignMessage(null);
                            setSelectedRouteOverride(null);
                          });
                        }}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "8px",
                          border: isSelected ? "2px solid #222" : "1px solid #e1e4e8",
                          background: isSelected ? "#f8f9fa" : "#ffffff",
                          marginBottom: "8px",
                          cursor: "pointer",
                          transition: "border-color 0.15s, background-color 0.15s",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            marginBottom: "4px",
                          }}
                        >
                          <span style={{ fontWeight: 600, fontSize: "14px", color: "#111" }}>
                            {vehicle.vehicle_id}
                          </span>
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 600,
                              padding: "2px 6px",
                              borderRadius: "999px",
                              color: statusBadge.color,
                              background: statusBadge.bg,
                              border: `1px solid ${statusBadge.border}`,
                            }}
                          >
                            {statusBadge.label}
                          </span>
                        </div>

                        {vehicle.display_name && (
                          <div style={{ fontSize: "12px", color: "#555", marginBottom: "4px" }}>
                            {vehicle.display_name}
                          </div>
                        )}

                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            fontSize: "11px",
                            color: "#777",
                            marginTop: "6px",
                          }}
                        >
                          <span>Route: {vehicle.route_id || "Unassigned"}</span>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              color: hasActiveDevice ? "#28a745" : "#6c757d",
                              fontWeight: hasActiveDevice ? 600 : 400,
                            }}
                          >
                            <span
                              style={{
                                display: "inline-block",
                                width: "6px",
                                height: "6px",
                                borderRadius: "50%",
                                background: hasActiveDevice ? "#28a745" : "#adb5bd",
                              }}
                            />
                            {hasActiveDevice ? "Active Device" : "No Device"}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </aside>

            {/* Right Column: Selected Vehicle Detail, Lifecycle, Route Assignment & Devices */}
            <main style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
              {!selectedVehicle ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#888", fontSize: "14px" }}>
                  Select a vehicle from the left panel to manage its lifecycle, route, and tracking devices.
                </div>
              ) : (
                <div style={{ maxWidth: "800px", margin: "0 auto" }}>
                  {/* Vehicle Banner with Lifecycle Controls */}
                  <div
                    style={{
                      background: "#ffffff",
                      padding: "18px 20px",
                      borderRadius: "10px",
                      border: "1px solid #e1e4e8",
                      marginBottom: "20px",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "10px",
                        marginBottom: "14px",
                      }}
                    >
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <h2 style={{ margin: 0, fontSize: "20px", color: "#111" }}>
                            {selectedVehicle.vehicle_id}
                          </h2>
                          {(() => {
                            const b = getVehicleStatusBadge(selectedVehicle.status);
                            return (
                              <span
                                style={{
                                  fontSize: "12px",
                                  fontWeight: 600,
                                  padding: "2px 8px",
                                  borderRadius: "999px",
                                  color: b.color,
                                  background: b.bg,
                                  border: `1px solid ${b.border}`,
                                }}
                              >
                                {b.label}
                              </span>
                            );
                          })()}
                        </div>
                        {selectedVehicle.display_name && (
                          <div style={{ fontSize: "14px", color: "#666", marginTop: "3px" }}>
                            {selectedVehicle.display_name}
                          </div>
                        )}
                      </div>

                      {/* Lifecycle Action Buttons */}
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        {selectedVehicle.status === "pending" && (
                          <button
                            type="button"
                            onClick={() => handleUpdateVehicleStatus("active")}
                            disabled={lifecycleLoading}
                            style={{
                              padding: "6px 12px",
                              fontSize: "12px",
                              fontWeight: 600,
                              borderRadius: "6px",
                              border: "1px solid #28a745",
                              background: "#28a745",
                              color: "#fff",
                              cursor: lifecycleLoading ? "wait" : "pointer",
                            }}
                          >
                            Activate Vehicle
                          </button>
                        )}

                        {selectedVehicle.status === "active" && (
                          <button
                            type="button"
                            onClick={() => handleUpdateVehicleStatus("deactivated")}
                            disabled={lifecycleLoading}
                            style={{
                              padding: "6px 12px",
                              fontSize: "12px",
                              fontWeight: 500,
                              borderRadius: "6px",
                              border: "1px solid #e67e22",
                              background: "#fff",
                              color: "#d35400",
                              cursor: lifecycleLoading ? "wait" : "pointer",
                            }}
                          >
                            Deactivate
                          </button>
                        )}

                        {selectedVehicle.status === "deactivated" && (
                          <button
                            type="button"
                            onClick={() => handleUpdateVehicleStatus("active")}
                            disabled={lifecycleLoading}
                            style={{
                              padding: "6px 12px",
                              fontSize: "12px",
                              fontWeight: 600,
                              borderRadius: "6px",
                              border: "1px solid #28a745",
                              background: "#28a745",
                              color: "#fff",
                              cursor: lifecycleLoading ? "wait" : "pointer",
                            }}
                          >
                            Reactivate
                          </button>
                        )}

                        {selectedVehicle.status !== "retired" && (
                          <button
                            type="button"
                            onClick={() => setConfirmRetireVehicle(true)}
                            disabled={lifecycleLoading}
                            style={{
                              padding: "6px 12px",
                              fontSize: "12px",
                              fontWeight: 500,
                              borderRadius: "6px",
                              border: "1px solid #dc3545",
                              background: "#fff",
                              color: "#dc3545",
                              cursor: lifecycleLoading ? "wait" : "pointer",
                            }}
                          >
                            Retire
                          </button>
                        )}

                        {selectedVehicle.status === "retired" && (
                          <span
                            style={{
                              fontSize: "12px",
                              color: "#6b7280",
                              background: "#f3f4f6",
                              border: "1px solid #e5e7eb",
                              padding: "4px 10px",
                              borderRadius: "6px",
                              fontWeight: 500,
                            }}
                          >
                            Permanent Lifecycle State
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            setVehicleToDelete(selectedVehicle);
                            setDeleteConfirmInput("");
                            setDeleteVehicleError("");
                          }}
                          disabled={lifecycleLoading}
                          style={{
                            padding: "6px 12px",
                            fontSize: "12px",
                            fontWeight: 500,
                            borderRadius: "6px",
                            border: "1px solid #b91c1c",
                            background: "#fff",
                            color: "#b91c1c",
                            cursor: lifecycleLoading ? "wait" : "pointer",
                          }}
                          title="Permanently delete vehicle and all associated records"
                        >
                          🗑️ Delete Permanently
                        </button>
                      </div>
                    </div>

                    {/* Vehicle Lifecycle Status Explanations */}
                    {selectedVehicle.status === "retired" && (
                      <div
                        style={{
                          background: "#f9fafb",
                          border: "1px solid #e5e7eb",
                          borderLeft: "4px solid #6b7280",
                          borderRadius: "6px",
                          padding: "12px 14px",
                          marginBottom: "12px",
                          fontSize: "13px",
                          color: "#374151",
                          lineHeight: 1.5,
                        }}
                      >
                        <div style={{ fontWeight: 600, color: "#1f2937", marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>🛑</span>
                          <span>Vehicle Retired</span>
                        </div>
                        <div>
                          This vehicle has been permanently retired. Retirement is permanent and irreversible:
                          retired vehicles cannot be reactivated, cannot be assigned to routes, and cannot receive tracking devices or telemetry.
                          All associated devices and credentials have been revoked.
                        </div>
                      </div>
                    )}

                    {selectedVehicle.status === "deactivated" && (
                      <div
                        style={{
                          background: "#fffbeb",
                          border: "1px solid #fde68a",
                          borderLeft: "4px solid #f59e0b",
                          borderRadius: "6px",
                          padding: "10px 14px",
                          marginBottom: "12px",
                          fontSize: "13px",
                          color: "#92400e",
                          lineHeight: 1.5,
                        }}
                      >
                        <div style={{ fontWeight: 600, marginBottom: "2px", display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>⏸</span>
                          <span>Vehicle Deactivated</span>
                        </div>
                        <div>
                          This vehicle is currently deactivated. It cannot receive routes or pair new devices while deactivated.
                          You can reactivate it anytime using the button above or permanently retire it.
                        </div>
                      </div>
                    )}

                    {lifecycleMessage && (
                      <div
                        style={{
                          padding: "8px 12px",
                          borderRadius: "6px",
                          fontSize: "12px",
                          marginBottom: "12px",
                          background: lifecycleMessage.type === "success" ? "#f0fdf4" : "#fef2f2",
                          border: `1px solid ${lifecycleMessage.type === "success" ? "#bbf7d0" : "#fecaca"}`,
                          color: lifecycleMessage.type === "success" ? "#166534" : "#b91c1c",
                        }}
                      >
                        {lifecycleMessage.text}
                      </div>
                    )}

                    <div
                      style={{
                        display: "flex",
                        gap: "24px",
                        paddingTop: "12px",
                        borderTop: "1px solid #f0f0f0",
                        fontSize: "12px",
                        color: "#666",
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <strong>Created:</strong> {new Date(selectedVehicle.created_at).toLocaleDateString()}
                      </div>
                      <div>
                        <strong>Active Devices:</strong> {selectedVehicle.active_device_count}
                      </div>
                      <div>
                        <strong>Assigned Route:</strong> {selectedVehicle.route_id || "None"}
                      </div>
                    </div>
                  </div>

                  {/* Route Assignment Card */}
                  <div
                    style={{
                      background: "#ffffff",
                      padding: "18px 20px",
                      borderRadius: "10px",
                      border: "1px solid #e1e4e8",
                      marginBottom: "20px",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                    }}
                  >
                    <h3 style={{ margin: "0 0 10px", fontSize: "15px", color: "#222" }}>
                      Route Assignment
                    </h3>
                    <p style={{ margin: "0 0 14px", fontSize: "13px", color: "#666" }}>
                      Telemetry validation requires vehicles to be assigned to an active route.
                    </p>

                    {assignMessage && (
                      <div
                        style={{
                          padding: "8px 12px",
                          borderRadius: "6px",
                          fontSize: "12px",
                          marginBottom: "12px",
                          background: assignMessage.type === "success" ? "#f0fdf4" : "#fef2f2",
                          border: `1px solid ${assignMessage.type === "success" ? "#bbf7d0" : "#fecaca"}`,
                          color: assignMessage.type === "success" ? "#166534" : "#b91c1c",
                        }}
                      >
                        {assignMessage.text}
                      </div>
                    )}

                    {selectedVehicle.status === "retired" ? (
                      <div
                        style={{
                          background: "#f9fafb",
                          border: "1px solid #e5e7eb",
                          borderRadius: "6px",
                          padding: "12px 14px",
                          fontSize: "13px",
                          color: "#6b7280",
                          lineHeight: 1.5,
                        }}
                      >
                        <div style={{ fontWeight: 600, color: "#374151", marginBottom: "3px", display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>🚫</span>
                          <span>Route Assignment Disabled (Vehicle Retired)</span>
                        </div>
                        <div>
                          Route assignment is permanently disabled because this vehicle is retired. Retired vehicles cannot operate on routes.
                        </div>
                      </div>
                    ) : selectedVehicle.status === "deactivated" ? (
                      <div
                        style={{
                          background: "#f9fafb",
                          border: "1px solid #e5e7eb",
                          borderRadius: "6px",
                          padding: "12px 14px",
                          fontSize: "13px",
                          color: "#6b7280",
                          lineHeight: 1.5,
                        }}
                      >
                        <div style={{ fontWeight: 600, color: "#374151", marginBottom: "3px", display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>⏸</span>
                          <span>Route Assignment Paused (Vehicle Deactivated)</span>
                        </div>
                        <div>
                          This vehicle is currently deactivated. Reactivate the vehicle to assign or modify its route. Current assigned route: <strong>{selectedVehicle.route_id || "None"}</strong>.
                        </div>
                      </div>
                    ) : (
                      <form onSubmit={handleAssignRoute} style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                        <select
                          value={selectedRouteForAssign}
                          onChange={(e) => setSelectedRouteOverride(e.target.value)}
                          disabled={assignLoading}
                          style={{
                            padding: "8px 12px",
                            borderRadius: "6px",
                            border: "1px solid #ccc",
                            fontSize: "13px",
                            minWidth: "240px",
                            outline: "none",
                            background: "#fff",
                          }}
                        >
                          <option value="">-- Select Route --</option>
                          {allRoutes.map((r) => (
                            <option key={r.route_id} value={r.route_id}>
                              {r.route_id} - {r.route_name}
                            </option>
                          ))}
                        </select>

                        <button
                          type="submit"
                          disabled={
                            assignLoading ||
                            !selectedRouteForAssign ||
                            selectedRouteForAssign === selectedVehicle.route_id
                          }
                          style={{
                            padding: "8px 16px",
                            borderRadius: "6px",
                            border: "none",
                            background:
                              assignLoading || !selectedRouteForAssign || selectedRouteForAssign === selectedVehicle.route_id
                                ? "#888"
                                : "#222",
                            color: "#fff",
                            fontSize: "13px",
                            fontWeight: 600,
                            cursor:
                              assignLoading || !selectedRouteForAssign || selectedRouteForAssign === selectedVehicle.route_id
                                ? "not-allowed"
                                : "pointer",
                          }}
                        >
                          {assignLoading ? "Assigning..." : "Assign Route"}
                        </button>
                      </form>
                    )}
                  </div>

                  {/* Device Pairing Generated Success Banner */}
                  {newEnrollment && selectedVehicle.status !== "retired" && (
                    <div
                      style={{
                        background: "#f0fdf4",
                        border: "1px solid #bbf7d0",
                        borderRadius: "10px",
                        padding: "20px",
                        marginBottom: "20px",
                        boxShadow: "0 2px 10px rgba(34,197,94,0.1)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: "12px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "20px" }}>✅</span>
                          <h3 style={{ margin: 0, fontSize: "16px", color: "#166534" }}>
                            Device Pairing Generated Successfully
                          </h3>
                        </div>
                        <button
                          type="button"
                          onClick={() => setNewEnrollment(null)}
                          style={{
                            border: "none",
                            background: "transparent",
                            fontSize: "18px",
                            cursor: "pointer",
                            color: "#666",
                            padding: "4px",
                          }}
                          title="Dismiss"
                        >
                          ✕
                        </button>
                      </div>

                      <p style={{ margin: "0 0 14px", fontSize: "13px", color: "#15803d" }}>
                        Provide this pairing code to the driver. The driver app must claim this code to activate telemetry for this vehicle.
                      </p>

                      <div
                        style={{
                          background: "#ffffff",
                          border: "1px solid #86efac",
                          borderRadius: "8px",
                          padding: "14px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: "14px",
                          flexWrap: "wrap",
                          gap: "10px",
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontSize: "11px",
                              fontWeight: 600,
                              color: "#166534",
                              textTransform: "uppercase",
                              letterSpacing: "0.5px",
                              marginBottom: "4px",
                            }}
                          >
                            Single-Use Pairing Code
                          </div>
                          <div
                            style={{
                              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              fontSize: "20px",
                              fontWeight: "bold",
                              letterSpacing: "2px",
                              color: "#111",
                            }}
                          >
                            {newEnrollment.pairing_code}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleCopyCode(newEnrollment.pairing_code)}
                          style={{
                            padding: "8px 14px",
                            fontSize: "13px",
                            fontWeight: 600,
                            borderRadius: "6px",
                            border: "1px solid #16a34a",
                            background: copiedCode ? "#16a34a" : "#22c55e",
                            color: "#ffffff",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          {copiedCode ? "✓ Copied to Clipboard" : "📋 Copy Code"}
                        </button>
                      </div>

                      <div style={{ fontSize: "12px", color: "#166534", display: "flex", flexDirection: "column", gap: "4px" }}>
                        <div>
                          ⏱ <strong>Expiry:</strong> {formatDeviceExpiry(newEnrollment.expires_at)} (Valid for 10 minutes)
                        </div>
                        <div>
                          ⚠️ <strong>Security Rule:</strong> Pairing codes are single-use. Once claimed or expired, they cannot be reused.
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Device Management Section */}
                  <div
                    style={{
                      background: "#ffffff",
                      padding: "20px",
                      borderRadius: "10px",
                      border: "1px solid #e1e4e8",
                      marginBottom: "20px",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
                      <h3 style={{ margin: 0, fontSize: "16px", color: "#111" }}>
                        Device Enrollment & Status
                      </h3>
                      <button
                        type="button"
                        onClick={() => loadDevices(selectedVehicleId)}
                        disabled={devicesLoading}
                        style={{
                          padding: "4px 8px",
                          fontSize: "12px",
                          borderRadius: "5px",
                          border: "1px solid #ccc",
                          background: "#ffffff",
                          cursor: devicesLoading ? "wait" : "pointer",
                        }}
                      >
                        {devicesLoading ? "Updating..." : "↻ Refresh Devices"}
                      </button>
                    </div>

                    {devicesError && (
                      <div style={{ background: "#fff2f2", border: "1px solid #ffc9c9", color: "#d32f2f", padding: "10px 12px", borderRadius: "6px", fontSize: "13px", marginBottom: "16px" }}>
                        {devicesError}
                      </div>
                    )}

                    {devicesLoading && devices.length === 0 ? (
                      <div style={{ padding: "20px", textAlign: "center", color: "#888", fontSize: "13px" }}>
                        Loading device status...
                      </div>
                    ) : (
                      <>
                        {/* Active Device Card */}
                        {activeDevice && (
                          <div style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: "8px", padding: "14px 16px", marginBottom: "14px" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", marginBottom: "8px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <span style={{ fontSize: "16px" }}>📱</span>
                                <span style={{ fontWeight: 600, fontSize: "14px", color: "#111" }}>
                                  {activeDevice.device_label}
                                </span>
                                <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "999px", color: "#166534", background: "#dcfce7", border: "1px solid #86efac" }}>
                                  Active Device
                                </span>
                              </div>

                              <button
                                type="button"
                                onClick={() => {
                                  setRevokeError("");
                                  setDeviceToRevoke(activeDevice);
                                }}
                                style={{
                                  padding: "5px 10px",
                                  fontSize: "12px",
                                  borderRadius: "5px",
                                  border: "1px solid #dc3545",
                                  background: "#ffffff",
                                  color: "#dc3545",
                                  cursor: "pointer",
                                  fontWeight: 500,
                                }}
                              >
                                Revoke Device
                              </button>
                            </div>

                            <div style={{ fontSize: "12px", color: "#555", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "6px" }}>
                              <div>
                                <strong>Device ID:</strong> <span style={{ fontFamily: "monospace", fontSize: "11px" }}>{activeDevice.device_id}</span>
                              </div>
                              <div>
                                <strong>Activated:</strong> {activeDevice.activated_at ? new Date(activeDevice.activated_at).toLocaleString() : "N/A"}
                              </div>
                              <div>
                                <strong>Last Seen:</strong> {activeDevice.last_seen_at ? new Date(activeDevice.last_seen_at).toLocaleString() : "No telemetry reported yet"}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Pending Claim Card */}
                        {pendingDevice && (
                          <div style={{ border: "1px solid #fed7aa", background: "#fffbeb", borderRadius: "8px", padding: "14px 16px", marginBottom: "14px" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", marginBottom: "8px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <span style={{ fontSize: "16px" }}>⏳</span>
                                <span style={{ fontWeight: 600, fontSize: "14px", color: "#111" }}>
                                  {pendingDevice.device_label}
                                </span>
                                <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "999px", color: "#9a3412", background: "#ffedd5", border: "1px solid #fed7aa" }}>
                                  Pending Claim
                                </span>
                              </div>

                              <button
                                type="button"
                                onClick={() => {
                                  setRevokeError("");
                                  setDeviceToRevoke(pendingDevice);
                                }}
                                style={{
                                  padding: "5px 10px",
                                  fontSize: "12px",
                                  borderRadius: "5px",
                                  border: "1px solid #dc3545",
                                  background: "#ffffff",
                                  color: "#dc3545",
                                  cursor: "pointer",
                                  fontWeight: 500,
                                }}
                              >
                                Cancel Pairing
                              </button>
                            </div>

                            <div style={{ fontSize: "12px", color: "#666", lineHeight: 1.5 }}>
                              <div>
                                <strong>Device ID:</strong> <span style={{ fontFamily: "monospace", fontSize: "11px" }}>{pendingDevice.device_id}</span>
                              </div>
                              <div>
                                <strong>Expiry:</strong> {formatDeviceExpiry(pendingDevice.pairing_expires_at)}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* If neither active nor pending */}
                        {!activeDevice && !pendingDevice && (
                          selectedVehicle.status === "retired" ? (
                            <div
                              style={{
                                padding: "14px",
                                background: "#f9fafb",
                                borderRadius: "8px",
                                border: "1px dashed #d1d5db",
                                fontSize: "13px",
                                color: "#6b7280",
                                marginBottom: "14px",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <span>ℹ️</span>
                              <span>
                                All tracking devices and credentials for this vehicle were revoked upon retirement. No active devices remain.
                              </span>
                            </div>
                          ) : (
                            <div
                              style={{
                                padding: "14px",
                                background: "#f8f9fa",
                                borderRadius: "8px",
                                border: "1px dashed #ced4da",
                                fontSize: "13px",
                                color: "#6c757d",
                                marginBottom: "14px",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <span>ℹ️</span>
                              <span>No active or pending device is currently attached to this vehicle.</span>
                            </div>
                          )
                        )}
                      </>
                    )}

                    {/* Enroll New Device Form */}
                    <div style={{ borderTop: "1px solid #eee", paddingTop: "16px", marginTop: "16px" }}>
                      <h4 style={{ margin: "0 0 10px", fontSize: "14px", color: "#222" }}>
                        Enroll New Tracking Device
                      </h4>

                      {selectedVehicle.status === "retired" ? (
                        <div
                          style={{
                            background: "#f9fafb",
                            border: "1px solid #e5e7eb",
                            borderLeft: "4px solid #6b7280",
                            borderRadius: "8px",
                            padding: "14px 16px",
                            fontSize: "13px",
                            color: "#4b5563",
                            lineHeight: 1.5,
                          }}
                        >
                          <div style={{ fontWeight: 600, color: "#1f2937", marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                            <span>🚫</span>
                            <span>Cannot Generate Pairing Code: Vehicle Retired</span>
                          </div>
                          <div>
                            A new pairing code cannot be generated because this vehicle has been permanently retired.
                            Retired vehicles cannot connect to devices, receive driver credentials, or stream telemetry into the tracking system.
                          </div>
                        </div>
                      ) : !enrollmentRule.canEnroll ? (
                        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", padding: "12px 14px", borderRadius: "8px", fontSize: "13px", lineHeight: 1.5 }}>
                          <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                            ⚠️ Cannot enroll a new device at this time
                          </div>
                          <div>{enrollmentRule.message}</div>
                        </div>
                      ) : (
                        <form onSubmit={handleEnrollDevice}>
                          {enrollError && (
                            <div style={{ background: "#fff2f2", border: "1px solid #ffc9c9", color: "#d32f2f", padding: "10px 12px", borderRadius: "6px", fontSize: "13px", marginBottom: "12px" }}>
                              {enrollError}
                            </div>
                          )}

                          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap" }}>
                            <div style={{ flex: 1, minWidth: "220px" }}>
                              <label htmlFor="device-label-input" style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "5px", color: "#444" }}>
                                Device Label
                              </label>
                              <input
                                id="device-label-input"
                                type="text"
                                value={deviceLabelInput}
                                onChange={(e) => setDeviceLabelInput(e.target.value)}
                                placeholder="e.g. Driver Tablet - Dash #3"
                                maxLength={128}
                                disabled={enrollLoading}
                                style={{
                                  width: "100%",
                                  boxSizing: "border-box",
                                  padding: "8px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #ccc",
                                  fontSize: "13px",
                                  outline: "none",
                                }}
                              />
                            </div>

                            <button
                              type="submit"
                              disabled={enrollLoading || !deviceLabelInput.trim()}
                              style={{
                                padding: "8px 16px",
                                background: enrollLoading || !deviceLabelInput.trim() ? "#888" : "#222",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "6px",
                                fontSize: "13px",
                                fontWeight: 600,
                                cursor: enrollLoading || !deviceLabelInput.trim() ? "not-allowed" : "pointer",
                                whiteSpace: "nowrap",
                                height: "36px",
                              }}
                            >
                              {enrollLoading ? "Generating..." : "Generate Pairing Code"}
                            </button>
                          </div>

                          <div style={{ fontSize: "11px", color: "#888", marginTop: "6px" }}>
                            Generates a single-use pairing code valid for 10 minutes. Only one active device can exist per vehicle.
                          </div>
                        </form>
                      )}
                    </div>

                    {/* Revoked Devices History */}
                    {revokedDevices.length > 0 && (
                      <div style={{ borderTop: "1px solid #eee", paddingTop: "14px", marginTop: "16px" }}>
                        <button
                          type="button"
                          onClick={() => setShowHistory(!showHistory)}
                          style={{
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            padding: 0,
                            fontSize: "12px",
                            color: "#555",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <span>{showHistory ? "▼" : "▶"}</span>
                          <span>Device History ({revokedDevices.length} previous/expired)</span>
                        </button>

                        {showHistory && (
                          <div style={{ marginTop: "10px" }}>
                            {revokedDevices.map((d) => {
                              const badge = getDeviceStatusBadge(d);
                              return (
                                <div
                                  key={d.device_id}
                                  style={{
                                    padding: "8px 10px",
                                    background: "#fafafa",
                                    border: "1px solid #eee",
                                    borderRadius: "6px",
                                    marginBottom: "6px",
                                    fontSize: "12px",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    flexWrap: "wrap",
                                    gap: "6px",
                                  }}
                                >
                                  <div>
                                    <span style={{ fontWeight: 600, color: "#333" }}>{d.device_label}</span>{" "}
                                    <span style={{ fontFamily: "monospace", fontSize: "11px", color: "#777" }}>
                                      ({d.device_id.slice(0, 8)}...)
                                    </span>
                                  </div>

                                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                    <span style={{ fontSize: "11px", color: "#888" }}>
                                      {d.revoked_at
                                        ? `Revoked ${new Date(d.revoked_at).toLocaleDateString()}`
                                        : d.pairing_expires_at
                                        ? `Expired ${new Date(d.pairing_expires_at).toLocaleDateString()}`
                                        : "Past"}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: "10px",
                                        fontWeight: 600,
                                        padding: "1px 6px",
                                        borderRadius: "999px",
                                        color: badge.color,
                                        background: badge.bg,
                                        border: `1px solid ${badge.border}`,
                                      }}
                                    >
                                      {badge.label}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </main>
          </>
        )}

        {/* =========================================================
            TAB 2: ROUTES & STOPS MANAGEMENT
           ========================================================= */}
        {activeTab === "routes" && (
          <>
            {/* Left Column: Routes List */}
            <aside
              style={{
                width: "360px",
                minWidth: "300px",
                background: "#ffffff",
                borderRight: "1px solid #e1e4e8",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div style={{ padding: "14px 16px", borderBottom: "1px solid #eee" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "10px",
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "15px", color: "#222" }}>
                    Routes ({allRoutes.length})
                  </h3>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      onClick={() => setShowCreateRouteModal(true)}
                      style={{
                        padding: "5px 10px",
                        fontSize: "12px",
                        fontWeight: 600,
                        borderRadius: "5px",
                        border: "1px solid #222",
                        background: "#222",
                        color: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      + New Route
                    </button>
                    <button
                      type="button"
                      onClick={() => loadRoutes()}
                      disabled={routesLoading}
                      style={{
                        padding: "5px 8px",
                        fontSize: "12px",
                        borderRadius: "5px",
                        border: "1px solid #ccc",
                        background: "#ffffff",
                        cursor: routesLoading ? "wait" : "pointer",
                      }}
                      title="Refresh routes"
                    >
                      ↻
                    </button>
                  </div>
                </div>

                <input
                  type="text"
                  value={routeFilterQuery}
                  onChange={(e) => setRouteFilterQuery(e.target.value)}
                  placeholder="Filter by ID or name..."
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 10px",
                    borderRadius: "6px",
                    border: "1px solid #ccc",
                    fontSize: "13px",
                    outline: "none",
                  }}
                />
              </div>

              {/* Routes List Body */}
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
                {routesError && (
                  <div style={{ background: "#fff2f2", border: "1px solid #ffc9c9", color: "#d32f2f", padding: "8px 10px", borderRadius: "6px", fontSize: "12px", marginBottom: "10px" }}>
                    {routesError}
                  </div>
                )}

                {routesLoading && allRoutes.length === 0 ? (
                  <div style={{ padding: "30px 10px", textAlign: "center", fontSize: "13px", color: "#888" }}>
                    Loading routes...
                  </div>
                ) : filteredRoutes.length === 0 ? (
                  <div style={{ padding: "30px 10px", textAlign: "center", fontSize: "13px", color: "#888" }}>
                    {routeFilterQuery ? "No matching routes found." : "No routes registered."}
                  </div>
                ) : (
                  filteredRoutes.map((route) => {
                    const isSelected = route.route_id === selectedRouteId;
                    return (
                      <div
                        key={route.route_id}
                        onClick={() => {
                          startTransition(() => {
                            setSelectedRouteId(route.route_id);
                          });
                        }}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "8px",
                          border: isSelected ? "2px solid #222" : "1px solid #e1e4e8",
                          background: isSelected ? "#f8f9fa" : "#ffffff",
                          marginBottom: "8px",
                          cursor: "pointer",
                          transition: "border-color 0.15s, background-color 0.15s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                          <span style={{ fontWeight: 600, fontSize: "14px", color: "#111" }}>
                            {route.route_id}
                          </span>
                          <span
                            style={{
                              fontSize: "11px",
                              padding: "2px 6px",
                              borderRadius: "999px",
                              background: "#f0f2f5",
                              color: "#555",
                              fontWeight: 500,
                            }}
                          >
                            {route.stops ? route.stops.length : 0} stops
                          </span>
                        </div>

                        <div style={{ fontSize: "13px", color: "#555" }}>
                          {route.route_name}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </aside>

            {/* Right Column: Selected Route & Stops Management */}
            <main style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
              {!selectedRoute ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#888", fontSize: "14px" }}>
                  Select a route from the left panel to manage its name and stops.
                </div>
              ) : (
                <div style={{ maxWidth: "840px", margin: "0 auto" }}>
                  {/* Route Header Card */}
                  <div
                    style={{
                      background: "#ffffff",
                      padding: "18px 20px",
                      borderRadius: "10px",
                      border: "1px solid #e1e4e8",
                      marginBottom: "20px",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <h2 style={{ margin: 0, fontSize: "20px", color: "#111" }}>
                            {selectedRoute.route_id}
                          </h2>
                          <span style={{ fontSize: "14px", color: "#666" }}>
                            {selectedRoute.route_name}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          type="button"
                          onClick={() => {
                            setEditRouteName(selectedRoute.route_name);
                            setEditRouteError("");
                            setShowEditRouteModal(true);
                          }}
                          style={{
                            padding: "6px 12px",
                            fontSize: "12px",
                            borderRadius: "6px",
                            border: "1px solid #ccc",
                            background: "#ffffff",
                            cursor: "pointer",
                          }}
                        >
                          Edit Name
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteRouteError("");
                            setShowDeleteRouteModal(true);
                          }}
                          style={{
                            padding: "6px 12px",
                            fontSize: "12px",
                            borderRadius: "6px",
                            border: "1px solid #dc3545",
                            color: "#dc3545",
                            background: "#ffffff",
                            cursor: "pointer",
                          }}
                        >
                          Delete Route
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Stops Management Section */}
                  <div
                    style={{
                      background: "#ffffff",
                      padding: "20px",
                      borderRadius: "10px",
                      border: "1px solid #e1e4e8",
                      marginBottom: "20px",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
                      <div>
                        <h3 style={{ margin: 0, fontSize: "16px", color: "#111" }}>
                          Route Stops ({stops.length})
                        </h3>
                        <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#666" }}>
                          Stops are visited in sequential order (1 to {stops.length || 0}).
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={openCreateStopModal}
                        style={{
                          padding: "7px 14px",
                          fontSize: "13px",
                          fontWeight: 600,
                          borderRadius: "6px",
                          border: "none",
                          background: "#222",
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        + Add Stop
                      </button>
                    </div>

                    {stopsError && (
                      <div style={{ background: "#fff2f2", border: "1px solid #ffc9c9", color: "#d32f2f", padding: "10px 12px", borderRadius: "6px", fontSize: "13px", marginBottom: "16px" }}>
                        {stopsError}
                      </div>
                    )}

                    {stopsLoading && stops.length === 0 ? (
                      <div style={{ padding: "30px", textAlign: "center", color: "#888", fontSize: "13px" }}>
                        Loading stops...
                      </div>
                    ) : stops.length === 0 ? (
                      <div style={{ padding: "30px", textAlign: "center", color: "#888", fontSize: "13px", border: "1px dashed #ccc", borderRadius: "8px" }}>
                        No stops added yet. Click &quot;+ Add Stop&quot; to configure the stops on this route.
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {stops.map((stop, index) => {
                          const isFirst = index === 0;
                          const isLast = index === stops.length - 1;

                          return (
                            <div
                              key={stop.stop_id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "10px 14px",
                                borderRadius: "8px",
                                border: "1px solid #e1e4e8",
                                background: "#ffffff",
                                flexWrap: "wrap",
                                gap: "10px",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                                <span
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: "28px",
                                    height: "28px",
                                    borderRadius: "50%",
                                    background: "#f0f2f5",
                                    fontWeight: 700,
                                    fontSize: "12px",
                                    color: "#333",
                                  }}
                                >
                                  {stop.sequence}
                                </span>
                                <div>
                                  <div style={{ fontWeight: 600, fontSize: "14px", color: "#111" }}>
                                    {stop.stop_name}
                                  </div>
                                  <div style={{ fontSize: "11px", color: "#777", marginTop: "2px" }}>
                                    ID: <span style={{ fontFamily: "monospace" }}>{stop.stop_id}</span> • Coords: {stop.latitude.toFixed(5)}, {stop.longitude.toFixed(5)}
                                  </div>
                                </div>
                              </div>

                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                {/* Move Up */}
                                <button
                                  type="button"
                                  onClick={() => handleMoveStop(stop, "up")}
                                  disabled={isFirst}
                                  style={{
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    borderRadius: "4px",
                                    border: "1px solid #ccc",
                                    background: "#fff",
                                    cursor: isFirst ? "not-allowed" : "pointer",
                                    color: isFirst ? "#ccc" : "#333",
                                  }}
                                  title="Move Up"
                                >
                                  ▲
                                </button>

                                {/* Move Down */}
                                <button
                                  type="button"
                                  onClick={() => handleMoveStop(stop, "down")}
                                  disabled={isLast}
                                  style={{
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    borderRadius: "4px",
                                    border: "1px solid #ccc",
                                    background: "#fff",
                                    cursor: isLast ? "not-allowed" : "pointer",
                                    color: isLast ? "#ccc" : "#333",
                                  }}
                                  title="Move Down"
                                >
                                  ▼
                                </button>

                                {/* Edit Stop */}
                                <button
                                  type="button"
                                  onClick={() => openEditStopModal(stop)}
                                  style={{
                                    padding: "4px 10px",
                                    fontSize: "12px",
                                    borderRadius: "4px",
                                    border: "1px solid #ccc",
                                    background: "#fff",
                                    cursor: "pointer",
                                    color: "#333",
                                  }}
                                >
                                  Edit
                                </button>

                                {/* Delete Stop */}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDeleteStopError("");
                                    setStopToDelete(stop);
                                  }}
                                  style={{
                                    padding: "4px 10px",
                                    fontSize: "12px",
                                    borderRadius: "4px",
                                    border: "1px solid #dc3545",
                                    background: "#fff",
                                    cursor: "pointer",
                                    color: "#dc3545",
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </main>
          </>
        )}
      </div>

      {/* =========================================================
          MODALS & DIALOGS
         ========================================================= */}

      {/* 1. Create Vehicle Modal */}
      {showCreateVehicleModal && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#111" }}>Add New Vehicle</h3>
              <button type="button" onClick={() => setShowCreateVehicleModal(false)} style={modalCloseBtnStyle}>✕</button>
            </div>

            {createVehicleError && (
              <div style={errorBannerStyle}>{createVehicleError}</div>
            )}

            <form onSubmit={handleCreateVehicle}>
              <div style={{ marginBottom: "14px" }}>
                <label style={labelStyle}>Vehicle ID *</label>
                <input
                  type="text"
                  value={newVehicleId}
                  onChange={(e) => setNewVehicleId(e.target.value.toUpperCase())}
                  placeholder="e.g. BUS-102"
                  maxLength={64}
                  autoFocus
                  required
                  style={inputStyle}
                />
                <span style={hintStyle}>Unique vehicle identifier (letters, numbers, hyphens).</span>
              </div>

              <div style={{ marginBottom: "18px" }}>
                <label style={labelStyle}>Display Name (Optional)</label>
                <input
                  type="text"
                  value={newVehicleName}
                  onChange={(e) => setNewVehicleName(e.target.value)}
                  placeholder="e.g. Downtown Express Shuttler"
                  maxLength={128}
                  style={inputStyle}
                />
              </div>

              <div style={modalActionsStyle}>
                <button type="button" onClick={() => setShowCreateVehicleModal(false)} style={cancelBtnStyle}>
                  Cancel
                </button>
                <button type="submit" disabled={createVehicleLoading || !newVehicleId.trim()} style={primaryBtnStyle}>
                  {createVehicleLoading ? "Creating..." : "Create Vehicle"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. Confirm Retire Vehicle Modal */}
      {confirmRetireVehicle && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
              <span style={{ fontSize: "22px" }}>⚠️</span>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#111" }}>Retire Vehicle</h3>
            </div>
            <p style={{ margin: "0 0 14px", fontSize: "13px", color: "#555", lineHeight: 1.5 }}>
              Are you sure you want to retire vehicle <strong>{selectedVehicleId}</strong>?
            </p>
            <div style={dangerWarningStyle}>
              Retirement is permanent. A retired vehicle cannot be reactivated, its assigned route is ended, and all associated devices will be revoked immediately.
            </div>
            <div style={modalActionsStyle}>
              <button type="button" onClick={() => setConfirmRetireVehicle(false)} style={cancelBtnStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleUpdateVehicleStatus("retired")}
                disabled={lifecycleLoading}
                style={dangerBtnStyle}
              >
                {lifecycleLoading ? "Retiring..." : "Permanently Retire"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2b. Confirm Permanent Delete Vehicle Modal */}
      {vehicleToDelete && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
              <span style={{ fontSize: "22px" }}>⚠️</span>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#b91c1c" }}>
                Permanently Delete Vehicle
              </h3>
            </div>

            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#374151", lineHeight: 1.5 }}>
              Are you sure you want to permanently delete vehicle <strong>{vehicleToDelete.vehicle_id}</strong>
              {vehicleToDelete.display_name ? ` (${vehicleToDelete.display_name})` : ""}?
            </p>

            <div style={{ ...dangerWarningStyle, marginBottom: "14px" }}>
              <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                ⚠️ This action is permanent and cannot be undone
              </div>
              <div style={{ marginBottom: "6px" }}>
                All vehicle-owned records will be immediately purged from the database:
              </div>
              <ul style={{ margin: "0 0 6px 18px", padding: 0, fontSize: "12px" }}>
                <li>All tracking devices and device credentials</li>
                <li>Live location and current movement state</li>
                <li>All historical GPS telemetry fixes</li>
                <li>Route assignment history</li>
              </ul>
              <div style={{ fontSize: "11px", color: "#7f1d1d" }}>
                <strong>Important:</strong> Delete is intended primarily for test, duplicate, or misconfigured vehicles. To take an operational vehicle out of service, use <strong>Retire</strong> instead to preserve audit history.
              </div>
            </div>

            {deleteVehicleError && (
              <div
                style={{
                  background: "#fff2f2",
                  border: "1px solid #ffc9c9",
                  color: "#d32f2f",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  marginBottom: "12px",
                }}
              >
                {deleteVehicleError}
              </div>
            )}

            <form onSubmit={handleDeleteVehicle}>
              <div style={{ marginBottom: "14px" }}>
                <label
                  htmlFor="confirm-delete-vehicle-input"
                  style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#374151", marginBottom: "6px" }}
                >
                  Type the exact vehicle ID <strong>{vehicleToDelete.vehicle_id}</strong> to confirm:
                </label>
                <input
                  id="confirm-delete-vehicle-input"
                  type="text"
                  value={deleteConfirmInput}
                  onChange={(e) => setDeleteConfirmInput(e.target.value)}
                  placeholder={vehicleToDelete.vehicle_id}
                  disabled={deleteVehicleLoading}
                  style={{
                    ...inputStyle,
                    borderColor:
                      deleteConfirmInput.trim().toUpperCase() === vehicleToDelete.vehicle_id.toUpperCase()
                        ? "#dc2626"
                        : "#ccc",
                  }}
                  autoFocus
                />
              </div>

              <div style={modalActionsStyle}>
                <button
                  type="button"
                  onClick={() => {
                    setVehicleToDelete(null);
                    setDeleteConfirmInput("");
                    setDeleteVehicleError("");
                  }}
                  disabled={deleteVehicleLoading}
                  style={cancelBtnStyle}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    deleteVehicleLoading ||
                    deleteConfirmInput.trim().toUpperCase() !== vehicleToDelete.vehicle_id.toUpperCase()
                  }
                  style={{
                    ...dangerBtnStyle,
                    cursor:
                      deleteVehicleLoading ||
                      deleteConfirmInput.trim().toUpperCase() !== vehicleToDelete.vehicle_id.toUpperCase()
                        ? "not-allowed"
                        : "pointer",
                    opacity:
                      deleteConfirmInput.trim().toUpperCase() !== vehicleToDelete.vehicle_id.toUpperCase()
                        ? 0.6
                        : 1,
                  }}
                >
                  {deleteVehicleLoading ? "Deleting..." : "Permanently Delete Vehicle"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 3. Confirm Device Revoke Modal */}
      {deviceToRevoke && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
              <span style={{ fontSize: "22px" }}>⚠️</span>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#111" }}>Confirm Device Revocation</h3>
            </div>
            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#555", lineHeight: 1.5 }}>
              Are you sure you want to revoke the device <strong>&quot;{deviceToRevoke.device_label}&quot;</strong> for vehicle <strong>{selectedVehicleId}</strong>?
            </p>
            <div style={dangerWarningStyle}>
              This will immediately invalidate the device credentials and disconnect telemetry. The driver will require a new pairing code to resume.
            </div>
            {revokeError && <div style={errorBannerStyle}>{revokeError}</div>}
            <div style={modalActionsStyle}>
              <button type="button" onClick={() => setDeviceToRevoke(null)} disabled={revokeLoading} style={cancelBtnStyle}>
                Cancel
              </button>
              <button type="button" onClick={handleConfirmRevoke} disabled={revokeLoading} style={dangerBtnStyle}>
                {revokeLoading ? "Revoking..." : "Yes, Revoke Device"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Create Route Modal */}
      {showCreateRouteModal && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#111" }}>Create New Route</h3>
              <button type="button" onClick={() => setShowCreateRouteModal(false)} style={modalCloseBtnStyle}>✕</button>
            </div>
            {createRouteError && <div style={errorBannerStyle}>{createRouteError}</div>}
            <form onSubmit={handleCreateRoute}>
              <div style={{ marginBottom: "14px" }}>
                <label style={labelStyle}>Route ID *</label>
                <input
                  type="text"
                  value={newRouteId}
                  onChange={(e) => setNewRouteId(e.target.value.toUpperCase())}
                  placeholder="e.g. R02"
                  maxLength={64}
                  autoFocus
                  required
                  style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: "18px" }}>
                <label style={labelStyle}>Route Name *</label>
                <input
                  type="text"
                  value={newRouteName}
                  onChange={(e) => setNewRouteName(e.target.value)}
                  placeholder="e.g. South Campus Circulator"
                  maxLength={128}
                  required
                  style={inputStyle}
                />
              </div>
              <div style={modalActionsStyle}>
                <button type="button" onClick={() => setShowCreateRouteModal(false)} style={cancelBtnStyle}>
                  Cancel
                </button>
                <button type="submit" disabled={createRouteLoading || !newRouteId.trim() || !newRouteName.trim()} style={primaryBtnStyle}>
                  {createRouteLoading ? "Creating..." : "Create Route"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 5. Edit Route Name Modal */}
      {showEditRouteModal && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#111" }}>Edit Route Name</h3>
              <button type="button" onClick={() => setShowEditRouteModal(false)} style={modalCloseBtnStyle}>✕</button>
            </div>
            {editRouteError && <div style={errorBannerStyle}>{editRouteError}</div>}
            <form onSubmit={handleUpdateRouteName}>
              <div style={{ marginBottom: "18px" }}>
                <label style={labelStyle}>Route Name</label>
                <input
                  type="text"
                  value={editRouteName}
                  onChange={(e) => setEditRouteName(e.target.value)}
                  placeholder="New route name"
                  maxLength={128}
                  autoFocus
                  required
                  style={inputStyle}
                />
              </div>
              <div style={modalActionsStyle}>
                <button type="button" onClick={() => setShowEditRouteModal(false)} style={cancelBtnStyle}>
                  Cancel
                </button>
                <button type="submit" disabled={editRouteLoading || !editRouteName.trim()} style={primaryBtnStyle}>
                  {editRouteLoading ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 6. Delete Route Modal */}
      {showDeleteRouteModal && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
              <span style={{ fontSize: "22px" }}>⚠️</span>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#111" }}>Delete Route</h3>
            </div>
            <p style={{ margin: "0 0 14px", fontSize: "13px", color: "#555", lineHeight: 1.5 }}>
              Are you sure you want to delete route <strong>{selectedRouteId}</strong>?
            </p>
            <div style={dangerWarningStyle}>
              Routes with active vehicles cannot be deleted. All stops associated with this route will also be removed.
            </div>
            {deleteRouteError && <div style={errorBannerStyle}>{deleteRouteError}</div>}
            <div style={modalActionsStyle}>
              <button type="button" onClick={() => setShowDeleteRouteModal(false)} disabled={deleteRouteLoading} style={cancelBtnStyle}>
                Cancel
              </button>
              <button type="button" onClick={handleDeleteRoute} disabled={deleteRouteLoading} style={dangerBtnStyle}>
                {deleteRouteLoading ? "Deleting..." : "Delete Route"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Create / Edit Stop Modal */}
      {stopModalMode && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#111" }}>
                {stopModalMode === "create" ? "Add Route Stop" : "Edit Stop"}
              </h3>
              <button type="button" onClick={() => setStopModalMode(null)} style={modalCloseBtnStyle}>✕</button>
            </div>
            {stopFormError && <div style={errorBannerStyle}>{stopFormError}</div>}
            <form onSubmit={handleSaveStop}>
              <div style={{ marginBottom: "12px" }}>
                <label style={labelStyle}>Stop ID *</label>
                <input
                  type="text"
                  value={stopFormId}
                  onChange={(e) => setStopFormId(e.target.value.toUpperCase())}
                  placeholder="e.g. ST-01"
                  maxLength={64}
                  disabled={stopModalMode === "edit"}
                  required
                  style={{
                    ...inputStyle,
                    background: stopModalMode === "edit" ? "#f5f5f5" : "#fff",
                  }}
                />
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label style={labelStyle}>Stop Name *</label>
                <input
                  type="text"
                  value={stopFormName}
                  onChange={(e) => setStopFormName(e.target.value)}
                  placeholder="e.g. Main Library Entrance"
                  maxLength={128}
                  required
                  style={inputStyle}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "12px" }}>
                <div>
                  <label style={labelStyle}>Latitude (-90 to 90) *</label>
                  <input
                    type="number"
                    step="any"
                    value={stopFormLat}
                    onChange={(e) => setStopFormLat(e.target.value)}
                    placeholder="27.2400"
                    required
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Longitude (-180 to 180) *</label>
                  <input
                    type="number"
                    step="any"
                    value={stopFormLng}
                    onChange={(e) => setStopFormLng(e.target.value)}
                    placeholder="77.8400"
                    required
                    style={inputStyle}
                  />
                </div>
              </div>

              <div style={{ marginBottom: "18px" }}>
                <label style={labelStyle}>Sequence Position (1 to {stopModalMode === "create" ? stops.length + 1 : stops.length}) *</label>
                <input
                  type="number"
                  min="1"
                  max={stopModalMode === "create" ? stops.length + 1 : stops.length}
                  value={stopFormSequence}
                  onChange={(e) => setStopFormSequence(e.target.value)}
                  required
                  style={inputStyle}
                />
              </div>

              <div style={modalActionsStyle}>
                <button type="button" onClick={() => setStopModalMode(null)} style={cancelBtnStyle}>
                  Cancel
                </button>
                <button type="submit" disabled={stopFormLoading || !stopFormId.trim() || !stopFormName.trim()} style={primaryBtnStyle}>
                  {stopFormLoading ? "Saving..." : stopModalMode === "create" ? "Add Stop" : "Save Stop"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 8. Delete Stop Confirmation Modal */}
      {stopToDelete && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
              <span style={{ fontSize: "22px" }}>⚠️</span>
              <h3 style={{ margin: 0, fontSize: "17px", color: "#111" }}>Delete Stop</h3>
            </div>
            <p style={{ margin: "0 0 14px", fontSize: "13px", color: "#555", lineHeight: 1.5 }}>
              Are you sure you want to remove stop <strong>&quot;{stopToDelete.stop_name}&quot;</strong> ({stopToDelete.stop_id}) from route <strong>{selectedRouteId}</strong>?
            </p>
            <div style={dangerWarningStyle}>
              Later stops will automatically shift up to preserve contiguous sequencing.
            </div>
            {deleteStopError && <div style={errorBannerStyle}>{deleteStopError}</div>}
            <div style={modalActionsStyle}>
              <button type="button" onClick={() => setStopToDelete(null)} disabled={deleteStopLoading} style={cancelBtnStyle}>
                Cancel
              </button>
              <button type="button" onClick={handleDeleteStop} disabled={deleteStopLoading} style={dangerBtnStyle}>
                {deleteStopLoading ? "Deleting..." : "Delete Stop"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================================================
   Inline Common Styles
   ========================================================= */
const modalBackdropStyle = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0,0,0,0.45)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px",
};

const modalCardStyle = {
  width: "100%",
  maxWidth: "460px",
  background: "#ffffff",
  borderRadius: "10px",
  padding: "24px",
  boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
};

const modalCloseBtnStyle = {
  border: "none",
  background: "transparent",
  fontSize: "18px",
  cursor: "pointer",
  color: "#666",
  padding: "4px",
};

const labelStyle = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  marginBottom: "5px",
  color: "#333",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 12px",
  borderRadius: "6px",
  border: "1px solid #ccc",
  fontSize: "13px",
  outline: "none",
};

const hintStyle = {
  display: "block",
  fontSize: "11px",
  color: "#888",
  marginTop: "4px",
};

const errorBannerStyle = {
  background: "#fff2f2",
  border: "1px solid #ffc9c9",
  color: "#d32f2f",
  padding: "8px 10px",
  borderRadius: "6px",
  fontSize: "12px",
  marginBottom: "14px",
};

const dangerWarningStyle = {
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: "6px",
  padding: "10px 12px",
  fontSize: "12px",
  color: "#b91c1c",
  marginBottom: "18px",
  lineHeight: 1.4,
};

const modalActionsStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "10px",
};

const cancelBtnStyle = {
  padding: "8px 14px",
  fontSize: "13px",
  borderRadius: "6px",
  border: "1px solid #ccc",
  background: "#ffffff",
  cursor: "pointer",
};

const primaryBtnStyle = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 600,
  borderRadius: "6px",
  border: "none",
  background: "#222",
  color: "#ffffff",
  cursor: "pointer",
};

const dangerBtnStyle = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 600,
  borderRadius: "6px",
  border: "none",
  background: "#dc3545",
  color: "#ffffff",
  cursor: "pointer",
};

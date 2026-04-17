import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { PaneNode } from "../types/session";
import { useSessionStore } from "./sessionStore";
import { firstLeafId, collectPtyIds, collectLeafIds, collectLeafCwds } from "../lib/paneTreeUtils";
import { isTauri } from "../lib/bridge";
import { listenRemote } from "../lib/remoteEvents";
import { loadProto } from "../lib/remoteProtobuf";
import { getBrowserRemoteClient } from "../lib/webrtcClient";
import { useDialogStore } from "./dialogStore";
import { getGitT } from "../lib/i18n/git";
import { useAuthStore } from "./authStore";
import { useSettingsStore, DEFAULT_SIGNALING_WS_URL } from "./settingsStore";
import { logger } from "../lib/logger";
import { disposeAllRemoteTerminals, disposeRemoteTerminals } from "../lib/remoteTerminalRegistry";
import { clearAllRemotePtyOutputBuffers, clearRemotePtyOutputBuffers } from "../lib/remotePtyOutputBuffer";

type RemoteStatus = "disconnected" | "connecting" | "reconnecting" | "waiting" | "connected" | "failed";
// Backend may emit "account_waiting" for account-based hosting — treat as "waiting"
const normalizeStatus = (s: string): RemoteStatus =>
  (s === "account_waiting" || s === "waiting_approval") ? "waiting" : (s as RemoteStatus);
type DialogMode = "host" | "client";

interface RemoteClient {
  id: string;
  name: string;
  connectedAt: number;
}

export interface RemoteSessionInfo {
  id: string;
  name: string;
  pane_count: number;
  created_at: number;
  pane_ids: string[];
  layout_json: string;
  /** "macos" | "linux" | "windows" | "unknown" | "" (empty when host is pre-0.0.4). */
  host_os: string;
}

export interface RemoteDevice {
  id: string;
  name: string;
  os?: string;
  online: boolean;
  sessions: { name: string; pane_count: number }[];
}

/** Per-device connection state. */
export interface DeviceConnection {
  deviceId: string;
  status: RemoteStatus;
  error: string | null;
  sessions: RemoteSessionInfo[];
  connectionSteps: { step: string; label: string; elapsedMs: number }[];
  connectionMode: "pairing" | "account" | null;
}

interface RemoteStore {
  // Host side
  hostStatus: RemoteStatus;
  hostError: string | null;

  // Client side — multi-connection
  /** Per-device connection states. */
  connections: Record<string, DeviceConnection>;

  // Legacy single-connection fields (derived for backward compat)
  clientStatus: RemoteStatus;
  clientError: string | null;

  // UI state
  pairingCode: string | null;
  isDialogOpen: boolean;
  dialogMode: DialogMode;
  connectedClients: RemoteClient[];
  /** Remote pane IDs discovered from remote-pty-output events (client mode). */
  remotePaneIds: string[];
  /** Full session info from the remote host (client mode — merged from all connections). */
  remoteSessions: RemoteSessionInfo[];
  remoteSessionsLoading: boolean;
  /** Currently active remote session (selected by user from session picker). */
  activeRemoteSession: RemoteSessionInfo | null;
  /** Account-based: online devices belonging to the current user. */
  myDevices: RemoteDevice[];
  myDevicesLoading: boolean;
  myDevicesError: string | null;
  /** Device name of this machine (used to identify current device in the list). */
  currentDeviceName: string | null;
  /** ID of the device we are currently connected to (client mode). */
  connectedDeviceId: string | null;
  /** Pending account-based connection requests from web clients (queue). */
  pendingConnectionRequests: { roomCode: string; fromLogin: string; fromDevice: string }[];
  /** Connection progress steps received from backend (for active connecting device). */
  connectionSteps: { step: string; label: string; elapsedMs: number }[];
  /** Connection mode: pairing or account. */
  connectionMode: "pairing" | "account" | null;
  /** Toast message shown after hosting starts successfully. */
  hostToast: string | null;
  /**
   * Intent flag: user clicked Share → Sign in while unauthenticated. When the
   * login flow completes, the ShareDialog consumes this flag and automatically
   * calls `startAccountHosting()` so the user does not have to click again.
   */
  pendingHostAfterLogin: boolean;
  setPendingHostAfterLogin: (pending: boolean) => void;

  /** Pane ID → device ID mapping (populated from events). */
  paneToDevice: Record<string, string>;
  /** Session ID → device ID mapping. */
  sessionToDevice: Record<string, string>;

  openDialog: () => void;
  closeDialog: () => void;
  setDialogMode: (mode: DialogMode) => void;
  startHosting: () => Promise<void>;
  stopHosting: () => Promise<void>;
  connectToHost: (code: string) => Promise<void>;
  disconnect: (deviceId?: string) => Promise<void>;
  approveClient: (clientId: string) => Promise<void>;
  rejectClient: (clientId: string) => Promise<void>;
  getStatus: () => Promise<void>;
  refreshRemoteSessions: (deviceId?: string) => Promise<void>;
  /** Fetch my online devices from signaling server (account-based). */
  fetchMyDevices: () => Promise<void>;
  /** Connect to a specific device by ID (account-based WebRTC). */
  connectToDevice: (deviceId: string) => Promise<void>;
  /** Start account-based hosting (register device with JWT via daemon IPC). */
  startAccountHosting: () => Promise<void>;
  /** Get list of connected device IDs. */
  getConnectedDeviceIds: () => string[];
  /** Get connection state for a specific device. */
  getDeviceConnection: (deviceId: string) => DeviceConnection | undefined;
}

/** Derive overall client status from all connections. */
function deriveClientStatus(connections: Record<string, DeviceConnection>): RemoteStatus {
  const statuses = Object.values(connections).map((c) => c.status);
  if (statuses.includes("connected")) return "connected";
  if (statuses.includes("connecting")) return "connecting";
  if (statuses.includes("failed")) return "failed";
  return "disconnected";
}

export const useRemoteStore = create<RemoteStore>((set, get) => ({
  hostStatus: "disconnected",
  hostError: null,
  connections: {},
  clientStatus: "disconnected",
  clientError: null,
  pairingCode: null,
  isDialogOpen: false,
  dialogMode: "client",
  connectedClients: [],
  remotePaneIds: [],
  remoteSessions: [],
  remoteSessionsLoading: false,
  activeRemoteSession: null,
  myDevices: [],
  myDevicesLoading: false,
  myDevicesError: null,
  currentDeviceName: null,
  connectedDeviceId: null,
  pendingConnectionRequests: [],
  connectionSteps: [],
  connectionMode: null,
  hostToast: null,
  pendingHostAfterLogin: false,
  paneToDevice: {},
  sessionToDevice: {},

  setPendingHostAfterLogin: (pending: boolean) => set({ pendingHostAfterLogin: pending }),

  openDialog: () => set({ isDialogOpen: true }),
  closeDialog: () => set({ isDialogOpen: false }),
  setDialogMode: (mode: DialogMode) => set({ dialogMode: mode }),

  getConnectedDeviceIds: () => {
    return Object.entries(get().connections)
      .filter(([, c]) => c.status === "connected")
      .map(([id]) => id);
  },

  getDeviceConnection: (deviceId: string) => {
    return get().connections[deviceId];
  },

  startHosting: async () => {
    logger.debug(`[remoteStore] startHosting`);
    set({ hostError: null, hostStatus: "connecting" });
    try {
      const result = await invoke<{ pairing_code: string; status: string }>(
        "start_remote_hosting"
      );
      logger.debug(`[remoteStore] startHosting success`);
      set({ pairingCode: result.pairing_code, hostStatus: "waiting" });
    } catch (e) {
      logger.error(`[remoteStore] startHosting failed: ${e}`);
      set({ hostStatus: "failed", hostError: String(e) });
    }
  },

  stopHosting: async () => {
    logger.debug(`[remoteStore] stopHosting`);
    set({ hostStatus: "disconnected", pairingCode: null, hostError: null, hostToast: null, connectedClients: [] });
    try {
      await invoke("stop_remote_hosting");
      logger.debug(`[remoteStore] stopHosting: backend command sent`);
    } catch (e) {
      logger.error(`[remoteStore] stopHosting backend error: ${e}`);
      set({ hostError: String(e) });
    }
  },

  connectToHost: async (code: string) => {
    set({
      clientError: null,
      clientStatus: "connecting",
      connectionSteps: [],
      connectionMode: "pairing",
      connectedDeviceId: "__pairing__",
    });
    try {
      if (!isTauri()) {
        await loadProto();
        await getBrowserRemoteClient().connect(DEFAULT_SIGNALING_WS_URL, code);
        return;
      }
      await invoke("connect_to_remote_host", { pairingCode: code });
    } catch (e) {
      set({ clientStatus: "failed", clientError: String(e) });
    }
  },

  disconnect: async (deviceId?: string) => {
    logger.debug(`[remoteStore] disconnect (device: ${deviceId ?? "all"})`);

    const state = get();
    const targetIds = deviceId
      ? [deviceId]
      : Object.keys(state.connections);

    // Remove remote sessions/tabs for disconnected devices
    for (const did of targetIds) {
      const conn = state.connections[did];
      if (conn) {
        const { sessions, removeSession } = useSessionStore.getState();
        for (const rs of conn.sessions) {
          const localId = `remote:${rs.id}`;
          if (sessions.find((s) => s.id === localId)) {
            removeSession(localId);
          }
        }
      }
    }

    // Dispose remote terminals — only for the target devices
    if (deviceId) {
      // Collect pane IDs belonging to the disconnecting device(s)
      const paneIdsToDispose = Object.entries(state.paneToDevice)
        .filter(([, did]) => targetIds.includes(did))
        .map(([paneId]) => paneId);
      disposeRemoteTerminals(paneIdsToDispose);
      clearRemotePtyOutputBuffers(paneIdsToDispose);
    } else {
      disposeAllRemoteTerminals();
      clearAllRemotePtyOutputBuffers();
    }

    // Update connections state
    const newConnections = { ...state.connections };
    const newPaneToDevice = { ...state.paneToDevice };
    const newSessionToDevice = { ...state.sessionToDevice };
    for (const did of targetIds) {
      delete newConnections[did];
      // Clean up pane/session mappings
      for (const [k, v] of Object.entries(newPaneToDevice)) {
        if (v === did) delete newPaneToDevice[k];
      }
      for (const [k, v] of Object.entries(newSessionToDevice)) {
        if (v === did) delete newSessionToDevice[k];
      }
    }

    // Merge remaining sessions
    const remainingSessions = Object.values(newConnections).flatMap((c) => c.sessions);

    const prev2 = get();
    const shouldClearActive = !deviceId
      || prev2.connectedDeviceId === deviceId
      || !prev2.connectedDeviceId;
    const shouldClearSession = !deviceId
      || (prev2.activeRemoteSession && targetIds.includes(
        prev2.sessionToDevice[prev2.activeRemoteSession.id] ?? ""
      ));

    set({
      connections: newConnections,
      clientStatus: deriveClientStatus(newConnections),
      clientError: null,
      remotePaneIds: remainingSessions.flatMap((s) => s.pane_ids),
      remoteSessions: remainingSessions,
      activeRemoteSession: shouldClearSession ? null : prev2.activeRemoteSession,
      connectedDeviceId: shouldClearActive ? null : prev2.connectedDeviceId,
      connectionSteps: shouldClearActive ? [] : prev2.connectionSteps,
      connectionMode: shouldClearActive ? null : prev2.connectionMode,
      paneToDevice: newPaneToDevice,
      sessionToDevice: newSessionToDevice,
    });

    try {
      if (!isTauri()) {
        getBrowserRemoteClient().disconnect();
        return;
      }
      await invoke("disconnect_remote", { deviceId: deviceId ?? null });
      logger.debug(`[remoteStore] disconnect: backend command sent`);
    } catch (e) {
      logger.error(`[remoteStore] disconnect backend error: ${e}`);
      set({ clientError: String(e) });
    }
  },

  approveClient: async (roomCode: string) => {
    useRemoteStore.setState((s) => ({
      pendingConnectionRequests: s.pendingConnectionRequests.filter((r) => r.roomCode !== roomCode),
    }));
    try {
      await invoke("approve_account_connection", { roomCode, approved: true });
    } catch (e) {
      set({ hostError: String(e) });
    }
  },

  rejectClient: async (roomCode: string) => {
    useRemoteStore.setState((s) => ({
      pendingConnectionRequests: s.pendingConnectionRequests.filter((r) => r.roomCode !== roomCode),
    }));
    try {
      await invoke("approve_account_connection", { roomCode, approved: false });
    } catch (e) {
      set({ hostError: String(e) });
    }
  },

  getStatus: async () => {
    try {
      const result = await invoke<{ status: string; pairing_code: string | null }>(
        "get_remote_status"
      );
      set({
        hostStatus: result.status as RemoteStatus,
        pairingCode: result.pairing_code,
      });
    } catch (e) {
      set({ hostError: String(e) });
    }
  },

  refreshRemoteSessions: async (deviceId?: string) => {
    set({ remoteSessionsLoading: true });
    try {
      if (!isTauri()) {
        getBrowserRemoteClient().requestSessionList();
        return;
      }
      await invoke("request_remote_session_list", { deviceId: deviceId ?? null });
    } catch (e) {
      set({ clientError: String(e), remoteSessionsLoading: false });
    }
  },

  fetchMyDevices: async () => {
    set({ myDevicesLoading: true, myDevicesError: null, myDevices: [] });
    try {
      const [devices, deviceName] = await Promise.all([
        invoke<RemoteDevice[]>("fetch_my_devices"),
        invoke<string>("get_current_device_name"),
      ]);
      set({ myDevices: devices, myDevicesLoading: false, currentDeviceName: deviceName });
    } catch (e) {
      set({ myDevicesError: String(e), myDevicesLoading: false });
    }
  },

  connectToDevice: async (deviceId: string) => {
    // Create/update per-device connection state
    const connections = { ...get().connections };
    connections[deviceId] = {
      deviceId,
      status: "connecting",
      error: null,
      sessions: [],
      connectionSteps: [],
      connectionMode: "account",
    };
    set({
      connections,
      clientStatus: "connecting",
      clientError: null,
      connectedDeviceId: deviceId,
      connectionSteps: [],
      connectionMode: "account",
    });
    try {
      await invoke("connect_to_device_account", { deviceId });
    } catch (e) {
      const conns = { ...get().connections };
      if (conns[deviceId]) {
        conns[deviceId] = { ...conns[deviceId], status: "failed", error: String(e) };
      }
      set({
        connections: conns,
        clientStatus: deriveClientStatus(conns),
        clientError: String(e),
      });
    }
  },

  startAccountHosting: async () => {
    logger.debug(`[remoteStore] startAccountHosting`);
    set({ hostError: null, hostStatus: "connecting", dialogMode: "host" });
    try {
      await invoke("start_account_hosting");
      logger.debug(`[remoteStore] startAccountHosting backend success`);
      set({ hostStatus: "waiting", hostToast: getGitT("remote.shareStarted") });
      setTimeout(() => useRemoteStore.setState({ hostToast: null }), 3000);
    } catch (e) {
      const msg = String(e);
      logger.error(`[remoteStore] startAccountHosting failed: ${msg}`);
      set({ hostStatus: "failed", hostError: msg });
      useDialogStore.getState().show({
        title: "Sharing Failed",
        message: msg,
        type: "error",
        confirmLabel: "OK",
      });
    }
  },
}));

// Setup all remote event listeners
let unlistenHostStatus: (() => void) | null = null;
let unlistenClientStatus: (() => void) | null = null;
let unlistenRemotePtyOutput: (() => void) | null = null;
let unlistenRemoteSessionList: (() => void) | null = null;
let unlistenRemoteLayoutUpdate: (() => void) | null = null;
let unlistenConnectionRequest: (() => void) | null = null;
let unlistenClientConnected: (() => void) | null = null;
let unlistenClientDisconnected: (() => void) | null = null;
let unlistenClientProgress: (() => void) | null = null;

export const setupRemoteListeners = async () => {
  // Clean up existing listeners if any
  unlistenHostStatus?.();
  unlistenClientStatus?.();
  unlistenRemotePtyOutput?.();
  unlistenRemoteSessionList?.();
  unlistenRemoteLayoutUpdate?.();
  unlistenConnectionRequest?.();
  unlistenClientConnected?.();
  unlistenClientDisconnected?.();
  unlistenClientProgress?.();

  unlistenHostStatus = await listenRemote(
    "remote-host-status",
    (payload) => {
      const { status, pairing_code, error } = payload as { status: string; pairing_code?: string; error?: string };
      logger.debug(`[remoteStore] EVENT remote-host-status: ${status} (error: ${error})`);
      if (status === "needs_reauth") {
        useSettingsStore.getState().setShareAliveEnabled(false);
        useAuthStore.getState().logout();
        useRemoteStore.setState({ hostStatus: "disconnected", hostError: null });
        return;
      }
      const prev = useRemoteStore.getState();
      useRemoteStore.setState({
        hostStatus: normalizeStatus(status),
        pairingCode: pairing_code ?? prev.pairingCode,
        hostError: error ?? null,
      });
    }
  );

  unlistenClientStatus = await listenRemote(
    "remote-client-status",
    (payload) => {
      const { status, error, device_id } = payload as {
        status: string; error?: string; gen?: number; device_id?: string;
      };
      const did = device_id ?? "__pairing__";
      logger.debug(`[remoteStore] EVENT remote-client-status: ${status} (device: ${did}, error: ${error})`);

      const prev = useRemoteStore.getState();
      const normalized = normalizeStatus(status);
      const isDisconnected = normalized === "disconnected" || normalized === "failed";

      // Update per-device connection
      const connections = { ...prev.connections };
      if (isDisconnected) {
        if (connections[did]) {
          // Clean up remote sessions/tabs and terminals for this device only
          const conn = connections[did];
          const paneIdsToDispose = Object.entries(prev.paneToDevice)
            .filter(([, d]) => d === did)
            .map(([paneId]) => paneId);
          disposeRemoteTerminals(paneIdsToDispose);
          clearRemotePtyOutputBuffers(paneIdsToDispose);

          const { sessions, removeSession } = useSessionStore.getState();
          for (const rs of conn.sessions) {
            const localId = `remote:${rs.id}`;
            if (sessions.find((s) => s.id === localId)) {
              removeSession(localId);
            }
          }
          delete connections[did];
        }
        // Clean up pane/session mappings
        const newPaneToDevice = { ...prev.paneToDevice };
        const newSessionToDevice = { ...prev.sessionToDevice };
        for (const [k, v] of Object.entries(newPaneToDevice)) {
          if (v === did) delete newPaneToDevice[k];
        }
        for (const [k, v] of Object.entries(newSessionToDevice)) {
          if (v === did) delete newSessionToDevice[k];
        }
        const remainingSessions = Object.values(connections).flatMap((c) => c.sessions);
        useRemoteStore.setState({
          connections,
          clientStatus: deriveClientStatus(connections),
          clientError: error ?? null,
          remoteSessions: remainingSessions,
          remotePaneIds: remainingSessions.flatMap((s) => s.pane_ids),
          paneToDevice: newPaneToDevice,
          sessionToDevice: newSessionToDevice,
        });
      } else {
        if (!connections[did]) {
          connections[did] = {
            deviceId: did,
            status: normalized,
            error: error ?? null,
            sessions: [],
            connectionSteps: [],
            connectionMode: "account",
          };
        } else {
          connections[did] = { ...connections[did], status: normalized, error: error ?? null };
        }
        useRemoteStore.setState({
          connections,
          clientStatus: deriveClientStatus(connections),
          clientError: error ?? null,
        });

        // Auto-fetch session list when device becomes connected
        if (normalized === "connected") {
          useRemoteStore.getState().refreshRemoteSessions(did).catch(() => {});
        }
      }
    }
  );

  unlistenRemotePtyOutput = await listenRemote(
    "remote-pty-output",
    (payload) => {
      const { pane_id, device_id } = payload as { pane_id: string; data: number[]; device_id?: string };
      const { remotePaneIds, paneToDevice } = useRemoteStore.getState();
      const updates: Partial<ReturnType<typeof useRemoteStore.getState>> = {};
      if (!remotePaneIds.includes(pane_id)) {
        updates.remotePaneIds = [...remotePaneIds, pane_id];
      }
      if (device_id && paneToDevice[pane_id] !== device_id) {
        updates.paneToDevice = { ...paneToDevice, [pane_id]: device_id };
      }
      if (Object.keys(updates).length > 0) {
        useRemoteStore.setState(updates as Record<string, unknown>);
      }
    }
  );

  unlistenRemoteSessionList = await listenRemote(
    "remote-session-list",
    (payload) => {
      const { sessions, device_id } = payload as {
        sessions: RemoteSessionInfo[]; device_id?: string;
      };
      const did = device_id ?? "__unknown__";
      const prev = useRemoteStore.getState();

      // Update per-device sessions
      const connections = { ...prev.connections };
      if (connections[did]) {
        connections[did] = { ...connections[did], sessions };
      }

      // Update session → device mapping
      const newSessionToDevice = { ...prev.sessionToDevice };
      const newPaneToDevice = { ...prev.paneToDevice };
      for (const s of sessions) {
        newSessionToDevice[s.id] = did;
        for (const pid of s.pane_ids) {
          newPaneToDevice[pid] = did;
        }
      }

      // Merge all sessions from all connections
      const allSessions = Object.values(connections).flatMap((c) => c.sessions);

      useRemoteStore.setState({
        connections,
        remoteSessions: allSessions,
        remoteSessionsLoading: false,
        sessionToDevice: newSessionToDevice,
        paneToDevice: newPaneToDevice,
      });
    }
  );

  unlistenRemoteLayoutUpdate = await listenRemote(
    "remote-layout-update",
    (payload) => {
      const { session_id, layout_json, pane_count, device_id } = payload as {
        session_id: string; layout_json: string; pane_count: number; device_id?: string;
      };
      let rootPane: PaneNode;
      try {
        rootPane = JSON.parse(layout_json);
      } catch {
        logger.error("[remoteStore] Failed to parse layout_json", layout_json);
        return;
      }

      const pane_ids = collectPtyIds(rootPane);
      const did = device_id ?? useRemoteStore.getState().sessionToDevice[session_id];

      // Update pane → device mapping
      if (did) {
        const prev = useRemoteStore.getState();
        const newPaneToDevice = { ...prev.paneToDevice };
        for (const pid of pane_ids) {
          newPaneToDevice[pid] = did;
        }
        useRemoteStore.setState({ paneToDevice: newPaneToDevice });
      }

      // Update active session and sessions list
      useRemoteStore.setState((state) => {
        const connections = { ...state.connections };
        if (did && connections[did]) {
          connections[did] = {
            ...connections[did],
            sessions: connections[did].sessions.map((s) =>
              s.id === session_id ? { ...s, layout_json, pane_count, pane_ids } : s
            ),
          };
        }
        const allSessions = Object.values(connections).flatMap((c) => c.sessions);
        return {
          connections,
          activeRemoteSession: state.activeRemoteSession?.id === session_id
            ? { ...state.activeRemoteSession, layout_json, pane_count, pane_ids }
            : state.activeRemoteSession,
          remoteSessions: allSessions,
        };
      });

      // Sync with sessionStore
      const localId = `remote:${session_id}`;
      const sessionState = useSessionStore.getState();
      const existing = sessionState.sessions.find((s) => s.id === localId);
      if (existing) {
        sessionState.updateSession({
          ...existing,
          rootPane,
          paneCount: pane_count,
        });

        // Sync CWD from leaf nodes into paneCwds map for ExplorerView
        for (const { ptyId, cwd } of collectLeafCwds(rootPane)) {
          sessionState.setPaneCwd(ptyId, cwd);
        }

        if (sessionState.focusedPaneId && sessionState.activeSessionId === localId) {
          const leafIds = collectLeafIds(rootPane);
          if (!leafIds.includes(sessionState.focusedPaneId)) {
            sessionState.setFocusedPane(firstLeafId(rootPane));
          }
        }
      }
    }
  );

  unlistenConnectionRequest = await listenRemote(
    "remote-connection-request",
    (payload) => {
      const { room_code, from_login, from_device } = payload as {
        room_code: string;
        from_login: string;
        from_device: string;
      };
      logger.debug(`[remoteStore] EVENT remote-connection-request from=${from_login}`);
      useRemoteStore.setState((s) => ({
        pendingConnectionRequests: [...s.pendingConnectionRequests, { roomCode: room_code, fromLogin: from_login, fromDevice: from_device }],
      }));
    }
  );

  unlistenClientConnected = await listenRemote(
    "remote-client-connected",
    (payload) => {
      const { room_code, from_login, from_device } = payload as {
        room_code: string;
        from_login: string;
        from_device: string;
      };
      logger.debug(`[remoteStore] EVENT remote-client-connected from=${from_login}`);
      useRemoteStore.setState((s) => ({
        connectedClients: [...s.connectedClients, {
          id: room_code,
          name: from_login !== "unknown" ? `@${from_login}` : from_device,
          connectedAt: Date.now(),
        }],
      }));
    }
  );

  unlistenClientDisconnected = await listenRemote(
    "remote-client-disconnected",
    (payload) => {
      const { room_code } = payload as { room_code: string };
      logger.debug(`[remoteStore] EVENT remote-client-disconnected`);
      useRemoteStore.setState((s) => ({
        connectedClients: s.connectedClients.filter((c) => c.id !== room_code),
      }));
    }
  );

  unlistenClientProgress = await listenRemote(
    "remote-client-progress",
    (payload) => {
      const { step, label, elapsed_ms, device_id } = payload as {
        step: string; label: string; elapsed_ms: number; device_id?: string;
      };
      const did = device_id ?? "__pairing__";
      logger.debug(`[remoteStore] EVENT remote-client-progress: ${step} (device: ${did}, ${elapsed_ms}ms)`);

      const prev = useRemoteStore.getState();
      const stepEntry = { step, label, elapsedMs: elapsed_ms };

      // Update per-device steps
      const connections = { ...prev.connections };
      if (connections[did]) {
        connections[did] = {
          ...connections[did],
          connectionSteps: [...connections[did].connectionSteps, stepEntry],
        };
      }

      // Also update top-level for the currently connecting device
      useRemoteStore.setState({
        connections,
        connectionSteps: [...prev.connectionSteps, stepEntry],
      });
    }
  );
};

// Note: setupRemoteListeners() and get_signaling_url are called from App.tsx
// after IPC is ready, not at module load.

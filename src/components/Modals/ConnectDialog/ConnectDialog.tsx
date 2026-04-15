import { useEffect, useState } from "react";
import { useRemoteStore } from "../../../stores/remoteStore";
import { useAuthStore } from "../../../stores/authStore";
import { X } from "@phosphor-icons/react";
import { BrowserHideGuard } from "../../Editor/BrowserViewer";
import { ConnectionSteps } from "./ConnectionSteps";
import { DeviceList } from "./DeviceList";
import { SessionPicker } from "./SessionPicker";

type View = "devices" | "sessions" | "connecting";

export default function ConnectDialog() {
  const isOpen = useRemoteStore((s) => s.isDialogOpen);
  const dialogMode = useRemoteStore((s) => s.dialogMode);
  const connections = useRemoteStore((s) => s.connections);
  const close = useRemoteStore((s) => s.closeDialog);
  const disconnect = useRemoteStore((s) => s.disconnect);
  const refreshRemoteSessions = useRemoteStore((s) => s.refreshRemoteSessions);
  const fetchMyDevices = useRemoteStore((s) => s.fetchMyDevices);
  const { isAuthenticated } = useAuthStore();

  const isVisible = isOpen && dialogMode === "client";

  // View state: which screen to show
  const [view, setView] = useState<View>("devices");
  // Which device we're viewing sessions for
  const [viewingDeviceId, setViewingDeviceId] = useState<string | null>(null);

  // Reset view to "devices" when dialog opens
  useEffect(() => {
    if (isVisible) {
      setView("devices");
      setViewingDeviceId(null);
    }
  }, [isVisible]);

  // When a device we're viewing finishes connecting, switch to sessions
  useEffect(() => {
    if (viewingDeviceId && view === "connecting") {
      const conn = connections[viewingDeviceId];
      if (conn?.status === "connected") {
        setView("sessions");
      } else if (conn?.status === "failed" || conn?.status === "disconnected") {
        setView("devices");
        setViewingDeviceId(null);
      }
    }
  }, [connections, viewingDeviceId, view]);

  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isVisible, close]);

  // Auto-fetch devices when opened
  useEffect(() => {
    if (isVisible && isAuthenticated) {
      fetchMyDevices();
    }
  }, [isVisible, isAuthenticated, fetchMyDevices]);

  // Auto-fetch sessions once when switching to sessions view
  useEffect(() => {
    if (isVisible && view === "sessions" && viewingDeviceId) {
      refreshRemoteSessions(viewingDeviceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, view, viewingDeviceId]);

  if (!isVisible) return null;

  const viewingConn = viewingDeviceId ? connections[viewingDeviceId] : null;
  const hasAnyConnection = Object.values(connections).some(
    (c) => c.status === "connecting" || c.status === "connected"
  );

  // Get failed device connection for error display
  const failedConn = viewingDeviceId ? connections[viewingDeviceId] : null;
  const showFailed = failedConn?.status === "failed" && view !== "devices";

  return (
    <>
    <BrowserHideGuard />
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="rounded-lg shadow-xl p-6 w-96"
        style={{
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          color: "var(--text-primary)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ fontSize: "var(--fs-15)", fontWeight: 600 }}>
            Connect to Device
          </h2>
          <button
            onClick={close}
            className="p-1 rounded hover:bg-white/10 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          {/* Device list view — always default */}
          {view === "devices" && (
            <DeviceList
              onViewSessions={(deviceId) => {
                setViewingDeviceId(deviceId);
                const conn = connections[deviceId];
                if (conn?.status === "connected") {
                  setView("sessions");
                } else if (conn?.status === "connecting") {
                  setView("connecting");
                }
              }}
            />
          )}

          {/* Connecting — step progress */}
          {view === "connecting" && viewingConn?.status === "connecting" && (
            <ConnectionSteps />
          )}

          {/* Sessions view — after selecting connected device */}
          {view === "sessions" && viewingConn?.status === "connected" && viewingDeviceId && (
            <SessionPicker
              onClose={close}
              deviceId={viewingDeviceId}
              onBackToDevices={() => {
                setView("devices");
                setViewingDeviceId(null);
              }}
            />
          )}

          {/* Failed */}
          {showFailed && (
            <div className="text-center py-2">
              <p style={{ fontSize: "var(--fs-13)", color: "var(--accent-red)" }} className="mb-2">
                Connection failed
              </p>
              {failedConn?.error && (
                <p style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }} className="mb-3">
                  {failedConn.error}
                </p>
              )}
              <button
                onClick={() => {
                  setView("devices");
                  setViewingDeviceId(null);
                }}
                className="px-4 py-1.5 rounded-md transition-colors"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  fontSize: "var(--fs-12)",
                  border: "1px solid var(--border-default)",
                }}
              >
                Try Again
              </button>
            </div>
          )}

          {/* Disconnect button — only when viewing a specific device's connection */}
          {view !== "devices" && viewingDeviceId && viewingConn && (
            <button
              onClick={() => {
                disconnect(viewingDeviceId);
                setView("devices");
                setViewingDeviceId(null);
              }}
              className="w-full py-2 rounded-md transition-colors"
              style={{
                backgroundColor: "color-mix(in srgb, var(--accent-red) 10%, transparent)",
                color: "var(--accent-red)",
                fontSize: "var(--fs-12)",
                border: "1px solid color-mix(in srgb, var(--accent-red) 30%, transparent)",
              }}
            >
              Disconnect
            </button>
          )}

          {/* Disconnect All — shown on devices view when multiple connections exist */}
          {view === "devices" && hasAnyConnection && Object.keys(connections).length > 1 && (
            <button
              onClick={() => disconnect()}
              className="w-full py-2 rounded-md transition-colors"
              style={{
                backgroundColor: "color-mix(in srgb, var(--accent-red) 10%, transparent)",
                color: "var(--accent-red)",
                fontSize: "var(--fs-12)",
                border: "1px solid color-mix(in srgb, var(--accent-red) 30%, transparent)",
              }}
            >
              Disconnect All
            </button>
          )}
        </div>
      </div>
    </div>
    </>
  );
}

import { useEffect, useRef } from "react";
import { useRemoteStore } from "../../../stores/remoteStore";
import type { RemoteDevice } from "../../../stores/remoteStore";
import { useAuthStore } from "../../../stores/authStore";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { AppleIcon, WindowsIcon, LinuxIcon } from "../../TabBar/Icons";

interface DeviceListProps {
  onViewSessions: (deviceId: string) => void;
}

export function DeviceList({ onViewSessions }: DeviceListProps) {
  const myDevices = useRemoteStore((s) => s.myDevices);
  const myDevicesLoading = useRemoteStore((s) => s.myDevicesLoading);
  const myDevicesError = useRemoteStore((s) => s.myDevicesError);
  const fetchMyDevices = useRemoteStore((s) => s.fetchMyDevices);
  const connectToDevice = useRemoteStore((s) => s.connectToDevice);
  const connections = useRemoteStore((s) => s.connections);
  const { isAuthenticated, isStartingLogin, startLogin } = useAuthStore();

  // Auto-navigate to sessions when a device becomes connected
  const pendingViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingViewRef.current) {
      const conn = connections[pendingViewRef.current];
      if (conn?.status === "connected") {
        const deviceId = pendingViewRef.current;
        pendingViewRef.current = null;
        onViewSessions(deviceId);
      } else if (conn?.status === "failed" || conn?.status === "disconnected") {
        pendingViewRef.current = null;
      }
    }
  }, [connections, onViewSessions]);

  if (!isAuthenticated) {
    return (
      <>
        <p style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>
          Sign in with GitHub to connect to your devices.
        </p>
        <button
          onClick={() => startLogin()}
          disabled={isStartingLogin}
          className={`w-full py-2 rounded-md transition-colors flex items-center justify-center gap-2 ${isStartingLogin ? 'opacity-70' : ''}`}
          style={{
            backgroundColor: "var(--accent-blue)",
            color: "var(--bg-base)",
            fontSize: "var(--fs-13)",
            cursor: "default",
          }}
        >
          {isStartingLogin ? "Connecting..." : "Sign in with GitHub"}
        </button>
      </>
    );
  }

  const handleDeviceClick = (device: RemoteDevice) => {
    const conn = connections[device.id];
    if (conn?.status === "connected") {
      onViewSessions(device.id);
      return;
    }
    pendingViewRef.current = device.id;
    connectToDevice(device.id);
  };

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <p style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>
          Your online devices:
        </p>
        <button
          onClick={fetchMyDevices}
          disabled={myDevicesLoading}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          title="Refresh"
        >
          <ArrowsClockwise
            size={14}
            className={myDevicesLoading ? "animate-spin" : ""}
            style={{ color: "var(--text-muted)" }}
          />
        </button>
      </div>

      {myDevicesLoading && myDevices.length === 0 ? (
        <div className="flex items-center justify-center py-4 gap-2">
          <span
            className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: "var(--accent-blue)", borderTopColor: "transparent" }}
          />
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}>
            Loading devices...
          </span>
        </div>
      ) : myDevicesError ? (
        <div className="text-center py-4 space-y-2">
          <p style={{ fontSize: "var(--fs-11)", color: "var(--status-error)" }}>
            {myDevicesError}
          </p>
          <button
            onClick={fetchMyDevices}
            className="px-3 py-1 rounded transition-colors"
            style={{
              fontSize: "var(--fs-11)",
              backgroundColor: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              color: "var(--text-muted)",
            }}
          >
            Retry
          </button>
        </div>
      ) : myDevices.length === 0 ? (
        <div
          className="text-center py-4"
          style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}
        >
          No devices online. Start sharing on another device first.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
          {myDevices.map((device: RemoteDevice) => {
            // 같은 기기 접속 차단을 일시 해제 (셀프 테스트 허용).
            const isDisabled = !device.online;
            const conn = connections[device.id];
            const isConnectedDevice = conn?.status === "connected";
            const isConnecting = conn?.status === "connecting";
            return (
              <button
                key={device.id}
                onClick={() => !isConnecting && handleDeviceClick(device)}
                disabled={isDisabled || isConnecting}
                className="flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  border: isConnectedDevice
                    ? "1px solid var(--accent-blue)"
                    : "1px solid var(--border-default)",
                  opacity: isDisabled ? 0.5 : 1,
                  cursor: isDisabled || isConnecting ? "not-allowed" : "pointer",
                }}
                onMouseEnter={(e) => {
                  if (!isDisabled && !isConnecting) e.currentTarget.style.borderColor = "var(--accent-blue)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = isConnectedDevice
                    ? "var(--accent-blue)"
                    : "var(--border-default)";
                }}
              >
                {(() => {
                  if (device.os === "macos") return <AppleIcon />;
                  if (device.os === "windows") return <WindowsIcon />;
                  if (device.os === "linux") return <LinuxIcon />;
                  return (
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: device.online ? "var(--status-active)" : "var(--text-muted)" }}
                    />
                  );
                })()}
                <div className="flex-1 min-w-0">
                  <div
                    className="font-medium truncate flex items-center gap-1.5"
                    style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)" }}
                  >
                    {device.name}
                  </div>
                  {device.sessions.length > 0 && (
                    <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)" }}>
                      {device.sessions.length} session{device.sessions.length !== 1 ? "s" : ""}
                      {" — "}
                      {device.sessions.reduce((a, s) => a + s.pane_count, 0)} panes
                    </div>
                  )}
                </div>
                {isConnectedDevice ? (
                  <span
                    className="px-1.5 py-0.5 rounded-sm flex-shrink-0"
                    style={{
                      fontSize: "var(--fs-9)",
                      color: "var(--accent-blue)",
                      backgroundColor: "color-mix(in srgb, var(--accent-blue) 15%, transparent)",
                      fontWeight: 500,
                      letterSpacing: "0.02em",
                    }}
                  >
                    Connected
                  </span>
                ) : isConnecting ? (
                  <span
                    className="px-1.5 py-0.5 rounded-sm flex-shrink-0"
                    style={{
                      fontSize: "var(--fs-9)",
                      color: "var(--text-muted)",
                      backgroundColor: "var(--bg-hover)",
                      fontWeight: 500,
                    }}
                  >
                    Connecting...
                  </span>
                ) : device.online ? (
                  <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}>
                    &rarr;
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

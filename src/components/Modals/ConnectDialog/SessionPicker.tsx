import { useRemoteStore } from "../../../stores/remoteStore";
import type { RemoteSessionInfo } from "../../../stores/remoteStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { firstLeafId, collectLeafCwds } from "../../../lib/paneTreeUtils";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { PaneNode, Session } from "../../../types/session";

interface SessionPickerProps {
  onClose: () => void;
  deviceId: string;
  onBackToDevices?: () => void;
}

export function SessionPicker({ onClose, deviceId, onBackToDevices }: SessionPickerProps) {
  const connections = useRemoteStore((s) => s.connections);
  const remoteSessionsLoading = useRemoteStore((s) => s.remoteSessionsLoading);
  const refreshRemoteSessions = useRemoteStore((s) => s.refreshRemoteSessions);
  const myDevices = useRemoteStore((s) => s.myDevices);

  const conn = connections[deviceId];
  const remoteSessions = conn?.sessions ?? [];
  const connectedDevice = myDevices.find((d) => d.id === deviceId);

  return (
    <div className="py-1">
      {/* Connected device header with back button */}
      {onBackToDevices && (
        <button
          onClick={onBackToDevices}
          className="flex items-center gap-2 mb-3 px-2 py-1 rounded transition-colors hover:bg-white/5 w-full text-left"
        >
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}>&larr;</span>
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}>
            {connectedDevice ? connectedDevice.name : "Back to devices"}
          </span>
        </button>
      )}
      <div className="flex items-center justify-between mb-2">
        <p style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>
          Select a session to view:
        </p>
        <button
          onClick={() => refreshRemoteSessions(deviceId)}
          disabled={remoteSessionsLoading}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          title="Refresh"
        >
          <ArrowsClockwise
            size={14}
            className={remoteSessionsLoading ? "animate-spin" : ""}
            style={{ color: "var(--text-muted)" }}
          />
        </button>
      </div>

      {remoteSessionsLoading && remoteSessions.length === 0 ? (
        <div className="flex items-center justify-center py-4 gap-2">
          <span
            className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: "var(--accent-blue)", borderTopColor: "transparent" }}
          />
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}>
            Loading sessions...
          </span>
        </div>
      ) : remoteSessions.length === 0 ? (
        <div
          className="text-center py-4"
          style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}
        >
          No sessions available on the host.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
          {remoteSessions.map((session: RemoteSessionInfo) => (
            <button
              key={session.id}
              onClick={() => {
                let rootPane: PaneNode;
                try {
                  rootPane = JSON.parse(session.layout_json) as PaneNode;
                } catch {
                  rootPane = {
                    type: "leaf",
                    id: session.pane_ids[0] ?? session.id,
                    ptyId: session.pane_ids[0] ?? session.id,
                  };
                }

                const remoteSession: Session = {
                  id: `remote:${session.id}`,
                  name: session.name,
                  rootPane,
                  createdAt: session.created_at,
                  paneCount: session.pane_count,
                  isRemote: true,
                  remoteOs: session.host_os,
                };

                useRemoteStore.setState({
                  remotePaneIds: [
                    ...useRemoteStore.getState().remotePaneIds.filter(
                      (id) => !session.pane_ids.includes(id)
                    ),
                    ...session.pane_ids,
                  ],
                  activeRemoteSession: session,
                  connectedDeviceId: deviceId,
                });

                const { addSession, setFocusedPane, setPaneCwd } = useSessionStore.getState();
                addSession(remoteSession);
                // Sync CWD from leaf nodes for ExplorerView
                for (const { ptyId, cwd } of collectLeafCwds(rootPane)) {
                  setPaneCwd(ptyId, cwd);
                }
                setFocusedPane(firstLeafId(rootPane));
                onClose();
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors"
              style={{
                backgroundColor: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.borderColor = "var(--accent-blue)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.borderColor = "var(--border-default)")
              }
            >
              <div
                className="w-7 h-7 rounded flex items-center justify-center text-xs font-mono flex-shrink-0"
                style={{ backgroundColor: "var(--accent-blue)", color: "var(--bg-base)" }}
              >
                {session.pane_ids.length}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="text-sm font-medium truncate"
                  style={{ color: "var(--text-primary)" }}
                >
                  {session.name}
                </div>
                <div style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}>
                  {session.pane_ids.length} pane{session.pane_ids.length !== 1 ? "s" : ""}
                </div>
              </div>
              <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)" }}>
                &rarr;
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

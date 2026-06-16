import { invoke } from "@tauri-apps/api/core";
import { TerminalWindow, ArrowRight } from "@phosphor-icons/react";
import { useSessionStore } from "../../stores/sessionStore";
import type { PaneNode, LeafPane, Session } from "../../types/session";

function collectLeaves(node: PaneNode): LeafPane[] {
  if (node.type === "leaf") return [node];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

function shortCwd(cwd: string | undefined): { text: string; prefix: string } {
  if (!cwd) return { text: "", prefix: "" };
  const trimmed = cwd.replace(/\/$/, "");
  const parts = trimmed.split("/");
  const tail = parts.slice(-2).join("/");
  // Heuristic: paths under /Users/<x>/... or /home/<x>/... live in $HOME.
  // We can't know $HOME for sure from JS; surface the short tail without
  // pretending it's home-relative when it isn't.
  const looksLikeHome = /^\/(Users|home)\/[^/]+\//.test(trimmed + "/");
  return { text: tail, prefix: looksLikeHome ? "~/" : "/" };
}

function SessionRow({ session, isActive }: { session: Session; isActive: boolean }) {
  const paneCwds = useSessionStore((s) => s.paneCwds);
  const paneLastCommands = useSessionStore((s) => s.paneLastCommands);
  const leaves = collectLeaves(session.rootPane);

  const handleSwitch = () => {
    invoke("switch_session", { sessionId: session.id }).catch(() => {});
    useSessionStore.getState().setActiveSession(session.id);
  };

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {/* Session header */}
      <button
        onClick={handleSwitch}
        style={{
          width: "100%",
          background: isActive ? "var(--bg-hover)" : "transparent",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "calc(6px * var(--ui-scale))",
          padding: "calc(5px * var(--ui-scale)) calc(10px * var(--ui-scale))",
          textAlign: "left",
        }}
        onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
            fontWeight: isActive ? 600 : 400,
            fontSize: "calc(12px * var(--ui-scale))",
          }}
        >
          {session.name}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: "calc(10px * var(--ui-scale))", flexShrink: 0 }}>
          {leaves.length} pane{leaves.length !== 1 ? "s" : ""}
        </span>
        {!isActive && (
          <ArrowRight
            size={12}
            style={{ width: "calc(12px * var(--ui-scale))", height: "calc(12px * var(--ui-scale))", color: "var(--text-muted)", flexShrink: 0 }}
          />
        )}
      </button>

      {/* Pane list */}
      {leaves.map((leaf, idx) => {
        const cwd = paneCwds[leaf.ptyId] ?? leaf.cwd;
        const { text: displayCwd, prefix: cwdPrefix } = shortCwd(cwd);
        const lastCmd = paneLastCommands[leaf.ptyId] ?? leaf.lastCommand;
        return (
          <div
            key={leaf.ptyId}
            style={{
              padding: "calc(3px * var(--ui-scale)) calc(10px * var(--ui-scale)) calc(3px * var(--ui-scale)) calc(22px * var(--ui-scale))",
              display: "flex",
              flexDirection: "column",
              gap: "calc(1px * var(--ui-scale))",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: "calc(6px * var(--ui-scale))" }}>
              <span style={{ color: "var(--text-muted)", fontSize: "calc(10px * var(--ui-scale))", flexShrink: 0 }}>
                {idx + 1}
              </span>
              <span style={{ color: "var(--text-secondary)", fontSize: "calc(11px * var(--ui-scale))", flexShrink: 0 }}>
                {leaf.shell ?? "shell"}
              </span>
              {displayCwd && (
                <span
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "calc(10px * var(--ui-scale))",
                    fontFamily: "monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                  title={cwd}
                >
                  {cwdPrefix}{displayCwd}
                </span>
              )}
            </div>
            {lastCmd && (
              <span
                style={{
                  color: "var(--text-muted)",
                  fontSize: "calc(10px * var(--ui-scale))",
                  fontFamily: "monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  paddingLeft: "calc(16px * var(--ui-scale))",
                  opacity: 0.7,
                }}
                title={lastCmd}
              >
                $ {lastCmd}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function TerminalsPanel() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full" style={{ color: "var(--text-muted)", gap: "calc(8px * var(--ui-scale))" }}>
        <TerminalWindow size={32} style={{ width: "calc(32px * var(--ui-scale))", height: "calc(32px * var(--ui-scale))" }} weight="thin" />
        <span style={{ fontSize: "calc(11px * var(--ui-scale))" }}>No terminals open</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
        />
      ))}
    </div>
  );
}

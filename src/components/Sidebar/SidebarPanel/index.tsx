import { useCallback, useEffect, useState } from "react";
import { useSidebarStore } from "../../../stores/sidebarStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useGitT } from "../../../lib/i18n/git";
import { findPtyId } from "../../../lib/paneTreeUtils";
import GitPanel from "../GitPanel";
import GitLogPanel from "../GitLogPanel";
import AiHistoryPanel from "../AiHistoryPanel";
import AiLogPanel from "../AiLogPanel";
import FileSearchPanel from "../FileSearchPanel";
import ExplorerView from "./ExplorerView";
import { EXPLORER_REFRESH_EVENT } from "./constants";
import {
  ArrowClockwise,
  X,
  Files,
  Article,
  GitBranch,
  ChatCircleDots,
  MagnifyingGlass,
  ClockCounterClockwise,
  PushPin,
} from "@phosphor-icons/react";

const MIN_PANEL_WIDTH = 160;
const MAX_PANEL_WIDTH = 480;
const DEFAULT_PANEL_WIDTH = 240;

export default function SidebarPanel() {
  const activePanel = useSidebarStore((s) => s.activePanel);
  const t = useGitT();
  const labelMap: Record<string, string> = { explorer: t("sidebar.explorer"), git: t("sidebar.gitControl"), ailog: t("sidebar.aiLog"), docs: t("sidebar.docs"), search: "Search" };
  const label = labelMap[activePanel ?? ""] ?? (activePanel ? activePanel.charAt(0).toUpperCase() + activePanel.slice(1) : t("sidebar.explorer"));
  const iconSize = 12;
  const iconStyle = { width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))', flexShrink: 0 } as const;
  const headerIconMap: Record<string, React.ReactNode> = {
    explorer: <Files size={iconSize} weight="bold" style={iconStyle} />,
    git: <GitBranch size={iconSize} weight="bold" style={iconStyle} />,
    docs: <Article size={iconSize} weight="bold" style={iconStyle} />,
    ailog: <ChatCircleDots size={iconSize} weight="bold" style={iconStyle} />,
    search: <MagnifyingGlass size={iconSize} weight="bold" style={iconStyle} />,
  };
  const headerIcon = headerIconMap[activePanel ?? ""] ?? headerIconMap.explorer;
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [showGitLog, setShowGitLog] = useState(false);
  const explorerDocsFilter = useSettingsStore((s) => s.explorerDocsFilter);
  const isPinned = useSessionStore((s) => s.activeSessionId ? !!s.pinnedCwds[s.activeSessionId] : false);

  const handleTogglePin = useCallback(() => {
    const store = useSessionStore.getState();
    const sid = store.activeSessionId;
    if (!sid) return;
    if (store.pinnedCwds[sid]) {
      store.clearPinnedCwd(sid);
    } else {
      // Derive focused cwd freshly from current store state
      const session = store.sessions.find((s) => s.id === sid);
      if (!session || !store.focusedPaneId) return;
      const ptyId = findPtyId(session.rootPane, store.focusedPaneId);
      const cwd = ptyId ? store.paneCwds[ptyId] ?? "" : "";
      if (cwd) store.setPinnedCwd(sid, cwd);
    }
  }, []);

  // ESC key to close Git Log popup
  useEffect(() => {
    if (!showGitLog) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowGitLog(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showGitLog]);

  const handleResizeDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setWidth(Math.min(Math.max(startW + delta, MIN_PANEL_WIDTH), MAX_PANEL_WIDTH));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [width]);

  return (
    <div className="flex h-full" style={{ position: "relative" }}>
      <div
        className="flex flex-col h-full overflow-hidden"
        style={{
          width,
          background: "var(--bg-surface)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center shrink-0 px-3 select-none"
          style={{
            height: 'calc(24px * var(--ui-scale))',
            fontSize: 'var(--fs-11)',
            letterSpacing: "0.08em",
            color: "var(--text-tertiary)",
            background: "var(--bg-overlay)",
            borderBottom: "1px solid var(--border-subtle)",
            userSelect: "none",
          }}
          data-tauri-drag-region
        >
          <span className="flex items-center" style={{ gap: 5 }}>
            {headerIcon}
            {label}
          </span>
          {activePanel === "explorer" && (
            <div className="ml-auto flex items-center" style={{ gap: 4 }}>
              <button
                onClick={handleTogglePin}
                className="cursor-pointer"
                style={{ color: isPinned ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = isPinned ? "var(--accent-blue)" : "var(--text-muted)"; }}
                title={isPinned ? t("explorer.unpin") : t("explorer.pin")}
              >
                <PushPin size={14} weight={isPinned ? "fill" : "regular"} style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
              </button>
              <button
                onClick={() => useSettingsStore.getState().setExplorerDocsFilter(!explorerDocsFilter)}
                className="cursor-pointer"
                style={{ color: explorerDocsFilter ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = explorerDocsFilter ? "var(--accent-blue)" : "var(--text-muted)"; }}
                title={explorerDocsFilter ? t("explorer.showAll") : t("explorer.docsOnly")}
              >
                <Article size={14} style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
              </button>
              <button
                onClick={() => window.dispatchEvent(new Event(EXPLORER_REFRESH_EVENT))}
                className="cursor-pointer"
                style={{ color: "var(--text-muted)", lineHeight: 0 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
                title="Refresh Explorer"
              >
                <ArrowClockwise size={14} style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
              </button>
            </div>
          )}
          {activePanel === "git" && (
            <button
              onClick={() => setShowGitLog((p) => !p)}
              className="ml-auto cursor-pointer"
              style={{ color: showGitLog ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = showGitLog ? "var(--accent-blue)" : "var(--text-muted)";
              }}
              title="Git Command Log"
            >
              <ClockCounterClockwise size={14} style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
            </button>
          )}
        </div>

        {/* Content — all panels stay mounted to preserve scroll position */}
        <div className="flex-1 min-h-0" style={{ display: activePanel === "git" ? undefined : "none" }}>
          <GitPanel />
        </div>
        <div className="flex-1 min-h-0" style={{ display: activePanel === "aihistory" ? undefined : "none" }}>
          <AiHistoryPanel />
        </div>
        <div className="flex-1 min-h-0" style={{ display: activePanel === "ailog" ? undefined : "none" }}>
          <AiLogPanel />
        </div>
        <div className="flex-1 overflow-y-auto py-1" style={{ display: activePanel === "explorer" ? undefined : "none" }}>
          <ExplorerView />
        </div>
        <div className="flex-1 min-h-0" style={{ display: activePanel === "search" ? undefined : "none" }}>
          <FileSearchPanel />
        </div>
        {/* DocsView disabled — re-enable when root scan issue is fixed */}
        {/* <div className="flex-1 overflow-y-auto py-1" style={{ display: activePanel === "docs" ? undefined : "none" }}>
          <DocsView />
        </div> */}
      </div>
      {/* Resize handle */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: -2,
          width: 4,
          cursor: "col-resize",
          zIndex: 10,
          background: "transparent",
        }}
        onMouseDown={handleResizeDrag}
      />

      {/* Git Command Log popup */}
      {showGitLog && (
        <div
          style={{
            position: "fixed",
            top: 60,
            left: 300,
            width: 420,
            maxHeight: "calc(100vh - 120px)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            className="flex items-center shrink-0 px-3"
            style={{
              height: 'calc(30px * var(--ui-scale))',
              fontSize: 'var(--fs-11)',
              letterSpacing: "0.08em",
              color: "var(--text-tertiary)",
              borderBottom: "1px solid var(--border-subtle)",
              userSelect: "none",
            }}
          >
            <span>Git Command Log</span>
            <button
              onClick={() => setShowGitLog(false)}
              className="sb-icon ml-auto cursor-pointer"
              style={{ lineHeight: 0 }}
            >
              <X size={14} style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <GitLogPanel />
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useRef, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useSessionStore } from "./stores/sessionStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useEditorStore } from "./stores/editorStore";
import { usePanelEditorStore } from "./stores/panelEditorStore";
import { useGitT } from "./lib/i18n/git";
import PaneLayout from "./components/Layout/PaneLayout";
import TabBar from "./components/TabBar/TabBar";
import StatusBar from "./components/StatusBar/StatusBar";
import Sidebar from "./components/Sidebar/Sidebar";
import ErrorBoundary from "./components/ErrorBoundary";
import HistorySearch from "./components/HistorySearch/HistorySearch";
import NewTabPopup from "./components/TabBar/NewTabPopup";
import WindowResizeHandles from "./components/WindowResizeHandles";

// Custom hooks — extracted from the monolithic App component
import { useAppTheme } from "./hooks/useAppTheme";
import { useGlobalListeners } from "./hooks/useGlobalListeners";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useIpcSetupEffect } from "./hooks/useIpcSetup";

// Lazy-loaded components (not needed for initial render)
const InlineEditorPanel = lazy(() => import("./components/Editor/InlineEditorPanel"));
const InlineEditorModal = lazy(() => import("./components/Editor/InlineEditorModal"));
const SettingsDialog = lazy(() => import("./components/Modals/SettingsDialog"));
const CommandPalette = lazy(() => import("./components/CommandPalette/CommandPalette"));
const AddWorktreeModal = lazy(() => import("./components/Modals/AddWorktreeModal"));
const WorktreeActionModal = lazy(() => import("./components/Modals/WorktreeActionModal"));
const GitOutputModal = lazy(() => import("./components/Modals/GitOutputModal"));
const ShareDialog = lazy(() => import("./components/Modals/ShareDialog"));
const ConnectDialog = lazy(() => import("./components/Modals/ConnectDialog"));
const GlobalDialog = lazy(() => import("./components/Modals/GlobalDialog"));
const PullConflictDialog = lazy(() => import("./components/Modals/PullConflictDialog"));
const RestoreCommandDialog = lazy(() => import("./components/Modals/RestoreCommandDialog"));
const ConnectionRequestToast = lazy(() => import("./components/Modals/ConnectionRequestToast"));
const ToastContainer = lazy(() => import("./components/Toast/ToastContainer"));


function EmptyTerminalView() {
  const [showPopup, setShowPopup] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const t = useGitT();

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center"
      style={{ color: "var(--text-muted)", gap: 12 }}
    >
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M7 10l3 2-3 2" />
        <line x1="12" y1="14" x2="16" y2="14" />
      </svg>
      <button
        ref={btnRef}
        onClick={() => setShowPopup((v) => !v)}
        className="flex items-center cursor-pointer"
        style={{
          gap: 6,
          padding: "6px 14px",
          fontSize: "var(--fs-13)",
          color: "var(--text-secondary)",
          background: "var(--bg-tertiary)",
          border: "1px solid var(--border-primary)",
          borderRadius: 6,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-tertiary)"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {t("app.openFolder")}
      </button>
      {showPopup && (
        <NewTabPopup anchorRef={btnRef} onClose={() => setShowPopup(false)} />
      )}
    </div>
  );
}

function RootErrorFallback() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 8,
        color: "var(--text-muted)",
        fontSize: "var(--fs-12)",
      }}
    >
      <span>Application error</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          padding: "4px 12px",
          fontSize: "var(--fs-11)",
          color: "var(--text-secondary)",
          background: "var(--bg-overlay)",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary fallback={<RootErrorFallback />}>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const editorModalOpen = useEditorStore((s) => s.modalOpen);
  const editorPanelOpen = usePanelEditorStore((s) => s.panelOpen);
  const editorMode = useSettingsStore((s) => s.editorMode);
  const [error, setError] = useState<string | null>(null);
  const [gitInitProgress, setGitInitProgress] = useState<{ done: number; total: number } | null>(null);
  const t = useGitT();

  // All hooks — extracted from this file
  useAppTheme();
  useGlobalListeners();
  useGlobalShortcuts();
  useIpcSetupEffect(setError, setGitInitProgress);

  const handleReconnect = async () => {
    setError(null);
    try {
      await invoke("reconnect_ipc");
    } catch (e) {
      setError(`Reconnection failed: ${e}`);
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div style={{ color: "var(--accent-red)" }}>
          <p>{t("app.serverError").replace("{msg}", error)}</p>
        </div>
        <button
          onClick={handleReconnect}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-red) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent-red) 50%, transparent)",
            color: "var(--accent-red)",
          }}
        >
          {t("app.reconnect")}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col" style={{ background: "var(--bg-base)" }}>
      <WindowResizeHandles />
      <TabBar />
      <div className="flex-1 min-h-0 flex">
        <Sidebar />
        <div className="flex-1 min-w-0 flex min-h-0">
          <div className="flex-1 min-w-0 h-full relative">
            {sessions.length === 0 && (
              <EmptyTerminalView />
            )}
            {sessions.map((session) => (
              <div
                key={session.id}
                className="absolute inset-0"
                style={{
                  visibility: session.id === activeSessionId ? "visible" : "hidden",
                }}
              >
                <PaneLayout node={session.rootPane} isRemote={session.isRemote} />
              </div>
            ))}
          </div>
          {editorPanelOpen && (
            <ErrorBoundary>
              <Suspense fallback={null}>
                <InlineEditorPanel />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </div>
      {gitInitProgress && (
        <div style={{ height: 2, background: "var(--bg-overlay)", position: "relative", overflow: "hidden" }}>
          <div style={{
            height: "100%",
            width: `${gitInitProgress.total > 0 ? (gitInitProgress.done / gitInitProgress.total) * 100 : 0}%`,
            background: "var(--status-active)",
            transition: "width 0.3s ease",
          }} />
        </div>
      )}
      <StatusBar />
      <Suspense fallback={null}>
        <CommandPalette />
        <HistorySearch />
        <AddWorktreeModal />
        <WorktreeActionModal />
        <GitOutputModal />
        <ShareDialog />
        <ConnectDialog />
        <GlobalDialog />
        <PullConflictDialog />
        <RestoreCommandDialog />
        <ConnectionRequestToast />
        <ToastContainer />
        {editorMode === "internal" && editorModalOpen && <InlineEditorModal />}
        {editorMode === "internal" && <SettingsDialog />}
      </Suspense>
    </div>
  );
}

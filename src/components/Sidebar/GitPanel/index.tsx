import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  Broom,
  Plus,
  WarningCircle,
} from "@phosphor-icons/react";
import { useGitStore } from "../../../stores/gitStore";
import { useShallow } from "zustand/react/shallow";
import { useGitT } from "../../../lib/i18n/git";
import { useWorktreeStore } from "../../../stores/worktreeStore";
import { safeOpenUrl } from "../../../lib/osUtils";
import { usePanelEditorStore } from "../../../stores/panelEditorStore";
import WorktreePanel from "../WorktreePanel";
import GitHistoryView from "../GitHistoryView";
import { useCwd } from "./shared";
import GitBranchInfo from "./GitBranchInfo";
import NoRepoPanel from "./NoRepoPanel";
import GitChanges from "./GitChanges";

export default function GitPanel() {
  const cwd = useCwd();
  const { repoInfo, error } = useGitStore(useShallow((s) => ({ repoInfo: s.repoInfo, error: s.error })));
  const t = useGitT();
  const wtIsLoading = useWorktreeStore((s) => s.isLoading);
  const wtRefresh = useWorktreeStore((s) => s.refresh);
  const wtPrune = useWorktreeStore((s) => s.prune);
  const wtOpenAddModal = useWorktreeStore((s) => s.openAddModal);

  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio1, setRatio1] = useState(0.5); // Ratio for Changes
  const [showHistory, setShowHistory] = useState(false);

  // ESC to close history popup
  useEffect(() => {
    if (!showHistory) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowHistory(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHistory]);

  const handleSplitter1Drag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let lastY = e.clientY;
    const onMouseMove = (ev: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const delta = ev.clientY - lastY;
      lastY = ev.clientY;
      const totalHeight = container.clientHeight;
      if (totalHeight <= 0) return;
      setRatio1((prev) => Math.max(0.1, Math.min(0.8, prev + delta / totalHeight)));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // cwd 변경 시: git 상태 즉시 로딩
  useEffect(() => {
    if (cwd) useGitStore.getState().refresh(cwd);
  }, [cwd]);

  if (!cwd) {
    return (
      <div className="sb-empty">
        {t("git.noTerminal")}
      </div>
    );
  }

  const gitNotInstalled = error && (error.includes("Failed to execute git") || error.includes("No such file") || error.includes("os error 2") || error.includes("not found") || error.includes("ENOENT"));

  if (gitNotInstalled) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 16, textAlign: "center", lineHeight: 1.6 }}>
        <WarningCircle size={32} weight="duotone" style={{ color: "var(--accent-yellow)", marginBottom: 8 }} />
        <div style={{ fontSize: "var(--fs-12)", fontWeight: 600, marginBottom: 6 }}>
          {t("git.notInstalled")}
        </div>
        <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", marginBottom: 8 }}>
          {t("git.notInstalledDesc")}
        </div>
        <button
          onClick={() => { safeOpenUrl("https://git-scm.com/downloads"); }}
          style={{ fontSize: "var(--fs-10)", color: "var(--accent-blue)", textDecoration: "underline", cursor: "pointer", background: "none", border: "none", padding: 0 }}
        >
          git-scm.com/downloads
        </button>
      </div>
    );
  }

  if (!repoInfo) {
    return <NoRepoPanel cwd={cwd} />;
  }

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--bg-surface)" }}>
      <GitBranchInfo cwd={cwd} onOpenHistory={() => setShowHistory((p) => !p)} />

      <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
        {/* Changes pane */}
        <div
          className="overflow-y-auto"
          style={{ flex: `${ratio1} 0 0`, minHeight: 0 }}
        >
          <GitChanges cwd={cwd} onDiffOpen={(path, staged) => {
            usePanelEditorStore.getState().openDiffTab(cwd, path, staged);
          }} />
        </div>

        {/* Worktrees header = splitter handle */}
        <div
          className="sb-section-header flex items-center px-2 select-none shrink-0"
          style={{
            height: 'calc(24px * var(--ui-scale))',
            background: "var(--bg-overlay)",
            cursor: "row-resize",
            color: "var(--text-tertiary)",
            letterSpacing: "0.08em",
            borderTop: "1px solid var(--border-subtle)",
          }}
          onMouseDown={handleSplitter1Drag}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderTopColor = "var(--border-strong)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderTopColor = "var(--border-subtle)";
          }}
        >
          <span style={{ flex: 1 }}>{t("sidebar.worktrees")}</span>
          {cwd && (
            <div className="flex items-center" style={{ gap: 4 }}>
              <button
                className="sb-icon"
                title={t("wt.addWorktree")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); wtOpenAddModal(cwd); }}
              >
                <Plus size={14} />
              </button>
              <button
                className="sb-icon"
                title={t("wt.pruneStale")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); wtPrune(cwd); }}
              >
                <Broom size={14} />
              </button>
              <button
                className="sb-icon"
                title={t("git.refresh")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); wtRefresh(cwd); }}
              >
                <ArrowClockwise size={14} className={wtIsLoading ? "animate-spin" : ""} />
              </button>
            </div>
          )}
        </div>

        {/* Worktree pane */}
        <div
          className="overflow-y-auto"
          style={{ flex: `${1 - ratio1} 0 0`, minHeight: 0 }}
        >
          <WorktreePanel />
        </div>
      </div>

      {/* History popup — Fork-like 3-panel view */}
      {showHistory && (
        <GitHistoryView cwd={cwd} onClose={() => setShowHistory(false)} />
      )}

    </div>
  );
}

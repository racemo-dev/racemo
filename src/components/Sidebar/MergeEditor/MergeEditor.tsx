import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { apiReadTextFile } from "../../../lib/bridge";
import {
  X,
  ArrowDown,
  ArrowUp,
  ArrowSquareOut,
  GitMerge,
  SpinnerGap,
} from "@phosphor-icons/react";
import { isMac } from "../../../lib/osUtils";
import { parseConflicts, countConflicts, type FileBlock } from "../../../lib/conflictParser";
import { useGitStore } from "../../../stores/gitStore";
import { useGitT } from "../../../lib/i18n/git";
import { ICON_S } from "./constants";
import { TextBlock } from "./TextBlock";
import { ConflictBlock } from "./ConflictBlock";
import { ExternalToolMenu } from "./ExternalToolMenu";

export default function MergeEditor({
  cwd,
  filePath,
  onClose,
  onResolved,
  standalone = false,
  headerExtra,
}: {
  cwd: string;
  filePath: string;
  onClose?: () => void;
  onResolved?: () => void;
  standalone?: boolean;
  headerExtra?: React.ReactNode;
}) {
  const t = useGitT();
  const [blocks, setBlocks] = useState<FileBlock[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [waitingTool, setWaitingTool] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);
  const [mergetoolName, setMergetoolName] = useState("");
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toolBtnRef = useRef<HTMLDivElement>(null);

  const repoInfo = useGitStore((s) => s.repoInfo);
  const repoRoot = repoInfo?.root ?? cwd;

  const fullPath = repoRoot.endsWith("/") || repoRoot.endsWith("\\")
    ? repoRoot + filePath
    : repoRoot + "/" + filePath;

  const loadFile = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const content = await apiReadTextFile(fullPath);
      const parsed = parseConflicts(content);
      setBlocks(parsed);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  }, [fullPath]);

  useEffect(() => { loadFile(); }, [loadFile]);

  // Load mergetool name on mount
  useEffect(() => {
    invoke<string>("git_mergetool_name", { path: cwd })
      .then((name) => setMergetoolName(name.trim()))
      .catch(() => setMergetoolName(""));
  }, [cwd]);

  // ESC to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showToolMenu) setShowToolMenu(false);
        else onClose?.();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, showToolMenu]);

  const conflictCount = countConflicts(blocks);
  const fileName = filePath.split("/").pop() ?? filePath;

  const resolveBlock = (blockId: number, chosenLines: string[]) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.kind === "conflict" && b.id === blockId
          ? { kind: "text" as const, lines: chosenLines }
          : b,
      ),
    );
  };

  // Check if all conflicts resolved, then write file + stage
  useEffect(() => {
    if (isLoading || blocks.length === 0) return;
    if (countConflicts(blocks) === 0 && blocks.some((b) => b.kind === "text")) {
      const content = blocks.flatMap((b) => (b.kind === "text" ? b.lines : [])).join("\n");
      (async () => {
        try {
          await invoke("write_text_file", { path: fullPath, content });
          await invoke("git_stage_file", { path: cwd, filePath });
          useGitStore.getState().refresh(cwd);
          onResolved?.();
          onClose?.();
        } catch (e) {
          setError(String(e));
        }
      })();
    }
  }, [blocks, isLoading, fullPath, cwd, filePath, onResolved, onClose]);

  const handleAcceptAllOurs = async () => {
    try {
      await useGitStore.getState().resolveOurs(cwd, filePath);
      onResolved?.();
      onClose?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAcceptAllTheirs = async () => {
    try {
      await useGitStore.getState().resolveTheirs(cwd, filePath);
      onResolved?.();
      onClose?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const startPolling = () => {
    setWaitingTool(true);
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const content = await apiReadTextFile(fullPath);
        const parsed = parseConflicts(content);
        const remaining = countConflicts(parsed);
        if (remaining === 0) {
          if (pollingRef.current) clearInterval(pollingRef.current);
          pollingRef.current = null;
          setWaitingTool(false);
          await invoke("git_stage_file", { path: cwd, filePath });
          useGitStore.getState().refresh(cwd);
          onResolved?.();
          onClose?.();
        } else {
          setBlocks(parsed);
        }
      } catch {
        await useGitStore.getState().refresh(cwd);
        const statusMap = useGitStore.getState().statusMap;
        if (statusMap[filePath] !== "conflicted") {
          if (pollingRef.current) clearInterval(pollingRef.current);
          pollingRef.current = null;
          setWaitingTool(false);
          onResolved?.();
          onClose?.();
        }
      }
    }, 2000);
  };

  const handleMergetool = async () => {
    try {
      await invoke("git_mergetool", { path: cwd, filePath });
      startPolling();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleVscode = async () => {
    try {
      await invoke("git_open_vscode_merge", { path: cwd, filePath });
      startPolling();
    } catch (e) {
      setError(String(e));
    }
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  // ── Resize / bounds (popup mode) ──
  const DEFAULT_BOUNDS = { top: 36, left: 52, right: 16, bottom: 36 };
  const [bounds, setBounds] = useState(DEFAULT_BOUNDS);
  const [isMaximized, setIsMaximized] = useState(false);
  const savedBounds = useRef(DEFAULT_BOUNDS);

  const toggleMaximize = useCallback(() => {
    if (isMaximized) {
      setBounds(savedBounds.current);
      setIsMaximized(false);
    } else {
      savedBounds.current = bounds;
      setBounds({ top: 0, left: 0, right: 0, bottom: 0 });
      setIsMaximized(true);
    }
  }, [isMaximized, bounds]);

  const EDGE = 5;
  const startResize = useCallback(
    (e: React.MouseEvent, edges: { top?: boolean; left?: boolean; right?: boolean; bottom?: boolean }) => {
      e.preventDefault();
      e.stopPropagation();
      if (isMaximized) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const startBounds = { ...bounds };
      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        setBounds(() => {
          const next = { ...startBounds };
          if (edges.top) next.top = Math.max(0, Math.min(startBounds.top + dy, window.innerHeight - 120 - startBounds.bottom));
          if (edges.bottom) next.bottom = Math.max(0, Math.min(startBounds.bottom - dy, window.innerHeight - 120 - startBounds.top));
          if (edges.left) next.left = Math.max(0, Math.min(startBounds.left + dx, window.innerWidth - 200 - startBounds.right));
          if (edges.right) next.right = Math.max(0, Math.min(startBounds.right - dx, window.innerWidth - 200 - startBounds.left));
          return next;
        });
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor =
        (edges.top && edges.left) || (edges.bottom && edges.right) ? "nwse-resize" :
          (edges.top && edges.right) || (edges.bottom && edges.left) ? "nesw-resize" :
            edges.top || edges.bottom ? "ns-resize" : "ew-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [bounds, isMaximized],
  );

  return (
    <div
      style={standalone ? {
        position: "relative",
        width: "100%",
        height: "100%",
        background: "var(--bg-surface)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      } : {
        position: "fixed",
        top: bounds.top,
        left: bounds.left,
        right: bounds.right,
        bottom: bounds.bottom,
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: isMaximized ? 0 : 8,
        boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Resize handles (popup mode) */}
      {!standalone && !isMaximized && (
        <>
          <div style={{ position: "absolute", top: 0, left: EDGE, right: EDGE, height: EDGE, cursor: "ns-resize", zIndex: 10 }} onMouseDown={(e) => startResize(e, { top: true })} />
          <div style={{ position: "absolute", bottom: 0, left: EDGE, right: EDGE, height: EDGE, cursor: "ns-resize", zIndex: 10 }} onMouseDown={(e) => startResize(e, { bottom: true })} />
          <div style={{ position: "absolute", left: 0, top: EDGE, bottom: EDGE, width: EDGE, cursor: "ew-resize", zIndex: 10 }} onMouseDown={(e) => startResize(e, { left: true })} />
          <div style={{ position: "absolute", right: 0, top: EDGE, bottom: EDGE, width: EDGE, cursor: "ew-resize", zIndex: 10 }} onMouseDown={(e) => startResize(e, { right: true })} />
          <div style={{ position: "absolute", top: 0, left: 0, width: EDGE * 2, height: EDGE * 2, cursor: "nwse-resize", zIndex: 11 }} onMouseDown={(e) => startResize(e, { top: true, left: true })} />
          <div style={{ position: "absolute", top: 0, right: 0, width: EDGE * 2, height: EDGE * 2, cursor: "nesw-resize", zIndex: 11 }} onMouseDown={(e) => startResize(e, { top: true, right: true })} />
          <div style={{ position: "absolute", bottom: 0, left: 0, width: EDGE * 2, height: EDGE * 2, cursor: "nesw-resize", zIndex: 11 }} onMouseDown={(e) => startResize(e, { bottom: true, left: true })} />
          <div style={{ position: "absolute", bottom: 0, right: 0, width: EDGE * 2, height: EDGE * 2, cursor: "nwse-resize", zIndex: 11 }} onMouseDown={(e) => startResize(e, { bottom: true, right: true })} />
        </>
      )}

      {/* Header */}
      <div
        className={`flex items-center shrink-0 ${standalone ? "pl-3" : "px-3"} gap-2`}
        style={{
          height: "calc(32px * var(--ui-scale))",
          fontSize: "var(--fs-13)",
          color: "var(--text-tertiary)",
          background: standalone ? "var(--bg-overlay)" : undefined,
          borderBottom: "1px solid var(--border-subtle)",
          userSelect: "none",
          cursor: "default",
        }}
        data-tauri-drag-region
        onDoubleClick={standalone ? undefined : toggleMaximize}
      >
        {standalone && isMac() && <div className="shrink-0" style={{ width: 74 }} />}
        <div className="flex items-center gap-2 shrink min-w-0 overflow-hidden">
          {/* Merge icon */}
          <GitMerge size={14} weight="bold" style={{ color: "var(--accent-red)", flexShrink: 0, width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))" }} />

          <span className="truncate shrink-0" style={{ fontWeight: 600, color: "var(--text-secondary)", maxWidth: 160 }} title={filePath}>
            {fileName}
          </span>
          <span
            style={{
              fontSize: "var(--fs-11)",
              fontWeight: 600,
              letterSpacing: "0.05em",
              padding: "1px 4px",
              borderRadius: 3,
              background: "color-mix(in srgb, var(--accent-red) 15%, transparent)",
              color: "var(--accent-red)",
              flexShrink: 0,
            }}
          >
            CONFLICTED
          </span>
          {!isLoading && conflictCount > 0 && (
            <span style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)", flexShrink: 0 }}>
              {conflictCount} {t("merge.conflicts")}
            </span>
          )}

          {/* Action buttons */}
          {!isLoading && conflictCount > 0 && !waitingTool && (
            <span className="flex items-center gap-1 shrink-0" style={{ fontSize: "var(--fs-10)" }}>
              <button
                onClick={handleAcceptAllOurs}
                className="cursor-pointer rounded px-1.5 flex items-center gap-0.5"
                style={{ background: "color-mix(in srgb, var(--status-active) 12%, transparent)", color: "var(--status-active)", border: "none", fontWeight: 600, fontSize: "var(--fs-10)" }}
                title={t("merge.acceptAllCurrent")}
              >
                <ArrowUp size={10} weight="bold" style={{ width: "calc(10px * var(--ui-scale))", height: "calc(10px * var(--ui-scale))" }} />
                {t("merge.acceptAllCurrent")}
              </button>
              <button
                onClick={handleAcceptAllTheirs}
                className="cursor-pointer rounded px-1.5 flex items-center gap-0.5"
                style={{ background: "color-mix(in srgb, var(--accent-blue) 12%, transparent)", color: "var(--accent-blue)", border: "none", fontWeight: 600, fontSize: "var(--fs-10)" }}
                title={t("merge.acceptAllIncoming")}
              >
                <ArrowDown size={10} weight="bold" style={{ width: "calc(10px * var(--ui-scale))", height: "calc(10px * var(--ui-scale))" }} />
                {t("merge.acceptAllIncoming")}
              </button>

              {/* External tool dropdown trigger */}
              <div ref={toolBtnRef} style={{ position: "relative" }}>
                <button
                  onClick={() => setShowToolMenu((p) => !p)}
                  className="cursor-pointer rounded px-1.5 flex items-center gap-0.5"
                  style={{ background: "var(--bg-overlay)", color: "var(--text-muted)", border: "none", fontWeight: 600, fontSize: "var(--fs-10)" }}
                  title={t("merge.mergetool")}
                >
                  <ArrowSquareOut size={10} weight="bold" style={{ width: "calc(10px * var(--ui-scale))", height: "calc(10px * var(--ui-scale))" }} />
                  {t("merge.mergetool")}
                </button>
                {showToolMenu && (
                  <ExternalToolMenu
                    mergetoolName={mergetoolName}
                    onMergetool={handleMergetool}
                    onVscode={handleVscode}
                    onClose={() => setShowToolMenu(false)}
                  />
                )}
              </div>
            </span>
          )}

          {/* Waiting indicator */}
          {waitingTool && (
            <span className="flex items-center gap-1 shrink-0" style={{ fontSize: "var(--fs-10)", color: "var(--accent-yellow)" }}>
              <SpinnerGap size={12} weight="bold" style={{ ...ICON_S, animation: "spin 1s linear infinite" }} />
              {t("merge.waitingTool")}
            </span>
          )}
        </div>

        <div className="flex-1 h-full" data-tauri-drag-region />
        <span className="flex items-center h-full gap-1" style={{ flexShrink: 0 }}>
          {headerExtra}
          {onClose && (
            <button
              onClick={onClose}
              onMouseDown={(e) => e.stopPropagation()}
              className="cursor-pointer"
              style={{ color: "var(--text-muted)", lineHeight: 0 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            >
              <X size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))" }} />
            </button>
          )}
        </span>
      </div>

      {/* Status */}
      {isLoading && <div className="px-3 py-3" style={{ color: "var(--text-muted)", fontSize: "var(--fs-11)" }}>Loading...</div>}
      {error && <div className="px-3 py-3" style={{ color: "var(--accent-red)", fontSize: "var(--fs-11)" }}>{error}</div>}

      {/* Body */}
      {!isLoading && !error && (
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "4px 8px" }}>
          {blocks.map((block, i) =>
            block.kind === "text" ? (
              <TextBlock key={`t-${i}`} lines={block.lines} />
            ) : (
              <ConflictBlock
                key={`c-${block.id}`}
                block={block}
                onAcceptCurrent={() => resolveBlock(block.id, block.current.lines)}
                onAcceptIncoming={() => resolveBlock(block.id, block.incoming.lines)}
                onAcceptBoth={() => resolveBlock(block.id, [...block.current.lines, ...block.incoming.lines])}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

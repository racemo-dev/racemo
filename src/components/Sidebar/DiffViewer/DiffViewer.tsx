import { useEffect, useRef, useState } from "react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useGitT } from "../../../lib/i18n/git";

import { SCROLLBAR_W, MARKER_TRACK_W } from "./constants";
import { DiffBody } from "./DiffBody";
import { useResizablePanel } from "./useResizablePanel";
import { useDiffData } from "./useDiffData";
import { useDiffNavigation } from "./useDiffNavigation";

// ── Main Component ───────────────────────────────────────────

const EDGE = 5;

export default function DiffViewer({
  cwd,
  filePath,
  staged,
  onClose,
  onHunkDiscarded,
  standalone = false,
  headerExtra,
}: {
  cwd: string;
  filePath: string;
  staged: boolean;
  onClose?: () => void;
  onHunkDiscarded?: () => void;
  standalone?: boolean;
  headerExtra?: React.ReactNode;
}) {
  const t = useGitT();
  const [diffFontSize, setDiffFontSize] = useState(12);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Auto-focus so keyboard shortcuts work immediately
  useEffect(() => { rootRef.current?.focus(); }, []);

  const { bounds, isMaximized, toggleMaximize, startResize } = useResizablePanel();

  const {
    displayDiff,
    error,
    isLoading,
    items,
    changeBlocks,
    changeMapMarkers,
    syntheticDiscardedIndices,
    collapsedHunks,
    confirmHunk,
    expandHunk,
    handleDiscardHunk,
    handleUndoDiscard,
    fileName,
    dirPath,
    totalAdded,
    totalRemoved,
    hasChanges,
    showDiffBody,
  } = useDiffData(cwd, filePath, staged, onHunkDiscarded);

  const { currentChangeIdx, changeCount, goNext, goPrev } = useDiffNavigation(
    changeBlocks,
    displayDiff,
    scrollRef,
    onClose,
    setDiffFontSize,
  );

  // Track container height for change map rendering
  const [trackHeight, setTrackHeight] = useState(0);
  useEffect(() => {
    if (!scrollRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setTrackHeight(entry.contentRect.height);
    });
    ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, [hasChanges, isLoading]);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
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
      {/* ── Resize handles (panel mode only) ── */}
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

      {/* ── Header ── */}
      <div
        className="flex items-center shrink-0 pl-2 pr-3 gap-2"
        style={{
          height: "calc(32px * var(--ui-scale))",
          fontSize: 'var(--fs-13)',
          color: "var(--text-tertiary)",
          background: standalone ? "var(--bg-overlay)" : undefined,
          borderBottom: "1px solid var(--border-subtle)",
          userSelect: "none",
          cursor: "default",
        }}
        data-tauri-drag-region
        onDoubleClick={standalone ? undefined : toggleMaximize}
      >
        {/* Left content — shrinkable so the flex-1 drag spacer always gets space */}
        <div className="flex items-center gap-2 shrink min-w-0 overflow-hidden">
        {dirPath && (
          <>
            <span className="truncate" style={{ fontSize: 'var(--fs-12)', color: "var(--text-muted)", maxWidth: 200 }} title={filePath}>
              {dirPath}
            </span>
            <span style={{ color: "var(--border-strong)", fontSize: 'var(--fs-12)' }}>/</span>
          </>
        )}
        <span className="truncate shrink-0" style={{ fontWeight: 600, color: "var(--text-secondary)", maxWidth: 160 }} title={filePath}>
          {fileName}
        </span>
        <span
          style={{
            fontSize: 'var(--fs-11)',
            fontWeight: 600,
            letterSpacing: "0.05em",
            padding: "1px 4px",
            borderRadius: 3,
            background: staged ? "color-mix(in srgb, var(--status-active) 15%, transparent)" : "color-mix(in srgb, var(--accent-yellow) 15%, transparent)",
            color: staged ? "var(--status-active)" : "var(--accent-yellow)",
            flexShrink: 0,
          }}
        >
          {staged ? t("diff.staged") : t("diff.unstaged")}
        </span>
        {!isLoading && !error && hasChanges && (
          <span style={{ fontSize: 'var(--fs-12)', flexShrink: 0 }}>
            {totalAdded > 0 && <span style={{ color: "var(--status-active)", marginRight: 4 }}>+{totalAdded}</span>}
            {totalRemoved > 0 && <span style={{ color: "var(--accent-red)" }}>-{totalRemoved}</span>}
          </span>
        )}
        {/* Change navigation */}
        {!isLoading && !error && changeCount > 0 && (
          <span
            className="flex items-center gap-0.5 shrink-0"
            style={{
              fontSize: 'var(--fs-12)',
              color: "var(--text-muted)",
              background: "var(--bg-overlay)",
              borderRadius: 4,
              padding: "1px 2px",
              userSelect: "none",
            }}
          >
            <button
              onClick={goPrev}
              onMouseDown={(e) => e.stopPropagation()}
              className="cursor-pointer"
              style={{ color: "var(--text-muted)", lineHeight: 0, padding: 1, background: "none", border: "none" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
              title={t("diff.prevChange")}
            >
              <CaretUp size={14} weight="bold" style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
            </button>
            <span style={{ minWidth: 48, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
              {currentChangeIdx >= 0 ? currentChangeIdx + 1 : "\u2013"} / {changeCount}
            </span>
            <button
              onClick={goNext}
              onMouseDown={(e) => e.stopPropagation()}
              className="cursor-pointer"
              style={{ color: "var(--text-muted)", lineHeight: 0, padding: 1, background: "none", border: "none" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
              title={t("diff.nextChange")}
            >
              <CaretDown size={14} weight="bold" style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
            </button>
            <span style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)", opacity: 0.5, marginLeft: 2 }}>
              Alt {"\u2191\u2193"}
            </span>
          </span>
        )}
        {headerExtra}
        </div>{/* end left content */}
      </div>

      {/* ── Status ── */}
      {isLoading && <div className="px-3 py-3" style={{ color: "var(--text-muted)", fontSize: 'var(--fs-11)' }}>{t("diff.loading")}</div>}
      {error && <div className="px-3 py-3" style={{ color: "var(--accent-red)", fontSize: 'var(--fs-11)' }}>{error}</div>}
      {!isLoading && !error && !showDiffBody && <div className="px-3 py-3" style={{ color: "var(--text-muted)", fontSize: 'var(--fs-11)' }}>{t("diff.noDiff")}</div>}

      {/* ── Unified inline body ── */}
      {!isLoading && !error && showDiffBody && (
        <div className="flex-1 min-h-0 relative">
          <div
            ref={scrollRef}
            className="diff-scroll-always"
            style={{
              position: "absolute",
              inset: 0,
              right: SCROLLBAR_W + MARKER_TRACK_W,
              overflowY: "scroll",
              overflowX: "auto",
              fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace",
              fontSize: `calc(${diffFontSize}px * var(--ui-scale))`,
            }}
          >
            <div style={{ display: "inline-block", minWidth: "100%" }}>
              <DiffBody
                items={items}
                syntheticDiscardedIndices={syntheticDiscardedIndices}
                collapsedHunks={collapsedHunks}
                onDiscardHunk={handleDiscardHunk}
                onConfirmHunk={confirmHunk}
                onExpandHunk={expandHunk}
                onUndoDiscard={handleUndoDiscard}
                t={t}
              />
            </div>
          </div>
          {/* ── Change map track (right edge) ── */}
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: SCROLLBAR_W + MARKER_TRACK_W,
              background: "var(--bg-surface)",
              borderLeft: "1px solid var(--border-subtle)",
              pointerEvents: "none",
            }}
          >
            {trackHeight > 0 && changeMapMarkers.map((m, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  right: 2,
                  top: m.top * trackHeight,
                  width: MARKER_TRACK_W,
                  height: Math.max(m.height * trackHeight, 2),
                  borderRadius: 1,
                  background: m.type === "remove"
                    ? "color-mix(in srgb, var(--accent-red) 70%, transparent)"
                    : "color-mix(in srgb, var(--status-active) 70%, transparent)",
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

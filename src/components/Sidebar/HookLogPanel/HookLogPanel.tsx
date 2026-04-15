import { useCallback, useEffect, useRef, useState } from "react";
import { apiReadHookLog, apiClearHookLog, isTauri } from "../../../lib/bridge";
import type { HookTreeNode } from "../../../types/hooklog";
import { ArrowClockwise, Trash } from "@phosphor-icons/react";
import { HOVER_SHOW_DELAY, HOVER_HIDE_DELAY } from "./helpers";
import type { TooltipState } from "./helpers";
import { DetailTooltip } from "./DetailTooltip";
import { TreeNode } from "./TreeNode";

export default function HookLogPanel() {
  const [nodes, setNodes] = useState<HookTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const cancelTimers = useCallback(() => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  const handleHover = useCallback((node: HookTreeNode, rect: DOMRect) => {
    // Cancel any pending hide
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    // Cancel any pending show for a different node
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    showTimer.current = setTimeout(() => {
      setTooltip({ node, anchorRect: rect });
      showTimer.current = null;
    }, HOVER_SHOW_DELAY);
  }, []);

  const handleHoverLeave = useCallback(() => {
    // Cancel pending show
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    // Start hide grace period
    hideTimer.current = setTimeout(() => {
      setTooltip(null);
      hideTimer.current = null;
    }, HOVER_HIDE_DELAY);
  }, []);

  // Tooltip hovered → cancel hide
  const handleTipEnter = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  // Tooltip left → start hide
  const handleTipLeave = useCallback(() => {
    hideTimer.current = setTimeout(() => {
      setTooltip(null);
      hideTimer.current = null;
    }, HOVER_HIDE_DELAY);
  }, []);

  const load = useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    try {
      const tree = await apiReadHookLog();
      setNodes(tree);
    } catch {
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleClear = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await apiClearHookLog();
      setNodes([]);
      cancelTimers();
      setTooltip(null);
    } catch {
      // ignore
    }
  }, [cancelTimers]);

  useEffect(() => { load(); }, [load]);

  if (!isTauri()) {
    return (
      <div className="px-3 py-2" style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>
        Hook logs are only available in the desktop app.
      </div>
    );
  }

  return (
    <div ref={panelRef} className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center px-2 py-1 select-none shrink-0"
        style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", userSelect: "none", gap: 6 }}
      >
        <span>{nodes.length} session{nodes.length !== 1 ? "s" : ""}</span>
        <div className="ml-auto flex items-center" style={{ gap: 4 }}>
          <button
            onClick={load}
            className="cursor-pointer"
            style={{ color: "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            title="Refresh"
            disabled={loading}
          >
            <ArrowClockwise size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))" }} />
          </button>
          <button
            onClick={handleClear}
            className="cursor-pointer"
            style={{ color: "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            title="Clear logs"
          >
            <Trash size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))" }} />
          </button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="px-3 py-2" style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>Loading...</div>
        ) : nodes.length === 0 ? (
          <div className="px-3 py-2" style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>No hook logs found.</div>
        ) : (
          nodes.map((session) => (
            <TreeNode key={session.id} node={session} depth={0} onHover={handleHover} onHoverLeave={handleHoverLeave} />
          ))
        )}
      </div>

      {/* Detail Tooltip — positioned to the right of the panel */}
      {tooltip && (
        <DetailTooltip
          node={tooltip.node}
          anchorRect={tooltip.anchorRect}
          panelRight={panelRef.current?.getBoundingClientRect().right ?? 0}
          onEnter={handleTipEnter}
          onLeave={handleTipLeave}
        />
      )}
    </div>
  );
}

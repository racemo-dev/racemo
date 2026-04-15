import { useEffect, useMemo, useRef, useState } from "react";
import type { HookTreeNode } from "../../../types/hooklog";
import { nodeIcon, statusBadge, SummaryField, CodeBlock } from "./helpers";

export function DetailTooltip({
  node,
  anchorRect,
  panelRight,
  onEnter,
  onLeave,
}: {
  node: HookTreeNode;
  anchorRect: DOMRect;
  panelRight: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const [tab, setTab] = useState<"summary" | "raw">("summary");
  const tipRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => {
    if (!node.detail) return null;
    try { return JSON.parse(node.detail) as Record<string, unknown>; } catch { return null; }
  }, [node.detail]);

  const rawParsed = useMemo(() => {
    if (!node.raw) return null;
    try { return JSON.parse(node.raw) as Record<string, string>; } catch { return null; }
  }, [node.raw]);

  const isPrompt = node.node_type === "prompt";
  const isSession = node.node_type === "session";
  const hasRaw = !!rawParsed;

  // Position: to the right of sidebar, vertically aligned with anchor row
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    const vh = window.innerHeight;
    const tipH = tip.offsetHeight;
    // Vertical: align top with anchor row, clamp to viewport
    let top = anchorRect.top;
    if (top + tipH > vh - 8) top = Math.max(8, vh - tipH - 8);
    // Horizontal: right of the sidebar panel
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position must be measured after DOM mount
    setPos({ top, left: panelRight + 2 });
  }, [anchorRect, panelRight]);

  return (
    <div
      ref={tipRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: 340,
        maxWidth: `calc(100vw - ${panelRight + 16}px)`,
        maxHeight: 320,
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "auto",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center shrink-0 gap-1 px-3"
        style={{ height: 28, borderBottom: "1px solid var(--border-subtle)" }}
      >
        {nodeIcon(node)}
        <span className="truncate" style={{ fontWeight: 600, fontSize: "var(--fs-11)", color: "var(--text-primary)", flex: 1 }}>
          {node.label}
        </span>
        {statusBadge(node.status)}
      </div>

      {/* Tabs */}
      {hasRaw && (
        <div className="flex shrink-0" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          {(["summary", "raw"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="cursor-pointer"
              style={{
                flex: 1,
                padding: "3px 0",
                fontSize: "var(--fs-10)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: tab === t ? "var(--text-primary)" : "var(--text-muted)",
                background: "transparent",
                borderBottom: tab === t ? "2px solid var(--accent-blue)" : "2px solid transparent",
              }}
            >
              {t === "summary" ? "Summary" : "Raw"}
            </button>
          ))}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "6px 10px" }}>
        <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", marginBottom: 4 }}>
          {node.timestamp}
        </div>

        {tab === "summary" && (
          <>
            {isPrompt && node.detail && (
              <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-secondary)", fontFamily: "inherit", margin: 0, lineHeight: 1.4, fontSize: "var(--fs-11)" }}>
                {node.detail}
              </pre>
            )}

            {isSession && (
              <>
                {node.model && <SummaryField label="Model" value={node.model} />}
                {node.detail && <SummaryField label="Session ID" value={node.detail} mono />}
              </>
            )}

            {!isPrompt && !isSession && parsed && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {Object.entries(parsed).map(([key, val]) => (
                  <SummaryField key={key} label={key} value={val} mono={key !== "tool"} />
                ))}
              </div>
            )}

            {!isPrompt && !isSession && !parsed && node.detail && (
              <CodeBlock content={node.detail} />
            )}

            {!node.detail && (
              <div style={{ color: "var(--text-muted)", fontStyle: "italic", fontSize: "var(--fs-11)" }}>
                No detail available.
              </div>
            )}
          </>
        )}

        {tab === "raw" && rawParsed && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rawParsed.tool_input && (
              <div>
                <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2, fontWeight: 600 }}>
                  tool_input
                </div>
                <CodeBlock content={rawParsed.tool_input} />
              </div>
            )}
            {rawParsed.tool_response && (
              <div>
                <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2, fontWeight: 600 }}>
                  tool_response
                </div>
                <CodeBlock content={rawParsed.tool_response} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

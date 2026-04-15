/**
 * List and group components for AI log panels.
 */
import { useState } from "react";
import {
  CaretDown,
  CaretRight,
  FolderSimple,
} from "@phosphor-icons/react";
import type { TranslationKey } from "../../../lib/i18n/git";
import { hashLabelHue, ICON_STYLE, relativeTime, formatTokens } from "../logUtils";

/* ─── Group row (folder group in grouped view) ─── */

export function GroupRow<T>({
  label,
  count,
  latestTimestamp,
  entries,
  renderEntry,
  t,
}: {
  label: string;
  count: number;
  latestTimestamp: number;
  entries: T[];
  renderEntry: (entry: T) => React.ReactNode;
  t: (key: TranslationKey) => string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const hue = hashLabelHue(label);

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-1.5 cursor-pointer select-none"
        style={{
          fontSize: "var(--fs-12)",
          color: "var(--text-secondary)",
          userSelect: "none",
          background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
        onClick={() => setIsOpen((p) => !p)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-elevated)"; }}
      >
        {isOpen ? (
          <CaretDown size={10} weight="bold" style={{ ...ICON_STYLE(10), color: "var(--text-muted)" }} />
        ) : (
          <CaretRight size={10} weight="bold" style={{ ...ICON_STYLE(10), color: "var(--text-muted)" }} />
        )}
        <FolderSimple size={13} style={ICON_STYLE(13)} color={`hsl(${hue}, 55%, 65%)`} />
        <span className="truncate flex-1" style={{ fontWeight: 600, color: `hsl(${hue}, 50%, 75%)` }}>
          {label}
        </span>
        <span
          style={{
            fontSize: "var(--fs-9)",
            color: `hsl(${hue}, 50%, 70%)`,
            flexShrink: 0,
            background: `hsla(${hue}, 40%, 40%, 0.12)`,
            borderRadius: 3,
            padding: "0 4px",
            border: `1px solid hsla(${hue}, 40%, 50%, 0.2)`,
          }}
        >
          {count}
        </span>
        <span className="sb-muted" style={{ fontSize: "var(--fs-9)", flexShrink: 0 }}>
          {relativeTime(latestTimestamp, t)}
        </span>
      </div>
      {isOpen && <div>{entries.map(renderEntry)}</div>}
    </div>
  );
}

/* ─── History row (flat list item) ─── */

export function HistoryRowShell({
  isActive,
  indent,
  icon,
  onClick,
  children,
}: {
  isActive: boolean;
  indent?: boolean;
  icon?: React.ReactNode;
  onClick: (rect: DOMRect) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-1.5 py-1.5 cursor-pointer select-none"
      style={{
        fontSize: "var(--fs-12)",
        color: "var(--text-secondary)",
        userSelect: "none",
        borderBottom: "1px solid var(--border-subtle)",
        paddingLeft: indent ? 20 : 8,
        paddingRight: 8,
        background: isActive ? "var(--bg-overlay)" : undefined,
      }}
      onClick={(e) => onClick(e.currentTarget.getBoundingClientRect())}
      onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)"; }}
      onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <CaretDown
        size={10}
        weight="bold"
        style={{ ...ICON_STYLE(10), transform: "rotate(-90deg)", color: "var(--text-muted)" }}
      />
      {icon && <span style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", flexShrink: 0 }}>{icon}</span>}
      <div className="flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}

/* ─── Token summary footer ─── */

export function TokenSummaryFooter({ totalInput, totalOutput, msgCount }: {
  totalInput: number;
  totalOutput: number;
  msgCount: number;
}) {
  return (
    <div className="shrink-0" style={{ borderTop: "1px solid var(--border-subtle)", padding: "6px 10px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {(totalInput > 0 || totalOutput > 0) && (
          <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
            <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", display: "flex", gap: 3, alignItems: "center" }}>
              <span style={{ color: "var(--accent-blue)" }}>↑</span>{formatTokens(totalInput)}
            </span>
            <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", display: "flex", gap: 3, alignItems: "center" }}>
              <span style={{ color: "var(--accent-purple)" }}>↓</span>{formatTokens(totalOutput)}
            </span>
          </div>
        )}
        <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", marginLeft: totalInput > 0 || totalOutput > 0 ? undefined : "auto" }}>
          {msgCount} msg{msgCount !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}

/* ─── Usage bar (context window etc.) ─── */

export function UsageBar({ pct, color }: { pct: number; color: string }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div style={{ width: "100%", height: 4, borderRadius: 2, background: "var(--bg-overlay)", overflow: "hidden" }}>
      <div style={{ width: `${clamped}%`, height: "100%", borderRadius: 2, background: color, transition: "width 0.3s ease" }} />
    </div>
  );
}

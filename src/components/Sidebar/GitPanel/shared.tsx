/* eslint-disable react-refresh/only-export-components -- shared file mixes components and helpers */
import { memo, useEffect, useRef, useState } from "react";
import {
  CaretRight,
  Plus,
  Minus,
  ArrowCounterClockwise,
  Check,
  Eye,
} from "@phosphor-icons/react";
import { useSessionStore } from "../../../stores/sessionStore";
import { findPtyId } from "../../../lib/paneTreeUtils";
import { useGitT } from "../../../lib/i18n/git";
import type { GitStatusEntry } from "../../../types/git";
import FileTypeIcon from "../FileTypeIcon";

// ─── Constants ──────────────────────────────────────────────

export const STATUS_COLORS: Record<string, string> = {
  modified: "var(--accent-yellow)",
  added: "var(--status-active)",
  deleted: "var(--accent-red)",
  renamed: "var(--accent-blue)",
  untracked: "var(--text-muted)",
  conflicted: "var(--status-error, var(--accent-red))",
  discarded: "var(--accent-yellow)",
};

export const STATUS_LABELS: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "!",
  discarded: "↩",
};

// ─── Hooks ──────────────────────────────────────────────────

export function useCwd(): string {
  return useSessionStore((s) => {
    const session = s.sessions.find((ss) => ss.id === s.activeSessionId);
    if (!session || !s.focusedPaneId) return "";
    const ptyId = findPtyId(session.rootPane, s.focusedPaneId);
    return ptyId ? (s.paneCwds[ptyId] ?? "") : "";
  });
}

// ─── Small Components ───────────────────────────────────────

/** Collapsible section header. */
export function SectionHeader({
  label,
  count,
  open,
  onToggle,
  actions,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className="sb-section-header flex items-center gap-1 py-0.5 px-2 cursor-pointer select-none"
      onClick={onToggle}
    >
      <CaretRight
        size={12}
        weight="bold"
        style={{
          width: 'calc(12px * var(--ui-scale))',
          height: 'calc(12px * var(--ui-scale))',
          transition: "transform 120ms ease",
          transform: open ? "rotate(90deg)" : "rotate(0deg)",
          flexShrink: 0,
          color: "var(--text-muted)",
        }}
      />
      <span className="truncate">
        {label} ({count})
      </span>
      {actions && (
        <span
          className="flex items-center gap-0.5 ml-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </span>
      )}
    </div>
  );
}

const GitFileIcon = FileTypeIcon;

/** Single file entry in changes list. */
export const FileEntry = memo(function FileEntry({
  entry,
  onAction,
  onSecondary,
  onDiff,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  entry: GitStatusEntry;
  onAction?: () => void;
  onSecondary?: () => void;
  onDiff?: () => void;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const color = STATUS_COLORS[entry.status] ?? "var(--text-muted)";
  const t = useGitT();
  const label = STATUS_LABELS[entry.status] ?? "?";
  const fileName = entry.path.replace(/\/+$/, "").split("/").pop() || entry.path;

  return (
    <div
      className="sb-item flex items-center gap-1 py-px cursor-default group select-none"
      style={{ paddingLeft: 20, paddingRight: 6 }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={entry.path}
    >
      {entry.staged && (
        <Check size={10} weight="bold" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))', color: "var(--status-active)", flexShrink: 0 }} />
      )}
      <GitFileIcon name={fileName} />
      {/* File name container with overlay icons */}
      <div className="flex-1 min-w-0 relative flex items-center">
        <span className="sb-text truncate">
          {fileName}
        </span>
        {/* Hover icons overlay */}
        <span
          className="absolute right-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ gap: 4, background: "var(--bg-overlay)", paddingLeft: 4 }}
        >
          {onDiff && (
            <button
              onClick={(e) => { e.stopPropagation(); onDiff(); }}
              className="cursor-pointer"
              style={{ color: "var(--text-muted)", lineHeight: 0 }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--accent-blue)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
              }}
              title={t("git.viewDiff")}
            >
              <Eye size={12} style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))' }} />
            </button>
          )}
          {onAction && (
            <button
              onClick={(e) => { e.stopPropagation(); onAction(); }}
              className="cursor-pointer"
              style={{ color: "var(--text-muted)", lineHeight: 0 }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
              }}
              title={entry.staged ? t("git.unstage") : t("git.stage")}
            >
              {entry.staged ? <Minus size={12} style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))' }} /> : <Plus size={12} style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))' }} />}
            </button>
          )}
          {onSecondary && (
            <button
              onClick={(e) => { e.stopPropagation(); onSecondary(); }}
              className="cursor-pointer"
              style={{ color: "var(--text-muted)", lineHeight: 0 }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--accent-red)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
              }}
              title={t("git.discard")}
            >
              <ArrowCounterClockwise size={12} style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))' }} />
            </button>
          )}
        </span>
      </div>
      <span style={{ color, fontWeight: 600, fontSize: 'var(--fs-10)', width: 12, textAlign: "center", flexShrink: 0 }}>
        {label}
      </span>
    </div>
  );
});

/** Small icon button. */
export function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="sb-icon cursor-pointer"
      style={{ lineHeight: 0 }}
      title={title}
    >
      {children}
    </button>
  );
}

// ─── Push Tooltip ───────────────────────────────────────────

export function PushTooltip({ x, y, commits }: { x: number; y: number; commits: string[] }) {
  const t = useGitT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const margin = 8;

    // Prefer above cursor
    let top = y - 8 - h;
    // If clipped at top, show below cursor instead
    if (top < margin) {
      top = y + 16;
    }
    // Clamp bottom
    if (top + h + margin > window.innerHeight) {
      top = window.innerHeight - h - margin;
    }
    top = Math.max(margin, top);

    let left = x + 12;
    if (left + w + margin > window.innerWidth) {
      left = x - w - 8;
    }
    left = Math.max(margin, left);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- position must be measured after DOM mount
    setPos({ top, left });
  }, [x, y, commits.length]);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 5,
        padding: "4px 0",
        boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
        zIndex: 9999,
        pointerEvents: "none",
        minWidth: 260,
        maxHeight: "50vh",
        overflowY: "auto",
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div style={{
        fontSize: "var(--fs-10)",
        color: "var(--text-muted)",
        padding: "3px 10px 5px",
        borderBottom: "1px solid var(--border-subtle)",
        marginBottom: 2,
      }}>
        {t("git.unpushedCount").replace("{n}", String(commits.length))}
      </div>
      {commits.map((c, i) => {
        const spaceIdx = c.indexOf(" ");
        const hash = spaceIdx > 0 ? c.slice(0, spaceIdx) : c;
        const msg = spaceIdx > 0 ? c.slice(spaceIdx + 1) : "";
        return (
          <div key={i} style={{
            display: "flex",
            alignItems: "baseline",
            gap: 7,
            padding: "2px 10px",
            fontSize: "var(--fs-10)",
          }}>
            <span style={{
              fontFamily: "monospace",
              color: "var(--accent-blue)",
              flexShrink: 0,
              opacity: 0.9,
            }}>{hash}</span>
            <span style={{
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
            }}>{msg}</span>
          </div>
        );
      })}
    </div>
  );
}

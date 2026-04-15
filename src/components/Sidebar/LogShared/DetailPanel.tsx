/**
 * Detail panel components for AI log panels.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { truncateDisplay } from "../logUtils";

/* ─── Detail panel shell (positioning + outside-click logic) ─── */

export function DetailPanelShell({
  anchorRect,
  panelRight,
  onClose,
  ownerRef,
  children,
}: {
  anchorRect: DOMRect;
  panelRight: number;
  onClose: () => void;
  ownerRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    const vh = window.innerHeight;
    const tipH = tip.offsetHeight;
    let top = anchorRect.top;
    if (top + tipH > vh - 8) top = Math.max(8, vh - tipH - 8);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position must be measured after DOM mount
    setPos({ top, left: panelRight + 2 });
  }, [anchorRect.top, panelRight]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (tipRef.current?.contains(target)) return;
      if (ownerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, ownerRef]);

  return (
    <div
      ref={tipRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: 570,
        maxWidth: `calc(100vw - ${panelRight + 16}px)`,
        maxHeight: "min(780px, calc(100vh - 60px))",
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
      {children}
    </div>
  );
}

/* ─── Detail panel header ─── */

export function DetailPanelHeader({
  title,
  onClose,
  closeLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-1 shrink-0 px-3"
      style={{ height: 30, borderBottom: "1px solid var(--border-subtle)" }}
    >
      <span
        className="truncate"
        style={{ fontWeight: 600, fontSize: "var(--fs-12)", color: "var(--text-secondary)", flex: 1 }}
        title={title}
      >
        {truncateDisplay(title, 70)}
      </span>
      {children}
      <button
        onClick={onClose}
        className="cursor-pointer"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 20, height: 20, background: "transparent", border: "none",
          borderRadius: 3, padding: 0, flexShrink: 0, color: "var(--text-muted)",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)"; (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
        title={closeLabel}
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}

/* ─── Detail panel message body (paginated) ─── */

export const INITIAL_MESSAGE_COUNT = 50;

export function MessageListBody<T>({
  messages,
  loading,
  showCount,
  onShowMore,
  loadingText,
  emptyText,
  showMoreText,
  renderMessage,
}: {
  messages: T[];
  loading: boolean;
  showCount: number;
  onShowMore: () => void;
  loadingText: string;
  emptyText: string;
  showMoreText: string;
  renderMessage: (msg: T, idx: number) => React.ReactNode;
}) {
  const visible = messages.slice(0, showCount);
  const hasMore = showCount < messages.length;

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      {loading ? (
        <div className="sb-empty">{loadingText}</div>
      ) : messages.length === 0 ? (
        <div className="sb-empty">{emptyText}</div>
      ) : (
        <>
          {visible.map(renderMessage)}
          {hasMore && (
            <button
              onClick={onShowMore}
              className="w-full py-1.5 cursor-pointer"
              style={{ fontSize: "var(--fs-10)", color: "var(--accent-blue)", background: "transparent", border: "none" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {showMoreText}
            </button>
          )}
        </>
      )}
    </div>
  );
}

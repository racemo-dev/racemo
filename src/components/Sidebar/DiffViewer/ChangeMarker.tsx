import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { MARKER_H, NUM_W } from "./constants";

export function ChangeMarker({
  onDiscard, discardLabel, discardTitle, confirmed, onConfirm, confirmLabel, confirmTitle,
}: {
  onDiscard?: () => void;
  discardLabel?: string;
  discardTitle?: string;
  confirmed?: boolean;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmTitle?: string;
}) {
  if (confirmed) return null;

  return (
    <div
      className="flex items-center"
      style={{
        height: MARKER_H,
        minHeight: MARKER_H,
        background: "color-mix(in srgb, var(--text-muted) 6%, transparent)",
        borderTop: "1px solid var(--border-subtle)",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 'var(--fs-11)',
        color: "var(--text-muted)",
        userSelect: "none",
        minWidth: "100%",
        width: "fit-content",
        paddingLeft: NUM_W * 2,
        gap: 6,
      }}
    >
      {onDiscard && (
        <span className="flex items-center gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); onDiscard(); }}
            className="cursor-pointer flex items-center gap-0.5"
            style={{
              fontSize: 'var(--fs-11)',
              color: "var(--accent-yellow)",
              padding: "1px 5px",
              borderRadius: 3,
              background: "transparent",
              border: "none",
              lineHeight: "normal",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "color-mix(in srgb, var(--accent-yellow) 10%, transparent)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            title={discardTitle}
          >
            <ArrowCounterClockwise size={10} style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }} />
            <span>{discardLabel}</span>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onConfirm?.(); }}
            className="cursor-pointer"
            style={{
              fontSize: 'var(--fs-11)',
              color: "var(--status-active)",
              padding: "1px 6px",
              borderRadius: 3,
              background: "transparent",
              border: "none",
              lineHeight: "normal",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "color-mix(in srgb, var(--status-active) 10%, transparent)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            title={confirmTitle}
          >
            {confirmLabel}
          </button>
        </span>
      )}
    </div>
  );
}

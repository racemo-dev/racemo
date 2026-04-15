import { SHELL_LABELS } from "./types";

interface RemoteTerminalTitleBarProps {
  paneId: string;
  remotePaneId: string;
  shell?: string;
  title: string;
  isFocused: boolean;
  onFocus: () => void;
  onSplit: (direction: "Horizontal" | "Vertical", before: boolean) => void;
  onClose: () => void;
}

export default function RemoteTerminalTitleBar({
  remotePaneId,
  shell,
  title,
  isFocused,
  onFocus,
  onSplit,
  onClose,
}: RemoteTerminalTitleBarProps) {
  return (
    <div
      className="flex items-center px-2 shrink-0 select-none"
      style={{
        height: 'calc(24px * var(--ui-scale))',
        fontSize: 'var(--fs-10)',
        letterSpacing: "0.05em",
        background: isFocused ? "var(--bg-overlay)" : "var(--bg-elevated)",
        borderBottom: `1px solid ${isFocused ? "var(--border-default)" : "var(--border-subtle)"}`,
      }}
      onClick={onFocus}
    >
      {/* Status dot */}
      <span
        className="inline-block rounded-full mr-2 shrink-0"
        style={{
          width: 'calc(6px * var(--ui-scale))',
          height: 'calc(6px * var(--ui-scale))',
          background: isFocused ? "var(--status-active)" : "var(--status-inactive)",
        }}
      />

      {/* Title */}
      <span
        className="truncate flex-1"
        style={{ color: isFocused ? "var(--text-secondary)" : "var(--text-muted)" }}
      >
        {title || "~"}
      </span>

      {/* Pty ID */}
      <span
        className="shrink-0 mx-2 uppercase"
        style={{ color: "var(--text-muted)", fontSize: 'var(--fs-9)' }}
      >
        {remotePaneId.slice(0, 8)}
      </span>

      {/* Shell type label (read-only for remote) */}
      <div className="relative shrink-0 mr-2">
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded"
          style={{
            fontSize: 'var(--fs-9)',
            color: "var(--text-muted)",
          }}
        >
          {shell ? (SHELL_LABELS[shell] || shell) : "Remote"}
        </span>
      </div>

      {/* Split & close buttons */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={(e) => { e.stopPropagation(); onSplit("Horizontal", true); }}
          className="p-0.5 rounded transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
          title="Split Left"
        >
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
            <polyline points="6,2 2,5 6,8" />
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSplit("Vertical", true); }}
          className="p-0.5 rounded transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
          title="Split Up"
        >
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
            <polyline points="2,6 5,2 8,6" />
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSplit("Vertical", false); }}
          className="p-0.5 rounded transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
          title="Split Down"
        >
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
            <polyline points="2,4 5,8 8,4" />
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSplit("Horizontal", false); }}
          className="p-0.5 rounded transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
          title="Split Right"
        >
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
            <polyline points="4,2 8,5 4,8" />
          </svg>
        </button>

        {/* Close pane (or disconnect if last pane) */}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="p-0.5 rounded ml-1 transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent-red)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
          title="Close pane"
        >
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      </div>
    </div>
  );
}

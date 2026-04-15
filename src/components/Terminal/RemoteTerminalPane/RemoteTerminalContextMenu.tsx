import { getModLabel } from "../../../lib/osUtils";

interface RemoteTerminalContextMenuProps {
  position: { x: number; y: number };
  onSplit: (direction: "Horizontal" | "Vertical", before: boolean) => void;
  onClose: () => void;
  onDisconnect: () => void;
  onDismiss: () => void;
}

export default function RemoteTerminalContextMenu({
  position,
  onSplit,
  onClose,
  onDisconnect,
  onDismiss,
}: RemoteTerminalContextMenuProps) {
  return (
    <div
      className="fixed z-[9999] py-1 rounded shadow-lg flex flex-col"
      style={{
        left: position.x,
        top: position.y,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        minWidth: 240,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {([
        { label: "Split Right", shortcut: `${getModLabel()}+D`, action: () => onSplit("Horizontal", false) },
        { label: "Split Down", shortcut: `${getModLabel()}+S`, action: () => onSplit("Vertical", false) },
        { label: "Split Left", shortcut: `${getModLabel()}+A`, action: () => onSplit("Horizontal", true) },
        { label: "Split Up", shortcut: `${getModLabel()}+W`, action: () => onSplit("Vertical", true) },
      ]).map((item) => (
        <button
          key={item.label}
          className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
          onClick={() => { item.action(); onDismiss(); }}
        >
          <span>{item.label}</span>
          <span className="sb-ctx-shortcut">{item.shortcut}</span>
        </button>
      ))}
      <div style={{ height: 1, background: "var(--border-subtle)", margin: "4px 0" }} />
      <button
        className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
        onClick={() => { onClose(); onDismiss(); }}
      >
        Close Pane
      </button>
      <button
        className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
        style={{ color: "var(--accent-red)" }}
        onClick={() => { onDisconnect(); onDismiss(); }}
      >
        Disconnect
      </button>
    </div>
  );
}

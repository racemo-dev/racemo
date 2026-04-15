import { handleWindowAction } from "./WindowControls";

interface SystemContextMenuProps {
  position: { x: number; y: number };
  onClose: () => void;
}

export default function SystemContextMenu({ position, onClose }: SystemContextMenuProps) {
  return (
    <div
      className="fixed z-[9999] py-1 rounded shadow-lg"
      style={{
        left: position.x,
        top: position.y,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        minWidth: 150,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="w-full px-3 py-1.5 text-left hover:bg-[var(--bg-overlay)] transition-colors"
        style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)" }}
        onClick={() => { handleWindowAction("minimize"); onClose(); }}
      >
        Minimize
      </button>
      <button
        className="w-full px-3 py-1.5 text-left hover:bg-[var(--bg-overlay)] transition-colors"
        style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)" }}
        onClick={() => { handleWindowAction("maximize"); onClose(); }}
      >
        Maximize
      </button>
      <div className="my-1" style={{ borderTop: "1px solid var(--border-default)" }} />
      <button
        className="w-full px-3 py-1.5 text-left hover:bg-[var(--bg-overlay)] transition-colors"
        style={{ fontSize: 'var(--fs-12)', color: "var(--accent-red)" }}
        onClick={() => { handleWindowAction("close"); onClose(); }}
      >
        Close
      </button>
    </div>
  );
}

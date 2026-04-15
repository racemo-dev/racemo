import { isMac } from "../../../lib/osUtils";
import { logger } from "../../../lib/logger";

export function WindowControls({ onClose }: { onClose: () => void }) {
  const handleAction = (action: "minimize" | "maximize" | "close") => {
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      if (action === "minimize") win.minimize().catch(logger.error);
      else if (action === "maximize") win.toggleMaximize().catch(logger.error);
      else onClose();
    });
  };

  if (isMac()) return null;

  return (
    <div className="flex items-center h-full">
      <button type="button" className="window-control" onClick={() => handleAction("minimize")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="currentColor" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <rect y="5" width="10" height="1" />
        </svg>
      </button>
      <button type="button" className="window-control" onClick={() => handleAction("maximize")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <rect x="1" y="1" width="8" height="8" />
        </svg>
      </button>
      <button type="button" className="window-control close" onClick={() => handleAction("close")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <line x1="1" y1="1" x2="9" y2="9" />
          <line x1="9" y1="1" x2="1" y2="9" />
        </svg>
      </button>
    </div>
  );
}

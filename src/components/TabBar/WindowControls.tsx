/* eslint-disable react-refresh/only-export-components -- exports both control components and helpers */
import { useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logger } from "../../lib/logger";

export function handleWindowAction(action: "minimize" | "maximize" | "close") {
  logger.debug("[racemo] Window action:", action);
  const win = getCurrentWindow();
  if (action === "minimize") win.minimize().catch(logger.error);
  else if (action === "maximize") win.toggleMaximize().catch(logger.error);
  else if (action === "close") win.close().catch(logger.error);
}

export function useWindowDrag() {
  const lastMouseDownTime = useRef(0);

  const startWindowDrag = async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastMouseDownTime.current < 300) {
      lastMouseDownTime.current = 0;
      handleWindowAction("maximize");
      return;
    }
    lastMouseDownTime.current = now;
    try {
      await getCurrentWindow().startDragging();
    } catch (err) {
      logger.error("[racemo] Failed to start window drag:", err);
    }
  };

  return { startWindowDrag };
}

export default function WindowControls() {
  return (
    <div className="flex items-center h-full relative z-10">
      <button
        type="button"
        className="window-control"
        onClick={(e) => { e.stopPropagation(); handleWindowAction("minimize"); }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg viewBox="0 0 10 10" fill="currentColor" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <rect y="5" width="10" height="1" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        onClick={(e) => { e.stopPropagation(); handleWindowAction("maximize"); }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <rect x="1" y="1" width="8" height="8" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control close"
        onClick={(e) => { e.stopPropagation(); handleWindowAction("close"); }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <line x1="1" y1="1" x2="9" y2="9" />
          <line x1="9" y1="1" x2="1" y2="9" />
        </svg>
      </button>
    </div>
  );
}

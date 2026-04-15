import { useCallback, useRef, useState } from "react";

const DEFAULT_BOUNDS = { top: 36, left: 52, right: 16, bottom: 36 };
const MAX_BOUNDS = { top: 0, left: 0, right: 0, bottom: 0 };

export interface Bounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export function useResizablePanel() {
  const [bounds, setBounds] = useState<Bounds>(DEFAULT_BOUNDS);
  const [isMaximized, setIsMaximized] = useState(false);
  const savedBounds = useRef(DEFAULT_BOUNDS);

  const toggleMaximize = useCallback(() => {
    if (isMaximized) {
      setBounds(savedBounds.current);
      setIsMaximized(false);
    } else {
      savedBounds.current = bounds;
      setBounds(MAX_BOUNDS);
      setIsMaximized(true);
    }
  }, [isMaximized, bounds]);

  const startResize = useCallback(
    (e: React.MouseEvent, edges: { top?: boolean; left?: boolean; right?: boolean; bottom?: boolean }) => {
      e.preventDefault();
      e.stopPropagation();
      if (isMaximized) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const startBounds = { ...bounds };
      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        setBounds(() => {
          const next = { ...startBounds };
          if (edges.top) next.top = Math.max(0, Math.min(startBounds.top + dy, window.innerHeight - 120 - startBounds.bottom));
          if (edges.bottom) next.bottom = Math.max(0, Math.min(startBounds.bottom - dy, window.innerHeight - 120 - startBounds.top));
          if (edges.left) next.left = Math.max(0, Math.min(startBounds.left + dx, window.innerWidth - 200 - startBounds.right));
          if (edges.right) next.right = Math.max(0, Math.min(startBounds.right - dx, window.innerWidth - 200 - startBounds.left));
          return next;
        });
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor =
        (edges.top && edges.left) || (edges.bottom && edges.right) ? "nwse-resize" :
          (edges.top && edges.right) || (edges.bottom && edges.left) ? "nesw-resize" :
            edges.top || edges.bottom ? "ns-resize" : "ew-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [bounds, isMaximized],
  );

  return { bounds, isMaximized, toggleMaximize, startResize };
}

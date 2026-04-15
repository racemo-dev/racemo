import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useSessionStore } from "../../stores/sessionStore";
import type { Session } from "../../types/session";
import { notifyBrowserHide, notifyBrowserShow } from "../Editor/BrowserViewer";
import { isRemoteSession, isTauri } from "../../lib/bridge";

interface SplitterProps {
  splitId: string;
  direction: "horizontal" | "vertical";
}

export default function Splitter({ splitId, direction }: SplitterProps) {
  const dragging = useRef(false);
  const setSession = useSessionStore((s) => s.setSession);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;

      const parent = (e.currentTarget as HTMLElement).parentElement;
      if (!parent) return;

      const rect = parent.getBoundingClientRect();

      let rafId = 0;
      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!dragging.current) return;
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          let ratio: number;
          const MIN_PX = 200;
          if (direction === "horizontal") {
            const minRatio = MIN_PX / rect.width;
            ratio = (moveEvent.clientX - rect.left) / rect.width;
            ratio = Math.max(minRatio, Math.min(1 - minRatio, ratio));
          } else {
            const minRatio = MIN_PX / rect.height;
            ratio = (moveEvent.clientY - rect.top) / rect.height;
            ratio = Math.max(minRatio, Math.min(1 - minRatio, ratio));
          }

          const sessionId = useSessionStore.getState().activeSessionId ?? "";
          if (isRemoteSession()) {
            if (isTauri()) {
              invoke("resize_remote_pane", { sessionId, splitId, ratio })
                .catch(console.error);
            } else {
              import("../../lib/webrtcClient").then(({ getBrowserRemoteClient }) => {
                getBrowserRemoteClient().sendResizePane(sessionId, splitId, ratio);
              });
            }
          } else {
            invoke<Session>("resize_pane", { sessionId, splitId, ratio })
              .then(setSession)
              .catch(console.error);
          }
        });
      };

      const cleanup = () => {
        dragging.current = false;
        cancelAnimationFrame(rafId);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        notifyBrowserShow();
      };

      document.body.style.cursor =
        direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      // Hide browser webviews during drag so they don't steal mouse events
      notifyBrowserHide();

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [splitId, direction, setSession],
  );

  const isHorizontal = direction === "horizontal";

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`flex-shrink-0 relative group ${
        isHorizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize"
      }`}
      style={{ background: "var(--border-subtle)" }}
    >
      {/* Invisible wider hit area */}
      <div
        className={`absolute ${
          isHorizontal
            ? "top-0 bottom-0 -left-2 -right-2"
            : "left-0 right-0 -top-2 -bottom-2"
        }`}
      />
    </div>
  );
}

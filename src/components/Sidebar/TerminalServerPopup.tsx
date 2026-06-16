import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import ServersPanel from "./ServersPanel";
import TerminalsPanel from "./TerminalsPanel";

type Tab = "servers" | "terminals";

interface Props {
  anchorRect: DOMRect;
  anchorEl?: HTMLElement | null;
  onClose: () => void;
}

const POPUP_WIDTH = 320;
const POPUP_HEIGHT = 440;

function TerminalServerPopupContent({ anchorRect, anchorEl, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("servers");
  const ref = useRef<HTMLDivElement>(null);

  const top = Math.max(8, Math.min(anchorRect.top, window.innerHeight - POPUP_HEIGHT - 8));
  const left = anchorRect.right + 8;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      // Ignore clicks on the toggle button itself — let its onClick handle the toggle.
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose, anchorEl]);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        top,
        left,
        width: POPUP_WIDTH,
        height: POPUP_HEIGHT,
        background: "var(--bg-surface)",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        zIndex: 9999,
        overflow: "hidden",
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}
      >
        {(["servers", "terminals"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: "calc(7px * var(--ui-scale)) 0",
              background: "transparent",
              border: "none",
              borderBottom: tab === t ? "2px solid var(--accent-blue)" : "2px solid transparent",
              cursor: "pointer",
              color: tab === t ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: tab === t ? 600 : 400,
              fontSize: "calc(12px * var(--ui-scale))",
              transition: "color 0.1s",
            }}
          >
            {t === "servers" ? "Servers" : "Terminals"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "servers" ? <ServersPanel /> : <TerminalsPanel />}
      </div>
    </div>
  );
}

export default function TerminalServerPopup(props: Props) {
  return createPortal(<TerminalServerPopupContent {...props} />, document.body);
}

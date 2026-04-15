import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "../lib/osUtils";

type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

/**
 * Invisible resize handles for windows without native decorations (Linux/Windows).
 * macOS uses titleBarStyle: "Overlay" which preserves native resize edges.
 */

const EDGE = 6; // px - resize grab area width
const CORNER = 10; // px - corner grab area size

const edges: { dir: ResizeDirection; style: React.CSSProperties }[] = [
  // Edges
  { dir: "North", style: { top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" } },
  { dir: "South", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" } },
  { dir: "West", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: "ew-resize" } },
  { dir: "East", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: "ew-resize" } },
  // Corners
  { dir: "NorthWest", style: { top: 0, left: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" } },
  { dir: "NorthEast", style: { top: 0, right: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" } },
  { dir: "SouthWest", style: { bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" } },
  { dir: "SouthEast", style: { bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" } },
];

export default function WindowResizeHandles() {
  if (isMac()) return null;

  const onMouseDown = (dir: ResizeDirection) => (e: React.MouseEvent) => {
    e.preventDefault();
    getCurrentWindow().startResizeDragging(dir).catch(() => {});
  };

  return (
    <>
      {edges.map(({ dir, style }) => (
        <div
          key={dir}
          onMouseDown={onMouseDown(dir)}
          style={{
            position: "fixed",
            zIndex: 99999,
            ...style,
          }}
        />
      ))}
    </>
  );
}

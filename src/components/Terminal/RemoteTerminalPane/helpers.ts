import { Terminal } from "@xterm/xterm";
import { getXTermCore } from "../../../lib/xtermInternal";

/** Get cursor pixel position from a terminal + container (no registry dependency). */
export function getRemoteCursorPos(term: Terminal, container: HTMLDivElement): { x: number; y: number; lineHeight: number } | null {
  const core = getXTermCore(term);
  const dimensions = core?.dimensions || core?._renderService?.dimensions;
  let cellWidth: number;
  let cellHeight: number;
  if (dimensions?.css?.cell) {
    cellWidth = dimensions.css.cell.width;
    cellHeight = dimensions.css.cell.height;
  } else {
    const screenEl = container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screenEl) return null;
    cellWidth = screenEl.clientWidth / term.cols;
    cellHeight = screenEl.clientHeight / term.rows;
  }
  const screenEl = container.querySelector(".xterm-screen") as HTMLElement | null;
  const offsetX = screenEl?.offsetLeft || 0;
  const offsetY = screenEl?.offsetTop || 0;
  const containerRect = container.getBoundingClientRect();
  const x = term.buffer.active.cursorX * cellWidth + offsetX + containerRect.left;
  const y = term.buffer.active.cursorY * cellHeight + offsetY + containerRect.top;
  return { x, y, lineHeight: cellHeight };
}

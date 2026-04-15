import type { PaneNode } from "../types/session";
import { logger } from "./logger";

logger.debug("[terminalSize] terminalUtils.ts module loaded");

export function getDefaultTerminalSize(): { rows: number; cols: number } {
  const availableHeight = window.innerHeight - 32 - 20;
  const availableWidth = window.innerWidth - 20;
  const rows = Math.max(24, Math.floor(availableHeight / 20));
  const cols = Math.max(80, Math.floor(availableWidth / 8));
  logger.debug(`[terminalSize] Calculated size: ${rows}x${cols} (inner: ${window.innerWidth}x${window.innerHeight})`);
  return { rows, cols };
}

/** Recursively collect all PTY IDs from a pane tree */
export function getAllPtyIds(node: PaneNode): string[] {
  if (node.type === "leaf") {
    return [node.ptyId];
  }
  return [...getAllPtyIds(node.first), ...getAllPtyIds(node.second)];
}

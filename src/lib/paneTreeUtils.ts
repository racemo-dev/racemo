import type { PaneNode } from "../types/session";

export function firstLeafId(node: PaneNode): string {
  if (node.type === "leaf") return node.id;
  return firstLeafId(node.first);
}

export function findPtyId(node: PaneNode, paneId: string): string | null {
  if (node.type === "leaf") {
    return node.id === paneId ? node.ptyId : null;
  }
  return findPtyId(node.first, paneId) || findPtyId(node.second, paneId);
}

export function collectLeafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)];
}

/** Collect all ptyIds from leaf nodes in the pane tree. */
export function collectPtyIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.ptyId];
  return [...collectPtyIds(node.first), ...collectPtyIds(node.second)];
}

/** Collect { ptyId, cwd } from leaf nodes that have a cwd set. */
export function collectLeafCwds(node: PaneNode): Array<{ ptyId: string; cwd: string }> {
  if (node.type === "leaf") {
    return node.cwd ? [{ ptyId: node.ptyId, cwd: node.cwd }] : [];
  }
  return [...collectLeafCwds(node.first), ...collectLeafCwds(node.second)];
}

/** Get the first (leftmost/topmost) ptyId from the pane tree. */
export function firstPtyId(node: PaneNode): string {
  if (node.type === "leaf") return node.ptyId;
  return firstPtyId(node.first);
}

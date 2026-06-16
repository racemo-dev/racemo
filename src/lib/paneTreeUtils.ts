import type { PaneNode, SplitPane } from "../types/session";

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

export type NavDirection = "left" | "right" | "up" | "down";

type PathEntry = { node: SplitPane; side: "first" | "second" };

function findPathTo(
  node: PaneNode,
  targetId: string,
  path: PathEntry[],
): PathEntry[] | null {
  if (node.type === "leaf") {
    return node.id === targetId ? [...path] : null;
  }
  path.push({ node, side: "first" });
  const l = findPathTo(node.first, targetId, path);
  if (l) return l;
  path.pop();
  path.push({ node, side: "second" });
  const r = findPathTo(node.second, targetId, path);
  if (r) return r;
  path.pop();
  return null;
}

/**
 * Returns the pane id to move focus to when navigating in the given direction.
 * Returns null if there's no adjacent pane in that direction.
 */
export function navigatePane(root: PaneNode, currentId: string, direction: NavDirection): string | null {
  const path = findPathTo(root, currentId, []);
  if (!path) return null;

  const splitDir = direction === "left" || direction === "right" ? "horizontal" : "vertical";
  // We need to be in `first` to have a neighbor on the right/down side
  const requiredSide: "first" | "second" = direction === "right" || direction === "down" ? "first" : "second";

  for (let i = path.length - 1; i >= 0; i--) {
    const { node, side } = path[i];
    if (node.direction === splitDir && side === requiredSide) {
      const neighbor = direction === "right" || direction === "down" ? node.second : node.first;
      return firstLeafId(neighbor);
    }
  }

  return null;
}

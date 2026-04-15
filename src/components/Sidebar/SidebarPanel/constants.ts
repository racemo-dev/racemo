import type { DirEntry } from "./types";

export const EXPLORER_REFRESH_EVENT = "explorer-refresh";
export const DOCS_EXTENSIONS = new Set(["md", "txt", "pdf"]);

export function isDocFile(name: string): boolean {
  return DOCS_EXTENSIONS.has(name.split(".").pop()?.toLowerCase() ?? "");
}

export const DOCS_EXT_ARRAY = Array.from(DOCS_EXTENSIONS);

// Directory listing cache: show cached results instantly, refresh in background
const dirCache = new Map<string, DirEntry[]>();

export function dirCacheGet(path: string): DirEntry[] | undefined {
  const val = dirCache.get(path);
  if (val !== undefined) {
    // Move to end for LRU semantics
    dirCache.delete(path);
    dirCache.set(path, val);
  }
  return val;
}

export function dirCacheSet(path: string, entries: DirEntry[]) {
  dirCache.set(path, entries);
  // Evict oldest entries when cache grows too large
  if (dirCache.size > 64) {
    const first = dirCache.keys().next().value;
    if (first !== undefined) dirCache.delete(first);
  }
}

export function dirCacheInvalidate(path: string) {
  dirCache.delete(path);
}

export function dirCacheInvalidateAll() {
  dirCache.clear();
}

// ── Pointer-based drag-and-drop (HTML5 DnD broken in Tauri WKWebView) ──

export interface ExplorerDragState {
  /** Full path of the file/folder being dragged */
  srcPath: string;
  /** Is the source a directory? */
  srcIsDir: boolean;
  /** Current ghost position */
  x: number;
  y: number;
}

let _dragState: ExplorerDragState | null = null;
const _listeners = new Set<() => void>();

export function getExplorerDrag(): ExplorerDragState | null { return _dragState; }

export function setExplorerDrag(state: ExplorerDragState | null) {
  _dragState = state;
  for (const fn of _listeners) fn();
}

export function onExplorerDragChange(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// Legacy aliases (still used in ExplorerView header)
export function setInternalDragPath(path: string | null) {
  if (path === null) setExplorerDrag(null);
}
export function getInternalDragPath(): string | null {
  return _dragState?.srcPath ?? null;
}

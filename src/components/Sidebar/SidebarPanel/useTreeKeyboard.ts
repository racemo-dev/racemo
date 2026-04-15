import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openEditorPanel } from "../../../lib/editorWindow";
import { apiListDirectoryGitFiltered, isTauri } from "../../../lib/bridge";
import { dirCacheGet, dirCacheSet, isDocFile } from "./constants";
import type { DirEntry, InlineInputState } from "./types";

interface UseTreeKeyboardParams {
  entries: DirEntry[];
  normalizedCwd: string;
  repoRoot: string | null;
  inlineInput: InlineInputState | null;
  docsFilter?: boolean;
  docsDirCache?: Map<string, boolean>;
  refreshCount: number;
}

export function useTreeKeyboard({
  entries,
  normalizedCwd,
  repoRoot,
  inlineInput,
  docsFilter,
  docsDirCache,
  refreshCount,
}: UseTreeKeyboardParams) {
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState("");
  const [childrenMap, setChildrenMap] = useState<Map<string, DirEntry[]>>(new Map());
  const treeContainerRef = useRef<HTMLDivElement>(null);

  const fetchDirChildren = useCallback((dirPath: string) => {
    const cached = dirCacheGet(dirPath);
    if (cached) setChildrenMap((m) => { const n = new Map(m); n.set(dirPath, cached); return n; });
    apiListDirectoryGitFiltered(dirPath, repoRoot)
      .then((res) => { dirCacheSet(dirPath, res); setChildrenMap((m) => { const n = new Map(m); n.set(dirPath, res); return n; }); })
      .catch(() => {});
  }, [repoRoot]);

  // Re-fetch children of all open directories on refresh (e.g. after DnD move)
  useEffect(() => {
    if (refreshCount === 0) return; // skip initial render
    for (const dir of openDirs) fetchDirChildren(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to refreshCount
  }, [refreshCount]);

  // Auto-expand for inline input
  useEffect(() => {
    if (inlineInput && (inlineInput.mode === "new-file" || inlineInput.mode === "new-dir")) {
      setOpenDirs((prev) => {
        if (prev.has(inlineInput.parentPath)) return prev;
        const next = new Set(prev);
        next.add(inlineInput.parentPath);
        fetchDirChildren(inlineInput.parentPath);
        return next;
      });
    }
  }, [inlineInput, fetchDirChildren]);

  const onToggleDir = useCallback((path: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) { next.delete(path); } else { next.add(path); fetchDirChildren(path); }
      return next;
    });
  }, [fetchDirChildren]);

  const onFocusPath = useCallback((path: string) => {
    setFocusedPath(path);
  }, []);

  // Build flat visible list for keyboard navigation
  const flatList = useMemo(() => {
    const result: { path: string; isDir: boolean; parentPath: string }[] = [];
    const filterEntries = (items: DirEntry[], parent: string): DirEntry[] => {
      if (!docsFilter) return items;
      return items.filter((e) =>
        e.type === "file" ? isDocFile(e.name) : (docsDirCache?.get(`${parent}/${e.name}`) ?? true)
      );
    };
    const walk = (items: DirEntry[], parent: string) => {
      for (const e of filterEntries(items, parent)) {
        const p = `${parent}/${e.name}`;
        result.push({ path: p, isDir: e.type === "dir", parentPath: parent });
        if (e.type === "dir" && openDirs.has(p)) {
          const ch = childrenMap.get(p);
          if (ch) walk(ch, p);
        }
      }
    };
    if (normalizedCwd) walk(entries, normalizedCwd);
    return result;
  }, [entries, openDirs, childrenMap, normalizedCwd, docsFilter, docsDirCache]);

  // Keyboard handler
  useEffect(() => {
    const container = treeContainerRef.current;
    if (!container) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = flatList.findIndex((f) => f.path === focusedPath);
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = idx < flatList.length - 1 ? idx + 1 : idx;
          if (next >= 0 && flatList[next]) {
            setFocusedPath(flatList[next].path);
            document.querySelector(`[data-tree-path="${CSS.escape(flatList[next].path)}"]`)?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev = idx > 0 ? idx - 1 : 0;
          if (flatList[prev]) {
            setFocusedPath(flatList[prev].path);
            document.querySelector(`[data-tree-path="${CSS.escape(flatList[prev].path)}"]`)?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const item = flatList[idx];
          if (item?.isDir && !openDirs.has(item.path)) {
            onToggleDir(item.path);
          } else if (item?.isDir && openDirs.has(item.path)) {
            const nextIdx = idx + 1;
            if (nextIdx < flatList.length && flatList[nextIdx].parentPath === item.path) {
              setFocusedPath(flatList[nextIdx].path);
            }
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          const item = flatList[idx];
          if (item?.isDir && openDirs.has(item.path)) {
            onToggleDir(item.path);
          } else if (item) {
            const parentIdx = flatList.findIndex((f) => f.path === item.parentPath);
            if (parentIdx >= 0) setFocusedPath(flatList[parentIdx].path);
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          const item = flatList[idx];
          if (!item) break;
          if (item.isDir) {
            onToggleDir(item.path);
          } else if (isTauri()) {
            openEditorPanel(item.path).then(() => {
              setTimeout(() => {
                const cm = document.querySelector(".cm-editor .cm-content") as HTMLElement;
                cm?.focus();
              }, 50);
            }).catch(console.error);
          }
          break;
        }
        default:
          return;
      }
    };
    container.addEventListener("keydown", handler);
    return () => container.removeEventListener("keydown", handler);
  }, [flatList, focusedPath, openDirs, onToggleDir]);

  return {
    openDirs,
    focusedPath,
    childrenMap,
    treeContainerRef,
    onToggleDir,
    onFocusPath,
  };
}

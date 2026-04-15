import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "../../../lib/logger";

import type { RenderItem, StructureHunk } from "./types";
import { LINE_H, MARKER_H } from "./constants";
import { parseUnifiedLines, parseStructureHunks, findStructHunk } from "./parsing";

export function useDiffData(cwd: string, filePath: string, staged: boolean, onHunkDiscarded?: () => void) {
  const [displayDiff, setDisplayDiff] = useState<string | null>(null);
  const [structHunks, setStructHunks] = useState<StructureHunk[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  // Discarded patches stored as array
  const [discardedPatches, setDiscardedPatches] = useState<string[]>([]);

  const cacheFileKey = `${filePath}:${staged}`;
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(new Set());

  // Serialized cache write queue to prevent read-modify-write races
  const savePendingRef = useRef<Promise<void>>(Promise.resolve());
  const saveDiscardedToCache = useCallback((next: string[]) => {
    savePendingRef.current = savePendingRef.current.then(async () => {
      try {
        const json = await invoke<string>("load_discard_cache", { path: cwd });
        const data = JSON.parse(json) as Record<string, string[]>;
        if (next.length > 0) {
          data[cacheFileKey] = next;
        } else {
          delete data[cacheFileKey];
        }
        await invoke("save_discard_cache", { path: cwd, data: JSON.stringify(data) });
      } catch (e) { logger.warn("Failed to save discard cache:", e); }
    });
  }, [cwd, cacheFileKey]);

  // Load discarded patches from disk on mount
  useEffect(() => {
    invoke<string>("load_discard_cache", { path: cwd })
      .then((json) => {
        try {
          const data = JSON.parse(json) as Record<string, unknown>;
          const cached = data[cacheFileKey];
          if (Array.isArray(cached) && cached.length > 0) {
            setDiscardedPatches(cached as string[]);
          } else if (cached && typeof cached === "object" && !Array.isArray(cached)) {
            // Migrate old format: { "0": "patch", "1": "patch" } -> ["patch", "patch"]
            const patches = Object.values(cached as Record<string, string>);
            if (patches.length > 0) setDiscardedPatches(patches);
          }
        } catch (e) { logger.warn("Failed to load discard cache:", e); }
      })
      .catch(() => { /* expected: cache file may not exist yet */ });
   
  }, [cwd, cacheFileKey]);

  // Load collapsed state from file cache on mount
  useEffect(() => {
    invoke<string>("load_diff_cache", { path: cwd })
      .then((json) => {
        try {
          const data = JSON.parse(json) as Record<string, number[]>;
          const indices = data[cacheFileKey];
          if (Array.isArray(indices) && indices.length > 0) {
            setCollapsedHunks(new Set(indices));
          }
        } catch { /* expected: cached JSON may be malformed or empty */ }
      })
      .catch(() => { /* expected: cache file may not exist yet */ });
   
  }, [cwd, cacheFileKey]);

  const saveCollapsed = useCallback(async (next: Set<number>) => {
    try {
      const json = await invoke<string>("load_diff_cache", { path: cwd });
      const data = JSON.parse(json) as Record<string, number[]>;
      data[cacheFileKey] = [...next];
      await invoke("save_diff_cache", { path: cwd, data: JSON.stringify(data) });
    } catch { /* expected: cache read/write may fail if file doesn't exist */ }
  }, [cwd, cacheFileKey]);

  const confirmHunk = (hunkIndex: number) =>
    setCollapsedHunks((prev) => {
      const next = new Set([...prev, hunkIndex]);
      void saveCollapsed(next);
      return next;
    });
  const expandHunk = (hunkIndex: number) =>
    setCollapsedHunks((prev) => {
      const next = new Set(prev);
      next.delete(hunkIndex);
      void saveCollapsed(next);
      return next;
    });

  const loadDiff = useCallback(() => {
    setIsLoading(true);
    setError("");
    Promise.all([
      invoke<string>("git_diff_file", { path: cwd, filePath, staged, contextLines: 99999 }),
      invoke<string>("git_diff_file", { path: cwd, filePath, staged }),
    ])
      .then(([display, structure]) => {
        setDisplayDiff(display);
        setStructHunks(parseStructureHunks(structure));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setIsLoading(false));
  }, [cwd, filePath, staged]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch entry point
    loadDiff();
  }, [loadDiff]);

  // Parse unified diff lines
  const diffLines = useMemo(
    () => (displayDiff ? parseUnifiedLines(displayDiff) : []),
    [displayDiff],
  );

  // Build render items from discarded patches + map synthetic indices back to original keys
  const { discardedItems, syntheticDiscardedIndices, syntheticToOriginal } = useMemo(() => {
    if (discardedPatches.length === 0) return {
      discardedItems: [] as RenderItem[],
      syntheticDiscardedIndices: new Set<number>(),
      syntheticToOriginal: new Map<number, number>(),
    };
    const result: RenderItem[] = [];
    const synIndices = new Set<number>();
    const synToOrig = new Map<number, number>(); // synthetic hunkIndex -> array index
    for (let arrIdx = 0; arrIdx < discardedPatches.length; arrIdx++) {
      const patch = discardedPatches[arrIdx];
      const lines = parseUnifiedLines(patch);
      let oldStart = Infinity, oldEnd = 0, newStart = Infinity, newEnd = 0;
      for (const l of lines) {
        if (l.oldNum != null) { oldStart = Math.min(oldStart, l.oldNum); oldEnd = Math.max(oldEnd, l.oldNum + 1); }
        if (l.newNum != null) { newStart = Math.min(newStart, l.newNum); newEnd = Math.max(newEnd, l.newNum + 1); }
      }
      // Use negative indices to guarantee no collision with real hunk indices
      const hunkIndex = -(arrIdx + 1);
      synIndices.add(hunkIndex);
      synToOrig.set(hunkIndex, arrIdx);
      const sh: StructureHunk = {
        hunkIndex,
        oldStart: oldStart === Infinity ? 0 : oldStart, oldEnd,
        newStart: newStart === Infinity ? 0 : newStart, newEnd,
      };
      let addedMarker = false;
      for (const line of lines) {
        if (!addedMarker && line.type !== "context") {
          result.push({ kind: "changeMarker", structHunk: sh });
          addedMarker = true;
        }
        result.push({ kind: "line", line });
      }
    }
    return { discardedItems: result, syntheticDiscardedIndices: synIndices, syntheticToOriginal: synToOrig };
  }, [discardedPatches]);

  // Build render items: insert change markers at the start of each change block
  const items = useMemo(() => {
    const result: RenderItem[] = [];
    let inChange = false;
    const usedHunkIndices = new Set<number>();

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];
      const isChanged = line.type !== "context";

      if (isChanged && !inChange) {
        inChange = true;
        // Find matching structure hunk
        let oldLine = line.oldNum;
        let newLine = line.newNum;
        if (oldLine == null) {
          for (let j = i - 1; j >= 0; j--) {
            if (diffLines[j].oldNum != null) { oldLine = diffLines[j].oldNum! + 1; break; }
          }
        }
        if (newLine == null) {
          for (let j = i - 1; j >= 0; j--) {
            if (diffLines[j].newNum != null) { newLine = diffLines[j].newNum! + 1; break; }
          }
        }
        const sh = findStructHunk(structHunks, oldLine, newLine);
        if (sh && !usedHunkIndices.has(sh.hunkIndex)) {
          usedHunkIndices.add(sh.hunkIndex);
          result.push({ kind: "changeMarker", structHunk: sh });
        } else {
          result.push({ kind: "changeMarker", structHunk: sh ?? { hunkIndex: Number.MIN_SAFE_INTEGER, oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 0 } });
        }
      } else if (!isChanged) {
        inChange = false;
      }
      result.push({ kind: "line", line });
    }
    // Append reconstructed discarded items at the end
    if (discardedItems.length > 0) result.push(...discardedItems);
    return result;
  }, [diffLines, structHunks, discardedItems]);

  // Change block positions for navigation
  const changeBlocks = useMemo(() => {
    const blocks: { offset: number }[] = [];
    let px = 0;
    for (const item of items) {
      if (item.kind === "changeMarker") {
        blocks.push({ offset: px });
        px += MARKER_H;
      } else {
        px += LINE_H;
      }
    }
    return blocks;
  }, [items]);

  // Change map: positions of changed lines as fraction of total content height
  const changeMapMarkers = useMemo(() => {
    const totalH = items.reduce((h, item) => h + (item.kind === "changeMarker" ? MARKER_H : LINE_H), 0);
    if (totalH === 0) return [];
    const markers: { top: number; height: number; type: "add" | "remove" }[] = [];
    let px = 0;
    for (const item of items) {
      if (item.kind === "line" && item.line.type !== "context") {
        markers.push({ top: px / totalH, height: Math.max(LINE_H / totalH, 0.002), type: item.line.type });
      }
      px += item.kind === "changeMarker" ? MARKER_H : LINE_H;
    }
    return markers;
  }, [items]);

  const handleDiscardHunk = async (hunkIndex: number) => {
    try {
      const patch = await invoke<string>("git_discard_hunk", { path: cwd, filePath, staged, hunkIndex });
      const next = [...discardedPatches, patch];
      setDiscardedPatches(next);
      saveDiscardedToCache(next);
      loadDiff();
      onHunkDiscarded?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleUndoDiscard = async (syntheticIdx: number) => {
    const arrayIdx = syntheticToOriginal.get(syntheticIdx);
    if (arrayIdx == null) return;
    const patch = discardedPatches[arrayIdx];
    if (!patch) return;
    try {
      await invoke("git_apply_patch", { path: cwd, patch, staged });
      const next = discardedPatches.filter((_, i) => i !== arrayIdx);
      setDiscardedPatches(next);
      saveDiscardedToCache(next);
      loadDiff();
      onHunkDiscarded?.();
    } catch (e) {
      const next = discardedPatches.filter((_, i) => i !== arrayIdx);
      setDiscardedPatches(next);
      saveDiscardedToCache(next);
      setError(String(e));
    }
  };

  const fileName = filePath.split("/").pop() ?? filePath;
  const dirPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const totalAdded = diffLines.filter((l) => l.type === "add").length;
  const totalRemoved = diffLines.filter((l) => l.type === "remove").length;
  const hasChanges = totalAdded > 0 || totalRemoved > 0;
  const hasDiscarded = discardedPatches.length > 0;
  const showDiffBody = hasChanges || hasDiscarded;

  return {
    displayDiff,
    error,
    isLoading,
    items,
    changeBlocks,
    changeMapMarkers,
    syntheticDiscardedIndices,
    collapsedHunks,
    confirmHunk,
    expandHunk,
    handleDiscardHunk,
    handleUndoDiscard,
    fileName,
    dirPath,
    totalAdded,
    totalRemoved,
    hasChanges,
    showDiffBody,
  };
}

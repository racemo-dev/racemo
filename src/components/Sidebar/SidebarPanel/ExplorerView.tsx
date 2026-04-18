import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { apiGetHomeDir, apiListDirectoryGitFiltered, apiDirHasDocs, isTauri, isRemoteSession } from "../../../lib/bridge";
import { usePanelEditorStore } from "../../../stores/panelEditorStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useGitStore } from "../../../stores/gitStore";
import { DirTreeNode, FolderIcon, FileIcon, InlineInput } from "./TreeComponents";
import { useFocusedCwd } from "./DocsView";
import { EXPLORER_REFRESH_EVENT, DOCS_EXT_ARRAY, isDocFile, dirCacheGet, dirCacheSet, dirCacheInvalidate, getExplorerDrag, setExplorerDrag, onExplorerDragChange } from "./constants";
import type { DirEntry, ContextMenuState, InlineInputState } from "./types";
import { useContextMenuActions } from "./useContextMenuActions";
import { useTreeKeyboard } from "./useTreeKeyboard";
import { ExplorerContextMenu } from "./ExplorerContextMenu";
import { logger } from "../../../lib/logger";

export default function ExplorerView() {
  const paneCwd = useFocusedCwd();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const pinnedCwd = useSessionStore((s) => s.activeSessionId ? s.pinnedCwds[s.activeSessionId] ?? "" : "");

  const repoRoot = useGitStore((s) => s.repoInfo?.root ?? null);

  const [entries, setEntries] = useState<DirEntry[]>([]);
  const currentDirRef = useRef("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [homeDir, setHomeDir] = useState("");
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  // Inline input state
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null);
  const [inlineValue, setInlineValue] = useState("");
  const inlineRef = useRef<HTMLInputElement>(null);

  const docsFilter = useSettingsStore((s) => s.explorerDocsFilter);
  const [docsDirCache, setDocsDirCache] = useState<Map<string, boolean>>(new Map());

  const refreshTree = useCallback(() => {
    if (currentDirRef.current) dirCacheInvalidate(currentDirRef.current);
    currentDirRef.current = "";
    setRefreshCount((c) => c + 1);
  }, []);

  // Listen for refresh trigger from header button
  useEffect(() => {
    window.addEventListener(EXPLORER_REFRESH_EVENT, refreshTree);
    return () => window.removeEventListener(EXPLORER_REFRESH_EVENT, refreshTree);
  }, [refreshTree]);

  const commitInlineInput = useCallback(() => {
    if (!inlineInput) return;
    const name = inlineValue.trim();
    if (!name) {
      setInlineInput(null);
      return;
    }
    const { mode, parentPath, originalName } = inlineInput;
    setInlineInput(null);

    if (mode === "new-file") {
      invoke("create_file", { path: `${parentPath}/${name}` })
        .then(refreshTree)
        .catch(logger.error);
    } else if (mode === "new-dir") {
      invoke("create_directory", { path: `${parentPath}/${name}` })
        .then(refreshTree)
        .catch(logger.error);
    } else if (mode === "rename" && originalName && name !== originalName) {
      invoke("rename_path", {
        oldPath: `${parentPath}/${originalName}`,
        newPath: `${parentPath}/${name}`,
      })
        .then(refreshTree)
        .catch(logger.error);
    }
  }, [inlineInput, inlineValue, refreshTree]);

  const cancelInlineInput = useCallback(() => {
    setInlineInput(null);
  }, []);

  const cwd = pinnedCwd || paneCwd || homeDir;
  const normalizedCwd = cwd.replaceAll("\\", "/");

  // When docsFilter is active, check which dirs contain doc files
  useEffect(() => {
    if (!docsFilter) { setDocsDirCache(new Map()); return; }
    let cancelled = false;
    const dirs = entries.filter((e) => e.type === "dir");
    Promise.all(dirs.map(async (d) => {
      const fullPath = `${normalizedCwd}/${d.name}`;
      const has = await apiDirHasDocs(fullPath, DOCS_EXT_ARRAY);
      return [fullPath, has] as const;
    })).then((results) => {
      if (cancelled) return;
      setDocsDirCache((prev) => {
        const next = new Map(prev);
        for (const [p, v] of results) next.set(p, v);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [docsFilter, entries, normalizedCwd]);

  const handleCheckDirDocs = useCallback((paths: string[]) => {
    if (!docsFilter) return;
    Promise.all(paths.map(async (p) => {
      const has = await apiDirHasDocs(p, DOCS_EXT_ARRAY);
      return [p, has] as const;
    })).then((results) => {
      setDocsDirCache((prev) => {
        const next = new Map(prev);
        for (const [p, v] of results) next.set(p, v);
        return next;
      });
    });
  }, [docsFilter]);

  // Tree keyboard navigation
  const {
    openDirs,
    focusedPath,
    childrenMap,
    treeContainerRef,
    onToggleDir,
    onFocusPath,
  } = useTreeKeyboard({ entries, normalizedCwd, repoRoot, inlineInput, docsFilter, docsDirCache, refreshCount });

  // Send watched paths to server when openDirs or active editor file changes
  useEffect(() => {
    if (!isTauri() || isRemoteSession()) return;
    const dirs = [normalizedCwd, ...Array.from(openDirs)];
    const editorFile = usePanelEditorStore.getState().tabs[usePanelEditorStore.getState().activeIndex]?.path ?? null;
    invoke("update_watched_paths", { dirs, editorFile: editorFile ?? null }).catch(() => {});
  }, [openDirs, normalizedCwd]);

  // Listen for fs-change events from the file watcher
  useEffect(() => {
    if (!isTauri()) return;
    const unlistenPromise = listen<Array<{ path: string; kind: string }>>("fs-change", (event) => {
      const changedDirs = new Set<string>();
      for (const e of event.payload) {
        const dir = e.path.substring(0, e.path.lastIndexOf("/"));
        changedDirs.add(dir);
        // Reload editor file if modified externally
        if (e.kind === "modified") {
          usePanelEditorStore.getState().reloadTabByPath(e.path).catch(() => {});
        }
      }
      for (const dir of changedDirs) {
        dirCacheInvalidate(dir);
      }
      if (changedDirs.size > 0) {
        window.dispatchEvent(new Event(EXPLORER_REFRESH_EVENT));
      }
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  // ── Pointer-based drag: ghost + drop on folder ──
  const [drag, setDrag] = useState(getExplorerDrag());
  useEffect(() => onExplorerDragChange(() => setDrag(getExplorerDrag())), []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cur = getExplorerDrag();
      if (!cur) return;
      setExplorerDrag({ ...cur, x: e.clientX, y: e.clientY });
    };
    const onUp = async (e: PointerEvent) => {
      const cur = getExplorerDrag();
      if (!cur) return;
      setExplorerDrag(null);

      // Find drop target: folder item or terminal
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!target) return;

      // Check if dropped on a folder in the explorer
      const folderEl = target.closest<HTMLElement>("[data-is-dir]");
      if (folderEl) {
        const destFolder = folderEl.dataset.treePath;
        if (!destFolder || destFolder === cur.srcPath) return;
        if (cur.srcPath.startsWith(destFolder + "/") || destFolder.startsWith(cur.srcPath + "/")) return;
        const fileName = cur.srcPath.split("/").pop() ?? "";
        const destPath = `${destFolder}/${fileName}`;
        if (cur.srcPath === destPath) return;
        invoke("rename_path", { oldPath: cur.srcPath, newPath: destPath })
          .then(() => {
            const srcDir = cur.srcPath.substring(0, cur.srcPath.lastIndexOf("/"));
            dirCacheInvalidate(srcDir);
            dirCacheInvalidate(destFolder);
            window.dispatchEvent(new Event(EXPLORER_REFRESH_EVENT));
          })
          .catch((err: unknown) => logger.error("[DnD] move failed:", err));
        return;
      }

      // Check if dropped on a terminal (local or remote)
      const termEl = target.closest<HTMLElement>("[data-pty-id]");
      if (termEl) {
        const id = termEl.dataset.ptyId;
        if (!id) return;
        const path = cur.srcPath;
        // Safe shell quoting: always single-quote, escape embedded single quotes
        const quoted = "'" + path.replace(/'/g, "'\\''") + "'";
        const encoder = new TextEncoder();
        const bytes = Array.from(encoder.encode(quoted + " "));
        if (termEl.dataset.remote === "1") {
          if (!isTauri()) {
            const { getBrowserRemoteClient } = await import("../../../lib/webrtcClient");
            getBrowserRemoteClient().sendInput(id, new Uint8Array(bytes));
          } else {
            invoke("write_to_remote_pty", { paneId: id, data: bytes }).catch(logger.error);
          }
        } else {
          invoke("write_to_pty", { paneId: id, data: bytes }).catch(logger.error);
        }
        return;
      }

      // Check if dropped on the explorer header (move to cwd root)
      const headerEl = target.closest<HTMLElement>(".sb-section-header");
      if (headerEl && normalizedCwd) {
        const fileName = cur.srcPath.split("/").pop() ?? "";
        const destPath = `${normalizedCwd}/${fileName}`;
        if (cur.srcPath === destPath) return;
        invoke("rename_path", { oldPath: cur.srcPath, newPath: destPath })
          .then(() => {
            const srcDir = cur.srcPath.substring(0, cur.srcPath.lastIndexOf("/"));
            dirCacheInvalidate(srcDir);
            dirCacheInvalidate(normalizedCwd);
            window.dispatchEvent(new Event(EXPLORER_REFRESH_EVENT));
          })
          .catch((err: unknown) => logger.error("[DnD] move failed:", err));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [normalizedCwd]);

  // Context menu actions
  const ctxActions = useContextMenuActions({
    ctxMenu,
    setCtxMenu,
    setInlineInput,
    setInlineValue,
    refreshTree,
  });

  // Close context menu on any click or right-click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, { capture: true });
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, { capture: true });
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, path, isDir });
  }, []);

  // Get home directory as fallback — only when a session exists
  useEffect(() => {
    if (!activeSessionId) return;
    if (!homeDir) apiGetHomeDir().then(setHomeDir).catch(() => { });
  }, [activeSessionId, homeDir]);

  useEffect(() => {
    if (!normalizedCwd) return;
    currentDirRef.current = normalizedCwd;

    const cached = dirCacheGet(normalizedCwd);
    if (cached) setEntries(cached);

    let stale = false;
    const timer = cached
      ? setTimeout(doFetch, 300)
      : (doFetch(), undefined);

    function doFetch() {
      apiListDirectoryGitFiltered(normalizedCwd, repoRoot)
        .then((res) => { dirCacheSet(normalizedCwd, res); if (!stale) setEntries(res); })
        .catch(() => { if (!stale) setEntries([]); });
    }

    return () => { stale = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repoRoot read fresh inside doFetch; including it would cause unnecessary refetches
  }, [normalizedCwd, refreshCount]);

  // Load git status when cwd changes
  useEffect(() => {
    if (cwd) useGitStore.getState().refresh(cwd);
  }, [cwd]);

  if (!activeSessionId) {
    return (
      <div className="sb-empty" style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)", padding: "16px 12px" }}>
        No open session
      </div>
    );
  }

  if (!cwd) {
    return (
      <div className="sb-empty">
        Loading...
      </div>
    );
  }

  const dirName = cwd.split("/").filter(Boolean).pop() ?? cwd;

  const showRootInline =
    inlineInput &&
    (inlineInput.mode === "new-file" || inlineInput.mode === "new-dir") &&
    inlineInput.parentPath === cwd;

  return (
    <div ref={treeContainerRef} tabIndex={0} className="outline-none">
      <div
        className="sb-section-header flex items-center gap-1 px-2 py-1 select-none"
        style={{ letterSpacing: "0.05em" }}
      >
        <FolderIcon open={true} />
        <span className="truncate">{dirName}</span>
      </div>
      {showRootInline && (
        <InlineInput
          depth={0}
          icon={inlineInput.mode === "new-dir" ? <FolderIcon open={false} /> : <FileIcon name={inlineValue || "file"} />}
          value={inlineValue}
          onChange={setInlineValue}
          onCommit={commitInlineInput}
          onCancel={cancelInlineInput}
          inputRef={inlineRef}
        />
      )}
      {(docsFilter ? entries.filter((e) => e.type === "file" ? isDocFile(e.name) : (docsDirCache.get(`${normalizedCwd}/${e.name}`) ?? true)) : entries).map((entry) => (
        <DirTreeNode
          key={entry.name}
          entry={entry}
          parentPath={normalizedCwd}
          depth={0}
          repoRoot={repoRoot}
          onContextMenu={handleContextMenu}
          inlineInput={inlineInput}
          inlineValue={inlineValue}
          inlineRef={inlineRef}
          setInlineValue={setInlineValue}
          commitInlineInput={commitInlineInput}
          cancelInlineInput={cancelInlineInput}
          openDirs={openDirs}
          onToggleDir={onToggleDir}
          focusedPath={focusedPath}
          onFocus={onFocusPath}
          childrenMap={childrenMap}
          docsFilter={docsFilter}
          docsDirCache={docsDirCache}
          onCheckDirDocs={handleCheckDirDocs}
        />
      ))}

      {ctxMenu && (
        <ExplorerContextMenu
          ctxMenu={ctxMenu}
          {...ctxActions}
        />
      )}

      {/* Drag ghost */}
      {drag && (
        <div
          style={{
            position: "fixed",
            left: drag.x + 12,
            top: drag.y - 10,
            zIndex: 99999,
            pointerEvents: "none",
            background: "var(--bg-overlay)",
            border: "1px solid var(--accent-blue)",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: "var(--fs-11)",
            color: "var(--text-primary)",
            opacity: 0.9,
            whiteSpace: "nowrap",
          }}
        >
          {drag.srcPath.split("/").pop()}
        </div>
      )}
    </div>
  );
}

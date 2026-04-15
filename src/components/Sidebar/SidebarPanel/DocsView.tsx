/* eslint-disable react-refresh/only-export-components -- view file mixes components and helpers */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openEditorPanel, openEditorExternalWindow } from "../../../lib/editorWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { apiGetHomeDir } from "../../../lib/bridge";
import { useSessionStore } from "../../../stores/sessionStore";
import { findPtyId } from "../../../lib/paneTreeUtils";
import { useGitT } from "../../../lib/i18n/git";
import FileTypeIcon from "../FileTypeIcon";
import { ChevronIcon, FolderIcon } from "./TreeComponents";
import type { DocTreeNode } from "./types";
import type { ContextMenuState } from "./types";

const FileIcon = FileTypeIcon;

export function buildDocTree(paths: string[], rootDir: string): DocTreeNode[] {
  const root: DocTreeNode = { name: "", fullPath: rootDir, children: [], isDir: true };

  for (const filePath of paths) {
    const normalRoot = rootDir.replace(/\\/g, "/");
    const normalFile = filePath.replace(/\\/g, "/");
    const relative = normalFile.startsWith(normalRoot + "/")
      ? normalFile.slice(normalRoot.length + 1)
      : normalFile;
    const parts = relative.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      let child = current.children.find((c) => c.name === part);
      if (!child) {
        const pathSoFar = normalRoot + "/" + parts.slice(0, i + 1).join("/");
        child = { name: part, fullPath: pathSoFar, children: [], isDir: !isLast };
        current.children.push(child);
      }
      current = child;
    }
  }

  // Sort: dirs first, then files, both alphabetical
  const sortTree = (nodes: DocTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const n of nodes) if (n.isDir) sortTree(n.children);
  };
  sortTree(root.children);
  return root.children;
}

function DocTreeItem({
  node,
  depth,
  onContextMenu,
}: {
  node: DocTreeNode;
  depth: number;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
}) {
  const [isOpen, setIsOpen] = useState(true);

  if (!node.isDir) {
    return (
      <div
        className="sb-item flex items-center gap-1 py-0.5 cursor-pointer transition-colors select-none"
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            openEditorExternalWindow(node.fullPath, true).catch(console.error);
          } else {
            openEditorPanel(node.fullPath).catch(console.error);
          }
        }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, node.fullPath, false); }}
        title={node.fullPath}
      >
        <span style={{ width: 10, flexShrink: 0 }} />
        <FileIcon name={node.name} />
        <span className="truncate">{node.name}</span>
      </div>
    );
  }

  return (
    <div>
      <div
        className="sb-item flex items-center gap-1 py-0.5 cursor-pointer transition-colors select-none"
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => setIsOpen((p) => !p)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, node.fullPath, true); }}
      >
        <ChevronIcon open={isOpen} />
        <FolderIcon open={isOpen} />
        <span className="truncate">{node.name}</span>
      </div>
      {isOpen && node.children.map((child) => (
        <DocTreeItem key={child.fullPath} node={child} depth={depth + 1} onContextMenu={onContextMenu} />
      ))}
    </div>
  );
}

/** Derive the focused pane's CWD from session store without subscribing to frequently-changing fields individually. */
export function useFocusedCwd(): string {
  return useSessionStore((s) => {
    const session = s.sessions.find((ses) => ses.id === s.activeSessionId);
    if (!session || !s.focusedPaneId) return "";
    const ptyId = findPtyId(session.rootPane, s.focusedPaneId);
    return ptyId ? s.paneCwds[ptyId] ?? "" : "";
  });
}

// DocsView disabled — re-enable when root scan issue is fixed
export function DocsViewDisabled() {
  const paneCwd = useFocusedCwd();
  const t = useGitT();
  const [homeDir, setHomeDir] = useState("");
  const [docs, setDocs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    apiGetHomeDir().then(setHomeDir).catch(() => {});
  }, [paneCwd]);

  const cwd = (paneCwd || homeDir).replaceAll("\\", "/");

  useEffect(() => {
    if (!cwd) return;
    // Skip root or very shallow paths to avoid scanning the entire filesystem
    const parts = cwd.split("/").filter(Boolean);
    if (parts.length < 2) return;
    setLoading(true);
    invoke("list_docs_recursive", { path: cwd })
      .then((result) => setDocs(result as string[]))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, [cwd]);

  const tree = useMemo(() => cwd ? buildDocTree(docs, cwd) : [], [docs, cwd]);

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

  if (loading) {
    return (
      <div className="sb-empty">
        Scanning...
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="sb-empty">
        No documents found.
      </div>
    );
  }

  const dirName = cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd;

  return (
    <div>
      <div
        className="sb-section-header flex items-center gap-1 px-2 py-1 select-none"
        style={{ letterSpacing: "0.05em" }}
      >
        <FolderIcon open={true} />
        <span className="truncate">{dirName}</span>
      </div>
      {tree.map((node) => (
        <DocTreeItem key={node.fullPath} node={node} depth={0} onContextMenu={handleContextMenu} />
      ))}

      {/* Context Menu */}
      {ctxMenu && (
        <div
          ref={(el) => {
            if (el) {
              const rect = el.getBoundingClientRect();
              if (rect.bottom > window.innerHeight) {
                el.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
              }
              if (rect.right > window.innerWidth) {
                el.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
              }
            }
          }}
          className="fixed z-[9999] py-1 rounded shadow-lg flex flex-col"
          style={{
            left: ctxMenu.x,
            top: ctxMenu.y,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            minWidth: 240,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {!ctxMenu.isDir && (
            <>
              <button
                className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
                onClick={() => { openEditorPanel(ctxMenu.path).catch(console.error); setCtxMenu(null); }}
              >
                {t("sidebar.openInPanel")}
              </button>
              <button
                className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
                onClick={() => {
                  import("../../../lib/editorWindow").then(({ openEditorExternalWindow }) =>
                    openEditorExternalWindow(ctxMenu.path, true).catch(console.error)
                  );
                  setCtxMenu(null);
                }}
              >
                <span>{t("sidebar.openInWindow")}</span><span className="sb-ctx-shortcut">Ctrl+Click</span>
              </button>
              <button
                className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
                onClick={() => { invoke("open_in_default_app", { path: ctxMenu.path }).catch(console.error); setCtxMenu(null); }}
              >
                {t("sidebar.openDefault")}
              </button>
              <div className="my-1" style={{ borderTop: "1px solid var(--border-default)" }} />
            </>
          )}
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={() => { invoke("reveal_in_file_manager", { path: ctxMenu.path }).catch(console.error); setCtxMenu(null); }}
          >
            {t("sidebar.revealInExplorer")}
          </button>
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={() => { writeText(ctxMenu.path).catch(console.error); setCtxMenu(null); }}
          >
            {t("sidebar.copyPath")}
          </button>
        </div>
      )}
    </div>
  );
}

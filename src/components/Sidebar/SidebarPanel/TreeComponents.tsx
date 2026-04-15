import { memo, useCallback, useEffect, useRef, useState } from "react";
// invoke no longer needed here — drop actions moved to ExplorerView
import { openEditorPanel, openEditorExternalWindow } from "../../../lib/editorWindow";
import { isTauri } from "../../../lib/bridge";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useGitStore } from "../../../stores/gitStore";
import GitStatusIcon, { getStatusColor } from "../GitStatusIcon";
import FileTypeIcon from "../FileTypeIcon";
import {
  CaretRight,
  Folder,
  FolderOpen,
} from "@phosphor-icons/react";
import { isDocFile, getExplorerDrag, setExplorerDrag, onExplorerDragChange } from "./constants";
import type { DirTreeProps } from "./types";

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <CaretRight
      size={14}
      weight="bold"
      style={{
        width: 'calc(14px * var(--ui-scale))',
        height: 'calc(14px * var(--ui-scale))',
        transition: "transform 120ms ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        flexShrink: 0,
        color: "var(--text-muted)",
      }}
    />
  );
}

export function FolderIcon({ open }: { open: boolean }) {
  const color = "var(--accent-yellow)";
  if (open) {
    return <FolderOpen size={15} weight="regular" color={color} style={{ width: 'calc(15px * var(--ui-scale))', height: 'calc(15px * var(--ui-scale))', flexShrink: 0, opacity: 0.8 }} />;
  }
  return <Folder size={15} weight="regular" color={color} style={{ width: 'calc(15px * var(--ui-scale))', height: 'calc(15px * var(--ui-scale))', flexShrink: 0, opacity: 0.8 }} />;
}

export const FileIcon = FileTypeIcon;

export function InlineInput({
  depth,
  icon,
  value,
  onChange,
  onCommit,
  onCancel,
  inputRef,
}: {
  depth: number;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      className="flex items-center gap-1 py-0.5"
      style={{
        paddingLeft: depth * 12 + 4 + 10,
        fontSize: 'var(--fs-12)',
      }}
    >
      {icon}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onBlur={onCommit}
        style={{
          flex: 1,
          background: "var(--bg-input)",
          color: "var(--text-primary)",
          border: "1px solid var(--accent-blue)",
          borderRadius: 2,
          padding: "0 4px",
          fontSize: 'var(--fs-12)',
          outline: "none",
          minWidth: 0,
        }}
        autoFocus
      />
    </div>
  );
}

export const DirTreeNode = memo(function DirTreeNode({
  entry, parentPath, depth, repoRoot, onContextMenu,
  inlineInput, inlineValue, inlineRef, setInlineValue, commitInlineInput, cancelInlineInput,
  openDirs, onToggleDir, focusedPath, onFocus, childrenMap, docsFilter, docsDirCache, onCheckDirDocs,
}: DirTreeProps) {
  const isDir = entry.type === "dir";
  const fullPath = `${parentPath}/${entry.name}`;
  const isOpen = openDirs.has(fullPath);
  const children = childrenMap.get(fullPath) ?? null;

  const statusMap = useGitStore((s) => s.statusMap);
  const folderStatusMap = useGitStore((s) => s.folderStatusMap);
  const singleClickOpen = useSettingsStore((s) => s.singleClickOpen);

  // When docsFilter is active and children are loaded, check subdirs for docs
  useEffect(() => {
    if (!docsFilter || !isDir || !isOpen || !children || !onCheckDirDocs) return;
    const unchecked = children.filter((c) => c.type === "dir" && !docsDirCache?.has(`${fullPath}/${c.name}`)).map((c) => `${fullPath}/${c.name}`);
    if (unchecked.length > 0) onCheckDirDocs(unchecked);
  }, [docsFilter, isDir, isOpen, children, fullPath, docsDirCache, onCheckDirDocs]);

  const relativePath = repoRoot ? fullPath.replace(repoRoot + "/", "") : "";
  const gitStatus = isDir
    ? folderStatusMap[relativePath]
    : statusMap[relativePath];
  const statusColor = getStatusColor(gitStatus);

  const handleOpenFile = useCallback(() => {
    if (!isDir && isTauri()) {
      openEditorPanel(fullPath).catch(console.error);
    }
  }, [isDir, fullPath]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    onFocus(fullPath);
    if (isDir) {
      onToggleDir(fullPath);
    } else if (e.ctrlKey || e.metaKey) {
      openEditorExternalWindow(fullPath, true).catch(console.error);
    } else if (singleClickOpen) {
      handleOpenFile();
    }
  }, [isDir, fullPath, singleClickOpen, handleOpenFile, onToggleDir, onFocus]);

  const isRenaming =
    inlineInput?.mode === "rename" &&
    inlineInput.parentPath === parentPath &&
    inlineInput.originalName === entry.name;

  const showInlineChild =
    isDir && isOpen && inlineInput &&
    (inlineInput.mode === "new-file" || inlineInput.mode === "new-dir") &&
    inlineInput.parentPath === fullPath;

  const isFocused = focusedPath === fullPath;
  const nodeRef = useRef<HTMLDivElement>(null);

  // ── Pointer-based drag (source) ──
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    pointerStart.current = { x: e.clientX, y: e.clientY };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!pointerStart.current) return;
      const dx = e.clientX - pointerStart.current.x;
      const dy = e.clientY - pointerStart.current.y;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      // threshold exceeded → start drag
      pointerStart.current = null;
      setExplorerDrag({ srcPath: fullPath, srcIsDir: isDir, x: e.clientX, y: e.clientY });
    };
    const onUp = () => { pointerStart.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [fullPath, isDir]);

  // ── Drop target highlight (folders only) ──
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!isDir) return;
    return onExplorerDragChange(() => {
      const drag = getExplorerDrag();
      if (!drag || !nodeRef.current) { setDragOver(false); return; }
      const rect = nodeRef.current.getBoundingClientRect();
      const over = drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom;
      setDragOver(over && drag.srcPath !== fullPath);
    });
  }, [isDir, fullPath]);

  return (
    <div>
      {isRenaming ? (
        <InlineInput
          depth={depth}
          icon={isDir ? <FolderIcon open={false} /> : <FileIcon name={inlineValue || entry.name} />}
          value={inlineValue}
          onChange={setInlineValue}
          onCommit={commitInlineInput}
          onCancel={cancelInlineInput}
          inputRef={inlineRef}
        />
      ) : (
        <div
          ref={nodeRef}
          className="sb-item flex items-center gap-1 py-0.5 cursor-pointer transition-colors select-none"
          data-tree-path={fullPath}
          data-is-dir={isDir ? "1" : undefined}
          onPointerDown={handlePointerDown}
          style={{
            paddingLeft: depth * 12 + 4,
            background: dragOver ? "color-mix(in srgb, var(--accent-blue) 15%, transparent)" : isFocused ? "var(--bg-overlay)" : undefined,
            borderTop: dragOver ? "1px solid var(--accent-blue)" : "1px solid transparent",
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu(e, fullPath, isDir);
          }}
          onClick={handleClick}
          onDoubleClick={!isDir && !singleClickOpen ? handleOpenFile : undefined}
        >
          {isDir ? (
            <>
              <ChevronIcon open={isOpen} />
              <FolderIcon open={isOpen} />
            </>
          ) : (
            <>
              <span style={{ width: 10, flexShrink: 0 }} />
              <FileIcon name={entry.name} />
            </>
          )}
          <span className="truncate" style={statusColor ? { color: statusColor } : undefined}>{entry.name}</span>
          <GitStatusIcon status={gitStatus} />
        </div>
      )}
      {isDir && isOpen && (
        <div>
          {showInlineChild && (
            <InlineInput
              depth={depth + 1}
              icon={inlineInput.mode === "new-dir" ? <FolderIcon open={false} /> : <FileIcon name={inlineValue || "file"} />}
              value={inlineValue}
              onChange={setInlineValue}
              onCommit={commitInlineInput}
              onCancel={cancelInlineInput}
              inputRef={inlineRef}
            />
          )}
          {(docsFilter ? children?.filter((c) => c.type === "file" ? isDocFile(c.name) : (docsDirCache?.get(`${fullPath}/${c.name}`) ?? true)) : children)?.map((child) => (
            <DirTreeNode
              key={child.name}
              entry={child}
              parentPath={fullPath}
              depth={depth + 1}
              repoRoot={repoRoot}
              onContextMenu={onContextMenu}
              inlineInput={inlineInput}
              inlineValue={inlineValue}
              inlineRef={inlineRef}
              setInlineValue={setInlineValue}
              commitInlineInput={commitInlineInput}
              cancelInlineInput={cancelInlineInput}
              openDirs={openDirs}
              onToggleDir={onToggleDir}
              focusedPath={focusedPath}
              onFocus={onFocus}
              childrenMap={childrenMap}
              docsFilter={docsFilter}
              docsDirCache={docsDirCache}
              onCheckDirDocs={onCheckDirDocs}
            />
          ))}
        </div>
      )}
    </div>
  );
});

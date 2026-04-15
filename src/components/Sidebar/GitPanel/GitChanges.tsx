import { useEffect, useState } from "react";
import {
  Plus,
  Minus,
  CheckCircle,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useGitStore } from "../../../stores/gitStore";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useGitT } from "../../../lib/i18n/git";
import { openDiffWindow } from "../../../lib/diffWindow";
import { usePanelEditorStore } from "../../../stores/panelEditorStore";
import type { GitStatusEntry } from "../../../types/git";
import { SectionHeader, FileEntry, IconButton } from "./shared";
import CommitForm from "./CommitForm";

export default function GitChanges({ cwd, onDiffOpen }: { cwd: string; onDiffOpen: (path: string, staged: boolean) => void }) {
  const t = useGitT();
  const { fileStatuses, repoInfo, unpushedCommits } = useGitStore(
    useShallow((s) => ({
      fileStatuses: s.fileStatuses,
      repoInfo: s.repoInfo,
      unpushedCommits: s.unpushedCommits,
    }))
  );
  const { stageFile, unstageFile, stageAll, unstageAll, discardFile, addToGitignore } = useGitStore.getState();

  const singleClickOpen = useSettingsStore((s) => s.singleClickOpen);
  const [changesOpen, setChangesOpen] = useState(true);
  const [commitMsg, setCommitMsg] = useState("");
  const { openDiffTab } = usePanelEditorStore.getState();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: GitStatusEntry } | null>(null);
  const [discardedFiles, setDiscardedFiles] = useState<string[]>([]);
  const [discardedOpen, setDiscardedOpen] = useState(true);

  // Load discarded file list from cache
  useEffect(() => {
    if (!cwd || !fileStatuses) return;
    invoke<string>("load_discard_cache", { path: cwd })
      .then((json) => {
        try {
          const data = JSON.parse(json) as Record<string, unknown>;
          const files = [...new Set(Object.keys(data).map((k) => k.replace(/:true$|:false$/, "")))];
          setDiscardedFiles(files);
        } catch { setDiscardedFiles([]); }
      })
      .catch(() => setDiscardedFiles([]));
  }, [cwd, fileStatuses]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    window.addEventListener("contextmenu", handleClick, { capture: true });
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("contextmenu", handleClick, { capture: true });
    };
  }, [contextMenu]);

  if (!fileStatuses) return null;

  const { staged, unstaged, untracked } = fileStatuses;
  const allChanges = [...staged, ...unstaged, ...untracked];
  const ahead = repoInfo?.ahead ?? 0;
  const behind = repoInfo?.behind ?? 0;

  const hasChanges = allChanges.length > 0;

  return (
    <div>
      {/* Commit box — pinned at top */}
      <CommitForm
        cwd={cwd}
        staged={staged}
        allChanges={allChanges}
        hasChanges={hasChanges}
        ahead={ahead}
        behind={behind}
        unpushedCommits={unpushedCommits}
        commitMsg={commitMsg}
        setCommitMsg={setCommitMsg}
        onCommitSuccess={() => setDiscardedFiles([])}
      />

      {!hasChanges && ahead === 0 && behind === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 select-none" style={{ padding: "32px 0", color: "var(--text-muted)" }}>
          <CheckCircle size={28} weight="thin" style={{ opacity: 0.4 }} />
          <span style={{ fontSize: 'var(--fs-11)' }}>{t("git.noChanges")}</span>
        </div>
      )}
      {hasChanges && (
        <>
          <SectionHeader
            label={t("git.changes")}
            count={allChanges.length}
            open={changesOpen}
            onToggle={() => setChangesOpen((p) => !p)}
            actions={
              <>
                <IconButton onClick={() => stageAll(cwd)} title={t("git.stageAll")}>
                  <Plus size={13} style={{ width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))' }} />
                </IconButton>
                {staged.length > 0 && (
                  <IconButton onClick={() => unstageAll(cwd)} title={t("git.unstageAll")}>
                    <Minus size={13} style={{ width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))' }} />
                  </IconButton>
                )}
              </>
            }
          />
          {changesOpen &&
            allChanges.map((e) => (
              <FileEntry
                key={`${e.staged ? "s" : "u"}-${e.path}`}
                entry={e}
                onAction={
                  e.staged
                    ? () => unstageFile(cwd, e.path)
                    : () => stageFile(cwd, e.path)
                }
                onSecondary={
                  !e.staged && e.status !== "untracked" && e.status !== "conflicted"
                    ? () => discardFile(cwd, e.path)
                    : undefined
                }
                onDiff={() => onDiffOpen(e.path, e.staged)}
                onClick={(ev) => {
                  if (ev.ctrlKey || ev.metaKey) {
                    openDiffWindow(cwd, e.path, e.staged);
                  } else if (singleClickOpen) {
                    onDiffOpen(e.path, e.staged);
                  }
                }}
                onDoubleClick={() => {
                  if (!singleClickOpen) onDiffOpen(e.path, e.staged);
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  setContextMenu({ x: ev.clientX, y: ev.clientY, entry: e });
                }}
              />
            ))}
        </>
      )}

      {/* Discarded files section */}
      {discardedFiles.length > 0 && (
        <>
          <SectionHeader
            label={t("git.discarded") ?? "Discarded"}
            count={discardedFiles.length}
            open={discardedOpen}
            onToggle={() => setDiscardedOpen((p) => !p)}
          />
          {discardedOpen &&
            discardedFiles.map((fp) => (
              <FileEntry
                key={`discarded-${fp}`}
                entry={{ path: fp, status: "discarded", staged: false }}
                onDiff={() => onDiffOpen(fp, false)}
                onClick={() => {
                  if (singleClickOpen) onDiffOpen(fp, false);
                }}
                onDoubleClick={() => {
                  if (!singleClickOpen) onDiffOpen(fp, false);
                }}
              />
            ))}
        </>
      )}

      {/* File context menu */}
      {contextMenu && (
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
            left: contextMenu.x,
            top: contextMenu.y,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            minWidth: 240,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Stage / Unstage */}
          {contextMenu.entry.staged ? (
            <button
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              onClick={() => { unstageFile(cwd, contextMenu.entry.path); setContextMenu(null); }}
            >
              {t("ctx.unstageFile")}
            </button>
          ) : (
            <button
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              onClick={() => { stageFile(cwd, contextMenu.entry.path); setContextMenu(null); }}
            >
              {t("ctx.stageFile")}
            </button>
          )}
          {!contextMenu.entry.staged && contextMenu.entry.status !== "untracked" && contextMenu.entry.status !== "conflicted" && (
            <button
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              style={{ color: "var(--accent-red)" }}
              onClick={() => { discardFile(cwd, contextMenu.entry.path); setContextMenu(null); }}
            >
              {t("ctx.discardChanges")}
            </button>
          )}
          {contextMenu.entry.status !== "untracked" && (<>
            <button
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              onClick={() => { openDiffTab(cwd, contextMenu.entry.path, contextMenu.entry.staged); setContextMenu(null); }}
            >
              {t("ctx.diffPanel")}
            </button>
            <button
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              onClick={() => { onDiffOpen(contextMenu.entry.path, contextMenu.entry.staged); setContextMenu(null); }}
            >
              {t("ctx.diffPopup")}
            </button>
            <button
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              onClick={() => { openDiffWindow(cwd, contextMenu.entry.path, contextMenu.entry.staged).catch(console.error); setContextMenu(null); }}
            >
              <span>{t("ctx.diffWindow")}</span><span className="sb-ctx-shortcut">Ctrl+Click</span>
            </button>
          </>)}
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={() => { addToGitignore(cwd, contextMenu.entry.path); setContextMenu(null); }}
          >
            {t("ctx.addGitignore")}
          </button>
          <div className="my-1" style={{ borderTop: "1px solid var(--border-default)" }} />
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={() => {
              const fullPath = cwd.endsWith("/") ? cwd + contextMenu.entry.path : cwd + "/" + contextMenu.entry.path;
              invoke("open_in_default_app", { path: fullPath }).catch(console.error);
              setContextMenu(null);
            }}
          >
            {t("ctx.openEditor")}
          </button>
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={() => {
              const fullPath = cwd.endsWith("/") ? cwd + contextMenu.entry.path : cwd + "/" + contextMenu.entry.path;
              invoke("reveal_in_file_manager", { path: fullPath }).catch(console.error);
              setContextMenu(null);
            }}
          >
            {t("ctx.revealExplorer")}
          </button>
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={() => {
              const fullPath = cwd.endsWith("/") ? cwd + contextMenu.entry.path : cwd + "/" + contextMenu.entry.path;
              writeText(fullPath).catch(console.error);
              setContextMenu(null);
            }}
          >
            {t("ctx.copyPath")}
          </button>
        </div>
      )}
    </div>
  );
}

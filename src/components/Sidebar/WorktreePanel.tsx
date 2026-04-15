import { useCallback, useState, useEffect, useRef } from "react";
import {
  Plus,
  ArrowClockwise,
  ArrowSquareIn,
  Scissors,
  ArrowCounterClockwise,
  Trash,
  DotsThreeVertical,
  Lock,
  LockOpen,
  FolderOpen,
  GitBranch,
  Star,
  Broom,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { findPtyId, firstLeafId, collectLeafCwds } from "../../lib/paneTreeUtils";
import { getDefaultTerminalSize } from "../../lib/terminalUtils";
import type { GitWorktreeEntry } from "../../types/git";
import type { Session } from "../../types/session";
import { useGitT } from "../../lib/i18n/git";
import { logger } from "../../lib/logger";
import { useDialogStore } from "../../stores/dialogStore";

function useCwd(): string {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const focusedPaneId = useSessionStore((s) => s.focusedPaneId);
  const paneCwds = useSessionStore((s) => s.paneCwds);

  const session = sessions.find((s) => s.id === activeSessionId);
  let paneCwd = "";
  if (session && focusedPaneId) {
    const ptyId = findPtyId(session.rootPane, focusedPaneId);
    if (ptyId) paneCwd = paneCwds[ptyId] ?? "";
  }
  return paneCwd;
}

function useWriteToPty() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const focusedPaneId = useSessionStore((s) => s.focusedPaneId);

  return useCallback(
    (text: string) => {
      const session = sessions.find((s) => s.id === activeSessionId);
      if (!session || !focusedPaneId) return;
      const ptyId = findPtyId(session.rootPane, focusedPaneId);
      if (ptyId) {
        const encoder = new TextEncoder();
        const data = Array.from(encoder.encode(text));
        invoke("write_to_pty", { paneId: ptyId, data }).catch(logger.error);
      }
    },
    [sessions, activeSessionId, focusedPaneId],
  );
}

function WorktreeContextMenu({
  x,
  y,
  wt,
  cwd,
  onClose,
  onLockToggle,
  onRemove,
}: {
  x: number;
  y: number;
  wt: GitWorktreeEntry;
  cwd: string;
  onClose: () => void;
  onLockToggle: () => void;
  onRemove: () => void;
}) {
  const { openActionModal } = useWorktreeStore();
  const t = useGitT();
  useEffect(() => {
    window.addEventListener("click", onClose);
    window.addEventListener("contextmenu", onClose, { capture: true });
    return () => {
      window.removeEventListener("click", onClose);
      window.removeEventListener("contextmenu", onClose, { capture: true });
    };
  }, [onClose]);
  return (
    <>
      <div
        className="fixed z-[9999] py-1 rounded shadow-lg flex flex-col"
        style={{
          left: x,
          top: y,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          minWidth: 240,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {wt.isMain ? (
          <>
            <button
              onClick={() => {
                const { openAddModal } = useWorktreeStore.getState();
                openAddModal(cwd);
                onClose();
              }}
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            >
              <span>{t("wt.addWorktreeMenu")}</span>
              <Plus size={16} />
            </button>
            <button
              onClick={() => {
                const { prune } = useWorktreeStore.getState();
                prune(cwd);
                onClose();
              }}
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            >
              <span>{t("wt.pruneWorktrees")}</span>
              <Broom size={16} />
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => { openActionModal(cwd, 'sync', wt); onClose(); }}
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            >
              <span>{t("wt.syncFromBase")}</span>
              <ArrowClockwise size={16} />
            </button>
            <button
              onClick={() => { openActionModal(cwd, 'apply', wt); onClose(); }}
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            >
              <span>{t("wt.applyToBranch")}</span>
              <ArrowSquareIn size={16} />
            </button>
            <button
              onClick={() => { openActionModal(cwd, 'cherrypick', wt); onClose(); }}
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            >
              <span>{t("wtAction.cherryPick")}</span>
              <Scissors size={16} />
            </button>
            <button
              onClick={() => { openActionModal(cwd, 'reset', wt); onClose(); }}
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            >
              <span>{t("wtAction.reset")}</span>
              <ArrowCounterClockwise size={16} />
            </button>
          </>
        )}
        {!wt.isMain && (
          <>
            <button
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              onClick={() => { onLockToggle(); onClose(); }}
            >
              {wt.isLocked ? t("wt.unlock") : t("wt.lock")}
              {wt.isLocked ? <LockOpen size={16} /> : <Lock size={16} />}
            </button>
            <button
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              style={{ color: "var(--accent-red)" }}
              onClick={() => { onRemove(); onClose(); }}
            >
              {t("wt.remove")}
              <Trash size={16} />
            </button>
          </>
        )}
      </div>
    </>
  );
}

function WorktreeItem({
  entry,
  isCurrent,
  onNavigate,
  onContextMenu,
  conflictState,
  onAbortConflict,
  onContinue,
}: {
  entry: GitWorktreeEntry;
  isCurrent: boolean;
  onRemove: () => void;
  onNavigate: () => void;
  onContextMenu: (e: React.MouseEvent, wt: GitWorktreeEntry) => void;
  conflictState: 'sync' | 'apply' | null;
  onAbortConflict: () => void;
  onContinue: () => void;
}) {
  const t = useGitT();
  const dirName = entry.path.split(/[\\/]/).pop() ?? entry.path;

  return (
    <div
      className="flex items-center gap-1.5 py-0.5 cursor-pointer group select-none"
      style={{
        fontSize: 'var(--fs-12)',
        paddingLeft: 8,
        paddingRight: 6,
        userSelect: "none",
        background: "transparent",
      }}
      onClick={onNavigate}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, entry);
      }}
      title={entry.path}
    >
      <FolderOpen
        size={14}
        style={{ color: "var(--accent-yellow)", opacity: 0.8 }}
      />
      <span
        className="truncate flex-1"
        style={{
          color: isCurrent ? "var(--text-primary)" : "var(--text-secondary)",
          fontWeight: 600,
        }}
      >
        {dirName}
        {entry.isDirty && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--accent-orange)",
              marginLeft: 4,
              display: "inline-block",
            }}
            title={t("wt.changesDetected")}
          />
        )}
      </span>
      <span className="flex items-center gap-1 shrink-0">
        {conflictState && (
          <span
            className="flex items-center gap-1 px-1 rounded"
            style={{ background: "var(--accent-red)", color: "var(--bg-base)", fontSize: 'var(--fs-9)', fontWeight: 700 }}
          >
            {t("wt.conflict")}
          </span>
        )}
        {entry.isLocked && (
          <Lock size={11} style={{ color: "var(--accent-orange)" }} />
        )}
        <GitBranch size={11} className="sb-muted" />
        <span className="sb-muted" style={{ fontSize: 'var(--fs-11)' }}>
          {entry.branch || t("wt.noBranch")}
        </span>
        {entry.isMain && (
          <Star size={10} weight="fill" style={{ color: "var(--accent-yellow)" }} />
        )}
      </span>

      <div className="flex items-center gap-1 shrink-0 ml-1">
        {conflictState ? (
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); onAbortConflict(); }}
              className="p-1 rounded hover:bg-white/10 text-[var(--accent-red)]"
            >
              <Trash size={12} weight="bold" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onContinue(); }}
              className="p-1 rounded hover:bg-white/10 text-[var(--accent-green)]"
            >
              <ArrowClockwise size={12} weight="bold" />
            </button>
          </div>
        ) : (
          <button
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/10 text-[var(--text-muted)]"
            onClick={(e) => { e.stopPropagation(); onContextMenu(e, entry); }}
          >
            <DotsThreeVertical size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function RemoveWorktreeConfirm({
  entry,
  onConfirm,
  onCancel,
  isRemoving,
}: {
  entry: GitWorktreeEntry;
  onConfirm: (deleteBranch: boolean, deleteFolder: boolean) => void;
  onCancel: () => void;
  isRemoving: boolean;
}) {
  const t = useGitT();
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [deleteFolder, setDeleteFolder] = useState(true);

  return (
    <div className="mx-2 my-1 p-2 rounded flex flex-col gap-2" style={{ backgroundColor: "color-mix(in srgb, var(--accent-red) 5%, transparent)", border: "1px solid color-mix(in srgb, var(--accent-red) 10%, transparent)" }}>
      <div style={{ fontSize: 'var(--fs-11)', fontWeight: 600, color: "var(--text-primary)" }}>
        {t("wt.removeConfirm")}
      </div>
      {entry.branch && (
        <div className="truncate" style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)", fontFamily: "var(--font-mono, monospace)" }}>
          {entry.branch}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={deleteBranch} disabled={isRemoving} onChange={e => setDeleteBranch(e.target.checked)} />
          <span style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)" }}>{t("wt.deleteBranch")}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={deleteFolder} disabled={isRemoving} onChange={e => setDeleteFolder(e.target.checked)} />
          <span style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)" }}>{t("wt.deleteFolder")}</span>
        </label>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(deleteBranch, deleteFolder)}
          disabled={isRemoving}
          className="flex-1 py-1 rounded bg-transparent text-[var(--fs-11)] font-semibold disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          style={{ border: "1px solid var(--accent-red)", color: "var(--accent-red)" }}
        >
          {isRemoving && (
            <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          {t("wt.remove")}
        </button>
        <button onClick={onCancel} disabled={isRemoving} className="flex-1 py-1 rounded text-[var(--fs-11)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed" style={{ backgroundColor: "var(--bg-hover)", color: "var(--text-primary)" }}>{t("wt.cancel")}</button>
      </div>
    </div>
  );
}

export default function WorktreePanel() {
  const cwd = useCwd();
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const refresh = useWorktreeStore((s) => s.refresh);
  const remove = useWorktreeStore((s) => s.remove);
  const lock = useWorktreeStore((s) => s.lock);
  const unlock = useWorktreeStore((s) => s.unlock);

  const t = useGitT();
  const sendToPty = useWriteToPty();

  const [confirmingRemove, setConfirmingRemove] = useState<GitWorktreeEntry | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  // 동기 재진입 가드 — state 업데이트 지연 사이 더블 클릭 차단
  const isRemovingRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, wt: GitWorktreeEntry } | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, 'sync' | 'apply' | null>>({});

  useEffect(() => {
    if (!cwd) return;
    const timer = setTimeout(() => refresh(cwd), 200);
    return () => clearTimeout(timer);
  }, [cwd, refresh]);

  const handleRemove = async (wt: GitWorktreeEntry, deleteBranch: boolean, deleteFolder: boolean) => {
    if (isRemovingRef.current) return;
    isRemovingRef.current = true;
    const mainWorktree = worktrees.find(w => w.isMain);
    const repoRoot = mainWorktree?.path || cwd;

    setIsRemoving(true);
    try {
      // 재시도 없이 한 번만 시도. 실패하면 즉시 throw → 사용자에게 알림.
      if (deleteFolder) {
        await remove(repoRoot, wt.path, false);
      }

      if (deleteBranch && wt.branch) {
        await invoke("git_delete_branch", { path: repoRoot, branch: wt.branch });
      }

      // 삭제 성공 시, 해당 워크트리 폴더에 "현재 위치한" 탭(세션)도 같이 닫는다.
      // 기준은 paneCwds(라이브 cwd) — 사용자가 shell 에서 `cd` 해서 들어간 경우도 잡기 위함.
      if (deleteFolder) {
        const normalizedWtPath = wt.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const { sessions, paneCwds, removeSession, setFocusedPane } = useSessionStore.getState();
        const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const isInside = (p: string) => {
          const n = norm(p);
          return n === normalizedWtPath || n.startsWith(normalizedWtPath + "/");
        };
        const sessionsToClose = sessions.filter((s) => {
          const leaves = collectLeafCwds(s.rootPane);
          return leaves.some(({ ptyId, cwd: initialCwd }) => {
            // 라이브 cwd 가 있으면 그걸, 없으면 생성 당시 cwd 로 폴백
            const live = paneCwds[ptyId];
            return isInside(live ?? initialCwd);
          });
        });
        for (const s of sessionsToClose) {
          removeSession(s.id);
          if (!s.isRemote) {
            invoke("close_session", { sessionId: s.id }).catch(logger.error);
          }
        }
        // 삭제 후 새 활성 세션의 leaf 로 focus 이동 — 그래야 useCwd 가 복구되어
        // 사이드바(Git 패널 등)가 "활성 터미널 없음"으로 굳지 않는다.
        if (sessionsToClose.length > 0) {
          const after = useSessionStore.getState();
          const newActive = after.sessions.find((s) => s.id === after.activeSessionId);
          if (newActive) setFocusedPane(firstLeafId(newActive.rootPane));
        }
      }

      // 성공 시에만 확인 패널 닫기
      setConfirmingRemove(null);
    } catch (e) {
      logger.error("Failed to remove worktree:", e);
      // 실패 시 확인 패널도 닫고 글로벌 에러 다이얼로그로 알림
      const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
      setConfirmingRemove(null);
      useDialogStore.getState().show({
        title: t("wt.remove"),
        message: msg,
        type: "error",
      });
    } finally {
      isRemovingRef.current = false;
      setIsRemoving(false);
    }
  };

  const handleNavigate = async (wt: GitWorktreeEntry) => {
    const { sessions, setActiveSession, setFocusedPane, addSession } = useSessionStore.getState();
    const dirName = wt.path.split(/[\\/]/).pop() ?? wt.path;

    const existingSession = sessions.find((s) => s.name === dirName);
    if (existingSession) {
      setActiveSession(existingSession.id);
      setFocusedPane(firstLeafId(existingSession.rootPane));
      return;
    }

    const shell = useSettingsStore.getState().defaultShell;
    const { rows, cols } = getDefaultTerminalSize();

    try {
      const session = await invoke<Session>("create_session", { name: dirName, workingDir: wt.path, shell, rows, cols });
      addSession(session);
      setFocusedPane(firstLeafId(session.rootPane));
    } catch (e) {
      logger.error("Failed to create session:", e);
      sendToPty(`cd "${wt.path}"\n`);
    }
  };

  const handleLockToggle = async (wt: GitWorktreeEntry) => {
    const mainWorktree = worktrees.find(w => w.isMain);
    const repoRoot = mainWorktree?.path || cwd;
    if (wt.isLocked) {
      await unlock(repoRoot, wt.path);
    } else {
      await lock(repoRoot, wt.path, "Locked via Racemo");
    }
  };

  const handleAbort = async (wt: GitWorktreeEntry) => {
    const state = conflicts[wt.path];
    if (state === 'sync') sendToPty(`git rebase --abort\n`);
    else if (state === 'apply') sendToPty(`git merge --abort\n`);
    setConflicts(prev => ({ ...prev, [wt.path]: null }));
    refresh(cwd);
  };

  if (!cwd) return <div className="sb-empty px-3 py-2">{t("git.noTerminal")}</div>;

  return (
    <div className="flex flex-col h-full bg-[var(--bg-base)]">
      <div className="flex-1 overflow-y-auto">
        {worktrees.map((wt) => (
          <WorktreeItem
            key={wt.path}
            entry={wt}
            isCurrent={cwd.replace(/\\/g, "/").toLowerCase().startsWith(wt.path.replace(/\\/g, "/").toLowerCase())}
            onRemove={() => setConfirmingRemove(wt)}
            onNavigate={() => handleNavigate(wt)}
            onContextMenu={(e, wt) => setContextMenu({ x: e.clientX, y: e.clientY, wt })}
            conflictState={conflicts[wt.path]}
            onAbortConflict={() => handleAbort(wt)}
            onContinue={() => {
              const { sync, apply } = useWorktreeStore.getState();
              const mainWorktree = worktrees.find(w => w.isMain);
              const repoRoot = mainWorktree?.path || cwd;
              const mode = conflicts[wt.path];
              if (mode === 'sync') sync(repoRoot, wt.path, "main", true).catch(e => logger.error(e));
              else if (mode === 'apply') apply(repoRoot, wt.path, "main", false).catch(e => logger.error(e));
            }}
          />
        ))}

        {confirmingRemove && (
          <RemoveWorktreeConfirm
            entry={confirmingRemove}
            onConfirm={(delBranch, delFolder) => handleRemove(confirmingRemove, delBranch, delFolder)}
            onCancel={() => setConfirmingRemove(null)}
            isRemoving={isRemoving}
          />
        )}
      </div>

      {contextMenu && (
        <WorktreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          wt={contextMenu.wt}
          cwd={cwd}
          onClose={() => setContextMenu(null)}
          onLockToggle={() => { handleLockToggle(contextMenu.wt); setContextMenu(null); }}
          onRemove={() => { setConfirmingRemove(contextMenu.wt); setContextMenu(null); }}
        />
      )}
    </div>
  );
}

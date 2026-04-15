import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { apiGetGitRepoInfo, apiGetGitFileStatuses, apiGitAction, apiGitCommitLog } from "../lib/bridge";
import { logger } from "../lib/logger";
import type {
  GitRepoInfo,
  GitFileStatuses,
  GitCommitEntry,
  GitFileStatus,
} from "../types/git";

/** Increments on every refresh call — lets us discard stale async results. */
let _refreshGen = 0;

/** Per-cwd snapshot cache for stale-while-revalidate. */
interface GitSnapshot {
  repoInfo: GitRepoInfo;
  fileStatuses: GitFileStatuses;
  statusMap: Record<string, GitFileStatus>;
  folderStatusMap: Record<string, GitFileStatus>;
  unpushedCommits: string[];
}
const _cache = new Map<string, GitSnapshot>();
/** git 저장소가 아닌 것으로 확인된 디렉토리 캐시 */
const _noRepoCache = new Set<string>();

export function hasCachedGitData(cwd: string): boolean {
  return _cache.has(cwd) || _noRepoCache.has(cwd);
}

/** Priority order for folder status aggregation (higher index = higher priority). */
const STATUS_PRIORITY: Record<GitFileStatus, number> = {
  untracked: 0,
  deleted: 1,
  added: 2,
  renamed: 2,
  modified: 3,
  conflicted: 4,
  discarded: 0,
};

function higherPriority(a: GitFileStatus, b: GitFileStatus): GitFileStatus {
  return STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b;
}

interface GitState {
  repoInfo: GitRepoInfo | null;
  fileStatuses: GitFileStatuses | null;
  commitLog: GitCommitEntry[];
  isLoading: boolean;
  error: string | null;
  /** file relative path → status (merged across staged/unstaged/untracked) */
  statusMap: Record<string, GitFileStatus>;
  /** folder path → aggregated status */
  folderStatusMap: Record<string, GitFileStatus>;
  /** Last refreshed git root — avoids redundant refreshes. */
  _lastRoot: string | null;

  refresh: (cwd: string) => Promise<void>;
  refreshIfNeeded: (cwd: string) => Promise<void>;
  loadCommitLog: (cwd: string) => Promise<void>;
  stageFile: (cwd: string, filePath: string) => Promise<void>;
  unstageFile: (cwd: string, filePath: string) => Promise<void>;
  stageAll: (cwd: string) => Promise<void>;
  unstageAll: (cwd: string) => Promise<void>;
  commit: (cwd: string, message: string) => Promise<void>;
  push: (cwd: string) => Promise<void>;
  pull: (cwd: string) => Promise<void>;
  stashPull: (cwd: string) => Promise<void>;
  stashRebasePull: (cwd: string) => Promise<void>;
  discardFile: (cwd: string, filePath: string) => Promise<void>;
  addToGitignore: (cwd: string, pattern: string) => Promise<void>;
  resolveOurs: (cwd: string, filePath: string) => Promise<void>;
  resolveTheirs: (cwd: string, filePath: string) => Promise<void>;
  mergeAbort: (cwd: string) => Promise<void>;

  /** Unpushed commit summaries for push tooltip */
  unpushedCommits: string[];

  /** Pull conflict state */
  pullConflictFiles: string[];
  pullConflictCwd: string | null;
  setPullConflict: (cwd: string, files: string[]) => void;
  clearPullConflict: () => void;
}

function buildMaps(statuses: GitFileStatuses) {
  const statusMap: Record<string, GitFileStatus> = {};
  const folderStatusMap: Record<string, GitFileStatus> = {};

  const processEntry = (path: string, status: GitFileStatus) => {
    // File-level: keep highest priority
    const existing = statusMap[path];
    statusMap[path] = existing ? higherPriority(existing, status) : status;

    // Propagate to parent folders
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      const prev = folderStatusMap[folder];
      folderStatusMap[folder] = prev ? higherPriority(prev, status) : status;
    }
  };

  for (const e of statuses.staged) processEntry(e.path, e.status);
  for (const e of statuses.unstaged) processEntry(e.path, e.status);
  for (const e of statuses.untracked) processEntry(e.path, e.status);

  return { statusMap, folderStatusMap };
}

// ── Centralized git background sync ──
let _bgTimer: ReturnType<typeof setInterval> | null = null;
const BG_POLL_INTERVAL = 5_000;

/**
 * Start background git sync — refreshes the active session's cwd every 5s.
 * Uses getCwd callback so it always refreshes the *current* cwd, not a stale one.
 */
export function startGitBackgroundSync(getCwd: () => string) {
  stopGitBackgroundSync();
  _bgTimer = setInterval(() => {
    const cwd = getCwd();
    if (cwd) useGitStore.getState().refresh(cwd);
  }, BG_POLL_INTERVAL);
}

export function stopGitBackgroundSync() {
  if (_bgTimer) { clearInterval(_bgTimer); _bgTimer = null; }
}

/**
 * Initial startup: refresh git status for all unique repo roots.
 * Returns progress callback. Used with progress bar on app init.
 */
export async function refreshAllGitStatus(
  cwds: string[],
  onProgress?: (done: number, total: number) => void,
) {
  // Deduplicate by repo root from cache, fallback to cwd itself
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const cwd of cwds) {
    const cached = _cache.get(cwd);
    const key = cached ? cached.repoInfo.root : cwd;
    if (!seen.has(key)) { seen.add(key); unique.push(cwd); }
  }
  const total = unique.length;
  let done = 0;
  for (const cwd of unique) {
    await useGitStore.getState().refresh(cwd);
    done++;
    onProgress?.(done, total);
  }
}

// Legacy exports — kept for compatibility but prefer background sync
export function startGitPolling(cwd: string) {
  startGitBackgroundSync(() => cwd);
}
export function stopGitPolling() {
  stopGitBackgroundSync();
}

export const useGitStore = create<GitState>()((set, get) => ({
  repoInfo: null,
  fileStatuses: null,
  commitLog: [],
  isLoading: false,
  error: null,
  statusMap: {},
  folderStatusMap: {},
  unpushedCommits: [],
  _lastRoot: null,

  refresh: async (cwd: string) => {
    const gen = ++_refreshGen;

    const cached = _cache.get(cwd);
    const isKnownNoRepo = _noRepoCache.has(cwd);

    // 캐시 있으면 즉시 표시 (API 결과로 덮어씀), 그 외 초기화
    if (cached) {
      set({ ...cached, isLoading: false, error: null });
    } else {
      set({ repoInfo: null, fileStatuses: null, statusMap: {}, folderStatusMap: {}, unpushedCommits: [], isLoading: false, error: null });
    }

    try {
      const [info, statuses] = await Promise.all([
        apiGetGitRepoInfo(cwd),
        apiGetGitFileStatuses(cwd),
      ]);
      if (gen !== _refreshGen) return;
      const { statusMap, folderStatusMap } = buildMaps(statuses);
      let unpushedCommits: string[] = [];
      if (info.ahead > 0) {
        try {
          unpushedCommits = await invoke<string[]>("git_unpushed_commits", { path: cwd });
        } catch (e) { logger.warn("[gitStore:unpushedCommits] failed:", e); }
      }
      if (gen !== _refreshGen) return;
      // git init 등으로 새로 repo가 된 경우 noRepoCache 제거
      _noRepoCache.delete(cwd);
      const snapshot: GitSnapshot = { repoInfo: info, fileStatuses: statuses, statusMap, folderStatusMap, unpushedCommits };
      _cache.set(cwd, snapshot);
      set({ ...snapshot, _lastRoot: info.root, isLoading: false, error: null });
    } catch (e) {
      if (gen !== _refreshGen) return;
      _noRepoCache.add(cwd);
      _cache.delete(cwd);  // stale git 캐시 제거 — 재시작 후 flash 방지
      const errStr = String(e);
      // 이미 non-repo 상태이면 에러만 유지하고 불필요한 전체 re-render 생략
      if (isKnownNoRepo) {
        set({ error: errStr });
      } else {
        set({
          repoInfo: null,
          fileStatuses: null,
          statusMap: {},
          folderStatusMap: {},
          _lastRoot: null,
          isLoading: false,
          error: errStr,
        });
      }
    }
  },

  refreshIfNeeded: async (cwd: string) => {
    try {
      const info = await apiGetGitRepoInfo(cwd);
      const root = info.root;
      if (root !== get()._lastRoot) {
        await get().refresh(cwd);
      }
    } catch {
      // Not a git repo — clear state
      if (get()._lastRoot !== null) {
        set({
          repoInfo: null,
          fileStatuses: null,
          statusMap: {},
          folderStatusMap: {},
          _lastRoot: null,
          error: null,
        });
      }
    }
  },

  loadCommitLog: async (cwd: string) => {
    try {
      const log = await apiGitCommitLog(cwd, 100, true);
      set({ commitLog: log });

      // Also refresh worktrees to ensure markers in the graph are up-to-date
      const { useWorktreeStore } = await import("./worktreeStore");
      useWorktreeStore.getState().refresh(cwd).catch(() => { });
    } catch {
      set({ commitLog: [] });
    }
  },

  stageFile: async (cwd: string, filePath: string) => {
    await apiGitAction(cwd, "stage", filePath);
    await get().refresh(cwd);
  },

  unstageFile: async (cwd: string, filePath: string) => {
    await apiGitAction(cwd, "unstage", filePath);
    await get().refresh(cwd);
  },

  stageAll: async (cwd: string) => {
    await apiGitAction(cwd, "stage_all");
    await get().refresh(cwd);
  },

  unstageAll: async (cwd: string) => {
    await apiGitAction(cwd, "unstage_all");
    await get().refresh(cwd);
  },

  commit: async (cwd: string, message: string) => {
    await apiGitAction(cwd, "commit", undefined, message);
    await get().refresh(cwd);
    await get().loadCommitLog(cwd);
  },

  push: async (cwd: string) => {
    await apiGitAction(cwd, "push");
    await get().refresh(cwd);
  },

  pull: async (cwd: string) => {
    await apiGitAction(cwd, "pull");
    await get().refresh(cwd);
  },

  stashPull: async (cwd: string) => {
    await invoke("git_stash_pull", { path: cwd });
    await get().refresh(cwd);
  },

  stashRebasePull: async (cwd: string) => {
    await invoke("git_stash_rebase_pull", { path: cwd });
    await get().refresh(cwd);
  },

  resolveOurs: async (cwd: string, filePath: string) => {
    await invoke("git_resolve_ours", { path: cwd, filePath });
    await get().refresh(cwd);
  },

  resolveTheirs: async (cwd: string, filePath: string) => {
    await invoke("git_resolve_theirs", { path: cwd, filePath });
    await get().refresh(cwd);
  },

  mergeAbort: async (cwd: string) => {
    await invoke("git_merge_abort", { path: cwd });
    await get().refresh(cwd);
  },

  pullConflictFiles: [],
  pullConflictCwd: null,

  setPullConflict: (cwd, files) => set({ pullConflictCwd: cwd, pullConflictFiles: files }),
  clearPullConflict: () => set({ pullConflictCwd: null, pullConflictFiles: [] }),

  discardFile: async (cwd: string, filePath: string) => {
    await apiGitAction(cwd, "discard", filePath);
    await get().refresh(cwd);
  },

  addToGitignore: async (cwd: string, pattern: string) => {
    await apiGitAction(cwd, "gitignore", pattern);
    await get().refresh(cwd);
  },
}));

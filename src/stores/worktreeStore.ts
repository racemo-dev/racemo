import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { GitWorktreeEntry } from "../types/git";

let _worktreeGen = 0;
const _worktreeCache = new Map<string, GitWorktreeEntry[]>();

interface WorktreeState {
  worktrees: GitWorktreeEntry[];
  isLoading: boolean;
  error: string | null;

  refresh: (cwd: string) => Promise<void>;
  add: (cwd: string, worktreePath: string, branch: string, newBranch: boolean, target?: string) => Promise<void>;
  remove: (cwd: string, worktreePath: string, force: boolean) => Promise<void>;
  prune: (cwd: string) => Promise<void>;
  sync: (cwd: string, worktreePath: string, base: string, rebase: boolean) => Promise<void>;
  apply: (cwd: string, worktreePath: string, target: string, squash: boolean) => Promise<void>;
  cherryPick: (worktreePath: string, commits: string[]) => Promise<void>;
  reset: (worktreePath: string, commit: string, mode: string) => Promise<void>;
  lock: (cwd: string, worktreePath: string, reason?: string) => Promise<void>;
  unlock: (cwd: string, worktreePath: string) => Promise<void>;

  // Modal State
  isAddModalOpen: boolean;
  modalCwd: string | null;
  modalTarget: string | null;
  openAddModal: (cwd: string, target?: string) => void;
  closeAddModal: () => void;

  // New Action Modal (Sync/Apply/CherryPick/Reset)
  actionModal: {
    isOpen: boolean;
    mode: 'sync' | 'apply' | 'pull' | 'cherrypick' | 'reset' | null;
    worktree: GitWorktreeEntry | null;
    cwd: string;
  };
  openActionModal: (cwd: string, mode: 'sync' | 'apply' | 'pull' | 'cherrypick' | 'reset', worktree: GitWorktreeEntry) => void;
  closeActionModal: () => void;
}

export const useWorktreeStore = create<WorktreeState>()((set, get) => ({
  worktrees: [],
  isLoading: false,
  error: null,

  refresh: async (cwd: string) => {
    const gen = ++_worktreeGen;

    const cached = _worktreeCache.get(cwd);
    if (cached) {
      set({ worktrees: cached, isLoading: false, error: null });
    } else {
      set({ isLoading: true, error: null });
    }

    try {
      const list = await invoke<GitWorktreeEntry[]>("git_worktree_list", { path: cwd });
      if (gen !== _worktreeGen) return;
      _worktreeCache.set(cwd, list);
      set({ worktrees: list, isLoading: false });
    } catch (e) {
      if (gen !== _worktreeGen) return;
      set({ worktrees: [], isLoading: false, error: String(e) });
    }
  },

  add: async (cwd: string, worktreePath: string, branch: string, newBranch: boolean, target?: string) => {
    await invoke("git_worktree_add", { path: cwd, worktreePath, branch, newBranch, target });
    await get().refresh(cwd);
  },

  remove: async (cwd: string, worktreePath: string, force: boolean) => {
    await invoke("git_worktree_remove", { path: cwd, worktreePath, force });
    await get().refresh(cwd);
  },

  prune: async (cwd: string) => {
    await invoke("git_worktree_prune", { path: cwd });
    await get().refresh(cwd);
  },
  sync: async (cwd: string, worktreePath: string, base: string, rebase: boolean) => {
    await invoke("git_worktree_sync", { path: cwd, worktreePath, base, rebase });
    await get().refresh(cwd);
  },
  apply: async (cwd: string, worktreePath: string, target: string, squash: boolean) => {
    await invoke("git_worktree_apply", { path: cwd, worktreePath, target, squash });
    await get().refresh(cwd);
  },
  cherryPick: async (worktreePath: string, commits: string[]) => {
    await invoke("git_worktree_cherry_pick", { worktreePath, commits });
  },
  reset: async (worktreePath: string, commit: string, mode: string) => {
    await invoke("git_worktree_reset", { worktreePath, commit, mode });
  },
  lock: async (cwd: string, worktreePath: string, reason?: string) => {
    await invoke("git_worktree_lock", { path: cwd, worktreePath, reason });
    await get().refresh(cwd);
  },
  unlock: async (cwd: string, worktreePath: string) => {
    await invoke("git_worktree_unlock", { path: cwd, worktreePath });
    await get().refresh(cwd);
  },

  isAddModalOpen: false,
  modalCwd: null,
  modalTarget: null,
  openAddModal: (cwd: string, target?: string) => set({ isAddModalOpen: true, modalCwd: cwd, modalTarget: target ?? null }),
  closeAddModal: () => set({ isAddModalOpen: false, modalCwd: null, modalTarget: null }),

  actionModal: {
    isOpen: false,
    mode: null,
    worktree: null,
    cwd: "",
  },
  openActionModal: (cwd, mode, worktree) => set(() => ({
    actionModal: { isOpen: true, mode, worktree, cwd }
  })),
  closeActionModal: () => set({
    actionModal: { isOpen: false, mode: null, worktree: null, cwd: "" }
  }),
}));

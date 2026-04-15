import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface GitOutputLine {
  line: string;
  isErr: boolean;
}

export interface ToolEntry {
  name: string;
  cmd: string;
}

export interface CommitSuggestion {
  type: string;
  message: string;
}

interface GitOutputState {
  isOpen: boolean;
  title: string;
  lines: GitOutputLine[];
  status: "running" | "success" | "error" | "cancelled" | "idle";
  onClose: (() => void) | null;
  currentChannelId: string | null;

  // AI commit mode
  mode: "terminal" | "ai-commit";
  toolEntries: ToolEntry[];
  suggestions: CommitSuggestion[];
  changedFiles: string[];

  /** 툴 호출 후 Claude가 응답 생성 중일 때 true */
  isThinking: boolean;

  /** AI에게 보낸 프롬프트 원문 */
  prompt: string;

  open: (title: string, onClose?: () => void, mode?: "terminal" | "ai-commit") => void;
  addLine: (line: string, isErr: boolean) => void;
  setStatus: (status: "running" | "success" | "error" | "cancelled") => void;
  setChannelId: (id: string | null) => void;
  addToolEntry: (entry: ToolEntry) => void;
  setSuggestions: (suggestions: CommitSuggestion[]) => void;
  setChangedFiles: (files: string[]) => void;
  setIsThinking: (v: boolean) => void;
  setPrompt: (prompt: string) => void;
  kill: () => void;
  close: () => void;
}

export const useGitOutputStore = create<GitOutputState>()((set, get) => ({
  isOpen: false,
  title: "",
  lines: [],
  status: "idle",
  onClose: null,
  currentChannelId: null,
  mode: "terminal",
  toolEntries: [],
  suggestions: [],
  changedFiles: [],
  isThinking: false,
  prompt: "",

  open: (title, onClose, mode = "terminal") =>
    set({ isOpen: true, title, lines: [], status: "running", onClose: onClose ?? null, currentChannelId: null, mode, toolEntries: [], suggestions: [], changedFiles: [], isThinking: false, prompt: "" }),

  addLine: (line, isErr) =>
    set((s) => {
      const last = s.lines[s.lines.length - 1];
      if (last && last.line === line) return s;
      return { lines: [...s.lines, { line, isErr }] };
    }),

  setStatus: (status) => set({ status }),

  setChannelId: (id) => set({ currentChannelId: id }),

  addToolEntry: (entry) =>
    set((s) => ({ toolEntries: [...s.toolEntries, entry] })),

  setSuggestions: (suggestions) => set({ suggestions }),

  setChangedFiles: (files) => set({ changedFiles: files }),

  setIsThinking: (v) => set({ isThinking: v }),
  setPrompt: (prompt) => set({ prompt }),

  kill: () => {
    const { currentChannelId } = get();
    if (currentChannelId) {
      invoke("kill_streaming", { channelId: currentChannelId }).catch(() => {});
    }
  },

  close: () => {
    const { onClose } = get();
    onClose?.();
    set({ isOpen: false, title: "", lines: [], status: "idle", onClose: null, currentChannelId: null, mode: "terminal", toolEntries: [], suggestions: [], changedFiles: [], isThinking: false, prompt: "" });
  },
}));

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logger } from "../lib/logger";

export interface FileMatch {
  path: string;
  relative: string;
  name: string;
}

export interface ContentMatch {
  path: string;
  relative: string;
  name: string;
  lineNumber: number;
  lineText: string;
}

export interface ContentGroup {
  path: string;
  relative: string;
  name: string;
  matches: { lineNumber: number; lineText: string; flatIndex: number }[];
}

interface FileSearchState {
  isOpen: boolean;
  query: string;
  caseSensitive: boolean;
  selectedIndex: number;
  fileResults: FileMatch[];
  contentGroups: ContentGroup[];
  contentFlat: ContentMatch[];
  isSearchingFiles: boolean;
  isSearchingContent: boolean;
  cwd: string;
  searchRoot: string;
  scanDir: string;

  open: (cwd: string) => void;
  initCwd: (cwd: string) => void;
  close: () => void;
  setQuery: (q: string) => void;
  setCaseSensitive: (v: boolean) => void;
  setSelectedIndex: (i: number) => void;
  setSearchRoot: (path: string) => void;
  runSearch: () => Promise<void>;
}

let _searchTimer: ReturnType<typeof setTimeout> | null = null;
let _unlisteners: UnlistenFn[] = [];
let _currentChannelId = "";
let _firstFileBatch = true;
let _firstContentBatch = true;

function cancelPendingSearch() {
  if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
  _unlisteners.forEach((u) => u());
  _unlisteners = [];
  _currentChannelId = "";
}

function buildContentGroups(payload: ContentMatch[], existingGroups: ContentGroup[], existingFlat: ContentMatch[]) {
  const groupMap = new Map<string, ContentGroup>();
  let flatIndex = existingFlat.length;
  for (const g of existingGroups) {
    groupMap.set(g.path, { ...g, matches: [...g.matches] });
  }
  for (const m of payload) {
    if (!groupMap.has(m.path)) {
      groupMap.set(m.path, { path: m.path, relative: m.relative, name: m.name, matches: [] });
    }
    groupMap.get(m.path)!.matches.push({ lineNumber: m.lineNumber, lineText: m.lineText, flatIndex });
    flatIndex++;
  }
  return {
    contentGroups: Array.from(groupMap.values()),
    contentFlat: [...existingFlat, ...payload],
  };
}

export const useFileSearchStore = create<FileSearchState>()((set, get) => ({
  isOpen: false,
  query: "",
  caseSensitive: false,
  selectedIndex: 0,
  fileResults: [],
  contentGroups: [],
  contentFlat: [],
  isSearchingFiles: false,
  isSearchingContent: false,
  cwd: "",
  searchRoot: "",
  scanDir: "",

  open: (cwd) => set({ isOpen: true, cwd, searchRoot: cwd, query: "", selectedIndex: 0, fileResults: [], contentGroups: [], contentFlat: [], scanDir: "" }),
  initCwd: (cwd) => {
    const prev = get().cwd;
    if (prev === cwd) return;
    set({ cwd, searchRoot: cwd, selectedIndex: 0, fileResults: [], contentGroups: [], contentFlat: [], scanDir: "" });
    const { query } = get();
    if (query.trim()) get().runSearch();
  },
  close: () => {
    cancelPendingSearch();
    set({ isOpen: false, query: "", selectedIndex: 0, isSearchingFiles: false, isSearchingContent: false, scanDir: "" });
  },

  setQuery: (q) => {
    set({ query: q, selectedIndex: 0 });
    cancelPendingSearch();
    if (!q.trim()) {
      set({ fileResults: [], contentGroups: [], contentFlat: [], isSearchingFiles: false, isSearchingContent: false });
      return;
    }
    set({ isSearchingFiles: true, isSearchingContent: true });
    _searchTimer = setTimeout(() => get().runSearch(), 250);
  },

  setCaseSensitive: (v) => {
    set({ caseSensitive: v, selectedIndex: 0 });
    const { query } = get();
    if (query.trim()) get().runSearch();
  },

  setSelectedIndex: (i) => set({ selectedIndex: i }),

  setSearchRoot: (path) => {
    set({ searchRoot: path, selectedIndex: 0, fileResults: [], contentGroups: [], contentFlat: [] });
    const { query } = get();
    if (query.trim()) get().runSearch();
  },

  runSearch: async () => {
    const { searchRoot, query, caseSensitive } = get();
    const root = searchRoot;
    if (!query.trim() || !root) { set({ isSearchingFiles: false, isSearchingContent: false }); return; }

    cancelPendingSearch();
    _firstFileBatch = true;
    _firstContentBatch = true;
    set({ isSearchingFiles: true, isSearchingContent: true, selectedIndex: 0, fileResults: [], contentGroups: [], contentFlat: [], scanDir: "" });

    const channelId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    _currentChannelId = channelId;

    const filesCh   = `files-${channelId}`;
    const contentCh = `content-${channelId}`;
    const filesBatch   = `search-batch-${filesCh}`;
    const filesDone    = `search-done-${filesCh}`;
    const filesDirEvt  = `search-dir-${filesCh}`;
    const contentBatch = `search-batch-${contentCh}`;
    const contentDone  = `search-done-${contentCh}`;
    const contentDirEvt = `search-dir-${contentCh}`;

    // ── Files ──
    const ulDir = await listen<string>(filesDirEvt, ({ payload }) => {
      if (_currentChannelId !== channelId) return;
      set({ scanDir: payload });
    });
    const ulContentDir = await listen<string>(contentDirEvt, ({ payload }) => {
      if (_currentChannelId !== channelId) return;
      set({ scanDir: payload });
    });
    const ulFilesBatch = await listen<FileMatch[]>(filesBatch, ({ payload }) => {
      if (_currentChannelId !== channelId) return;
      if (_firstFileBatch) { _firstFileBatch = false; set({ fileResults: payload }); }
      else set((s) => ({ fileResults: [...s.fileResults, ...payload] }));
    });
    const ulFilesDone = await listen(filesDone, () => {
      if (_currentChannelId !== channelId) return;
      if (_firstFileBatch) set({ fileResults: [] });
      set({ isSearchingFiles: false, scanDir: "" });
    });

    // ── Content ──
    const ulContentBatch = await listen<ContentMatch[]>(contentBatch, ({ payload }) => {
      if (_currentChannelId !== channelId) return;
      if (_firstContentBatch) {
        _firstContentBatch = false;
        const { contentGroups, contentFlat } = buildContentGroups(payload, [], []);
        set({ contentGroups, contentFlat });
      } else {
        set((s) => buildContentGroups(payload, s.contentGroups, s.contentFlat));
      }
    });
    const ulContentDone = await listen(contentDone, () => {
      if (_currentChannelId !== channelId) return;
      if (_firstContentBatch) set({ contentGroups: [], contentFlat: [] });
      set({ isSearchingContent: false });
    });

    _unlisteners = [ulDir, ulContentDir, ulFilesBatch, ulFilesDone, ulContentBatch, ulContentDone];

    invoke("search_files", { root, query, channelId: filesCh }).catch((e) => {
      logger.error("[fileSearch] search_files error:", e);
      set({ isSearchingFiles: false, fileResults: [] });
    });
    invoke("search_content", { root, query, caseSensitive, channelId: contentCh }).catch((e) => {
      logger.error("[fileSearch] search_content error:", e);
      set({ isSearchingContent: false, contentGroups: [], contentFlat: [] });
    });
  },
}));

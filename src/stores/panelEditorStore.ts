import { create } from "zustand";
import { apiReadTextFile } from "../lib/bridge";
import type { EditorTab } from "./editorStore";
import { detectLanguage } from "./editorStore";
import * as tabUtils from "./tabUtils";

export interface DiffPanelTab {
  type: "diff";
  path: string; // unique key: `diff:${cwd}:${filePath}:${staged}`
  name: string;
  cwd: string;
  filePath: string;
  staged: boolean;
}

export interface BrowserPanelTab {
  type: "browser";
  path: string;
  name: string;
  url: string;
  favicon?: string;
}

export type EditorPanelTab = EditorTab & { type?: "editor" };

export type PanelTab = EditorPanelTab | DiffPanelTab | BrowserPanelTab;

interface PanelEditorState {
  tabs: PanelTab[];
  activeIndex: number;
  panelOpen: boolean;

  openTab: (path: string, name: string, content: string) => void;
  openDiffTab: (cwd: string, filePath: string, staged: boolean) => void;
  openBrowserTab: (url: string, name?: string) => void;
  closeTab: (index: number) => void;
  closeOthers: (index: number) => void;
  closeToRight: (index: number) => void;
  closeAll: () => void;
  moveTab: (from: number, to: number) => void;
  setActiveIndex: (index: number) => void;
  updateContent: (index: number, content: string) => void;
  markSaved: (index: number) => void;
  setPanelOpen: (open: boolean) => void;
  reloadTabByPath: (path: string) => Promise<void>;
  reloadAllNonDirtyTabs: () => Promise<void>;
}

export const usePanelEditorStore = create<PanelEditorState>()((set, get) => ({
  tabs: [],
  activeIndex: 0,
  panelOpen: false,

  openTab: (path, name, content) => {
    const { tabs } = get();
    const existing = tabs.findIndex((t) => t.path === path);
    if (existing >= 0) {
      set({ activeIndex: existing, panelOpen: true });
      return;
    }
    const lang = detectLanguage(name);
    const newTab: EditorPanelTab = {
      path,
      name,
      content,
      originalContent: content,
      isDirty: false,
      language: lang,
    };
    set({ tabs: [...tabs, newTab], activeIndex: tabs.length, panelOpen: true });
  },

  openDiffTab: (cwd, filePath, staged) => {
    const { tabs } = get();
    const key = `diff:${cwd}:${filePath}:${staged}`;
    const existing = tabs.findIndex((t) => t.path === key);
    if (existing >= 0) {
      set({ activeIndex: existing, panelOpen: true });
      return;
    }
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    const newTab: DiffPanelTab = { type: "diff", path: key, name, cwd, filePath, staged };
    set({ tabs: [...tabs, newTab], activeIndex: tabs.length, panelOpen: true });
  },

  openBrowserTab: (url, name) => {
    const { tabs } = get();
    const displayName = name || (() => { try { return new URL(url).hostname; } catch { return url; } })();
    const id = Date.now();
    const newTab: BrowserPanelTab = { type: "browser", path: `browser:${id}`, name: displayName, url };
    set({ tabs: [...tabs, newTab], activeIndex: tabs.length, panelOpen: true });
  },

  closeTab: (index) => {
    const { tabs, activeIndex } = get();
    set(tabUtils.closeTab(tabs, index, activeIndex));
  },

  closeOthers: (index) => {
    const { tabs } = get();
    set(tabUtils.closeOthers(tabs, index));
  },

  closeToRight: (index) => {
    const { tabs, activeIndex } = get();
    set(tabUtils.closeToRight(tabs, index, activeIndex));
  },

  closeAll: () => set(tabUtils.closeAll()),

  moveTab: (from, to) => {
    set((s) => tabUtils.moveTab(s.tabs, from, to, s.activeIndex));
  },

  setActiveIndex: (index) => set({ activeIndex: index }),

  updateContent: (index, content) => {
    set((s) => {
      const tabs = [...s.tabs];
      const tab = tabs[index];
      if (!tab || tab.type === "diff" || tab.type === "browser") return s;
      tabs[index] = { ...tab, content, isDirty: content !== tab.originalContent };
      return { tabs };
    });
  },

  setPanelOpen: (open) => set({ panelOpen: open }),

  reloadTabByPath: async (path) => {
    const { tabs } = get();
    const index = tabUtils.findTabIndexByPath(tabs, path);
    if (index < 0) return;
    const tab = tabs[index];
    if (tab.type === "diff" || tab.type === "browser") return;
    if (tab.isDirty) {
      const ok = window.confirm(`"${tab.name}" has unsaved changes. Reload from disk?`);
      if (!ok) return;
    }
    try {
      const content = await apiReadTextFile(path);
      set((s) => {
        const next = [...s.tabs];
        const t = next[index];
        if (!t || t.type === "diff" || t.type === "browser") return s;
        next[index] = { ...t, content, originalContent: content, isDirty: false };
        return { tabs: next };
      });
    } catch { /* ignore */ }
  },

  reloadAllNonDirtyTabs: async () => {
    const { tabs } = get();
    await Promise.all(
      tabs.map(async (tab, index) => {
        if (tab.type === "diff" || tab.type === "browser" || tab.isDirty) return;
        try {
          const content = await apiReadTextFile(tab.path);
          set((s) => {
            const next = [...s.tabs];
            const t = next[index];
            if (!t || t.type === "diff" || t.type === "browser") return s;
            next[index] = { ...t, content, originalContent: content, isDirty: false };
            return { tabs: next };
          });
        } catch { /* ignore */ }
      })
    );
  },

  markSaved: (index) => {
    set((s) => {
      const tabs = [...s.tabs];
      const tab = tabs[index];
      if (!tab || tab.type === "diff" || tab.type === "browser") return s;
      tabs[index] = { ...tab, originalContent: tab.content, isDirty: false };
      return { tabs };
    });
  },
}));

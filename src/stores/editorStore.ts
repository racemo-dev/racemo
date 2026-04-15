import { create } from "zustand";
import { apiReadTextFile } from "../lib/bridge";
import * as tabUtils from "./tabUtils";

export interface EditorTab {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  language: string;
}

interface EditorState {
  tabs: EditorTab[];
  activeIndex: number;
  modalOpen: boolean;

  openTab: (path: string, name: string, content: string) => void;
  closeTab: (index: number) => void;
  closeOthers: (index: number) => void;
  closeToRight: (index: number) => void;
  closeAll: () => void;
  moveTab: (from: number, to: number) => void;
  setActiveIndex: (index: number) => void;
  updateContent: (index: number, content: string) => void;
  markSaved: (index: number) => void;
  setModalOpen: (open: boolean) => void;
  reloadTabByPath: (path: string) => Promise<void>;
  reloadAllNonDirtyTabs: () => Promise<void>;
}

export function detectLanguage(name: string): string {
  const lower = name.toLowerCase();
  // Handle special filenames without extension
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile" || lower === "gnumakefile") return "shell";
  if (lower === "rakefile" || lower === "gemfile" || lower === "guardfile") return "ruby";
  if (lower === "vagrantfile") return "ruby";
  if (lower === "podfile") return "ruby";
  if (lower === "cmakelists.txt") return "cmake";
  if (lower === ".env" || lower.startsWith(".env.")) return "shell";
  if (lower === "nginx.conf" || lower.endsWith("/nginx.conf")) return "nginx";

  const ext = lower.split(".").pop() ?? "";
  const map: Record<string, string> = {
    md: "markdown", mdx: "markdown",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    json: "json", jsonc: "json",
    rs: "rust",
    css: "css", scss: "css", less: "css",
    html: "html", htm: "html", svg: "html",
    toml: "toml",
    yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
    ps1: "powershell", psm1: "powershell", psd1: "powershell",
    bat: "shell", cmd: "shell",
    py: "python", pyw: "python",
    go: "go",
    cpp: "cpp", cc: "cpp", cxx: "cpp", c: "cpp",
    h: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
    java: "java",
    kt: "kotlin", kts: "kotlin",
    scala: "scala", sc: "scala",
    dart: "dart",
    rb: "ruby", rake: "ruby", gemspec: "ruby",
    swift: "swift",
    lua: "lua",
    pl: "perl", pm: "perl",
    r: "r",
    groovy: "groovy", gradle: "groovy",
    sql: "sql",
    xml: "xml", plist: "xml", xsl: "xml", xslt: "xml",
    php: "php", phtml: "php",
    cs: "csharp",
    vb: "vb",
    fs: "fsharp", fsi: "fsharp", fsx: "fsharp",
    ml: "ocaml", mli: "ocaml",
    hs: "haskell", lhs: "haskell",
    erl: "erlang", hrl: "erlang",
    ex: "elixir", exs: "elixir",
    clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure",
    jl: "julia",
    elm: "elm",
    cr: "crystal",
    tf: "hcl", tfvars: "hcl",
    proto: "protobuf",
    nginx: "nginx",
    conf: "nginx",
    coffee: "coffeescript",
    sass: "sass",
    vue: "vue",
    svelte: "html",
    env: "shell",
    ini: "properties", properties: "properties",
    makefile: "shell", mk: "shell",
  };
  return map[ext] ?? "text";
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  tabs: [],
  activeIndex: 0,
  modalOpen: false,

  openTab: (path, name, content) => {
    const { tabs } = get();
    const existing = tabs.findIndex((t) => t.path === path);
    if (existing >= 0) {
      set({ activeIndex: existing });
      return;
    }
    const lang = detectLanguage(name);
    const newTab: EditorTab = {
      path,
      name,
      content,
      originalContent: content,
      isDirty: false,
      language: lang,
    };
    set({ tabs: [...tabs, newTab], activeIndex: tabs.length });
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
      if (!tabs[index]) return s;
      tabs[index] = {
        ...tabs[index],
        content,
        isDirty: content !== tabs[index].originalContent,
      };
      return { tabs };
    });
  },

  setModalOpen: (open) => set({ modalOpen: open }),

  reloadTabByPath: async (path) => {
    const { tabs } = get();
    const index = tabUtils.findTabIndexByPath(tabs, path);
    if (index < 0) return;
    const tab = tabs[index];
    if (tab.isDirty) {
      const ok = window.confirm(`"${tab.name}" has unsaved changes. Reload from disk?`);
      if (!ok) return;
    }
    try {
      const content = await apiReadTextFile(path);
      set((s) => {
        const next = [...s.tabs];
        if (!next[index]) return s;
        next[index] = { ...next[index], content, originalContent: content, isDirty: false };
        return { tabs: next };
      });
    } catch { /* file deleted or unreadable — ignore */ }
  },

  reloadAllNonDirtyTabs: async () => {
    const { tabs } = get();
    await Promise.all(
      tabs.map(async (tab, index) => {
        if (tab.isDirty) return;
        try {
          const content = await apiReadTextFile(tab.path);
          set((s) => {
            const next = [...s.tabs];
            if (!next[index]) return s;
            next[index] = { ...next[index], content, originalContent: content, isDirty: false };
            return { tabs: next };
          });
        } catch { /* ignore */ }
      })
    );
  },

  markSaved: (index) => {
    set((s) => {
      const tabs = [...s.tabs];
      if (!tabs[index]) return s;
      tabs[index] = {
        ...tabs[index],
        originalContent: tabs[index].content,
        isDirty: false,
      };
      return { tabs };
    });
  },
}));

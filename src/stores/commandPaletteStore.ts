import { create } from "zustand";

interface CommandPaletteStore {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  mode: "search" | "snippet-edit" | "variable-prompt";
  editingSnippetId: string | null;
  pendingVariables: { name: string; value: string }[];
  pendingCommand: string;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  setSelectedIndex: (i: number) => void;
  setMode: (m: "search" | "snippet-edit" | "variable-prompt") => void;
  startEditSnippet: (id: string | null) => void;
  promptVariables: (command: string, vars: { name: string; value: string }[]) => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>()((set) => ({
  isOpen: false,
  query: "",
  selectedIndex: 0,
  mode: "search",
  editingSnippetId: null,
  pendingVariables: [],
  pendingCommand: "",
  open: () => set({ isOpen: true, query: "", selectedIndex: 0, mode: "search" }),
  close: () =>
    set({
      isOpen: false,
      query: "",
      selectedIndex: 0,
      mode: "search",
      editingSnippetId: null,
      pendingVariables: [],
      pendingCommand: "",
    }),
  setQuery: (q) => set({ query: q, selectedIndex: 0 }),
  setSelectedIndex: (i) => set({ selectedIndex: i }),
  setMode: (m) => set({ mode: m }),
  startEditSnippet: (id) => set({ mode: "snippet-edit", editingSnippetId: id }),
  promptVariables: (command, vars) =>
    set({ mode: "variable-prompt", pendingCommand: command, pendingVariables: vars }),
}));

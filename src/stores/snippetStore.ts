import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Snippet } from "../types/commandPalette";

interface SnippetStore {
  snippets: Snippet[];
  addSnippet: (name: string, command: string, category?: string) => void;
  updateSnippet: (id: string, updates: Partial<Omit<Snippet, "id" | "createdAt">>) => void;
  removeSnippet: (id: string) => void;
}

export const useSnippetStore = create<SnippetStore>()(
  persist(
    (set) => ({
      snippets: [],
      addSnippet: (name, command, category) =>
        set((state) => ({
          snippets: [
            ...state.snippets,
            { id: crypto.randomUUID(), name, command, category, createdAt: Date.now() },
          ],
        })),
      updateSnippet: (id, updates) =>
        set((state) => ({
          snippets: state.snippets.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })),
      removeSnippet: (id) =>
        set((state) => ({ snippets: state.snippets.filter((s) => s.id !== id) })),
    }),
    { name: "racemo-snippets" },
  ),
);

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AiTaskType = "commit" | "auto-commit" | "review" | "error-explain";
export type AiTaskStatus = "running" | "success" | "error";

export interface AiHistoryEntry {
  id: string;
  type: AiTaskType;
  status: AiTaskStatus;
  command: string;
  summary: string;
  output: string;
  prompt?: string;
  timestamp: number;
}

const MAX_ENTRIES = 100;
const MAX_OUTPUT_LENGTH = 3000;

interface AiHistoryState {
  entries: AiHistoryEntry[];
  add: (entry: Omit<AiHistoryEntry, "id" | "timestamp">) => string;
  update: (id: string, patch: Partial<Pick<AiHistoryEntry, "status" | "summary" | "output" | "prompt">>) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useAiHistoryStore = create<AiHistoryState>()(
  persist(
    (set) => ({
      entries: [],

      add: (entry) => {
        const id = crypto.randomUUID();
        const output = entry.output.length > MAX_OUTPUT_LENGTH
          ? entry.output.slice(0, MAX_OUTPUT_LENGTH) + "…"
          : entry.output;
        set((s) => ({
          entries: [{ ...entry, output, id, timestamp: Date.now() }, ...s.entries].slice(0, MAX_ENTRIES),
        }));
        return id;
      },

      update: (id, patch) =>
        set((s) => ({
          entries: s.entries.map((e) => {
            if (e.id !== id) return e;
            const updated = { ...e, ...patch };
            if (updated.output.length > MAX_OUTPUT_LENGTH) {
              updated.output = updated.output.slice(0, MAX_OUTPUT_LENGTH) + "…";
            }
            return updated;
          }),
        })),

      remove: (id) =>
        set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),

      clear: () => set({ entries: [] }),
    }),
    {
      name: "racemo-ai-history",
      partialize: (s) => ({ entries: s.entries }),
    },
  ),
);

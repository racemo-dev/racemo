import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Prompt, PromptStatus } from "../types/prompts";
import { createTauriStateStorage } from "../lib/tauriStateStorage";

interface PromptStore {
  prompts: Prompt[];
  addPrompt: (text: string, folder?: string) => void;
  updatePrompt: (id: string, text: string) => void;
  removePrompt: (id: string) => void;
  toggleDone: (id: string) => void;
  setStatus: (id: string, status: PromptStatus) => void;
}

const STORE_FILE = "prompts.json";
const PERSIST_KEY = "racemo-prompts";

export const usePromptStore = create<PromptStore>()(
  persist(
    (set) => ({
      prompts: [],
      addPrompt: (text, folder) =>
        set((state) => ({
          prompts: [
            { id: crypto.randomUUID(), text, folder: folder || undefined, status: "pending", createdAt: Date.now() },
            ...state.prompts,
          ],
        })),
      updatePrompt: (id, text) =>
        set((state) => ({
          prompts: state.prompts.map((p) => (p.id === id ? { ...p, text } : p)),
        })),
      removePrompt: (id) =>
        set((state) => ({ prompts: state.prompts.filter((p) => p.id !== id) })),
      toggleDone: (id) =>
        set((state) => ({
          prompts: state.prompts.map((p) => {
            if (p.id !== id) return p;
            return p.status === "done"
              ? { ...p, status: "pending", completedAt: undefined }
              : { ...p, status: "done", completedAt: Date.now() };
          }),
        })),
      setStatus: (id, status) =>
        set((state) => ({
          prompts: state.prompts.map((p) => {
            if (p.id !== id) return p;
            return {
              ...p,
              status,
              completedAt: status === "done" ? Date.now() : undefined,
            };
          }),
        })),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() =>
        createTauriStateStorage(STORE_FILE, { key: PERSIST_KEY }),
      ),
    },
  ),
);

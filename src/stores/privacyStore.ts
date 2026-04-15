import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PrivacyStore {
  enabled: boolean;
  customPatterns: string[];
  toggle: () => void;
  setEnabled: (enabled: boolean) => void;
  addPattern: (pattern: string) => void;
  removePattern: (index: number) => void;
}

export const usePrivacyStore = create<PrivacyStore>()(
  persist(
    (set) => ({
      enabled: false,
      customPatterns: [],
      toggle: () => set((s) => ({ enabled: !s.enabled })),
      setEnabled: (enabled) => set({ enabled }),
      addPattern: (pattern) =>
        set((s) => ({ customPatterns: [...s.customPatterns, pattern] })),
      removePattern: (index) =>
        set((s) => ({
          customPatterns: s.customPatterns.filter((_, i) => i !== index),
        })),
    }),
    { name: "racemo-privacy" },
  ),
);

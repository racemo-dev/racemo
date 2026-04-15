import { create } from "zustand";
import { persist } from "zustand/middleware";

interface LoggingStore {
  enabled: boolean;
  logPath: string;
  setEnabled: (enabled: boolean) => void;
  setLogPath: (path: string) => void;
  toggle: () => void;
}

export const useLoggingStore = create<LoggingStore>()(
  persist(
    (set) => ({
      enabled: true,
      logPath: "", // Will be set from backend default path
      setEnabled: (enabled) => set({ enabled }),
      setLogPath: (path) => set({ logPath: path }),
      toggle: () => set((state) => ({ enabled: !state.enabled })),
    }),
    {
      name: "racemo-logging",
    },
  ),
);

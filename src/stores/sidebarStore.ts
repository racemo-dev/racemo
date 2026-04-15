import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidebarPanel = "explorer" | "docs" | "git" | "ailog" | "search" | "aihistory";

/** @deprecated Use "ailog" instead. Kept for localStorage migration. */
export type LegacySidebarPanel = "claudelog" | "codexlog" | "geminilog";

interface SidebarState {
  isExpanded: boolean;
  activePanel: SidebarPanel | null;
  togglePanel: (panel: SidebarPanel) => void;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
      isExpanded: false,
      activePanel: null,
      togglePanel: (panel) => {
        const { activePanel, isExpanded } = get();
        if (activePanel === panel && isExpanded) {
          set({ isExpanded: false, activePanel: null });
        } else {
          set({ isExpanded: true, activePanel: panel });
        }
      },
    }),
    {
      name: "racemo-sidebar",
      partialize: (state) => ({
        isExpanded: state.isExpanded,
        activePanel: state.activePanel,
      }),
      // Migrate legacy per-provider panels to unified "ailog"
      migrate: (persisted: unknown) => {
        const state = persisted as { isExpanded?: boolean; activePanel?: string | null };
        const legacy = ["claudelog", "codexlog", "geminilog"];
        const activePanel = state.activePanel && legacy.includes(state.activePanel)
          ? "ailog"
          : state.activePanel;
        return { isExpanded: state.isExpanded, activePanel } as Pick<SidebarState, "isExpanded" | "activePanel">;
      },
      version: 1,
    },
  ),
);

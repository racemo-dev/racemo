import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CompletionItem } from "../types/autocomplete";

interface AutocompleteStore {
  enabled: boolean;
  isOpen: boolean;
  items: CompletionItem[];
  selectedIndex: number;
  cursorPixelX: number;
  cursorPixelY: number;
  lineHeight: number;
  activePtyId: string | null;

  toggle: () => void;
  setEnabled: (enabled: boolean) => void;
  show: (items: CompletionItem[], x: number, y: number, lineHeight: number, ptyId: string) => void;
  dismiss: () => void;
  setSelectedIndex: (i: number) => void;
  moveUp: () => void;
  moveDown: () => void;
}

export const useAutocompleteStore = create<AutocompleteStore>()(
  persist(
    (set) => ({
      enabled: true,
      isOpen: false,
      items: [],
      selectedIndex: 0,
      cursorPixelX: 0,
      cursorPixelY: 0,
      lineHeight: 16,
      activePtyId: null,

      toggle: () => set((s) => ({ enabled: !s.enabled })),
      setEnabled: (enabled) => set({ enabled }),

      show: (items, x, y, lineHeight, ptyId) =>
        set({ isOpen: true, items, cursorPixelX: x, cursorPixelY: y, lineHeight, activePtyId: ptyId, selectedIndex: 0 }),

      dismiss: () =>
        set({ isOpen: false, items: [], selectedIndex: 0, activePtyId: null }),

      setSelectedIndex: (i) => set({ selectedIndex: i }),

      moveUp: () => set((s) => ({ selectedIndex: Math.max(0, s.selectedIndex - 1) })),
      moveDown: () => set((s) => ({ selectedIndex: Math.min(s.items.length - 1, s.selectedIndex + 1) })),
    }),
    {
      name: "racemo-autocomplete",
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);

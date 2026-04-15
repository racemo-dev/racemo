import { create } from "zustand";

interface BroadcastStore {
  enabled: boolean;
  selectedPtyIds: string[];
  toggle: () => void;
  selectPane: (ptyId: string) => void;
  selectAll: (ptyIds: string[]) => void;
  clearSelection: () => void;
  isSelected: (ptyId: string) => boolean;
}

export const useBroadcastStore = create<BroadcastStore>()((set, get) => ({
  enabled: false,
  selectedPtyIds: [],
  toggle: () => {
    const next = !get().enabled;
    set({ enabled: next, selectedPtyIds: next ? get().selectedPtyIds : [] });
  },
  selectPane: (ptyId) => {
    const ids = get().selectedPtyIds;
    if (ids.includes(ptyId)) {
      set({ selectedPtyIds: ids.filter((id) => id !== ptyId) });
    } else {
      set({ selectedPtyIds: [...ids, ptyId] });
    }
  },
  selectAll: (ptyIds) => set({ selectedPtyIds: [...ptyIds] }),
  clearSelection: () => set({ selectedPtyIds: [] }),
  isSelected: (ptyId) => get().selectedPtyIds.includes(ptyId),
}));

import { create } from "zustand";

export type SettingsCategory =
  | "account"
  | "appearance"
  | "terminal"
  | "notifications"
  | "autocomplete"
  | "privacy"
  | "debug"
  | "help";

interface SettingsDialogState {
  isOpen: boolean;
  activeCategory: SettingsCategory;
  open: (category?: SettingsCategory) => void;
  close: () => void;
  toggle: (category?: SettingsCategory) => void;
  setCategory: (category: SettingsCategory) => void;
}

export const useSettingsDialogStore = create<SettingsDialogState>()((set, get) => ({
  isOpen: false,
  activeCategory: "appearance",
  open: (category) => set({ isOpen: true, activeCategory: category ?? get().activeCategory }),
  close: () => set({ isOpen: false }),
  toggle: (category) => {
    const { isOpen, activeCategory } = get();
    if (isOpen && (!category || category === activeCategory)) {
      set({ isOpen: false });
    } else {
      set({ isOpen: true, activeCategory: category ?? activeCategory });
    }
  },
  setCategory: (category) => set({ activeCategory: category }),
}));

import { create } from "zustand";

interface ToastItem {
  id: number;
  message: string;
  type: "info" | "success" | "error";
}

interface ToastStore {
  toasts: ToastItem[];
  show: (message: string, type?: ToastItem["type"], duration?: number) => number;
  dismiss: (id: number) => void;
  /** Pane-level progress bar — null when hidden */
  progress: { message: string; state: "loading" | "success" | "error"; ptyId: string } | null;
  showProgress: (message: string, ptyId: string) => void;
  resolveProgress: (state: "success" | "error", message: string) => void;
  hideProgress: () => void;
}

let nextId = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  progress: null,

  show: (message, type = "info", duration = 2500) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
    return id;
  },

  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  showProgress: (message, ptyId) => {
    set({ progress: { message, state: "loading", ptyId } });
  },

  resolveProgress: (state, message) => {
    set((s) => ({ progress: s.progress ? { ...s.progress, message, state } : null }));
    setTimeout(() => set({ progress: null }), 1800);
  },

  hideProgress: () => set({ progress: null }),
}));

import { create } from "zustand";

export interface CommandError {
  command: string;
  exitCode: number;
  timestamp: number;
  terminalOutput?: string;
}

interface CommandErrorStore {
  errors: Record<string, CommandError>; // ptyId → last error
  setError: (ptyId: string, error: CommandError) => void;
  clearError: (ptyId: string) => void;
}

export const useCommandErrorStore = create<CommandErrorStore>()((set) => ({
  errors: {},
  setError: (ptyId, error) =>
    set((state) => ({ errors: { ...state.errors, [ptyId]: error } })),
  clearError: (ptyId) =>
    set((state) => {
      const { [ptyId]: _, ...rest } = state.errors;
      return { errors: rest };
    }),
}));

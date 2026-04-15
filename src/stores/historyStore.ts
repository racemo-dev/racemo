import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { HistoryEntry } from "../types/history";
import { logger } from "../lib/logger";

interface RawHistoryItem {
  command: string;
  timestamp: number | null;
}

interface HistoryStore {
  entries: HistoryEntry[];
  favorites: Set<string>;
  isLoaded: boolean;
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  historyPath: string | null;
  showFavoritesOnly: boolean;
  loadFromFile: () => Promise<void>;
  addLiveEntry: (entry: HistoryEntry) => void;
  deleteEntry: (command: string) => Promise<void>;
  clearAll: () => Promise<void>;
  toggleFavorite: (command: string) => Promise<void>;
  toggleShowFavoritesOnly: () => void;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  setSelectedIndex: (i: number) => void;
}

export const useHistoryStore = create<HistoryStore>()((set, get) => ({
  entries: [],
  favorites: new Set<string>(),
  isLoaded: false,
  isOpen: false,
  query: "",
  selectedIndex: 0,
  historyPath: null,
  showFavoritesOnly: false,

  loadFromFile: async () => {
    if (get().isLoaded) return;
    try {
      // Get history path
      const path = await invoke<string>("get_history_path");
      // Get history entries
      const items = await invoke<RawHistoryItem[]>("read_shell_history");
      // Get favorites
      const favoritesArray = await invoke<string[]>("get_favorites");
      const favorites = new Set(favoritesArray);

      // Deduplicate: keep the latest entry per normalized command
      const seen = new Map<string, HistoryEntry>();
      for (const item of items) {
        const key = item.command.toLowerCase().replace(/\s+/g, " ").trim();
        const existing = seen.get(key);
        const ts = item.timestamp ?? 0;
        if (!existing || (existing.timestamp ?? 0) < ts) {
          seen.set(key, {
            command: item.command,
            timestamp: item.timestamp ?? undefined,
            source: "file" as const,
            favorite: favorites.has(item.command),
          });
        }
      }
      const entries = Array.from(seen.values());
      set({ entries, favorites, isLoaded: true, historyPath: path });
    } catch (e) {
      logger.error("[historyStore] Failed to load shell history:", e);
      set({ isLoaded: true });
    }
  },

  addLiveEntry: (entry) =>
    set((state) => {
      // Deduplicate: remove existing entries with the same normalized command
      const normalizedNew = entry.command.toLowerCase().replace(/\s+/g, " ").trim();
      const filtered = state.entries.filter(
        (e) => e.command.toLowerCase().replace(/\s+/g, " ").trim() !== normalizedNew
      );
      // Mark as favorite if in favorites set
      const newEntry = {
        ...entry,
        favorite: state.favorites.has(entry.command),
      };
      return { entries: [...filtered, newEntry] };
    }),

  deleteEntry: async (command: string) => {
    // Optimistic removal: update UI immediately
    const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
    const removed: HistoryEntry[] = [];
    set((state) => {
      const next = state.entries.filter((e) => {
        if (e.command.toLowerCase().replace(/\s+/g, " ").trim() === normalized) {
          removed.push(e);
          return false;
        }
        return true;
      });
      return { entries: next };
    });
    // Persist removal to disk — rollback on failure
    try {
      await invoke("delete_history_entry", { command });
    } catch (e) {
      logger.error("[historyStore] Failed to delete history entry — rolling back:", e);
      if (removed.length > 0) {
        set((state) => ({ entries: [...state.entries, ...removed] }));
      }
    }
  },

  clearAll: async () => {
    try {
      await invoke("clear_history");
      set({ entries: [] });
    } catch (e) {
      logger.error("[historyStore] Failed to clear history:", e);
    }
  },

  toggleFavorite: async (command: string) => {
    const { favorites } = get();
    const isFavorite = favorites.has(command);

    try {
      if (isFavorite) {
        await invoke("remove_favorite", { command });
        set((state) => {
          const newFavorites = new Set(state.favorites);
          newFavorites.delete(command);
          return {
            favorites: newFavorites,
            entries: state.entries.map((e) =>
              e.command === command ? { ...e, favorite: false } : e
            ),
          };
        });
      } else {
        await invoke("add_favorite", { command });
        set((state) => {
          const newFavorites = new Set(state.favorites);
          newFavorites.add(command);
          return {
            favorites: newFavorites,
            entries: state.entries.map((e) =>
              e.command === command ? { ...e, favorite: true } : e
            ),
          };
        });
      }
    } catch (e) {
      logger.error("[historyStore] Failed to toggle favorite:", e);
    }
  },

  toggleShowFavoritesOnly: () =>
    set((state) => ({
      showFavoritesOnly: !state.showFavoritesOnly,
      selectedIndex: 0,
    })),

  open: () => set({ isOpen: true, query: "", selectedIndex: 0 }),
  close: () => set({ isOpen: false, query: "", selectedIndex: 0, showFavoritesOnly: false }),
  setQuery: (q) => set({ query: q, selectedIndex: 0 }),
  setSelectedIndex: (i) => set({ selectedIndex: i }),
}));

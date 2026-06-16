import { LazyStore } from "@tauri-apps/plugin-store";
import type { StateStorage } from "zustand/middleware";

/**
 * zustand persist storage adapter backed by `tauri-plugin-store`.
 *
 * dev (vite origin) and built (tauri:// origin) share localStorage *separately*,
 * so persisting through the Tauri plugin (filesystem-backed) keeps both paths
 * pointing at the same data file.
 *
 * One file per logical store keeps debugging tractable; collapsing every
 * persisted slice into one file would make hand-edits during incidents painful.
 *
 * @param fileName        Store filename under app data dir (e.g. "prompts.json").
 * @param migrateFromLocal If set, before the first getItem, copies the value at
 *                        this localStorage key into the Tauri store (when the
 *                        Tauri store has nothing for that key) and clears the
 *                        localStorage entry. Awaited so persist hydrates with
 *                        the migrated data instead of an empty initial state.
 */
export function createTauriStateStorage(
  fileName: string,
  migrateFromLocal?: { key: string },
): StateStorage {
  const store = new LazyStore(fileName);

  let migrationPromise: Promise<void> | null = null;
  const ensureMigrated = (): Promise<void> => {
    if (!migrateFromLocal) return Promise.resolve();
    migrationPromise ??= (async () => {
      try {
        if (typeof window === "undefined" || !window.localStorage) return;
        const legacy = window.localStorage.getItem(migrateFromLocal.key);
        if (legacy === null) return;

        const existing = await store.get<string>(migrateFromLocal.key);
        if (typeof existing === "string") return;

        await store.set(migrateFromLocal.key, legacy);
        await store.save();
        window.localStorage.removeItem(migrateFromLocal.key);
      } catch {
        // Best-effort migration. If it fails the user just keeps the legacy
        // localStorage copy on that origin.
      }
    })();
    return migrationPromise;
  };

  return {
    getItem: async (name) => {
      await ensureMigrated();
      const v = await store.get<string>(name);
      return typeof v === "string" ? v : null;
    },
    setItem: async (name, value) => {
      await ensureMigrated();
      await store.set(name, value);
      await store.save();
    },
    removeItem: async (name) => {
      await ensureMigrated();
      await store.delete(name);
      await store.save();
    },
  };
}

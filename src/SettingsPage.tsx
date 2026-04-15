import { useEffect } from "react";
import { useThemeStore, applyCssTheme } from "./stores/themeStore";
import SettingsDialog from "./components/Modals/SettingsDialog";
import { useSettingsDialogStore, type SettingsCategory } from "./stores/settingsDialogStore";

/**
 * Standalone settings page rendered in a separate Tauri window.
 * Shares localStorage with the main window for Zustand persisted state.
 */
export default function SettingsPage() {
  const themeName = useThemeStore((s) => s.themeName);
  const fontSize = useThemeStore((s) => s.fontSize);

  useEffect(() => {
    const theme = useThemeStore.getState().getTheme();
    applyCssTheme(theme);
    const scale = fontSize / 12;
    document.documentElement.style.setProperty("--ui-scale", String(scale));
  }, [themeName, fontSize]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  // Sync theme changes from other windows via localStorage
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "racemo-theme" && e.newValue) {
        try {
          const { state } = JSON.parse(e.newValue);
          if (state?.themeName) useThemeStore.getState().setTheme(state.themeName);
          if (state?.fontSize) useThemeStore.getState().setFontSize(state.fontSize);
        } catch { /* ignore parse errors */ }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // Auto-open the dialog in "fullscreen" mode for this window
  useEffect(() => {
    useSettingsDialogStore.getState().open("appearance");
  }, []);

  // Parse category from URL if present: ?category=help
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const category = params.get("category");
    if (category) {
      useSettingsDialogStore.getState().open(category as SettingsCategory);
    }
  }, []);

  return <SettingsDialog standalone />;
}

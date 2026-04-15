import { useEffect } from "react";
import { useThemeStore, applyCssTheme } from "../stores/themeStore";
import { applyThemeToAll } from "../lib/terminalRegistry";
import { useSettingsStore } from "../stores/settingsStore";
import { logger } from "../lib/logger";

/**
 * Handles theme initialization, cross-window sync, and UI scale.
 */
export function useAppTheme() {
  // Apply persisted theme on startup.
  useEffect(() => {
    const theme = useThemeStore.getState().getTheme();
    applyCssTheme(theme);
  }, []);

  // 외부 설정창에서 변경된 설정/테마를 메인 창에 즉시 동기화
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "racemo-settings") {
        useSettingsStore.persist.rehydrate();
      } else if (e.key === "racemo-theme" && e.newValue) {
        try {
          const { state } = JSON.parse(e.newValue);
          if (state?.themeName) useThemeStore.getState().setTheme(state.themeName);
          if (state?.fontSize) useThemeStore.getState().setFontSize(state.fontSize);
          applyCssTheme(useThemeStore.getState().getTheme());
          applyThemeToAll();
        } catch (err) { logger.warn("[App:themeSync] failed:", err); }
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Sync UI scale CSS variable with font size.
  const fontSize = useThemeStore((s) => s.fontSize);
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(fontSize / 12));
  }, [fontSize]);
}

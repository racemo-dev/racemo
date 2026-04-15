import { useEffect } from "react";
import { useThemeStore, applyCssTheme } from "./stores/themeStore";
import DiffWindow from "./components/Diff/DiffWindow";
import { logger } from "./lib/logger";

export default function DiffPage() {
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
        } catch (e) { logger.warn("[DiffPage:themeSync] failed:", e); }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return <DiffWindow />;
}

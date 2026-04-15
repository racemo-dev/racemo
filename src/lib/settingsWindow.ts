import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import type { SettingsCategory } from "../stores/settingsDialogStore";
import { useSettingsDialogStore } from "../stores/settingsDialogStore";
import { useSettingsStore } from "../stores/settingsStore";
import { isMac } from "./platform/detect";

let settingsWindow: WebviewWindow | null = null;

export async function openSettingsWindow(category?: SettingsCategory): Promise<void> {
  const mode = useSettingsStore.getState().editorMode;

  if (mode === "internal") {
    useSettingsDialogStore.getState().open(category);
    return;
  }

  // Check if already open
  if (settingsWindow) {
    try {
      await settingsWindow.setFocus();
      return;
    } catch {
      settingsWindow = null;
    }
  }

  // Double-check: destroy any leftover webview with the same label
  try {
    const existing = await import("@tauri-apps/api/webviewWindow")
      .then(m => m.WebviewWindow.getByLabel("settings"));
    if (existing) {
      await existing.destroy();
    }
  } catch { /* expected: leftover webview may not exist */ }

  const mac = isMac();
  const categoryParam = category ? `&category=${category}` : "";
  settingsWindow = new WebviewWindow("settings", {
    url: `index.html?page=settings${categoryParam}`,
    title: "Settings",
    width: 900,
    height: 680,
    center: true,
    decorations: mac,
    titleBarStyle: mac ? "overlay" : undefined,
    trafficLightPosition: mac ? new LogicalPosition(12, 18) : undefined,
    visible: false,
    resizable: true,
    minWidth: 600,
    minHeight: 400,
  });

  settingsWindow.once("tauri://webview-created", () => {
    settingsWindow?.show();
  });

  settingsWindow.once("tauri://error", () => {
    settingsWindow = null;
  });

  settingsWindow.once("tauri://destroyed", () => {
    settingsWindow = null;
  });
}

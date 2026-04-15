import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { isMac } from "./platform/detect";
import { useEditorStore } from "../stores/editorStore";
import { usePanelEditorStore } from "../stores/panelEditorStore";
import { logger } from "./logger";
import { useSettingsStore } from "../stores/settingsStore";
import { apiReadTextFile, isRemoteSession, remoteApiNotify } from "./bridge";

let editorWindow: WebviewWindow | null = null;

export async function openEditorWindow(filePath?: string): Promise<void> {
  const mode = useSettingsStore.getState().editorMode;

  if (mode === "internal") {
    await openEditorModal(filePath);
    return;
  }

  await openEditorExternalWindow(filePath);
}

async function openEditorModal(filePath?: string): Promise<void> {
  const store = useEditorStore.getState();

  if (filePath) {
    const existing = store.tabs.findIndex((t) => t.path === filePath);
    if (existing >= 0) {
      store.setActiveIndex(existing);
      await store.reloadTabByPath(filePath);
    } else {
      try {
        const content = await apiReadTextFile(filePath);
        const name = filePath.split(/[\\/]/).pop() ?? filePath;
        store.openTab(filePath, name, content);
      } catch (e) {
        logger.error("Failed to open file:", e);
      }
    }
  }

  store.setModalOpen(true);
}

export async function openEditorPanel(filePath?: string): Promise<void> {
  const store = usePanelEditorStore.getState();

  if (filePath) {
    // Notify host to also open the file when we're a remote client
    if (isRemoteSession()) {
      remoteApiNotify("open_editor", { path: filePath }).catch(() => {/* best-effort */});
    }

    const existing = store.tabs.findIndex((t) => t.path === filePath);
    if (existing >= 0) {
      store.setActiveIndex(existing);
      await store.reloadTabByPath(filePath);
    } else {
      try {
        const content = await apiReadTextFile(filePath);
        const name = filePath.split(/[\\/]/).pop() ?? filePath;
        store.openTab(filePath, name, content);
      } catch (e) {
        logger.error("Failed to open file:", e);
      }
    }
  }

  store.setPanelOpen(true);
}

/** Notify host to close a file in the editor panel (remote → host sync). */
export function notifyRemoteEditorClose(filePath: string): void {
  if (isRemoteSession()) {
    remoteApiNotify("close_editor", { path: filePath }).catch(() => {/* best-effort */});
  }
}

export async function openEditorExternalWindow(filePath?: string, explicit = false): Promise<void> {
  const fileParam = filePath ? `&file=${encodeURIComponent(filePath)}` : "";
  const explicitParam = explicit ? "&explicit=1" : "";

  if (editorWindow) {
    try {
      if (filePath) {
        await editorWindow.emit("editor:open-file", { path: filePath });
      }
      await editorWindow.setFocus();
      return;
    } catch {
      editorWindow = null;
    }
  }

  const mac = isMac();
  editorWindow = new WebviewWindow("editor", {
    url: `index.html?page=editor${fileParam}${explicitParam}`,
    title: "",
    width: 1000,
    height: 720,
    center: true,
    decorations: mac,
    titleBarStyle: mac ? "overlay" : undefined,
    trafficLightPosition: mac ? new LogicalPosition(12, 18) : undefined,
    visible: false,
    resizable: true,
    minWidth: 500,
    minHeight: 300,
  });

  editorWindow.once("tauri://webview-created", () => {
    editorWindow?.show();
  });

  editorWindow.once("tauri://destroyed", () => {
    editorWindow = null;
  });
}

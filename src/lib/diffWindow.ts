import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { isMac } from "./platform/detect";

let diffWindow: WebviewWindow | null = null;

export async function openDiffWindow(cwd: string, filePath: string, staged: boolean): Promise<void> {
  const cwdParam = encodeURIComponent(cwd);
  const fileParam = encodeURIComponent(filePath);
  const stagedParam = staged ? "1" : "0";

  if (diffWindow) {
    try {
      await diffWindow.emit("diff:view-file", { cwd, filePath, staged });
      await diffWindow.setFocus();
      return;
    } catch {
      diffWindow = null;
    }
  }

  const mac = isMac();
  diffWindow = new WebviewWindow("diff", {
    url: `index.html?page=diff&cwd=${cwdParam}&file=${fileParam}&staged=${stagedParam}`,
    title: "",
    width: 900,
    height: 680,
    center: true,
    decorations: mac,
    titleBarStyle: mac ? "overlay" : undefined,
    trafficLightPosition: mac ? new LogicalPosition(12, 18) : undefined,
    visible: false,
    resizable: true,
    minWidth: 500,
    minHeight: 300,
  });

  diffWindow.once("tauri://webview-created", () => {
    diffWindow?.show();
  });

  diffWindow.once("tauri://destroyed", () => {
    diffWindow = null;
  });
}

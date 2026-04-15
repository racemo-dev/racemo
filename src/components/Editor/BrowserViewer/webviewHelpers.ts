import { useEffect } from "react";
import { isMac, isWindows } from "../../../lib/osUtils";
import { logger } from "../../../lib/logger";
import type { WebviewHandle } from "./types";

// Persistent webview registry -- survives React mount/unmount cycles
export const webviewRegistry = new Map<string, WebviewHandle>();
// Navigation lock per id -- prevents concurrent navigations
export const navLocks = new Map<string, boolean>();
// Creation lock -- prevents duplicate webview creation
const createLocks = new Map<string, Promise<WebviewHandle>>();

export function toLabel(id: string): string {
  return "bw" + id.replace(/[^a-zA-Z0-9\-_]/g, "-").slice(0, 50);
}

async function createWebview(
  label: string,
  url: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<WebviewHandle> {
  const { Webview } = await import("@tauri-apps/api/webview");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");

  try {
    const old = await Webview.getByLabel(label);
    if (old) { await old.close().catch(() => {}); await new Promise((r) => setTimeout(r, 50)); }
  } catch { /* expected: leftover webview may not exist */ }

  const bgColor = getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim() || "#1e1e1e";
  const win = getCurrentWindow();
  const wv = new Webview(win, label, {
    url, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    transparent: false, focus: false, backgroundColor: bgColor,
    userAgent: isMac()
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
      : isWindows()
        ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
        : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  await new Promise<void>((resolve) => {
    wv.once("tauri://created", () => resolve());
    wv.once("tauri://error", (e) => { logger.warn("[BrowserViewer] webview error:", e); resolve(); });
    setTimeout(resolve, 5000);
  });

  return {
    label,
    close: () => wv.close(),
    setPosition: (x, y) => wv.setPosition(new LogicalPosition(x, y)),
    setSize: (w, h) => wv.setSize(new LogicalSize(w, h)),
  };
}

export async function getOrCreateWebview(
  id: string,
  url: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<WebviewHandle> {
  const existing = webviewRegistry.get(id);
  if (existing) {
    await existing.setPosition(rect.x, rect.y).catch(() => {});
    await existing.setSize(rect.width, rect.height).catch(() => {});
    return existing;
  }
  // Deduplicate concurrent creation requests
  const pending = createLocks.get(id);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const label = toLabel(id);
      const handle = await createWebview(label, url, rect);
      webviewRegistry.set(id, handle);
      return handle;
    } finally {
      createLocks.delete(id);
    }
  })();
  createLocks.set(id, promise);
  return promise;
}

export function hideWebview(id: string) {
  const wv = webviewRegistry.get(id);
  if (wv) wv.setPosition(-9999, -9999).catch(() => {});
}

/** Destroy a webview permanently (on tab close) */
export function destroyBrowserWebview(id: string) {
  const wv = webviewRegistry.get(id);
  if (wv) { wv.close().catch(() => {}); webviewRegistry.delete(id); }
}

/** Notify browser webviews to hide (call when modal opens) */
export function notifyBrowserHide() {
  window.dispatchEvent(new Event("browser-webview-hide"));
}

/** Notify browser webviews to restore (call when modal closes) */
export function notifyBrowserShow() {
  window.dispatchEvent(new Event("browser-webview-show"));
}

/** Render this component inside a modal to auto-hide/show browser webviews. */
export function BrowserHideGuard() {
  useEffect(() => {
    if (webviewRegistry.size === 0) return;
    const timer = setTimeout(notifyBrowserHide, 80);
    return () => { clearTimeout(timer); notifyBrowserShow(); };
  }, []);
  return null;
}

/** Hide all browser webviews */
export function hideAllBrowserWebviews() {
  for (const [, wv] of webviewRegistry) {
    wv.setPosition(-9999, -9999).catch(() => {});
  }
}

/** Destroy all browser webviews (on panel close) */
export function destroyAllBrowserWebviews() {
  for (const [, wv] of webviewRegistry) {
    wv.close().catch(() => {});
  }
  webviewRegistry.clear();
}

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { useThemeStore } from "../stores/themeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { installAtlasMergeWorkaround, invalidateAtlasTextures, scrubAtlasAfterClear } from "./webglAtlasFix";
import { logger } from "./logger";

export interface RemoteTerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  webglAddon: WebglAddon | null;
  container: HTMLDivElement;
}

const registry = new Map<string, RemoteTerminalEntry>();

function getTerminalOptions(): ConstructorParameters<typeof Terminal>[0] {
  const theme = useThemeStore.getState().getTheme();
  const { fontSize } = useThemeStore.getState();
  const settings = useSettingsStore.getState();
  return {
    fontFamily: settings.fontFamily,
    fontSize,
    convertEol: false,
    scrollback: settings.scrollback,
    scrollSensitivity: 0.5,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    allowProposedApi: true,
    rescaleOverlappingGlyphs: true,
    lineHeight: 1.1,
    fontWeightBold: 570,
    theme: theme.terminal,
  };
}

/**
 * Get or create a remote Terminal instance for the given remotePaneId.
 */
export function getOrCreateRemoteTerminal(remotePaneId: string): RemoteTerminalEntry & { isNew: boolean } {
  const existing = registry.get(remotePaneId);
  if (existing) return { ...existing, isNew: false };

  const terminal = new Terminal(getTerminalOptions());
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";

  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";

  terminal.open(container);

  // 4-click or Ctrl+double-click: select block bounded by prompt lines or empty lines
  const selectBlock = (e: MouseEvent) => {
    const isQuadClick = e.detail >= 4;
    const isCtrlDblClick = e.detail === 2 && e.ctrlKey && !e.altKey && !e.metaKey;
    if (!isQuadClick && !isCtrlDblClick) return;
    e.preventDefault();

    const buffer = terminal.buffer.active;
    const screenEl = container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screenEl) return;

    const rect = screenEl.getBoundingClientRect();
    const cellHeight = screenEl.clientHeight / terminal.rows;
    const clickedViewportRow = Math.floor((e.clientY - rect.top) / cellHeight);
    const absoluteRow = clickedViewportRow + buffer.viewportY;

    const clickedLine = buffer.getLine(absoluteRow);
    if (!clickedLine || clickedLine.translateToString(true).trim() === "") return;

    const isPromptLine = (text: string): boolean => {
      const t = text.trim();
      if (!t) return false;
      if (/(?:^|\s|[~\w])[$%#❯➜]\s/.test(t)) return true;
      if (/(?:^|\s|[~\w])[$%#❯➜]\s*$/.test(t)) return true;
      if (/[A-Za-z]:\\[^<]*>\s*$/.test(t)) return true;
      return false;
    };

    const clickedText = clickedLine.translateToString(true);

    let startRow = absoluteRow;
    if (!isPromptLine(clickedText)) {
      while (startRow > 0) {
        const above = buffer.getLine(startRow - 1);
        if (!above) break;
        const aboveText = above.translateToString(true);
        if (aboveText.trim() === "") break;
        startRow--;
        if (isPromptLine(aboveText)) break;
      }
    }

    let endRow = absoluteRow;
    while (endRow < buffer.length - 1) {
      const below = buffer.getLine(endRow + 1);
      if (!below) break;
      const belowText = below.translateToString(true);
      if (belowText.trim() === "") {
        const nextBelow = buffer.getLine(endRow + 2);
        if (!nextBelow || nextBelow.translateToString(true).trim() === "") break;
      }
      if (isPromptLine(belowText)) break;
      endRow++;
    }

    terminal.selectLines(startRow, endRow);
  };
  container.addEventListener("mousedown", selectBlock);
  container.addEventListener("dblclick", selectBlock);

  // Clipboard: Ctrl+Shift+C/V, Ctrl+C (copy if selection), Ctrl+V
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;

    const isCtrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const isCtrlShift = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;

    if (isCtrlShift && e.code === "KeyC") {
      e.preventDefault();
      const selection = terminal.getSelection();
      if (selection) writeText(selection).catch(logger.error);
      return false;
    }
    if (isCtrlShift && e.code === "KeyV") {
      e.preventDefault();
      readText().then((text) => { if (text) terminal.paste(text); }).catch(logger.error);
      return false;
    }
    if (isCtrl && !e.shiftKey && e.code === "KeyC") {
      const selection = terminal.getSelection();
      if (selection) {
        e.preventDefault();
        writeText(selection).catch(logger.error);
        terminal.clearSelection();
        return false;
      }
      return true;
    }
    if (isCtrl && !e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      readText().then((text) => { if (text) terminal.paste(text); }).catch(logger.error);
      return false;
    }
    return true;
  });

  const entry: RemoteTerminalEntry = { terminal, fitAddon, webglAddon: null, container };
  registry.set(remotePaneId, entry);

  // Defer WebGL addon init; on context loss, retry up to twice before
  // falling back to Canvas2D permanently. Mirrors terminalRegistry behavior
  // to recover from Chromium/Nvidia atlas corruption after sleep/wake.
  const loadWebgl = (retryCount: number) => {
    // Identity check guards against remotePaneId reuse between dispose and timer fire.
    if (registry.get(remotePaneId) !== entry) return;
    try {
      const addon = new WebglAddon();
      installAtlasMergeWorkaround(addon);
      addon.onContextLoss(() => {
        logger.warn(`[remoteTerminalRegistry] WebGL context lost (retry ${retryCount}/2)`);
        try { addon.dispose(); } catch { /* already disposed */ }
        entry.webglAddon = null;
        if (retryCount < 2 && registry.get(remotePaneId) === entry) {
          setTimeout(() => loadWebgl(retryCount + 1), 200);
        }
      });
      terminal.loadAddon(addon);
      entry.webglAddon = addon;
      if (Number.isFinite(terminal.rows) && terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    } catch (e) {
      logger.warn("[remoteTerminalRegistry] WebGL addon load failed:", e);
    }
  };
  setTimeout(() => loadWebgl(0), 0);

  return { ...entry, isNew: true };
}

export function getRemoteTerminal(remotePaneId: string): RemoteTerminalEntry | undefined {
  return registry.get(remotePaneId);
}

export function disposeRemoteTerminal(remotePaneId: string): void {
  const entry = registry.get(remotePaneId);
  if (entry) {
    entry.terminal.dispose();
    registry.delete(remotePaneId);
  }
}

export function disposeRemoteTerminals(paneIds: string[]): void {
  for (const id of paneIds) {
    const entry = registry.get(id);
    if (entry) {
      entry.terminal.dispose();
      registry.delete(id);
    }
  }
}

export function disposeAllRemoteTerminals(): void {
  for (const entry of registry.values()) {
    entry.terminal.dispose();
  }
  registry.clear();
}

export function applyThemeToAllRemote(): void {
  const theme = useThemeStore.getState().getTheme();
  for (const entry of registry.values()) {
    entry.terminal.options.theme = theme.terminal;
  }
}

export function applyFontSizeToAllRemote(): void {
  const { fontSize } = useThemeStore.getState();
  for (const entry of registry.values()) {
    entry.terminal.options.fontSize = fontSize;
    entry.fitAddon.fit();
  }
}

export function applySettingsToAllRemote(opts: {
  fontFamily?: string;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  scrollback?: number;
}): void {
  for (const entry of registry.values()) {
    if (opts.fontFamily !== undefined) entry.terminal.options.fontFamily = opts.fontFamily;
    if (opts.cursorStyle !== undefined) entry.terminal.options.cursorStyle = opts.cursorStyle;
    if (opts.cursorBlink !== undefined) entry.terminal.options.cursorBlink = opts.cursorBlink;
    if (opts.scrollback !== undefined) entry.terminal.options.scrollback = opts.scrollback;
    entry.fitAddon.fit();
  }
}

/**
 * Heavy recovery for one remote terminal — dispose + recreate WebglAddon.
 * Mirror of `recoverTerminal` in terminalRegistry; see there for rationale.
 */
export function recoverRemoteTerminal(remotePaneId: string): boolean {
  const entry = registry.get(remotePaneId);
  if (!entry) return false;

  if (entry.webglAddon) {
    try {
      // Manual-only full reset of the shared atlas cache; see recoverTerminal
      // in terminalRegistry for rationale.
      entry.webglAddon.clearTextureAtlas();
      scrubAtlasAfterClear(entry.webglAddon);
    } catch (e) {
      logger.warn("[remoteTerminalRegistry] recoverRemoteTerminal: atlas clear failed:", e);
    }
    try {
      entry.webglAddon.dispose();
    } catch (e) {
      logger.warn("[remoteTerminalRegistry] recoverRemoteTerminal: dispose failed:", e);
    }
    entry.webglAddon = null;
  }

  try {
    const addon = new WebglAddon();
    installAtlasMergeWorkaround(addon);
    addon.onContextLoss(() => {
      try { addon.dispose(); } catch { /* already disposed */ }
      if (registry.get(remotePaneId) === entry) entry.webglAddon = null;
    });
    entry.terminal.loadAddon(addon);
    entry.webglAddon = addon;
  } catch (e) {
    logger.error("[remoteTerminalRegistry] recoverRemoteTerminal: WebGL re-init failed, staying on Canvas2D:", e);
  }

  if (Number.isFinite(entry.terminal.rows) && entry.terminal.rows > 0) {
    try {
      entry.terminal.refresh(0, entry.terminal.rows - 1);
    } catch (e) {
      logger.warn("[remoteTerminalRegistry] recoverRemoteTerminal: refresh failed:", e);
    }
  }
  return true;
}

/**
 * Heavy recovery for ALL remote terminals. Returns number processed.
 */
export function recoverAllRemoteTerminals(): number {
  let count = 0;
  for (const id of Array.from(registry.keys())) {
    if (recoverRemoteTerminal(id)) count++;
  }
  return count;
}

/**
 * Refresh ALL remote terminals — re-upload atlas textures + redraw, same
 * gentle recovery as the local registry (no shared-cache wipe; see
 * refreshTerminal in terminalRegistry for rationale).
 *
 * Returns the number of terminals refreshed (used for toast confirmation).
 */
export function refreshAllRemoteTerminals(): number {
  let count = 0;
  for (const entry of registry.values()) {
    if (entry.webglAddon) {
      invalidateAtlasTextures(entry.webglAddon);
    }
    if (Number.isFinite(entry.terminal.rows) && entry.terminal.rows > 0) {
      try {
        entry.terminal.refresh(0, entry.terminal.rows - 1);
        count++;
      } catch (e) {
        logger.warn("[remoteTerminalRegistry] refreshAllRemoteTerminals: refresh failed:", e);
      }
    }
  }
  return count;
}

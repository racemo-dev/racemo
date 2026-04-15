import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { useThemeStore } from "../stores/themeStore";
import { useSettingsStore } from "../stores/settingsStore";

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
      if (selection) writeText(selection).catch(console.error);
      return false;
    }
    if (isCtrlShift && e.code === "KeyV") {
      e.preventDefault();
      readText().then((text) => { if (text) terminal.paste(text); }).catch(console.error);
      return false;
    }
    if (isCtrl && !e.shiftKey && e.code === "KeyC") {
      const selection = terminal.getSelection();
      if (selection) {
        e.preventDefault();
        writeText(selection).catch(console.error);
        terminal.clearSelection();
        return false;
      }
      return true;
    }
    if (isCtrl && !e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      readText().then((text) => { if (text) terminal.paste(text); }).catch(console.error);
      return false;
    }
    return true;
  });

  const entry: RemoteTerminalEntry = { terminal, fitAddon, webglAddon: null, container };
  registry.set(remotePaneId, entry);

  // Defer WebGL addon init
  setTimeout(() => {
    try {
      const addon = new WebglAddon();
      terminal.loadAddon(addon);
      entry.webglAddon = addon;
    } catch {
      // WebGL not available
    }
  }, 0);

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

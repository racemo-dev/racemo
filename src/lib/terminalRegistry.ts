import { Terminal } from "@xterm/xterm";
import { getXTermCore } from "./xtermInternal";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { writeText, readText, readImage } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { createLinkProviderWithTerminal } from "./linkDetector";
import { useThemeStore } from "../stores/themeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useHistoryStore } from "../stores/historyStore";
import { useSessionStore } from "../stores/sessionStore";
import { type IMEInterceptor, createIMEInterceptor } from "./platform";
import { isShellIntegrationActive } from "./commandTracker";
import { installAtlasMergeWorkaround, invalidateAtlasTextures, scrubAtlasAfterClear, getAtlasFixFireCount } from "./webglAtlasFix";
import { useToastStore } from "../stores/toastStore";
import { getGitT } from "./i18n/git";
import { logger } from "./logger";

export interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  webglAddon: WebglAddon | null;
  container: HTMLDivElement;
  ime: IMEInterceptor;
}

const registry = new Map<string, TerminalEntry>();

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
    fastScrollSensitivity: 1,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    allowProposedApi: true,
    rescaleOverlappingGlyphs: true,
    lineHeight: 1.1,
    fontWeight: 400,
    fontWeightBold: 500,
    theme: theme.terminal,
  };
}

/**
 * Paste with clipboard image detection.
 */
async function pasteWithImageCheck(terminal: Terminal): Promise<void> {
  try {
    const rgba = await readImage();
    if (rgba) {
      const toast = useToastStore.getState();
      const ptyId = getPtyIdByTerminal(terminal) ?? "";
      toast.showProgress(getGitT("terminal.imageSaving"), ptyId);
      try {
        const [bytes, size] = await Promise.all([rgba.rgba(), rgba.size()]);
        const dataArray = Array.from(bytes);
        const path: string = await invoke("save_clipboard_image", {
          data: dataArray,
          width: size.width,
          height: size.height,
        });
        toast.resolveProgress("success", getGitT("terminal.imageSaved"));
        terminal.paste(path);
      } catch (saveErr) {
        toast.resolveProgress("error", getGitT("terminal.imageFailed"));
        logger.warn("[terminalRegistry] Failed to save clipboard image:", saveErr);
      }
      return;
    }
  } catch (err) {
    logger.warn("[terminalRegistry] Failed to read clipboard image:", err);
  }
  const text = await readText();
  if (text) terminal.paste(text);
}

/**
 * Get or create a Terminal instance for the given ptyId.
 */
export function getOrCreateTerminal(ptyId: string): TerminalEntry & { isNew: boolean } {
  const existing = registry.get(ptyId);
  if (existing) return { ...existing, isNew: false };

  const terminal = new Terminal(getTerminalOptions());
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
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

    // Detect shell prompt boundary: $ % # ❯ ➜ > preceded by whitespace, ~, word char, or line start
    const isPromptLine = (text: string): boolean => {
      const t = text.trim();
      if (!t) return false;
      // Unix/zsh/fish/PS prompts: $ % # ❯ ➜ — can appear mid-line (e.g. "~/path $ cmd")
      if (/(?:^|\s|[~\w])[$%#❯➜]\s/.test(t)) return true;
      if (/(?:^|\s|[~\w])[$%#❯➜]\s*$/.test(t)) return true;
      // Windows CMD prompt: drive letter + colon + path + ">" (e.g. "C:\Users\foo>").
      // Excludes angle-bracket tokens like "<DIR>" in "dir" output.
      if (/[A-Za-z]:\\[^<]*>\s*$/.test(t)) return true;
      return false;
    };

    const clickedText = clickedLine.translateToString(true);

    // Expand upward: if not on a prompt line, search upward for the command line
    let startRow = absoluteRow;
    if (!isPromptLine(clickedText)) {
      while (startRow > 0) {
        const above = buffer.getLine(startRow - 1);
        if (!above) break;
        const aboveText = above.translateToString(true);
        if (aboveText.trim() === "") break;  // empty line = hard boundary
        startRow--;
        if (isPromptLine(aboveText)) break;  // found command line, include and stop
      }
    }

    // Expand downward: stop at 2+ consecutive empty lines or next prompt line.
    // Single blank lines are skipped to handle CMD output (e.g. "dir") which
    // inserts blank lines between file entries.
    let endRow = absoluteRow;
    while (endRow < buffer.length - 1) {
      const below = buffer.getLine(endRow + 1);
      if (!below) break;
      const belowText = below.translateToString(true);
      if (belowText.trim() === "") {
        // Single blank line: peek one more row; stop only if next is also blank
        const nextBelow = buffer.getLine(endRow + 2);
        if (!nextBelow || nextBelow.translateToString(true).trim() === "") break;
        // Otherwise skip this lone blank line and continue
      }
      if (isPromptLine(belowText)) break;
      endRow++;
    }

    terminal.selectLines(startRow, endRow);
  };
  container.addEventListener("mousedown", selectBlock);
  container.addEventListener("dblclick", selectBlock);

  // Initialize modular IME interceptor
  const ime = createIMEInterceptor(terminal, container);

  // Disable focus tracking mode (DECRST 1004)
  terminal.write("\x1b[?1004l");

  // Handle custom key events (Ctrl+C/V, etc.)
  // Note: Most of this was commented out in previous tasks.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;

    const isCtrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const isCtrlShift = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;

    // Ctrl+Shift+C: always copy
    if (isCtrlShift && e.code === "KeyC") {
      e.preventDefault();
      const selection = terminal.getSelection();
      if (selection) {
        writeText(selection).catch(logger.error);
      }
      return false;
    }

    // Ctrl+Shift+V: always paste
    if (isCtrlShift && e.code === "KeyV") {
      e.preventDefault();
      pasteWithImageCheck(terminal).catch(logger.error);
      return false;
    }

    // Ctrl+C: copy if selection exists, otherwise let it through as SIGINT
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

    // Ctrl+V: paste
    if (isCtrl && !e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      pasteWithImageCheck(terminal).catch(logger.error);
      return false;
    }

    // Ctrl+= / Ctrl+- / Ctrl+0 or Cmd+= / Cmd+- / Cmd+0: font size zoom handled by App.tsx.
    // Prevent PTY passthrough so CMD doesn't echo '=' / '-' characters.
    if ((isCtrl || (e.metaKey && !e.ctrlKey && !e.altKey)) && !e.shiftKey && (e.code === "Equal" || e.code === "Minus" || e.code === "Digit0")) {
      return false;
    }

    // Enter key: save command to history (fallback for shells without OSC 133)
    // Only when NOT in application cursor mode (vim, less, etc.)
    if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.shiftKey) {
        // Shift+Enter → newline instead of carriage return
        e.preventDefault();
        const encoder = new TextEncoder();
        const bytes = Array.from(encoder.encode("\n"));
        invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(logger.error);
        return false;
      }

      const isAppMode = terminal.modes.applicationCursorKeysMode;
      if (!isAppMode) {
        // Get current line text from terminal buffer
        const buffer = terminal.buffer.active;
        const cursorY = buffer.cursorY + buffer.viewportY;
        const line = buffer.getLine(cursorY);
        if (line) {
          const lineText = line.translateToString(true).trim();
          // Save non-empty commands (skip if looks like output or prompt-only)
          if (lineText.length > 0 && !lineText.match(/^[$>#%]\s*$/)) {
            // Extract command part (remove common prompt prefixes)
            const command = lineText
              .replace(/^.*?[$>#%]\s*/, "") // Remove prompt prefix
              .trim();
            if (command.length > 0) {
              // Skip immediate saving if shell integration (OSC 133) is active.
              // commandTracker.ts will handle saving after successful completion.
              if (!isShellIntegrationActive(ptyId)) {
                // Save to history store and file (fallback for non-integrated shells)
                const { activeSessionId, paneCwds } = useSessionStore.getState();
                useHistoryStore.getState().addLiveEntry({
                  command,
                  timestamp: Date.now(),
                  source: "live",
                  sessionId: activeSessionId ?? undefined,
                  cwd: paneCwds[ptyId],
                });
                invoke("write_racemo_history", { command }).catch((err) => {
                  logger.warn("[terminalRegistry] Failed to save history:", err);
                });
              }
            }
          }
        }
      }
    }

    return true;
  });

  // Register clickable link detection
  terminal.registerLinkProvider(createLinkProviderWithTerminal(terminal, ptyId));

  const entry: TerminalEntry = { terminal, fitAddon, searchAddon, webglAddon: null, container, ime };
  registry.set(ptyId, entry);

  // Defer WebGL addon init so Canvas2D renders immediately.
  // After loading, refresh all rows so CJK glyphs rendered by Canvas2D
  // are properly re-rendered by the WebGL texture atlas.
  const loadWebgl = (retryCount: number) => {
    // Identity check (not just registry.has) — if the ptyId was reused for a
    // new terminal between the dispose and this timer firing, we must not
    // attach a stale addon to it.
    if (registry.get(ptyId) !== entry) return;
    try {
      const addon = new WebglAddon();
      installAtlasMergeWorkaround(addon);
      addon.onContextLoss(() => {
        // Chromium/Nvidia loses the GL context after OS sleep or driver hiccups.
        // Without a retry, the renderer would silently fall back to Canvas2D
        // and never recover until app restart.
        logger.warn(`[terminalRegistry] WebGL context lost (retry ${retryCount}/2)`);
        try { addon.dispose(); } catch { /* already disposed */ }
        entry.webglAddon = null;
        if (retryCount < 2 && registry.get(ptyId) === entry) {
          setTimeout(() => loadWebgl(retryCount + 1), 200);
        }
      });
      terminal.loadAddon(addon);
      entry.webglAddon = addon;
      if (Number.isFinite(terminal.rows) && terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    } catch (e) {
      logger.error("[terminalRegistry] Failed to load WebGL addon:", e);
      // WebGL not available, keep using Canvas2D
    }
  };
  setTimeout(() => loadWebgl(0), 0);

  return { ...entry, isNew: true };
}

export function getTerminal(ptyId: string): TerminalEntry | undefined {
  return registry.get(ptyId);
}

export function getPtyIdByTerminal(terminal: Terminal): string | undefined {
  for (const [ptyId, entry] of registry.entries()) {
    if (entry.terminal === terminal) return ptyId;
  }
  return undefined;
}

export function disposeTerminal(ptyId: string): void {
  const entry = registry.get(ptyId);
  if (entry) {
    entry.ime.dispose();
    entry.terminal.dispose();
    registry.delete(ptyId);
  }
}

export function applyThemeToAll(): void {
  const theme = useThemeStore.getState().getTheme();
  for (const entry of registry.values()) {
    entry.terminal.options.theme = theme.terminal;
    entry.ime.refresh();
  }
}

export function applyFontSizeToAll(): void {
  const { fontSize } = useThemeStore.getState();
  for (const entry of registry.values()) {
    entry.terminal.options.fontSize = fontSize;
    entry.ime.refresh();
    entry.fitAddon.fit();
    if (Number.isFinite(entry.terminal.rows) && entry.terminal.rows > 0) {
      entry.terminal.refresh(0, entry.terminal.rows - 1);
    }
  }
}

export function clearTextureAtlas(ptyId: string): void {
  const entry = registry.get(ptyId);
  if (entry?.webglAddon) {
    entry.webglAddon.clearTextureAtlas();
  }
}

/**
 * Force refresh a specific terminal: re-upload all atlas page textures and
 * redraw. Recovers from stale GPU textures (sleep/wake, GPU drift) WITHOUT
 * wiping the shared glyph cache.
 *
 * Deliberately NOT clearTextureAtlas(): the atlas is shared across terminals,
 * and 0.19.0's clearTexture leaves stale glyph bookkeeping on its pages. With
 * focus/visibility handlers calling this for every pane, automatic cache
 * wipes caused clear→refill→merge churn, and a later merge could then delete
 * the wrong page (indexes derived from stale glyphs) — permanently corrupting
 * live cache entries into multi-glyph "franken" stripes. Cache wipes are
 * reserved for the manual heavy recovery path (recoverTerminal).
 */
export function refreshTerminal(ptyId: string): void {
  const entry = registry.get(ptyId);
  if (entry) {
    if (entry.webglAddon) {
      invalidateAtlasTextures(entry.webglAddon);
    }
    if (Number.isFinite(entry.terminal.rows) && entry.terminal.rows > 0) {
      entry.terminal.refresh(0, entry.terminal.rows - 1);
    }
  }
}

/**
 * Heavy recovery: dispose & recreate the WebglAddon for one terminal.
 * Use this when `refreshTerminal()` / `clearTextureAtlas()` are not enough —
 * the GL context may be soft-degraded (no onContextLoss fired) or the addon's
 * internal glyph→slot cache may be desynced from the texture. Recreating the
 * addon is what a window resize does implicitly and is the most reliable
 * recovery path. Cost: ~1 frame of Canvas2D fallback while the new addon
 * attaches. Falls back to Canvas2D permanently if re-init throws.
 */
export function recoverTerminal(ptyId: string): boolean {
  const entry = registry.get(ptyId);
  if (!entry) return false;

  if (entry.webglAddon) {
    try {
      // Full reset of the SHARED atlas cache: re-rasterizes every glyph, the
      // only cure once cache entries themselves are corrupted (e.g. by a bad
      // page merge). Safe here because this path is manual-only; the atlas
      // no-ops repeated clears until new glyphs are drawn. The scrub clears
      // the stale page bookkeeping that would otherwise poison later merges.
      entry.webglAddon.clearTextureAtlas();
      scrubAtlasAfterClear(entry.webglAddon);
    } catch (e) {
      logger.warn("[terminalRegistry] recoverTerminal: atlas clear failed:", e);
    }
    try {
      entry.webglAddon.dispose();
    } catch (e) {
      logger.warn("[terminalRegistry] recoverTerminal: dispose failed:", e);
    }
    entry.webglAddon = null;
  }

  try {
    const addon = new WebglAddon();
    installAtlasMergeWorkaround(addon);
    addon.onContextLoss(() => {
      try { addon.dispose(); } catch { /* already disposed */ }
      if (registry.get(ptyId) === entry) entry.webglAddon = null;
    });
    entry.terminal.loadAddon(addon);
    entry.webglAddon = addon;
  } catch (e) {
    logger.error("[terminalRegistry] recoverTerminal: WebGL re-init failed, staying on Canvas2D:", e);
  }

  if (Number.isFinite(entry.terminal.rows) && entry.terminal.rows > 0) {
    try {
      entry.terminal.refresh(0, entry.terminal.rows - 1);
    } catch (e) {
      logger.warn("[terminalRegistry] recoverTerminal: refresh failed:", e);
    }
  }
  return true;
}

/**
 * Heavy recovery for ALL local terminals. Returns number processed.
 * Use as the manual escape hatch (Cmd/Ctrl+Shift+R) when glyph corruption
 * doesn't clear via the lighter `refreshAllTerminals` path.
 */
export function recoverAllTerminals(): number {
  let count = 0;
  for (const ptyId of Array.from(registry.keys())) {
    if (recoverTerminal(ptyId)) count++;
  }
  return count;
}

/**
 * Refresh ALL local terminals: re-upload atlas page textures + redraw.
 * Recovers stale GPU textures after sleep/wake without touching the shared
 * glyph cache (see refreshTerminal for why cache wipes are avoided here).
 *
 * Returns the number of terminals refreshed (used for toast confirmation).
 */
export function refreshAllTerminals(): number {
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
        logger.warn("[terminalRegistry] refreshAllTerminals: refresh failed:", e);
      }
    }
  }
  return count;
}

// Diagnostics for WebGL atlas state (glyph corruption debugging). Available in
// all builds — the chronic corruption only reproduces in long production
// sessions, so field inspection matters. Call `__atlasInfo()` in devtools:
// shows per-terminal atlas page count/sizes/versions, the merge threshold
// (maxPages), and how many times the merge workaround fired. If the function
// is missing, the running bundle predates it.
(window as unknown as Record<string, unknown>).__atlasInfo = () => {
  const terminals: Record<string, unknown>[] = [];
  for (const [ptyId, entry] of registry.entries()) {
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const rendererRaw = (entry.webglAddon as any)?._renderer;
      const renderer = rendererRaw?.value ?? rendererRaw;
      const atlas = renderer?._charAtlas;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (!atlas) {
        terminals.push({ ptyId, atlas: null });
        continue;
      }
      terminals.push({
        ptyId,
        maxPages: atlas.constructor?.maxAtlasPages,
        pageCount: atlas.pages.length,
        pages: atlas.pages.map((p: { canvas: HTMLCanvasElement; version: number; glyphs?: unknown[] }) => ({
          size: p.canvas.width,
          version: p.version,
          glyphs: p.glyphs?.length,
        })),
      });
    } catch (e) {
      terminals.push({ ptyId, error: String(e) });
    }
  }
  return { workaroundFires: getAtlasFixFireCount(), terminals };
};

export function getCursorPixelPosition(ptyId: string): { x: number; y: number; lineHeight: number } | null {
  const entry = registry.get(ptyId);
  if (!entry) return null;
  const { terminal, container } = entry;

  const core = getXTermCore(terminal);
  const dimensions = core?.dimensions || core?._renderService?.dimensions;

  let cellWidth: number;
  let cellHeight: number;

  if (dimensions?.css?.cell) {
    cellWidth = dimensions.css.cell.width;
    cellHeight = dimensions.css.cell.height;
  } else {
    const screenEl = container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screenEl) return null;
    cellWidth = screenEl.clientWidth / terminal.cols;
    cellHeight = screenEl.clientHeight / terminal.rows;
  }

  const screenEl = container.querySelector(".xterm-screen") as HTMLElement | null;
  const offsetX = screenEl?.offsetLeft || 0;
  const offsetY = screenEl?.offsetTop || 0;

  const containerRect = container.getBoundingClientRect();
  const x = terminal.buffer.active.cursorX * cellWidth + offsetX + containerRect.left;
  const y = terminal.buffer.active.cursorY * cellHeight + offsetY + containerRect.top;

  return { x, y, lineHeight: cellHeight };
}

export function applySettingsToAll(opts: {
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
    entry.ime.refresh();
    entry.fitAddon.fit();
    if (Number.isFinite(entry.terminal.rows) && entry.terminal.rows > 0) {
      entry.terminal.refresh(0, entry.terminal.rows - 1);
    }
  }
}

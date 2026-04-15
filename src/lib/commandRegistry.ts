import { invoke } from "@tauri-apps/api/core";
import { useThemeStore, applyCssTheme } from "../stores/themeStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useBroadcastStore } from "../stores/broadcastStore";
import { useSidebarStore } from "../stores/sidebarStore";
import { openSettingsWindow } from "./settingsWindow";
import { useSnippetStore } from "../stores/snippetStore";
import { useCommandPaletteStore } from "../stores/commandPaletteStore";
import { useRemoteStore } from "../stores/remoteStore";
import { useAuthStore } from "../stores/authStore";
import { applyThemeToAll, applyFontSizeToAll } from "./terminalRegistry";
import { applyThemeToAllRemote, applyFontSizeToAllRemote } from "./remoteTerminalRegistry";
import { firstLeafId, findPtyId, collectPtyIds } from "./paneTreeUtils";
import { getDefaultTerminalSize } from "./terminalUtils";
import { getModLabel } from "./osUtils";
import type { CommandItem } from "../types/commandPalette";
import type { Session } from "../types/session";
import { logger } from "./logger";

/** Extract {{variable}} names from a command string. */
export function extractVariables(command: string): string[] {
  const matches = command.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(2, -2).trim()))];
}

/** Replace {{variable}} placeholders with values. */
export function substituteVariables(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(/\{\{([^}]+)\}\}/g, (_, name) => values[name.trim()] ?? "");
}

/** Execute a snippet: check for variables, then write to PTY. */
export function executeSnippet(command: string): void {
  const vars = extractVariables(command);
  if (vars.length > 0) {
    useCommandPaletteStore
      .getState()
      .promptVariables(command, vars.map((name) => ({ name, value: "" })));
    return;
  }
  writeCommandToPty(command);
}

/** Write a command string to the currently focused PTY. */
export function writeCommandToPty(command: string): void {
  const { sessions, activeSessionId, focusedPaneId } = useSessionStore.getState();
  const session = sessions.find((s) => s.id === activeSessionId);
  if (!session || !focusedPaneId) return;

  const ptyId = findPtyId(session.rootPane, focusedPaneId);
  if (!ptyId) return;

  const encoder = new TextEncoder();
  const bytes = Array.from(encoder.encode(command));
  invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(logger.error);
  useCommandPaletteStore.getState().close();
}

/** Get all available commands (internal + snippets). */
export function getAllCommands(): CommandItem[] {
  const internal = getInternalCommands();
  const snippets = useSnippetStore.getState().snippets.map((s) => ({
    id: `snippet-${s.id}`,
    label: s.name,
    category: "snippet" as const,
    keywords: s.command,
    action: () => executeSnippet(s.command),
  }));
  return [...snippets, ...internal];
}

function getInternalCommands(): CommandItem[] {
  const items: CommandItem[] = [];

  // Session management
  items.push({
    id: "new-tab",
    label: "New Tab",
    category: "internal",
    shortcut: `${getModLabel()}+T`,
    keywords: "session create terminal",
    action: () => {
      const name = useSessionStore.getState().nextTabName();
      const shell = useSettingsStore.getState().defaultShell;
      const { rows, cols } = getDefaultTerminalSize();
      logger.debug(`[racemo] CommandPalette: Creating new tab "${name}" (${rows}x${cols})`);
      invoke<Session>("create_session", { name, workingDir: null, shell, rows, cols })
        .then((session) => {
          useSessionStore.getState().addSession(session);
          useSessionStore.getState().setFocusedPane(firstLeafId(session.rootPane));
        })
        .catch(logger.error);
      useCommandPaletteStore.getState().close();
    },
  });

  items.push({
    id: "close-tab",
    label: "Close Tab",
    category: "internal",
    shortcut: `${getModLabel()}+Q`,
    keywords: "session close terminal",
    action: () => {
      const { activeSessionId, removeSession, setFocusedPane } = useSessionStore.getState();
      if (!activeSessionId) return;
      removeSession(activeSessionId);
      invoke<Session | null>("close_session", { sessionId: activeSessionId })
        .then((next) => { if (next) setFocusedPane(firstLeafId(next.rootPane)); })
        .catch(logger.error);
      useCommandPaletteStore.getState().close();
    },
  });

  // Theme commands
  for (const theme of useThemeStore.getState().getThemes()) {
    items.push({
      id: `theme-${theme.name}`,
      label: `Theme: ${theme.label}`,
      category: "internal",
      keywords: "appearance color scheme dark light",
      action: () => {
        useThemeStore.getState().setTheme(theme.name);
        applyCssTheme(useThemeStore.getState().getTheme());
        applyThemeToAll();
        applyThemeToAllRemote();
        useCommandPaletteStore.getState().close();
      },
    });
  }

  // Font size
  items.push({
    id: "font-increase",
    label: "Font Size: Increase",
    category: "internal",
    shortcut: `${getModLabel()}+=`,
    keywords: "zoom bigger larger",
    action: () => {
      useThemeStore.getState().increaseFontSize();
      applyFontSizeToAll();
      applyFontSizeToAllRemote();
      useCommandPaletteStore.getState().close();
    },
  });
  items.push({
    id: "font-decrease",
    label: "Font Size: Decrease",
    category: "internal",
    shortcut: `${getModLabel()}+-`,
    keywords: "zoom smaller",
    action: () => {
      useThemeStore.getState().decreaseFontSize();
      applyFontSizeToAll();
      applyFontSizeToAllRemote();
      useCommandPaletteStore.getState().close();
    },
  });
  items.push({
    id: "font-reset",
    label: "Font Size: Reset",
    category: "internal",
    shortcut: `${getModLabel()}+0`,
    keywords: "zoom default",
    action: () => {
      useThemeStore.getState().resetFontSize();
      applyFontSizeToAll();
      applyFontSizeToAllRemote();
      useCommandPaletteStore.getState().close();
    },
  });

  // Broadcast
  items.push({
    id: "broadcast-toggle",
    label: "Broadcast: Toggle",
    category: "internal",
    shortcut: `${getModLabel()}+B`,
    keywords: "multi pane simultaneous input",
    action: () => {
      const { enabled, toggle, selectAll } = useBroadcastStore.getState();
      toggle();
      if (!enabled) {
        const { sessions, activeSessionId } = useSessionStore.getState();
        const session = sessions.find((s) => s.id === activeSessionId);
        if (session) selectAll(collectPtyIds(session.rootPane));
      }
      useCommandPaletteStore.getState().close();
    },
  });

  // Sidebar
  items.push({
    id: "toggle-explorer",
    label: "Toggle File Explorer",
    category: "internal",
    shortcut: `${getModLabel()}+Shift+E`,
    keywords: "sidebar files directory tree",
    action: () => {
      useSidebarStore.getState().togglePanel("explorer");
      useCommandPaletteStore.getState().close();
    },
  });
  items.push({
    id: "toggle-search",
    label: "Toggle Search",
    category: "internal",
    shortcut: `${getModLabel()}+Shift+F`,
    keywords: "sidebar search find grep ripgrep files",
    action: () => {
      useSidebarStore.getState().togglePanel("search");
      useCommandPaletteStore.getState().close();
    },
  });
  items.push({
    id: "toggle-git",
    label: "Toggle Source Control",
    category: "internal",
    shortcut: `${getModLabel()}+Shift+G`,
    keywords: "sidebar git source control branch commit",
    action: () => {
      useSidebarStore.getState().togglePanel("git");
      useCommandPaletteStore.getState().close();
    },
  });
  items.push({
    id: "toggle-ai-history",
    label: "Toggle AI History",
    category: "internal",
    shortcut: `${getModLabel()}+Shift+H`,
    keywords: "sidebar ai history chat log",
    action: () => {
      useSidebarStore.getState().togglePanel("aihistory");
      useCommandPaletteStore.getState().close();
    },
  });
  items.push({
    id: "toggle-ai-log",
    label: "Toggle AI Logs",
    category: "internal",
    shortcut: `${getModLabel()}+Shift+L`,
    keywords: "sidebar ai log claude codex",
    action: () => {
      useSidebarStore.getState().togglePanel("ailog");
      useCommandPaletteStore.getState().close();
    },
  });
  items.push({
    id: "open-settings",
    label: "Open Settings",
    category: "internal",
    shortcut: `${getModLabel()}+,`,
    keywords: "preferences config",
    action: () => {
      openSettingsWindow("appearance");
      useCommandPaletteStore.getState().close();
    },
  });
  items.push({
    id: "remote-share",
    label: "Share Alive: Start Sharing",
    category: "internal",
    keywords: "remote share alive mobile web hosting",
    action: () => {
      useCommandPaletteStore.getState().close();
      const { isAuthenticated, startLogin } = useAuthStore.getState();
      if (!isAuthenticated) { startLogin(); return; }
      useRemoteStore.getState().setDialogMode("host");
      useRemoteStore.getState().openDialog();
    },
  });
  items.push({
    id: "remote-connect",
    label: "Share Alive: Connect to Device",
    category: "internal",
    keywords: "remote connect device pairing share alive",
    action: () => {
      useCommandPaletteStore.getState().close();
      const { isAuthenticated, startLogin } = useAuthStore.getState();
      if (!isAuthenticated) { startLogin(); return; }
      useRemoteStore.getState().setDialogMode("client");
      useRemoteStore.getState().openDialog();
    },
  });

  return items;
}

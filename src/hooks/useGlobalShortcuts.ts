import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useThemeStore } from "../stores/themeStore";
import { useBroadcastStore } from "../stores/broadcastStore";
import { useCommandPaletteStore } from "../stores/commandPaletteStore";
import { useHistoryStore } from "../stores/historyStore";
import { usePrivacyStore } from "../stores/privacyStore";
import { useRemoteStore } from "../stores/remoteStore";
import { useSidebarStore } from "../stores/sidebarStore";
import { applyFontSizeToAll } from "../lib/terminalRegistry";
import { applyFontSizeToAllRemote } from "../lib/remoteTerminalRegistry";
import { firstLeafId, collectPtyIds } from "../lib/paneTreeUtils";
import { openSettingsWindow } from "../lib/settingsWindow";
import { getDefaultTerminalSize } from "../lib/terminalUtils";
import { isModKey } from "../lib/osUtils";
import type { Session } from "../types/session";
import { logger } from "../lib/logger";

// VSCode 스타일 사이드바 단축키 — KeyboardEvent.code → SidebarPanel
const SIDEBAR_KEY_MAP: Partial<Record<string, "explorer" | "git" | "aihistory" | "ailog">> = {
  KeyE: "explorer",
  KeyG: "git",
  KeyH: "aihistory",
  KeyL: "ailog",
};

/**
 * All global keyboard shortcuts.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+F (Mac) / Ctrl+F (Win/Linux): block browser find bar, but allow CodeMirror search
      if (isModKey(e) && !e.shiftKey && e.code === "KeyF") {
        const target = e.target as HTMLElement;
        if (target.closest(".cm-editor")) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Cmd+Shift+F (Mac) / Ctrl+Shift+F (Win/Linux): open search sidebar
      if (isModKey(e) && e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        const { activePanel, isExpanded, togglePanel } = useSidebarStore.getState();
        if (activePanel === "search" && isExpanded) {
          window.dispatchEvent(new Event("search-panel-focus"));
        } else {
          togglePanel("search");
        }
        return;
      }

      // Sidebar panel shortcuts — VSCode 스타일 (Cmd/Ctrl+Shift+{E,G,H,L})
      if (isModKey(e) && e.shiftKey) {
        const panel = SIDEBAR_KEY_MAP[e.code];
        if (panel) {
          const target = e.target as HTMLElement;
          if (target.closest(".cm-editor")) return;
          e.preventDefault();
          e.stopPropagation();
          useSidebarStore.getState().togglePanel(panel);
          return;
        }
      }

      // Cmd+, (Mac) / Ctrl+, (Win/Linux): open settings
      if (isModKey(e) && !e.shiftKey && e.code === "Comma") {
        e.preventDefault();
        e.stopPropagation();
        openSettingsWindow("appearance");
        return;
      }

      // Ctrl+F4: close window (custom title bar)
      if (e.ctrlKey && e.code === "F4") {
        e.preventDefault();
        e.stopPropagation();
        getCurrentWindow().close();
        return;
      }

      // F12: toggle devtools
      if (e.key === "F12") {
        e.preventDefault();
        import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
          getCurrentWebviewWindow().emit("tauri://devtools");
        }).catch(() => {
          logger.debug("[racemo] DevTools not available");
        });
        return;
      }

      // Alt+1~9: switch to tab by index
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const digit = e.code.match(/^Digit([1-9])$/)?.[1];
        if (digit) {
          e.preventDefault();
          e.stopPropagation();
          const { sessions, setActiveSession, setFocusedPane } = useSessionStore.getState();
          const idx = parseInt(digit) - 1;
          const target = sessions[idx];
          if (target) {
            setActiveSession(target.id);
            setFocusedPane(firstLeafId(target.rootPane));
          }
          return;
        }
      }

      if (!isModKey(e)) return;

      // Mod+Shift+M: toggle secret masking
      if (e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        e.stopPropagation();
        usePrivacyStore.getState().toggle();
        return;
      }

      // Cmd+? (Cmd+Shift+/): open settings window (help tab)
      if (e.shiftKey && e.code === "Slash") {
        e.preventDefault();
        e.stopPropagation();
        openSettingsWindow("help");
        return;
      }

      // Cmd+R: toggle history search
      if (e.code === "KeyR" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const store = useHistoryStore.getState();
        if (!store.isLoaded) store.loadFromFile();
        if (store.isOpen) store.close();
        else store.open();
        return;
      }

      // Cmd+Q: close active tab, or quit app if no tabs
      if (e.code === "KeyQ" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const { sessions, activeSessionId, removeSession, setFocusedPane } = useSessionStore.getState();
        if (!activeSessionId || sessions.length === 0) {
          getCurrentWindow().close();
          return;
        }
        const activeSession = sessions.find((s) => s.id === activeSessionId);
        removeSession(activeSessionId);
        if (activeSession?.isRemote) {
          useRemoteStore.getState().disconnect();
        } else {
          invoke<Session | null>("close_session", { sessionId: activeSessionId })
            .then((nextSession) => {
              if (nextSession) {
                setFocusedPane(firstLeafId(nextSession.rootPane));
              }
            })
            .catch(logger.error);
        }
        return;
      }

      // Cmd+T: new tab
      if (e.code === "KeyT" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const name = useSessionStore.getState().nextTabName();
        const shell = useSettingsStore.getState().defaultShell;
        const { rows, cols } = getDefaultTerminalSize();
        invoke<Session>("create_session", { name, workingDir: null, shell, rows, cols })
          .then((session) => {
            const { addSession, setFocusedPane } = useSessionStore.getState();
            addSession(session);
            setFocusedPane(firstLeafId(session.rootPane));
          })
          .catch(logger.error);
        return;
      }

      // Cmd+B: toggle broadcast mode
      if (e.code === "KeyB" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const { enabled, toggle, selectAll } = useBroadcastStore.getState();
        toggle();
        if (!enabled) {
          const { sessions, activeSessionId } = useSessionStore.getState();
          const session = sessions.find((s) => s.id === activeSessionId);
          if (session) {
            selectAll(collectPtyIds(session.rootPane));
          }
        }
        return;
      }

      // Cmd+K: toggle command palette
      if (e.code === "KeyK" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const { isOpen, open, close } = useCommandPaletteStore.getState();
        if (isOpen) close();
        else open();
        return;
      }

      if (e.code === "Equal") {
        e.preventDefault();
        e.stopPropagation();
        useThemeStore.getState().increaseFontSize();
        applyFontSizeToAll();
        applyFontSizeToAllRemote();
        return;
      }
      if (e.code === "Minus") {
        e.preventDefault();
        e.stopPropagation();
        useThemeStore.getState().decreaseFontSize();
        applyFontSizeToAll();
        applyFontSizeToAllRemote();
        return;
      }
      if (e.code === "Digit0") {
        e.preventDefault();
        e.stopPropagation();
        useThemeStore.getState().resetFontSize();
        applyFontSizeToAll();
        applyFontSizeToAllRemote();
        return;
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);
}

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

interface RestoreItem {
  sessionId: string;
  ptyId: string;
  paneId: string;
  command: string;
  checked: boolean;
}

interface RestoreStore {
  items: RestoreItem[];
  isOpen: boolean;
  /** ptyIds that have already been offered (survives execute/dismiss to prevent re-trigger on tab switch) */
  seen: Set<string>;
  register: (sessionId: string, ptyId: string, paneId: string, command: string) => void;
  toggle: (ptyId: string) => void;
  execute: () => void;
  dismiss: () => void;
}

function clearLastCommand(sessionId: string, paneId: string) {
  invoke("set_pane_last_command", { sessionId, paneId, command: "" }).catch(console.error);
}

/** Strip shell prompt prefix from a saved last-command string. */
function stripShellPrompt(cmd: string): string {
  // PowerShell: "PS D:\path> cmd" or "PS D:\path>  cmd"
  const stripped = cmd.replace(/^PS\s+\S[^>]*>\s*/, "").trimStart();
  if (stripped && stripped !== cmd) return stripped;
  // bash/zsh/fish: "user@host:~/path$ cmd" or "~/path % cmd"
  const sh = cmd.replace(/^[^\n]*[$%#]\s+/, "");
  return sh || cmd;
}

/**
 * Return true if the string looks like a real shell command.
 * Filters out terminal output that was mistakenly saved as a command.
 */
function isRealCommand(cmd: string): boolean {
  if (!cmd.trim()) return false;
  // Too long to be a real command (e.g. concatenated server output)
  if (cmd.length > 500) return false;
  // Contains process output markers like [0], [1] (e.g. from concurrently)
  if (/\[\d+\]/.test(cmd)) return false;
  // Contains typical server shutdown messages
  if (/pool closed|port released|exited with code/i.test(cmd)) return false;
  // Contains embedded newlines (multiline output)
  if (/\n/.test(cmd)) return false;
  return true;
}

export const useRestoreStore = create<RestoreStore>((set, get) => ({
  items: [],
  isOpen: false,
  seen: new Set(),

  register: (sessionId, ptyId, paneId, command) => {
    const cleanCommand = stripShellPrompt(command);
    set((s) => {
      // Never show twice for the same ptyId (survives tab switches)
      if (s.seen.has(ptyId)) return s;
      // Skip terminal output that was mistakenly saved as a command
      if (!isRealCommand(cleanCommand)) return s;
      const newSeen = new Set(s.seen);
      newSeen.add(ptyId);
      return {
        items: [...s.items, { sessionId, ptyId, paneId, command: cleanCommand, checked: true }],
        isOpen: true,
        seen: newSeen,
      };
    });
  },

  toggle: (ptyId) => {
    set((s) => ({
      items: s.items.map((i) =>
        i.ptyId === ptyId ? { ...i, checked: !i.checked } : i
      ),
    }));
  },

  execute: () => {
    const { items } = get();
    const enc = new TextEncoder();
    for (const item of items) {
      if (item.checked) {
        const data = Array.from(enc.encode(item.command + "\r"));
        invoke("write_to_pty", { paneId: item.ptyId, data }).catch(console.error);
      } else {
        clearLastCommand(item.sessionId, item.paneId);
      }
    }
    set({ items: [], isOpen: false });
  },

  dismiss: () => {
    const { items } = get();
    for (const item of items) {
      clearLastCommand(item.sessionId, item.paneId);
    }
    set({ items: [], isOpen: false });
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useSessionStore } from "../stores/sessionStore";
import { useToastStore } from "../stores/toastStore";
import { findPtyId } from "./paneTreeUtils";
import { logger } from "./logger";

function activePtyId(): string | null {
  const { sessions, activeSessionId, focusedPaneId } = useSessionStore.getState();
  const session = sessions.find((s) => s.id === activeSessionId);
  if (!session || !focusedPaneId) return null;
  return findPtyId(session.rootPane, focusedPaneId);
}

export async function copyPromptToClipboard(text: string): Promise<void> {
  try {
    await writeText(text);
    useToastStore.getState().show("Copied to clipboard", "success");
  } catch (e) {
    logger.error(e);
    useToastStore.getState().show("Copy failed", "error");
  }
}

export function pastePromptToActivePty(text: string): boolean {
  const ptyId = activePtyId();
  if (!ptyId) {
    useToastStore.getState().show("No active terminal", "error");
    return false;
  }
  const bytes = Array.from(new TextEncoder().encode(text));
  invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(logger.error);
  return true;
}

export function runPromptInActivePty(text: string): boolean {
  const ptyId = activePtyId();
  if (!ptyId) {
    useToastStore.getState().show("No active terminal", "error");
    return false;
  }
  const bytes = Array.from(new TextEncoder().encode(`${text}\r`));
  invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(logger.error);
  return true;
}

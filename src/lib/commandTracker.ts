import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore } from "../stores/historyStore";
import { useSessionStore } from "../stores/sessionStore";
import { useCommandErrorStore } from "../stores/commandErrorStore";
import { logger } from "./logger";

interface CommandState {
  startTime: number;
  isRunning: boolean;
}

const commandStates = new Map<string, CommandState>();
const pendingCommandText = new Map<string, string>();
const shellIntegrationActive = new Map<string, boolean>();

/** Returns true if the PTY has ever sent OSC 133 sequences. */
export function isShellIntegrationActive(ptyId: string): boolean {
  return !!shellIntegrationActive.get(ptyId);
}

/** Called when OSC 133;B is received — command text captured. */
export function onCommandText(ptyId: string, text: string) {
  const trimmed = text.trim();
  if (trimmed) pendingCommandText.set(ptyId, trimmed);
}

/** Returns the pending command text for a PTY (before onCommandEnd consumes it). */
export function getPendingCommandText(ptyId: string): string | undefined {
  return pendingCommandText.get(ptyId);
}

/** Called when OSC 133;C is received — command execution starts. */
export function onCommandStart(ptyId: string) {
  commandStates.set(ptyId, { startTime: Date.now(), isRunning: true });
  // Clear previous error when a new command starts
  useCommandErrorStore.getState().clearError(ptyId);
}

/** Called when OSC 133;D is received — command execution ends. */
export function onCommandEnd(ptyId: string, exitCode?: number) {
  const state = commandStates.get(ptyId);
  if (!state || !state.isRunning) return;

  state.isRunning = false;

  const commandText = pendingCommandText.get(ptyId);

  // If exit code is non-zero, store error and skip history
  if (exitCode !== undefined && exitCode !== 0 && commandText) {
    useCommandErrorStore.getState().setError(ptyId, {
      command: commandText,
      exitCode,
      timestamp: Date.now(),
    });
    pendingCommandText.delete(ptyId);
    return;
  }

  // Capture live history entry and save to Racemo history file
  if (commandText) {
    const { activeSessionId, paneCwds } = useSessionStore.getState();
    useHistoryStore.getState().addLiveEntry({
      command: commandText,
      timestamp: Date.now(),
      source: "live",
      sessionId: activeSessionId ?? undefined,
      cwd: paneCwds[ptyId],
    });
    pendingCommandText.delete(ptyId);

    // Save to Racemo's persistent history file
    invoke("write_racemo_history", { command: commandText }).catch((e) => {
      logger.warn("[commandTracker] Failed to save history:", e);
    });
  }
}

/** Called when OSC 133;A is received — prompt start (new prompt = previous command finished). */
export function onPromptStart(ptyId: string) {
  shellIntegrationActive.set(ptyId, true);
  // If there was a running command, treat this as command end
  const state = commandStates.get(ptyId);
  if (state?.isRunning) {
    onCommandEnd(ptyId);
  }
  // Don't clear error here — error persists until the next command starts (OSC 133;C)
}

/** Returns true if the PTY currently has a running command (between OSC 133;C and 133;D). */
export function isCommandRunning(ptyId: string): boolean {
  return !!commandStates.get(ptyId)?.isRunning;
}

/** Clean up when a PTY is removed. */
export function removeCommandState(ptyId: string) {
  commandStates.delete(ptyId);
  shellIntegrationActive.delete(ptyId);
  useCommandErrorStore.getState().clearError(ptyId);
}

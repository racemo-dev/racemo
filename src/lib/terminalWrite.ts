import type { Terminal } from "@xterm/xterm";
import { usePrivacyStore } from "../stores/privacyStore";
import { maskSecrets } from "./secretDetector";

/**
 * Write PTY output to a terminal, applying secret masking when enabled in privacy settings.
 * No-op wrapper when the toggle is OFF (original text is written unchanged).
 *
 * `onConsumed` is invoked by xterm.js after the chunk has been parsed
 * (used for PTY output flow-control acks).
 */
export function writeToTerminal(terminal: Terminal, text: string, onConsumed?: () => void): void {
  const out = usePrivacyStore.getState().enabled ? maskSecrets(text) : text;
  terminal.write(out, onConsumed);
}

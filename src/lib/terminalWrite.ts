import type { Terminal } from "@xterm/xterm";
import { usePrivacyStore } from "../stores/privacyStore";
import { maskSecrets } from "./secretDetector";

/**
 * Write PTY output to a terminal, applying secret masking when enabled in privacy settings.
 * No-op wrapper when the toggle is OFF (original text is written unchanged).
 */
export function writeToTerminal(terminal: Terminal, text: string): void {
  const out = usePrivacyStore.getState().enabled ? maskSecrets(text) : text;
  terminal.write(out);
}

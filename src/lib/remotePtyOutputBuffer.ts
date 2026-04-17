import { listenRemote } from "./remoteEvents";
import { getRemoteTerminal } from "./remoteTerminalRegistry";
import { logger } from "./logger";
import { writeToTerminal } from "./terminalWrite";

interface RemotePtyOutputPayload {
  pane_id: string;
  data: number[];
}

/**
 * In-memory buffer for remote PTY output that arrives before its terminal is ready.
 *
 * Same pattern as ptyOutputBuffer.ts but for remote terminals:
 *   1. Global listener receives remote-pty-output event
 *   2. If terminal exists in registry -> write immediately
 *   3. If terminal not yet created -> store in pending buffer
 *   4. When terminal mounts, caller invokes flush() -> writes buffered data
 */
const pending = new Map<string, number[][]>();
let decoder = new TextDecoder();

/**
 * Register the global remote-pty-output listener. Call once at app startup.
 * Returns the unlisten function for cleanup.
 */
export function setupRemotePtyOutputListener(): Promise<() => void> {
  return listenRemote("remote-pty-output", (raw) => {
    const { pane_id, data } = raw as RemotePtyOutputPayload;
    const bytes = new Uint8Array(data);
    const text = decoder.decode(bytes, { stream: true });

    const entry = getRemoteTerminal(pane_id);
    if (entry) {
      writeToTerminal(entry.terminal, text);
    } else {
      let buf = pending.get(pane_id);
      if (!buf) {
        buf = [];
        pending.set(pane_id, buf);
      }
      buf.push(data);
    }
  });
}

/**
 * Flush any buffered output for the given remotePaneId into the terminal.
 * Call this right after the terminal is created/mounted.
 */
export function flushRemotePtyOutputBuffer(remotePaneId: string): void {
  const buf = pending.get(remotePaneId);
  if (!buf || buf.length === 0) return;

  const entry = getRemoteTerminal(remotePaneId);
  if (!entry) {
    logger.error("[remote-pty-output] Flush failed: terminal not found for", remotePaneId);
    return;
  }

  const flushDecoder = new TextDecoder();
  for (const data of buf) {
    const bytes = new Uint8Array(data);
    const text = flushDecoder.decode(bytes, { stream: true });
    writeToTerminal(entry.terminal, text);
  }
  pending.delete(remotePaneId);
}

/**
 * Clean up buffer for a closed remote pane (prevent memory leak).
 */
export function clearRemotePtyOutputBuffer(remotePaneId: string): void {
  pending.delete(remotePaneId);
}

/**
 * Clear pending buffers for specific pane IDs.
 */
export function clearRemotePtyOutputBuffers(paneIds: string[]): void {
  for (const id of paneIds) {
    pending.delete(id);
  }
}

/**
 * Clear all pending buffers (e.g., on full disconnect).
 */
export function clearAllRemotePtyOutputBuffers(): void {
  pending.clear();
  decoder = new TextDecoder();
}

interface RemotePtyResizedPayload {
  pane_id: string;
  rows: number;
  cols: number;
}

/** Host PTY sizes — used by RemoteTerminalPane to cap local fitAddon.fit(). */
const hostPtySizes = new Map<string, { rows: number; cols: number }>();

export function getHostPtySize(paneId: string): { rows: number; cols: number } | undefined {
  return hostPtySizes.get(paneId);
}

/**
 * Register a global listener for remote-pty-resized events.
 * PTY는 서버에서 min(호스트, 원격)으로 이미 resize됨 → 원격 xterm.js는 그 사이즈에 맞춤.
 * 단, 컨테이너보다 큰 사이즈로는 resize하지 않음 (호스트가 더 큰 경우 방지).
 */
export function setupRemotePtyResizedListener(): Promise<() => void> {
  return listenRemote("remote-pty-resized", (raw) => {
    const { pane_id, rows, cols } = raw as RemotePtyResizedPayload;
    hostPtySizes.set(pane_id, { rows, cols });
    const entry = getRemoteTerminal(pane_id);
    if (entry) {
      // 컨테이너 fit 사이즈로 cap하여 호스트의 큰 사이즈가 적용되는 것을 방지.
      // 컨테이너가 비표시(탭 비활성 등)이면 proposeDimensions()=undefined → resize 보류.
      const proposed = entry.fitAddon.proposeDimensions();
      if (!proposed) return;
      const effectiveCols = Math.min(cols, proposed.cols);
      const effectiveRows = Math.min(rows, proposed.rows);
      const cur = { cols: entry.terminal.cols, rows: entry.terminal.rows };
      if (cur.cols !== effectiveCols || cur.rows !== effectiveRows) {
        entry.terminal.resize(effectiveCols, effectiveRows);
      }
    }
  });
}

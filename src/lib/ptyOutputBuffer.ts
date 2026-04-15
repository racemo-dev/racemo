import { listen } from "@tauri-apps/api/event";
import { getTerminal } from "./terminalRegistry";
import { onPtyOutput } from "./silenceDetector";
import { useSessionStore } from "../stores/sessionStore";
import { logger } from "./logger";

interface PtyOutputPayload {
  pane_id: string;
  data: number[];
}

/**
 * In-memory buffer for PTY output that arrives before its terminal is ready.
 *
 * Flow:
 *   1. Global listener receives pty-output event
 *   2. If terminal exists → write immediately
 *   3. If terminal not yet created → store in pending buffer
 *   4. When terminal is created, caller invokes flush() → writes buffered data
 *
 * IMPORTANT: PTY output must be written as string (not Uint8Array) to xterm.js.
 * Writing binary data causes CJK character width miscalculation on Windows ConPTY,
 * resulting in blank lines between output entries.
 */
const pending = new Map<string, number[][]>();
const decoder = new TextDecoder();

/** Debounce timers for activity cooldown per PTY. */
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Accumulated output bytes in current activity window per PTY. */
const activityBytes = new Map<string, number>();
const ACTIVITY_COOLDOWN_MS = 5000;
/** Minimum bytes to trigger activity indicator (filters out prompts, key echo & ConPTY cursor sequences). */
const ACTIVITY_THRESHOLD = 2048;

/** PTY IDs temporarily suppressed from activity tracking (e.g., after resize). */
const activitySuppressed = new Map<string, ReturnType<typeof setTimeout>>();
/** Grace period after suppress ends — ignore first burst of output. */
const activityGrace = new Map<string, ReturnType<typeof setTimeout>>();
const GRACE_PERIOD_MS = 2000;

/**
 * Suppress activity tracking for a PTY for a short duration.
 * Call this before resize to prevent ConPTY screen repaints from triggering the indicator.
 */
export function suppressActivity(ptyId: string, durationMs = 500) {
  const prev = activitySuppressed.get(ptyId);
  if (prev) clearTimeout(prev);
  const prevGrace = activityGrace.get(ptyId);
  if (prevGrace) clearTimeout(prevGrace);
  activitySuppressed.set(
    ptyId,
    setTimeout(() => {
      activitySuppressed.delete(ptyId);
      activityBytes.delete(ptyId);
      // Start grace period — continue ignoring output briefly after suppress ends
      activityGrace.set(
        ptyId,
        setTimeout(() => {
          activityGrace.delete(ptyId);
          activityBytes.delete(ptyId);
        }, GRACE_PERIOD_MS),
      );
    }, durationMs),
  );
}

/**
 * Track PTY output activity for tab indicator.
 * Activates when output exceeds threshold; deactivates after cooldown with no output.
 */
function trackActivity(ptyId: string, dataLen: number) {
  if (activitySuppressed.has(ptyId) || activityGrace.has(ptyId)) return;

  const accumulated = (activityBytes.get(ptyId) ?? 0) + dataLen;
  activityBytes.set(ptyId, accumulated);

  if (accumulated >= ACTIVITY_THRESHOLD) {
    const store = useSessionStore.getState();
    if (!store.paneActive[ptyId]) {
      store.setPaneActive(ptyId, true);
    }
  }

  // Reset cooldown — if no output for ACTIVITY_COOLDOWN_MS, go idle
  const prev = activityTimers.get(ptyId);
  if (prev) clearTimeout(prev);
  activityTimers.set(
    ptyId,
    setTimeout(() => {
      useSessionStore.getState().setPaneActive(ptyId, false);
      activityTimers.delete(ptyId);
      activityBytes.delete(ptyId);
    }, ACTIVITY_COOLDOWN_MS),
  );
}

/**
 * Register the global pty-output listener. Call once at app startup.
 * Returns the unlisten function for cleanup.
 */
export function setupPtyOutputListener(): Promise<() => void> {
  return listen<PtyOutputPayload>("pty-output", (event) => {
    const { pane_id, data } = event.payload;
    const bytes = new Uint8Array(data);
    const text = decoder.decode(bytes, { stream: true });

    // Track output for silence detection (badge + notification)
    onPtyOutput(pane_id);
    // Track output activity for tab indicator
    trackActivity(pane_id, data.length);

    const entry = getTerminal(pane_id);
    if (entry) {
      entry.terminal.write(text);
    } else {
      // Terminal not ready yet — buffer the data
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
 * Flush any buffered output for the given ptyId into the terminal.
 * Call this right after the terminal is created/mounted.
 */
export function flushPtyOutputBuffer(ptyId: string): void {
  const buf = pending.get(ptyId);
  if (!buf || buf.length === 0) return;

  const entry = getTerminal(ptyId);
  if (!entry) {
    logger.error("[pty-output] Flush failed: terminal not found for", ptyId);
    return;
  }

  const flushDecoder = new TextDecoder();
  for (const data of buf) {
    const bytes = new Uint8Array(data);
    const text = flushDecoder.decode(bytes, { stream: true });
    entry.terminal.write(text);
  }
  pending.delete(ptyId);
}

/**
 * Returns true if there is buffered output for the given ptyId (i.e., the session was restored).
 */
export function hasPendingOutput(ptyId: string): boolean {
  const buf = pending.get(ptyId);
  return !!buf && buf.length > 0;
}

interface PtyResizedPayload {
  pane_id: string;
  rows: number;
  cols: number;
}

/**
 * Register the global pty-resized listener. Call once at app startup.
 * 원격 클라이언트 연결로 PTY가 min(호스트, 원격)으로 리사이즈되면
 * 호스트 로컬 xterm도 동일 크기로 맞춤.
 */
export function setupPtyResizedListener(): Promise<() => void> {
  return listen<PtyResizedPayload>("pty-resized", (event) => {
    const { pane_id, rows, cols } = event.payload;
    const entry = getTerminal(pane_id);
    if (!entry) return;
    const cur = { cols: entry.terminal.cols, rows: entry.terminal.rows };
    if (cur.cols !== cols || cur.rows !== rows) {
      suppressActivity(pane_id);
      entry.terminal.resize(cols, rows);
    }
  });
}

/**
 * Clean up buffer for a closed pane (prevent memory leak).
 */
export function clearPtyOutputBuffer(ptyId: string): void {
  pending.delete(ptyId);
  const timer = activityTimers.get(ptyId);
  if (timer) clearTimeout(timer);
  activityTimers.delete(ptyId);
  const grace = activityGrace.get(ptyId);
  if (grace) clearTimeout(grace);
  activityGrace.delete(ptyId);
}

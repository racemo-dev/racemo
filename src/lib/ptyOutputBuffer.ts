import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getTerminal } from "./terminalRegistry";
import { onPtyOutput } from "./silenceDetector";
import { useSessionStore } from "../stores/sessionStore";
import { logger } from "./logger";
import { writeToTerminal } from "./terminalWrite";

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

/** 미마운트 pane의 pending 버퍼 총량 상한 — 초과 시 가장 오래된 청크부터 폐기. */
const PENDING_MAX_BYTES = 4 * 1024 * 1024;
/** pane별 pending 버퍼 누적 바이트. */
const pendingBytes = new Map<string, number>();
/** 상한 초과로 폐기가 발생한 pane (경고 1회 로깅용). */
const pendingDropped = new Set<string>();

/**
 * PTY 출력 소비 완료 ack — 서버 흐름 제어에 크레딧 반환.
 * pane별로 누적했다가 매크로태스크당 1회만 invoke하여 IPC 오버헤드를 줄인다.
 * 수신한 각 청크는 정확히 1회만 ack한다 (마운트 시 write 콜백, 미마운트 시 수신 즉시).
 */
const ackPending = new Map<string, number>();
let ackFlushScheduled = false;

function queueAck(paneId: string, bytes: number) {
  if (bytes <= 0) return;
  ackPending.set(paneId, (ackPending.get(paneId) ?? 0) + bytes);
  if (!ackFlushScheduled) {
    ackFlushScheduled = true;
    setTimeout(flushAcks, 0);
  }
}

function flushAcks() {
  ackFlushScheduled = false;
  for (const [paneId, bytes] of ackPending) {
    // IPC 미연결 시 무해하게 실패 — 연결이 없으면 서버 카운터도 없다.
    invoke("ack_pty_output", { paneId, bytes }).catch(() => {});
  }
  ackPending.clear();
}

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
      // xterm이 이 청크 파싱을 마친 시점에 소비 완료 ack (흐름 제어 크레딧 반환).
      // text가 빈 문자열이면(UTF-8 경계 대기) write를 거치지 않고 즉시 ack.
      if (text.length === 0) {
        queueAck(pane_id, data.length);
      } else {
        writeToTerminal(entry.terminal, text, () => queueAck(pane_id, data.length));
      }
    } else {
      // Terminal not ready yet — buffer the data
      let buf = pending.get(pane_id);
      if (!buf) {
        buf = [];
        pending.set(pane_id, buf);
      }
      buf.push(data);
      // 미마운트 pane은 수신 즉시 ack — 백그라운드 PTY가 흐름 제어로 막히지 않게 한다.
      // (flush 시에는 다시 ack하지 않음 — 청크당 1회 ack 원칙)
      queueAck(pane_id, data.length);
      // 메모리 상한 유지: 초과분은 가장 오래된 청크부터 폐기.
      let total = (pendingBytes.get(pane_id) ?? 0) + data.length;
      while (total > PENDING_MAX_BYTES && buf.length > 0) {
        total -= buf.shift()!.length;
        if (!pendingDropped.has(pane_id)) {
          pendingDropped.add(pane_id);
          logger.warn("[pty-output] pending buffer cap exceeded, dropping oldest output for", pane_id);
        }
      }
      pendingBytes.set(pane_id, total);
    }
  }).then((unlisten) => {
    // 리스너 등록 직후 이 연결의 서버측 미ack 카운터 리셋 — 웹뷰 리로드로
    // ack가 끊겨 PTY가 영구 일시정지하는 것을 방지.
    // (콜드 스타트 시 IPC 미연결이면 무해하게 실패하며, 새 연결은 카운터 0으로 시작)
    invoke("reset_pty_acks").catch(() => {});
    return unlisten;
  });
}

/**
 * Flush any buffered output for the given ptyId into the terminal.
 * Call this right after the terminal is created/mounted.
 * 버퍼링된 청크는 수신 시점에 이미 ack됐으므로 여기서는 ack하지 않는다.
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
    writeToTerminal(entry.terminal, text);
  }
  pending.delete(ptyId);
  pendingBytes.delete(ptyId);
  pendingDropped.delete(ptyId);
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
  pendingBytes.delete(ptyId);
  pendingDropped.delete(ptyId);
  const timer = activityTimers.get(ptyId);
  if (timer) clearTimeout(timer);
  activityTimers.delete(ptyId);
  const grace = activityGrace.get(ptyId);
  if (grace) clearTimeout(grace);
  activityGrace.delete(ptyId);
}

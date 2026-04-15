import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { collectPtyIds, firstLeafId } from "./paneTreeUtils";
import { suppressActivity } from "./ptyOutputBuffer";
import type { Session } from "../types/session";
import { logger } from "./logger";

/** ms timestamp when each session was switched AWAY from. */
const sessionDeactivatedAt = new Map<string, number>();

/** ms timestamp of the most recent PTY output for each ptyId. */
const ptyLastOutputAt = new Map<string, number>();

/** Whether we already fired a notification for this silence window. */
const ptrNotified = new Map<string, boolean>();

/** Active silence debounce timers. */
const silenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Call for every PTY output chunk received (from ptyOutputBuffer).
 * Resets the silence timer for this pane.
 */
export function onPtyOutput(ptyId: string) {
  const now = Date.now();
  ptyLastOutputAt.set(ptyId, now);
  ptrNotified.set(ptyId, false);

  // During grace period (tab switch ConPTY repaint), track timestamps but skip timer setup.
  // When grace ends, a timer is started so we don't miss completions during grace.
  if (silenceGrace.has(ptyId)) return;

  resetSilenceTimer(ptyId);
}

/** Grace period for panes after their session is deactivated (prevents ConPTY repaint from triggering badge). */
const silenceGrace = new Map<string, ReturnType<typeof setTimeout>>();
const SILENCE_GRACE_MS = 1500;

/**
 * Call when switching AWAY from a session (BEFORE switching to the new tab).
 * Records the exact moment the session went to background.
 * Adds grace period to prevent ConPTY repaint output from triggering badge.
 */
export function onSessionDeactivated(sessionId: string) {
  // grace 구간 내 ConPTY 리페인트가 뱃지를 유발하지 않도록
  // lastDeactivated를 grace 종료 시점으로 설정
  sessionDeactivatedAt.set(sessionId, Date.now() + SILENCE_GRACE_MS);
  const { sessions } = useSessionStore.getState();
  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    for (const ptyId of collectPtyIds(session.rootPane)) {
      clearSilenceTimer(ptyId);
      const prev = silenceGrace.get(ptyId);
      if (prev) clearTimeout(prev);
      silenceGrace.set(
        ptyId,
        setTimeout(() => {
          silenceGrace.delete(ptyId);
          // If there was output during grace, start silence timer now
          if (ptyLastOutputAt.has(ptyId)) resetSilenceTimer(ptyId);
        }, SILENCE_GRACE_MS),
      );
    }
  }
}

/**
 * Call when a session becomes active (user switches to it).
 * Cancels pending silence timers and suppresses notifications for this session's panes.
 */
export function onSessionActivated(sessionId: string) {
  const { sessions } = useSessionStore.getState();
  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    for (const ptyId of collectPtyIds(session.rootPane)) {
      clearSilenceTimer(ptyId);
      ptrNotified.set(ptyId, true);
    }
  }
}

/**
 * Call when a pane/PTY is removed.
 */
export function removeSilenceDetector(ptyId: string) {
  clearSilenceTimer(ptyId);
  ptyLastOutputAt.delete(ptyId);
  ptrNotified.delete(ptyId);
  const grace = silenceGrace.get(ptyId);
  if (grace) clearTimeout(grace);
  silenceGrace.delete(ptyId);
}

/**
 * Call when a session is fully removed.
 * Cleans up the deactivation timestamp to prevent memory leaks.
 */
export function removeSessionDeactivation(sessionId: string) {
  sessionDeactivatedAt.delete(sessionId);
}

function resetSilenceTimer(ptyId: string) {
  clearSilenceTimer(ptyId);
  const thresholdMs = useSettingsStore.getState().notificationThreshold * 1000;
  silenceTimers.set(ptyId, setTimeout(() => checkSilence(ptyId), thresholdMs));
}

function clearSilenceTimer(ptyId: string) {
  const t = silenceTimers.get(ptyId);
  if (t) clearTimeout(t);
  silenceTimers.delete(ptyId);
}

function checkSilence(ptyId: string) {
  if (ptrNotified.get(ptyId)) return;

  const { sessions, activeSessionId, incrementTabBadge } = useSessionStore.getState();

  let targetSessionId: string | null = null;
  let targetSessionName = ptyId.slice(0, 8);
  for (const session of sessions) {
    if (collectPtyIds(session.rootPane).includes(ptyId)) {
      targetSessionId = session.id;
      targetSessionName = session.name;
      break;
    }
  }

  if (!targetSessionId || targetSessionId === activeSessionId) return;

  // Session must have been explicitly switched away from at least once.
  // Without this, app startup output (lastDeactivated=0) would always fire.
  if (!sessionDeactivatedAt.has(targetSessionId)) return;

  const lastOutput = ptyLastOutputAt.get(ptyId) ?? 0;
  const lastDeactivated = sessionDeactivatedAt.get(targetSessionId)!;
  if (lastOutput <= lastDeactivated) return;

  ptrNotified.set(ptyId, true);

  const settings = useSettingsStore.getState();

  // Tab badge
  incrementTabBadge(targetSessionId);

  // Sound
  if (settings.soundEnabled) {
    playChime();
  }

  // OS notification
  if (settings.notificationEnabled) {
    doNotify("Task Completed", targetSessionName, targetSessionId).catch(logger.error);
  }

  const message = `Task completed — ${targetSessionName}`;

  // Slack
  if (settings.slackWebhookUrl) {
    fetch(settings.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    }).catch((e) => logger.warn("[silenceDetector] Slack failed:", e));
  }

  // Telegram
  if (settings.telegramBotToken && settings.telegramChatId) {
    const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: settings.telegramChatId, text: message }),
    }).catch((e) => logger.warn("[silenceDetector] Telegram failed:", e));
  }
}

function playChime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
    osc.onended = () => ctx.close();
  } catch (e) {
    logger.warn("[silenceDetector] Audio chime failed:", e);
  }
}

async function doNotify(title: string, body: string, sessionId: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    if (!granted) return;

    const n = new Notification(title, { body });
    n.onclick = () => {
      const { sessions, activeSessionId, setActiveSession, setFocusedPane, clearTabBadge } = useSessionStore.getState();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;

      // Deactivate current session
      if (activeSessionId && activeSessionId !== sessionId) {
        onSessionDeactivated(activeSessionId);
      }

      clearTabBadge(sessionId);
      onSessionActivated(sessionId);

      // Suppress ConPTY repaint noise
      for (const id of collectPtyIds(session.rootPane)) suppressActivity(id, 3000);

      if (session.isRemote) {
        setActiveSession(session.id);
        setFocusedPane(firstLeafId(session.rootPane));
      } else {
        invoke<Session>("switch_session", { sessionId })
          .then((s) => {
            setActiveSession(s.id);
            setFocusedPane(firstLeafId(s.rootPane));
          })
          .catch(logger.error);
      }

      getCurrentWindow().setFocus().catch(logger.error);
    };
  } catch (e) {
    logger.error("[silenceDetector] notification error:", e);
  }
}


import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useHistoryStore } from "../stores/historyStore";
import { useAuthStore } from "../stores/authStore";
import { useRemoteStore, setupRemoteListeners } from "../stores/remoteStore";
import { refreshAllGitStatus, startGitBackgroundSync } from "../stores/gitStore";
import { usePanelEditorStore } from "../stores/panelEditorStore";
import { firstLeafId, findPtyId } from "../lib/paneTreeUtils";
import { isTauri, apiGetHomeDir, apiReadTextFile } from "../lib/bridge";
import { useGitT } from "../lib/i18n/git";
import type { Session } from "../types/session";
import { logger } from "../lib/logger";

/**
 * IPC connection setup, session initialization, editor restore, and git init.
 * Returns { error, handleReconnect, gitInitProgress }.
 */

/**
 * The main IPC setup effect. Must be called in App with setError/setGitInitProgress.
 */
export function useIpcSetupEffect(
  setError: (e: string | null) => void,
  setGitInitProgress: (p: { done: number; total: number } | null) => void,
) {
  const initialized = useRef(false);
  const t = useGitT();

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // 브라우저 모드(5173): Tauri IPC 없이 원격 연결 모드로 초기화
    if (!isTauri()) {
      logger.debug("[racemo] Browser mode: opening remote pairing dialog");
      setupRemoteListeners().catch(logger.error);
      useRemoteStore.getState().setDialogMode("client");
      useRemoteStore.getState().openDialog();

      const createMockSession = (homeDir?: string) => {
        const name = useSessionStore.getState().nextTabName();
        const mockPtyId = crypto.randomUUID();
        const mockPaneId = crypto.randomUUID();
        const mockSession: Session = {
          id: crypto.randomUUID(),
          name,
          rootPane: { type: "leaf", id: mockPaneId, ptyId: mockPtyId },
          createdAt: Date.now(),
          paneCount: 1,
        };
        const store = useSessionStore.getState();
        store.addSession(mockSession);
        store.setActiveSession(mockSession.id);
        if (homeDir) store.setPaneCwd(mockPtyId, homeDir);
        store.setFocusedPane(mockPaneId);
      };

      apiGetHomeDir()
        .then((homeDir) => createMockSession(homeDir))
        .catch(() => createMockSession());
      return;
    }

    // Git 초기화: paneCwds가 채워지면 전체 git status 갱신 + 백그라운드 sync 시작
    let gitInitDone = false;
    const initGit = () => {
      if (gitInitDone) return;
      const { paneCwds } = useSessionStore.getState();
      const cwds = [...new Set(Object.values(paneCwds).filter(Boolean))];
      if (cwds.length === 0) return;
      gitInitDone = true;
      let showTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => { showTimer = null; }, 500);
      refreshAllGitStatus(cwds, (done, total) => { if (!showTimer) setGitInitProgress({ done, total }); })
        .finally(() => { if (showTimer) clearTimeout(showTimer); setGitInitProgress(null); });
      startGitBackgroundSync(() => {
        const st = useSessionStore.getState();
        const session = st.sessions.find((s) => s.id === st.activeSessionId);
        if (!session || !st.focusedPaneId) return "";
        const ptyId = findPtyId(session.rootPane, st.focusedPaneId);
        return ptyId ? (st.paneCwds[ptyId] ?? "") : "";
      });
    };
    const unsubGit = useSessionStore.subscribe((s) => {
      if (!gitInitDone && Object.keys(s.paneCwds).length > 0) { initGit(); unsubGit(); }
    });

    const initSessions = () => {
      logger.debug("[racemo] Requesting session list from server");
      invoke<Session[]>("list_sessions")
        .then(async (serverSessions) => {
          logger.debug("[racemo] Received session list:", serverSessions.length, "sessions");
          if (serverSessions.length > 0) {
            const lastId = localStorage.getItem("racemo:lastSessionId");
            let targetId = serverSessions.find(s => s.id === lastId)?.id ?? null;

            if (!targetId) {
              try {
                const serverId = await invoke<string | null>("get_active_session_id");
                if (serverId && serverSessions.some(s => s.id === serverId)) {
                  targetId = serverId;
                }
              } catch (e) {
                logger.warn("[racemo] Failed to get active session id from server:", e);
              }
            }

            targetId ??= serverSessions[0].id;

            logger.debug("[racemo] Re-attaching to", serverSessions.length, "server sessions. Target:", targetId);
            invoke<Session>("attach_session", { sessionId: targetId })
              .then((session) => {
                logger.debug(`[racemo] attached session ${session.id}, letting panes handle their own sizing`);
                const store = useSessionStore.getState();
                store.setSessions(serverSessions.map(s => s.id === session.id ? session : s));
                store.setActiveSession(session.id);
                store.setFocusedPane(firstLeafId(session.rootPane));
              })
              .catch((e) => {
                logger.error("[racemo] Failed to attach to session:", e);
                const store = useSessionStore.getState();
                store.setSessions(serverSessions);
                if (targetId) store.setActiveSession(targetId);
                store.setFocusedPane(firstLeafId(serverSessions[0].rootPane));
              });
          }
        })
        .catch((e) => {
          logger.error("[racemo] Failed to list sessions:", e);
        });
    };

    // Reconnect state
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let initDone = false;
    const MAX_AUTO_RECONNECTS = 5;
    const RECONNECT_DELAY_MS = 2000;

    const tryInit = async () => {
      if (initDone) return;
      initDone = true;
      logger.debug("[racemo] Server connection ready");
      useSessionStore.getState().setIpcReady(true);
      setError(null);
      getCurrentWindow().show().catch(logger.error);
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      initSessions();

      // Restore editor panel state
      invoke<{ panelOpen: boolean; activeIndex: number; tabs: { type: string; path?: string; url?: string; name?: string }[]; paths: string[] }>("get_editor_state")
        .then(async ({ panelOpen, activeIndex, tabs, paths }) => {
          const items: { type: "editor" | "browser"; path?: string; url?: string; name?: string }[] =
            tabs.length > 0
              ? tabs.map((t) => t.type === "browser"
                  ? { type: "browser" as const, url: t.url ?? "", name: t.name ?? "New Tab" }
                  : { type: "editor" as const, path: t.path })
              : paths.map((p) => ({ type: "editor" as const, path: p }));
          if (!panelOpen || items.length === 0) return;
          const store = usePanelEditorStore.getState();
          let restored = 0;
          for (const item of items) {
            if (item.type === "browser") {
              store.openBrowserTab(item.url ?? "", item.name);
              restored++;
            } else if (item.path) {
              try {
                const content = await apiReadTextFile(item.path);
                const name = item.path.split(/[\\/]/).pop() ?? item.path;
                store.openTab(item.path, name, content);
                restored++;
              } catch { /* expected: file may have been deleted since last session */ }
            }
          }
          if (restored > 0) {
            store.setActiveIndex(Math.min(activeIndex, Math.max(restored - 1, 0)));
            store.setPanelOpen(true);
          }
        })
        .catch(() => {});

      // Deferred initializations
      useHistoryStore.getState().loadFromFile();
      await useAuthStore.getState().checkAuth();
      setupRemoteListeners().catch(logger.error);

      // Auto-start Share Alive if previously enabled
      if (useSettingsStore.getState().shareAliveEnabled) {
        const { isAuthenticated } = useAuthStore.getState();
        if (isAuthenticated) {
          logger.debug("[racemo] Auto-starting Share Alive (previously enabled)");
          useRemoteStore.getState().startAccountHosting();
        } else {
          useSettingsStore.getState().setShareAliveEnabled(false);
        }
      }
    };

    // Listen for server-pushed session updates
    const unlistenSessionUpdated = listen<Session>("session-updated", (event) => {
      useSessionStore.getState().setSession(event.payload);
    });

    const unlistenPromise = listen("ipc-ready", tryInit);

    const unlistenDiscPromise = listen("ipc-disconnected", () => {
      logger.debug("[racemo] IPC disconnected event received");
      useSessionStore.getState().setIpcReady(false);

      if (reconnectTimer) return;

      reconnectAttempts++;
      if (reconnectAttempts > MAX_AUTO_RECONNECTS) {
        logger.error(`[racemo] Max auto-reconnect attempts (${MAX_AUTO_RECONNECTS}) exceeded.`);
        setError(t("app.serverConnectFail"));
        return;
      }

      if (!import.meta.env.PROD) {
        logger.debug("[racemo] Auto-reconnect disabled in development mode");
        return;
      }

      logger.debug(`[racemo] Auto-reconnect attempt ${reconnectAttempts}/${MAX_AUTO_RECONNECTS} in ${RECONNECT_DELAY_MS}ms...`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        setError(null);
        invoke("reconnect_ipc").catch((e) => setError(`Reconnection failed: ${e}`));
      }, RECONNECT_DELAY_MS);
    });

    // Poll in case we missed the event
    const pollReady = async () => {
      for (let i = 0; i < 25; i++) {
        if (cancelled || useSessionStore.getState().isIpcReady) return;
        try {
          const ready = await invoke<boolean>("is_ipc_ready");
          if (ready) {
            logger.debug("[racemo] IPC ready detected via polling");
            tryInit();
            return;
          }
        } catch {
          // Command not yet available
        }
        await new Promise(r => setTimeout(r, 200));
      }
      logger.error("[racemo] IPC not ready after 5 seconds");
    };
    pollReady();

    logger.debug("[racemo] Waiting for IPC ready...");

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      unlistenSessionUpdated.then(unlisten => unlisten());
      unlistenPromise.then(unlisten => unlisten());
      unlistenDiscPromise.then(unlisten => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- IPC setup runs once on mount
  }, []);
}

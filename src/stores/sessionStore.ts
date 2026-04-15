import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Session, ShellType, PaneNode } from "../types/session";
import { getGitT } from "../lib/i18n/git";
import { removeSessionDeactivation } from "../lib/silenceDetector";
import { logger } from "../lib/logger";

interface SessionStore {
  sessions: Session[];
  activeSessionId: string | null;
  focusedPaneId: string | null;
  tabCounter: number;
  /** ptyId → cwd mapping for persistence */
  paneCwds: Record<string, string>;
  /** ptyId → shell type mapping for status bar display */
  paneShellTypes: Record<string, ShellType>;
  /** sessionId → unread completion count (tab badge) */
  tabBadges: Record<string, number>;
  /** ptyId → true when a command is running AND producing output */
  paneActive: Record<string, boolean>;
  /** sessionId → pinned cwd (explorer stays at this path) */
  pinnedCwds: Record<string, string>;
  isIpcReady: boolean;
  setIpcReady: (ready: boolean) => void;
  setPinnedCwd: (sessionId: string, cwd: string) => void;
  clearPinnedCwd: (sessionId: string) => void;
  nextTabName: () => string;
  setPaneCwd: (ptyId: string, cwd: string) => void;
  setPaneShellType: (ptyId: string, shellType: ShellType) => void;
  setPaneActive: (ptyId: string, active: boolean) => void;
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (sessionId: string) => void;
  updateSession: (session: Session) => void;
  addSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
  setFocusedPane: (paneId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  reorderSessions: (fromIndex: number, toIndex: number) => void;
  incrementTabBadge: (sessionId: string) => void;
  clearTabBadge: (sessionId: string) => void;

  /** @deprecated use activeSession selector instead */
  session: Session | null;
  setSession: (session: Session) => void;
}

const extractShellTypes = (node: PaneNode): Record<string, ShellType> => {
  if (node.type === "leaf") {
    return node.shell ? { [node.ptyId]: node.shell } : {};
  } else {
    return {
      ...extractShellTypes(node.first),
      ...extractShellTypes(node.second),
    };
  }
};

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  focusedPaneId: null,
  tabCounter: 0,
  paneCwds: {},
  paneShellTypes: {},
  tabBadges: {},
  paneActive: {},
  pinnedCwds: {},
  isIpcReady: false,

  setIpcReady: (ready) => set({ isIpcReady: ready }),

  setPinnedCwd: (sessionId, cwd) =>
    set((state) => ({
      pinnedCwds: { ...state.pinnedCwds, [sessionId]: cwd },
    })),

  clearPinnedCwd: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.pinnedCwds;
      return { pinnedCwds: rest };
    }),

  setPaneCwd: (ptyId, cwd) =>
    set((state) => ({
      paneCwds: { ...state.paneCwds, [ptyId]: cwd },
    })),

  setPaneShellType: (ptyId, shellType) =>
    set((state) => ({
      paneShellTypes: { ...state.paneShellTypes, [ptyId]: shellType },
    })),

  setPaneActive: (ptyId, active) =>
    set((state) => ({
      paneActive: { ...state.paneActive, [ptyId]: active },
    })),

  nextTabName: () => {
    const sessions = get().sessions;
    const prefix = getGitT("session.newTab");
    const usedNumbers = new Set(
      sessions
        .map((s) => s.name.match(/^.+-(\d+)$/))
        .filter(Boolean)
        .map((m) => parseInt(m![1], 10)),
    );
    let next = 1;
    while (usedNumbers.has(next)) next++;
    set({ tabCounter: next });
    return `${prefix}-${String(next).padStart(2, "0")}`;
  },

  // Computed-like getter via derived state
  get session() {
    const { sessions, activeSessionId } = get();
    return sessions.find((s) => s.id === activeSessionId) ?? null;
  },

  setSessions: (sessions) => {
    const newShellTypes = sessions.reduce(
      (acc, s) => ({ ...acc, ...extractShellTypes(s.rootPane) }),
      {},
    );
    set((state) => ({
      sessions,
      paneShellTypes: { ...state.paneShellTypes, ...newShellTypes },
    }));
  },

  setActiveSession: (sessionId) => {
    localStorage.setItem("racemo:lastSessionId", sessionId);
    set({ activeSessionId: sessionId });
  },

  updateSession: (session) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === session.id ? session : s,
      ),
      paneShellTypes: { ...state.paneShellTypes, ...extractShellTypes(session.rootPane) },
    })),

  addSession: (session) => {
    localStorage.setItem("racemo:lastSessionId", session.id);
    return set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
      paneShellTypes: { ...state.paneShellTypes, ...extractShellTypes(session.rootPane) },
    }));
  },

  removeSession: (sessionId) => {
    removeSessionDeactivation(sessionId);
    return set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId);
      const activeSessionId =
        state.activeSessionId === sessionId
          ? (sessions[sessions.length - 1]?.id ?? null)
          : state.activeSessionId;
      const { [sessionId]: _, ...pinnedRest } = state.pinnedCwds;
      return { sessions, activeSessionId, pinnedCwds: pinnedRest };
    });
  },

  setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

  incrementTabBadge: (sessionId) =>
    set((state) => ({
      tabBadges: { ...state.tabBadges, [sessionId]: (state.tabBadges[sessionId] ?? 0) + 1 },
    })),

  clearTabBadge: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.tabBadges;
      return { tabBadges: rest };
    }),

  reorderSessions: (fromIndex, toIndex) =>
    set((state) => {
      logger.debug("[sessionStore] reorderSessions:", fromIndex, "->", toIndex, "sessions:", state.sessions.length);
      const sessions = [...state.sessions];
      const [moved] = sessions.splice(fromIndex, 1);
      sessions.splice(toIndex, 0, moved);
      logger.debug("[sessionStore] new order:", sessions.map((s) => s.name));
      return { sessions };
    }),

  renameSession: (sessionId, name) => {
    invoke("rename_session", { sessionId, name }).catch(logger.error);
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, name } : s,
      ),
    }));
  },

  // Legacy compat — updates the active session in the array
  setSession: (session) =>
    set((state) => {
      const exists = state.sessions.some((s) => s.id === session.id);
      if (exists) {
        return {
          sessions: state.sessions.map((s) =>
            s.id === session.id ? session : s,
          ),
          paneShellTypes: { ...state.paneShellTypes, ...extractShellTypes(session.rootPane) },
        };
      }
      return {
        sessions: [...state.sessions, session],
        activeSessionId: session.id,
        paneShellTypes: { ...state.paneShellTypes, ...extractShellTypes(session.rootPane) },
      };
    }),
}));

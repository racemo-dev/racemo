import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../stores/sessionStore";
import { useRemoteStore } from "../../stores/remoteStore";
import { useGitT } from "../../lib/i18n/git";
import { logger } from "../../lib/logger";
import type { Session } from "../../types/session";

export interface TabCtxMenuState {
  x: number;
  y: number;
  sessionId: string;
  index: number;
}

interface TabContextMenuProps {
  menu: TabCtxMenuState;
  sessions: Session[];
  onClose: () => void;
  onCloseTab: (e: React.MouseEvent, sessionId: string) => void;
  onStartEditing: (session: Session) => void;
}

export default function TabContextMenu({ menu, sessions, onClose, onCloseTab, onStartEditing }: TabContextMenuProps) {
  const t = useGitT();
  const removeSession = useSessionStore((s) => s.removeSession);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
  }, [onClose]);

  const handleCloseOthers = (sessionId: string) => {
    const others = sessions.filter((s) => s.id !== sessionId);
    const { sessionToDevice } = useRemoteStore.getState();
    // Collect device IDs of tabs being closed
    const closingDeviceIds = new Set<string>();
    for (const s of others) {
      if (s.isRemote) {
        const did = sessionToDevice[s.id.replace(/^remote:/, "")];
        if (did) closingDeviceIds.add(did);
      }
    }
    // Exclude devices that the kept tab belongs to
    const kept = sessions.find((s) => s.id === sessionId);
    if (kept?.isRemote) {
      const keptDid = sessionToDevice[sessionId.replace(/^remote:/, "")];
      if (keptDid) closingDeviceIds.delete(keptDid);
    }
    for (const s of others) {
      removeSession(s.id);
      if (!s.isRemote) {
        invoke("close_session", { sessionId: s.id }).catch(logger.error);
      }
    }
    for (const did of closingDeviceIds) {
      useRemoteStore.getState().disconnect(did);
    }
  };

  const handleCloseToRight = (index: number) => {
    const toClose = sessions.slice(index + 1);
    const surviving = sessions.slice(0, index + 1);
    const { sessionToDevice } = useRemoteStore.getState();
    // Collect device IDs of tabs being closed
    const closingDeviceIds = new Set<string>();
    for (const s of toClose) {
      if (s.isRemote) {
        const did = sessionToDevice[s.id.replace(/^remote:/, "")];
        if (did) closingDeviceIds.add(did);
      }
    }
    // Exclude devices that have surviving tabs to the left
    for (const s of surviving) {
      if (s.isRemote) {
        const did = sessionToDevice[s.id.replace(/^remote:/, "")];
        if (did) closingDeviceIds.delete(did);
      }
    }
    for (const s of toClose) {
      removeSession(s.id);
      if (!s.isRemote) {
        invoke("close_session", { sessionId: s.id }).catch(logger.error);
      }
    }
    for (const did of closingDeviceIds) {
      useRemoteStore.getState().disconnect(did);
    }
  };

  return (
    <div
      ref={ref}
      className="fixed z-[9999] py-1 rounded shadow-lg flex flex-col"
      style={{
        left: menu.x,
        top: menu.y,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        minWidth: 180,
      }}
    >
      <button
        className="w-full text-left hover:bg-[var(--bg-overlay)] transition-colors"
        style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)", padding: "3px 12px" }}
        onClick={() => { onCloseTab({ stopPropagation: () => {} } as React.MouseEvent, menu.sessionId); onClose(); }}
      >
        {t("tab.close")}
      </button>
      {sessions.length > 1 && (
        <button
          className="w-full text-left hover:bg-[var(--bg-overlay)] transition-colors"
          style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)", padding: "3px 12px" }}
          onClick={() => { handleCloseOthers(menu.sessionId); onClose(); }}
        >
          {t("tab.closeOthers")}
        </button>
      )}
      {menu.index < sessions.length - 1 && (
        <button
          className="w-full text-left hover:bg-[var(--bg-overlay)] transition-colors"
          style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)", padding: "3px 12px" }}
          onClick={() => { handleCloseToRight(menu.index); onClose(); }}
        >
          {t("tab.closeRight")}
        </button>
      )}
      <div style={{ borderTop: "1px solid var(--border-subtle)", margin: "2px 0" }} />
      <button
        className="w-full text-left hover:bg-[var(--bg-overlay)] transition-colors"
        style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)", padding: "3px 12px" }}
        onClick={() => {
          const session = sessions.find((s) => s.id === menu.sessionId);
          if (session) onStartEditing(session);
          onClose();
        }}
      >
        {t("tab.rename")}
      </button>
    </div>
  );
}

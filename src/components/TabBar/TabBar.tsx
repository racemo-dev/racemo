import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useSessionStore } from "../../stores/sessionStore";
import { useRemoteStore } from "../../stores/remoteStore";
import { isMac } from "../../lib/osUtils";
import { isTauri } from "../../lib/bridge";
import { firstLeafId, firstPtyId, collectPtyIds } from "../../lib/paneTreeUtils";
import { suppressActivity } from "../../lib/ptyOutputBuffer";
import { onSessionActivated, onSessionDeactivated } from "../../lib/silenceDetector";
import { logger } from "../../lib/logger";
import type { Session, ShellType } from "../../types/session";

import { ShellIcon } from "./Icons";
import { useTabDrag } from "./useTabDrag";
import { useWindowDrag } from "./WindowControls";
import WindowControls from "./WindowControls";
import SystemContextMenu from "./SystemContextMenu";
import TabContextMenu, { type TabCtxMenuState } from "./TabContextMenu";
import { ConnectBadge, ShareAliveBadge } from "./StatusBadges";
import NewTabPopup from "./NewTabPopup";
import UpdateToast from "../Modals/UpdateToast";

export default function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const setFocusedPane = useSessionStore((s) => s.setFocusedPane);
  const renameSession = useSessionStore((s) => s.renameSession);
  const paneShellTypes = useSessionStore((s) => s.paneShellTypes);
  const tabBadges = useSessionStore((s) => s.tabBadges);
  const paneActive = useSessionStore((s) => s.paneActive);
  const clearTabBadge = useSessionStore((s) => s.clearTabBadge);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Context menus
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [tabCtxMenu, setTabCtxMenu] = useState<TabCtxMenuState | null>(null);

  // New tab popup
  const [showNewTabPopup, setShowNewTabPopup] = useState(false);
  const newTabButtonRef = useRef<HTMLButtonElement>(null);

  // Drag & window drag
  const { dragIndex, dropIndex, ghostPos, isDragging, tabRefs, handlePointerDown } =
    useTabDrag(sessions, activeSessionId, editingId);
  const { startWindowDrag } = useWindowDrag();

  const handleSwitchTab = useCallback((sessionId: string) => {
    if (activeSessionId && activeSessionId !== sessionId) {
      onSessionDeactivated(activeSessionId);
    }
    clearTabBadge(sessionId);
    onSessionActivated(sessionId);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      for (const id of collectPtyIds(session.rootPane)) suppressActivity(id, 3000);
    }
    if (!session) return;
    setActiveSession(session.id);
    setFocusedPane(firstLeafId(session.rootPane));
    localStorage.setItem("racemo:lastSessionId", session.id);
  }, [activeSessionId, sessions, clearTabBadge, setActiveSession, setFocusedPane]);

  const handleCloseTab = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    const session = sessions.find((s) => s.id === sessionId);
    removeSession(sessionId);
    if (session?.isRemote) {
      const remoteSessionId = sessionId.replace(/^remote:/, "");
      const { sessionToDevice } = useRemoteStore.getState();
      const deviceId = sessionToDevice[remoteSessionId];
      // Only disconnect the device if no other tabs from the same device remain
      const remainingSessions = useSessionStore.getState().sessions;
      const sameDeviceTabs = deviceId
        ? remainingSessions.filter((s) => {
            if (!s.isRemote) return false;
            const rsId = s.id.replace(/^remote:/, "");
            return sessionToDevice[rsId] === deviceId;
          })
        : [];
      if (sameDeviceTabs.length === 0 && deviceId) {
        useRemoteStore.getState().disconnect(deviceId);
      }
      // Set focused pane to the newly active session
      const next = useSessionStore.getState();
      const nextSession = next.sessions.find((s) => s.id === next.activeSessionId);
      if (nextSession) setFocusedPane(firstLeafId(nextSession.rootPane));
    } else {
      invoke<Session | null>("close_session", { sessionId })
        .then((nextSession) => {
          if (nextSession) setFocusedPane(firstLeafId(nextSession.rootPane));
        })
        .catch(logger.error);
    }
  }, [sessions, removeSession, setFocusedPane]);

  const startEditing = (session: Session) => {
    setEditingId(session.id);
    setEditValue(session.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) renameSession(editingId, editValue.trim());
    setEditingId(null);
  };

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    window.addEventListener("contextmenu", handleClick, { capture: true });
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("contextmenu", handleClick, { capture: true });
    };
  }, [contextMenu]);

  return (
    <div
      className="flex items-center shrink-0 select-none"
      style={{
        height: 'calc(32px * var(--ui-scale))',
        background: "var(--bg-overlay)",
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      {/* macOS traffic light spacing */}
      {isMac() && <div className="shrink-0" style={{ width: 86 }} />}

      {/* Tab List */}
      <div className="flex h-full">
        {sessions.map((session, index) => {
          const isActive = session.id === activeSessionId;
          const isEditing = editingId === session.id;
          const isBeingDragged = dragIndex === index;
          const isDropTarget = dropIndex === index;
          const badgeCount = tabBadges[session.id] ?? 0;
          const hasBadge = !isActive && badgeCount > 0;
          const showLeftIndicator = isDropTarget && dragIndex !== null && dragIndex > index;
          const showRightIndicator = isDropTarget && dragIndex !== null && dragIndex < index;
          const tabShell: ShellType | undefined = paneShellTypes[firstPtyId(session.rootPane)];
          const ptyIds = collectPtyIds(session.rootPane);
          const isSessionActive = ptyIds.some((id) => paneActive[id]);

          return (
            <div
              key={session.id}
              ref={(el) => { tabRefs.current[index] = el; }}
              onClick={() => { if (!isDragging.current) handleSwitchTab(session.id); }}
              onDoubleClick={(e) => { e.stopPropagation(); startEditing(session); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTabCtxMenu({ x: e.clientX, y: e.clientY, sessionId: session.id, index }); }}
              onPointerDown={(e) => handlePointerDown(e, index)}
              className="group relative flex items-center h-full px-3 gap-1.5 cursor-pointer"
              style={{
                fontSize: 'var(--fs-12)',
                letterSpacing: "0.05em",
                borderRight: showRightIndicator ? "1px solid var(--text-primary)" : `1px solid var(--border-default)`,
                borderLeft: showLeftIndicator ? "1px solid var(--text-primary)" : "2px solid transparent",
                background: isActive ? "var(--bg-base)" : "var(--bg-overlay)",
                color: isActive ? "var(--text-primary)" : "var(--text-tertiary)",
                opacity: isBeingDragged ? 0.4 : 1,
                transition: "opacity 0.15s, border-left 0.1s, border-right 0.1s",
              }}
            >
              {isSessionActive && (
                <span className="absolute bottom-0 left-0 right-0 tab-activity-bar" style={{ height: "1px" }} />
              )}
              <span style={{ color: isActive ? "var(--text-secondary)" : "var(--text-muted)", display: "inline-flex", alignItems: "center" }}>
                <ShellIcon shell={tabShell} isRemote={session.isRemote} remoteOs={session.remoteOs} />
              </span>
              {isEditing ? (
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="bg-transparent outline-none w-20"
                  style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", borderBottom: "1px solid var(--border-strong)" }}
                />
              ) : (
                <span className="uppercase whitespace-nowrap truncate" style={{ maxWidth: "120px" }}>{session.name}</span>
              )}
              <span className="flex-1" />
              <button
                onClick={(e) => handleCloseTab(e, session.id)}
                className="titlebar-btn p-1 shrink-0 relative"
                style={{ width: 'calc(18px * var(--ui-scale))', height: 'calc(18px * var(--ui-scale))' }}
              >
                {hasBadge && (
                  <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0 transition-opacity">
                    <span
                      className="rounded-full"
                      style={{ width: 'calc(6px * var(--ui-scale))', height: 'calc(6px * var(--ui-scale))', backgroundColor: "var(--status-warning)", boxShadow: "0 0 4px var(--status-warning)" }}
                    />
                  </span>
                )}
                <svg
                  viewBox="0 0 10 10" fill="none" stroke={hasBadge ? "var(--status-warning)" : "currentColor"} strokeWidth="1.5" strokeLinecap="round"
                  className={hasBadge ? "opacity-0 group-hover:opacity-100 transition-opacity" : "opacity-0 group-hover:opacity-100"}
                  style={{ width: 'calc(8px * var(--ui-scale))', height: 'calc(8px * var(--ui-scale))' }}
                >
                  <line x1="2" y1="2" x2="8" y2="8" />
                  <line x1="8" y1="2" x2="2" y2="8" />
                </svg>
              </button>
            </div>
          );
        })}

        {/* New tab button */}
        <button
          ref={newTabButtonRef}
          onClick={() => setShowNewTabPopup((prev) => !prev)}
          className="titlebar-btn h-full px-2"
          style={{ color: showNewTabPopup ? "var(--text-primary)" : "var(--text-muted)" }}
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))' }}>
            <line x1="6" y1="2" x2="6" y2="10" />
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
        </button>

        {showNewTabPopup && <NewTabPopup anchorRef={newTabButtonRef} onClose={() => setShowNewTabPopup(false)} />}
      </div>

      {/* Remaining area — draggable + right-click system menu */}
      <div
        className="flex-1 h-full cursor-default"
        onMouseDown={startWindowDrag}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
      />

      {/* Right Section */}
      <div className="flex items-center h-full">
        {isTauri() && (
          <div className="flex items-center gap-1 pr-3">
            <ShareAliveBadge />
            <ConnectBadge />
          </div>
        )}
        <div className="flex items-center pr-2">
          <UpdateToast />
        </div>
        {!isMac() && <WindowControls />}
      </div>

      {/* Drag ghost */}
      {dragIndex !== null && ghostPos && sessions[dragIndex] && (() => {
        const dragSession = sessions[dragIndex];
        const dragShell: ShellType | undefined = paneShellTypes[firstPtyId(dragSession.rootPane)];
        return (
          <div
            className="fixed z-50 flex items-center px-3 gap-1.5 pointer-events-none rounded shadow-lg"
            style={{
              left: ghostPos.x, top: ghostPos.y,
              height: 'calc(32px * var(--ui-scale))', fontSize: 'var(--fs-12)', letterSpacing: "0.05em",
              background: "var(--bg-overlay)", color: "var(--text-primary)", opacity: 0.9,
            }}
          >
            <span style={{ color: "var(--text-secondary)" }}>
              <ShellIcon shell={dragShell} isRemote={dragSession.isRemote} remoteOs={dragSession.remoteOs} />
            </span>
            <span className="uppercase">{dragSession.name}</span>
          </div>
        );
      })()}

      {/* Context menus */}
      {contextMenu && <SystemContextMenu position={contextMenu} onClose={() => setContextMenu(null)} />}
      {tabCtxMenu && (
        <TabContextMenu
          menu={tabCtxMenu}
          sessions={sessions}
          onClose={() => setTabCtxMenu(null)}
          onCloseTab={handleCloseTab}
          onStartEditing={startEditing}
        />
      )}
    </div>
  );
}

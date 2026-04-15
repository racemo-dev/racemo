import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri, apiGetHomeDir, apiGetRecentDirs } from "../../../lib/bridge";

import { useSessionStore } from "../../../stores/sessionStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { firstLeafId, collectLeafIds } from "../../../lib/paneTreeUtils";
import { getDefaultTerminalSize } from "../../../lib/terminalUtils";
import type { Session } from "../../../types/session";
import { logger } from "../../../lib/logger";

import type { LayoutOption } from "./types";
import { LAYOUT_OPTIONS } from "./types";
import { LAYOUT_ICONS } from "./layoutIcons";
import { getRecentFolders, saveRecentFolder, getFolderName, getUniqueTabName } from "./helpers";
import DuplicateConfirmDialog from "./DuplicateConfirmDialog";
import RecentFoldersList from "./RecentFoldersList";

import type { NewTabPopupProps } from "./types";

export default function NewTabPopup({ anchorRef, onClose }: NewTabPopupProps) {
  const addSession = useSessionStore((s) => s.addSession);
  const setFocusedPane = useSessionStore((s) => s.setFocusedPane);
  const sessions = useSessionStore((s) => s.sessions);

  const [workingDir, setWorkingDir] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [layout, setLayout] = useState<LayoutOption>("1");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [duplicateConfirm, setDuplicateConfirm] = useState<{ baseName: string; uniqueName: string } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load home directory and recent folders on mount
  useEffect(() => {
    // homeDir: 실패해도 빈 값으로 graceful
    apiGetHomeDir()
      .then((dir) => {
        setHomeDir(dir);
        setWorkingDir((prev) => prev || dir);
      })
      .catch(logger.error);

    // recent dirs: 서버 파일 우선, 실패 시 localStorage fallback
    apiGetRecentDirs()
      .then((dirs) => {
        if (dirs.length > 0) {
          setRecentFolders(dirs);
          setWorkingDir(dirs[0]);
        } else {
          // 서버에 데이터 없으면 localStorage 사용 (Tauri 초기 상태 등)
          const local = getRecentFolders();
          setRecentFolders(local);
          if (local.length > 0) setWorkingDir(local[0]);
        }
      })
      .catch(() => {
        // 서버 연결 안 될 때 localStorage fallback
        const local = getRecentFolders();
        setRecentFolders(local);
        if (local.length > 0) setWorkingDir(local[0]);
      });
  }, []);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [homeDir]);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Click outside to close
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    // Delay to avoid immediate close from the click that opened the popup
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [onClose, anchorRef]);

  const handleBrowse = async () => {
    if (!isTauri()) {
      // 브라우저 모드: 파일 피커 없음, 직접 타이핑
      return;
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Working Directory",
        defaultPath: workingDir || homeDir || undefined,
      });
      if (selected && typeof selected === "string") {
        setWorkingDir(selected);
      }
    } catch (err) {
      logger.error("[NewTabPopup] Failed to open directory picker:", err);
    }
  };

  const doCreateSession = useCallback(async (tabName: string) => {
    const shell = useSettingsStore.getState().defaultShell;
    const { rows, cols } = getDefaultTerminalSize();
    const dir = workingDir.trim() || null;

    // 브라우저 모드: 실제 PTY 없이 mock 세션 생성 (파일탐색/깃 상태 테스트용)
    if (!isTauri()) {
      const mockPtyId = crypto.randomUUID();
      const mockPaneId = crypto.randomUUID();
      const mockSession: Session = {
        id: crypto.randomUUID(),
        name: tabName,
        rootPane: { type: "leaf", id: mockPaneId, ptyId: mockPtyId },
        createdAt: Date.now(),
        paneCount: 1,
      };
      addSession(mockSession);
      useSessionStore.getState().setActiveSession(mockSession.id);
      if (dir) useSessionStore.getState().setPaneCwd(mockPtyId, dir);
      setFocusedPane(mockPaneId);
      if (dir) saveRecentFolder(dir);
      onClose();
      return;
    }

    try {
      // Create the initial session
      const session = await invoke<Session>("create_session", {
        name: tabName,
        workingDir: dir,
        shell,
        rows,
        cols,
      });
      addSession(session);

      // Apply layout splits
      // SplitDirection: "horizontal" = left|right, "vertical" = top/bottom
      if (layout === "2h") {
        await invoke("split_pane", {
          sessionId: session.id,
          paneId: firstLeafId(session.rootPane),
          direction: "horizontal",
          shell,
          rows,
          cols,
          before: false,
        });
      } else if (layout === "2v") {
        await invoke("split_pane", {
          sessionId: session.id,
          paneId: firstLeafId(session.rootPane),
          direction: "vertical",
          shell,
          rows,
          cols,
          before: false,
        });
      } else if (layout === "3") {
        await invoke("split_pane", {
          sessionId: session.id,
          paneId: firstLeafId(session.rootPane),
          direction: "horizontal",
          shell,
          rows,
          cols,
          before: false,
        });
        const updated = await invoke<Session>("get_session", { sessionId: session.id });
        const panes = collectLeafIds(updated.rootPane);
        if (panes.length >= 2) {
          await invoke("split_pane", {
            sessionId: session.id,
            paneId: panes[1],
            direction: "vertical",
            shell,
            rows,
            cols,
            before: false,
          });
        }
      } else if (layout === "4") {
        await invoke("split_pane", {
          sessionId: session.id,
          paneId: firstLeafId(session.rootPane),
          direction: "horizontal",
          shell,
          rows,
          cols,
          before: false,
        });
        let updated = await invoke<Session>("get_session", { sessionId: session.id });
        let panes = collectLeafIds(updated.rootPane);
        if (panes.length >= 2) {
          await invoke("split_pane", {
            sessionId: session.id,
            paneId: panes[1],
            direction: "vertical",
            shell,
            rows,
            cols,
            before: false,
          });
        }
        updated = await invoke<Session>("get_session", { sessionId: session.id });
        panes = collectLeafIds(updated.rootPane);
        if (panes.length >= 1) {
          await invoke("split_pane", {
            sessionId: session.id,
            paneId: panes[0],
            direction: "vertical",
            shell,
            rows,
            cols,
            before: false,
          });
        }
      }

      // Refresh session state and focus
      const finalSession = await invoke<Session>("get_session", { sessionId: session.id });
      useSessionStore.getState().updateSession(finalSession);
      setFocusedPane(firstLeafId(finalSession.rootPane));

      // Save to recent folders
      if (dir) {
        saveRecentFolder(dir);
      }

      onClose();
    } catch (err) {
      logger.error("[NewTabPopup] Failed to create session:", err);
      setCreateError(String(err));
    }
  }, [workingDir, layout, addSession, setFocusedPane, onClose]);

  const handleCreate = useCallback(async () => {
    if (isCreating) return;
    setIsCreating(true);

    try {
      const dir = workingDir.trim();

      // Determine tab name based on working directory
      let tabName: string;
      if (dir) {
        const folderName = getFolderName(dir);
        if (folderName) {
          const { exists, uniqueName } = getUniqueTabName(folderName, sessions);
          if (exists) {
            // Show confirmation dialog
            setDuplicateConfirm({ baseName: folderName, uniqueName });
            setIsCreating(false);
            return;
          }
          tabName = folderName;
        } else {
          tabName = useSessionStore.getState().nextTabName();
        }
      } else {
        tabName = useSessionStore.getState().nextTabName();
      }

      await doCreateSession(tabName);
    } finally {
      setIsCreating(false);
    }
  }, [isCreating, workingDir, sessions, doCreateSession]);

  // Handle duplicate confirmation
  const handleConfirmDuplicate = useCallback(async () => {
    if (!duplicateConfirm) return;
    setIsCreating(true);
    setDuplicateConfirm(null);
    try {
      await doCreateSession(duplicateConfirm.uniqueName);
    } finally {
      setIsCreating(false);
    }
  }, [duplicateConfirm, doCreateSession]);

  const handleCancelDuplicate = useCallback(() => {
    setDuplicateConfirm(null);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCreate();
    }
  };

  // Duplicate confirmation dialog
  if (duplicateConfirm) {
    return (
      <DuplicateConfirmDialog
        popupRef={popupRef}
        baseName={duplicateConfirm.baseName}
        uniqueName={duplicateConfirm.uniqueName}
        onCancel={handleCancelDuplicate}
        onConfirm={handleConfirmDuplicate}
      />
    );
  }

  return (
    <div
      ref={popupRef}
      className="fixed rounded-lg shadow-xl"
      style={{
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 9999,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        width: 340,
        padding: 16,
      }}
    >
      {/* Header */}
      <div
        className="mb-4 uppercase"
        style={{ fontSize: 'var(--fs-10)', letterSpacing: "0.1em", color: "var(--text-secondary)" }}
      >
        New Tab
      </div>

      {/* Directory Input */}
      <div className="mb-4">
        <label
          className="block mb-1.5 uppercase"
          style={{ fontSize: 'var(--fs-9)', letterSpacing: "0.08em", color: "var(--text-muted)" }}
        >
          Working Directory
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={workingDir}
            onChange={(e) => { setWorkingDir(e.target.value); setCreateError(""); }}
            onKeyDown={handleKeyDown}
            placeholder={homeDir || "Home directory"}
            className="flex-1 px-2 py-1.5 rounded outline-none"
            style={{
              fontSize: 'var(--fs-11)',
              background: "var(--bg-base)",
              border: "1px solid var(--border-default)",
              color: "var(--text-primary)",
            }}
          />
          <button
            onClick={handleBrowse}
            className="px-2 py-1.5 rounded transition-colors"
            style={{
              fontSize: 'var(--fs-11)',
              background: "var(--bg-base)",
              border: "1px solid var(--border-default)",
              color: "var(--text-secondary)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--text-muted)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)";
            }}
            title="Browse..."
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 4h4l2 2h6v8H2z" />
            </svg>
          </button>
        </div>
        {createError && (
          <p style={{ color: "var(--accent-red)", fontSize: "var(--fs-10)", marginTop: 4 }}>{createError}</p>
        )}
      </div>

      {/* Recent Folders */}
      <RecentFoldersList
        folders={recentFolders}
        workingDir={workingDir}
        homeDir={homeDir}
        onSelectFolder={setWorkingDir}
        onFoldersChange={setRecentFolders}
      />

      {/* Layout Selection */}
      <div className="mb-4">
        <label
          className="block mb-1.5 uppercase"
          style={{ fontSize: 'var(--fs-9)', letterSpacing: "0.08em", color: "var(--text-muted)" }}
        >
          Pane Layout
        </label>
        <div className="flex justify-between">
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => setLayout(opt)}
              className="flex items-center justify-center p-2 rounded transition-colors"
              style={{
                background: layout === opt ? "var(--bg-overlay)" : "var(--bg-base)",
                border: layout === opt ? "1px solid var(--accent-blue)" : "1px solid var(--border-default)",
                color: layout === opt ? "var(--accent-blue)" : "var(--text-secondary)",
              }}
              title={
                opt === "1" ? "Single pane" :
                  opt === "2h" ? "2 panes (side by side)" :
                    opt === "2v" ? "2 panes (top/bottom)" :
                      opt === "3" ? "3 panes" :
                        "4 panes (grid)"
              }
            >
              {LAYOUT_ICONS[opt]}
            </button>
          ))}
        </div>
      </div>

      {/* Create Button - Outline Style */}
      <button
        onClick={handleCreate}
        disabled={isCreating}
        className="w-full py-2 rounded transition-colors uppercase"
        style={{
          fontSize: 'var(--fs-10)',
          letterSpacing: "0.08em",
          background: "transparent",
          border: "1px solid var(--border-default)",
          color: "var(--text-secondary)",
          opacity: isCreating ? 0.5 : 1,
          cursor: isCreating ? "not-allowed" : "pointer",
        }}
        onMouseEnter={(e) => {
          if (!isCreating) {
            (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)";
            (e.currentTarget as HTMLElement).style.borderColor = "var(--text-muted)";
          }
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
          (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)";
        }}
      >
        {isCreating ? "Creating..." : "Create Tab"}
      </button>
    </div>
  );
}

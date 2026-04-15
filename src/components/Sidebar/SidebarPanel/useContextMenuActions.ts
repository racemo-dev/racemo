import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openEditorPanel } from "../../../lib/editorWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { apiWriteToPty } from "../../../lib/bridge";
import { useSessionStore } from "../../../stores/sessionStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { findPtyId } from "../../../lib/paneTreeUtils";
import { useDialogStore } from "../../../stores/dialogStore";
import type { ContextMenuState, InlineInputState } from "./types";

interface UseContextMenuActionsParams {
  ctxMenu: ContextMenuState | null;
  setCtxMenu: (v: ContextMenuState | null) => void;
  setInlineInput: (v: InlineInputState | null) => void;
  setInlineValue: (v: string) => void;
  refreshTree: () => void;
}

export function useContextMenuActions({
  ctxMenu,
  setCtxMenu,
  setInlineInput,
  setInlineValue,
  refreshTree,
}: UseContextMenuActionsParams) {
  const getActivePtyId = useCallback(() => {
    const { sessions, activeSessionId, focusedPaneId } = useSessionStore.getState();
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session || !focusedPaneId) return null;
    return findPtyId(session.rootPane, focusedPaneId) ?? null;
  }, []);

  const handleOpenInTerminal = useCallback(() => {
    if (!ctxMenu) return;
    const { path } = ctxMenu;
    const ptyId = getActivePtyId();
    if (!ptyId) return;

    const shellType = useSessionStore.getState().paneShellTypes[ptyId] || useSettingsStore.getState().defaultShell;
    const command = shellType === "Cmd" ? `cd /d "${path}"\r` : `cd "${path}"\r`;
    apiWriteToPty(ptyId, new TextEncoder().encode(command)).catch(console.error);
    setCtxMenu(null);
  }, [ctxMenu, getActivePtyId, setCtxMenu]);

  const handlePastePathToTerminal = useCallback(() => {
    if (!ctxMenu) return;
    const ptyId = getActivePtyId();
    if (!ptyId) return;
    apiWriteToPty(ptyId, new TextEncoder().encode(ctxMenu.path)).catch(console.error);
    setCtxMenu(null);
  }, [ctxMenu, getActivePtyId, setCtxMenu]);

  const handleOpenInPanel = useCallback(() => {
    if (!ctxMenu || ctxMenu.isDir) return;
    openEditorPanel(ctxMenu.path).catch(console.error);
    setCtxMenu(null);
  }, [ctxMenu, setCtxMenu]);

  const handleOpenInWindow = useCallback(() => {
    if (!ctxMenu || ctxMenu.isDir) return;
    import("../../../lib/editorWindow").then(({ openEditorExternalWindow }) =>
      openEditorExternalWindow(ctxMenu.path, true).catch(console.error)
    );
    setCtxMenu(null);
  }, [ctxMenu, setCtxMenu]);

  const handleOpenInDefaultApp = useCallback(() => {
    if (!ctxMenu) return;
    invoke("open_in_default_app", { path: ctxMenu.path }).catch(console.error);
    setCtxMenu(null);
  }, [ctxMenu, setCtxMenu]);

  const handleRevealInFinder = useCallback(() => {
    if (!ctxMenu) return;
    invoke("reveal_in_file_manager", { path: ctxMenu.path }).catch(console.error);
    setCtxMenu(null);
  }, [ctxMenu, setCtxMenu]);

  const handleCopyPath = useCallback(() => {
    if (!ctxMenu) return;
    writeText(ctxMenu.path).catch(console.error);
    setCtxMenu(null);
  }, [ctxMenu, setCtxMenu]);

  const handleNewFile = useCallback(() => {
    if (!ctxMenu) return;
    const parentPath = ctxMenu.isDir ? ctxMenu.path : ctxMenu.path.substring(0, ctxMenu.path.lastIndexOf("/"));
    setInlineInput({ mode: "new-file", parentPath });
    setInlineValue("");
    setCtxMenu(null);
  }, [ctxMenu, setCtxMenu, setInlineInput, setInlineValue]);

  const handleNewFolder = useCallback(() => {
    if (!ctxMenu) return;
    const parentPath = ctxMenu.isDir ? ctxMenu.path : ctxMenu.path.substring(0, ctxMenu.path.lastIndexOf("/"));
    setInlineInput({ mode: "new-dir", parentPath });
    setInlineValue("");
    setCtxMenu(null);
  }, [ctxMenu, setCtxMenu, setInlineInput, setInlineValue]);

  const handleRename = useCallback(() => {
    if (!ctxMenu) return;
    const lastSlash = ctxMenu.path.lastIndexOf("/");
    const parentPath = ctxMenu.path.substring(0, lastSlash);
    const originalName = ctxMenu.path.substring(lastSlash + 1);
    setInlineInput({ mode: "rename", parentPath, originalName });
    setInlineValue(originalName);
    setCtxMenu(null);
  }, [ctxMenu, setCtxMenu, setInlineInput, setInlineValue]);

  const handleTrash = useCallback(() => {
    if (!ctxMenu) return;
    const { path } = ctxMenu;
    const name = path.substring(path.lastIndexOf("/") + 1);
    setCtxMenu(null);
    useDialogStore.getState().show({
      title: "Move to Trash",
      message: `"${name}" will be moved to trash.`,
      type: "warning",
      confirmLabel: "Move to Trash",
      cancelLabel: "Cancel",
      onConfirm: () => {
        invoke("trash_path", { path })
          .then(refreshTree)
          .catch(console.error);
      },
    });
  }, [ctxMenu, setCtxMenu, refreshTree]);

  return {
    handleOpenInTerminal,
    handlePastePathToTerminal,
    handleOpenInPanel,
    handleOpenInWindow,
    handleOpenInDefaultApp,
    handleRevealInFinder,
    handleCopyPath,
    handleNewFile,
    handleNewFolder,
    handleRename,
    handleTrash,
  };
}

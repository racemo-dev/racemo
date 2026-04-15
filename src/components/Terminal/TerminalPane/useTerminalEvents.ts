import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../../lib/bridge";
import { useAutocompleteStore } from "../../../stores/autocompleteStore";
import { isMac } from "../../../lib/osUtils";
import type { SearchBarHandle } from "../../SearchBar";

/**
 * Intercept arrow keys / Escape / Tab at keydown level when autocomplete popup is open.
 */
export function useAutocompleteKeyHandler(
  acIsOpenForPane: boolean,
  ptyId: string,
  isFocusedRef: React.RefObject<boolean>,
  acNavigatedRef: React.MutableRefObject<boolean>,
  acceptCompletion: (insertText: string, kind?: string) => void,
) {
  useEffect(() => {
    if (!acIsOpenForPane) return;
    const handler = (e: KeyboardEvent) => {
      if (!isFocusedRef.current) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        useAutocompleteStore.getState().moveDown();
        acNavigatedRef.current = true;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        useAutocompleteStore.getState().moveUp();
        acNavigatedRef.current = true;
        return;
      }
      if (e.key === "Tab" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const acStore = useAutocompleteStore.getState();
        const item = acStore.items[acStore.selectedIndex];
        if (item) acceptCompletion(item.insertText, item.kind);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        useAutocompleteStore.getState().dismiss();
        return;
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [acIsOpenForPane, ptyId, isFocusedRef, acNavigatedRef, acceptCompletion]);
}

/**
 * Cmd+F search shortcut for this pane.
 */
export function useSearchShortcut(
  ptyId: string,
  isFocusedRef: React.RefObject<boolean>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  setSearchOpen: (open: boolean) => void,
  searchBarRef: React.RefObject<SearchBarHandle | null>,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isFocusedRef.current) return;
      const target = e.target as HTMLElement;
      if (!containerRef.current?.contains(target)) return;
      if (target.closest(".cm-editor")) return;
      if ((isMac() ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        setTimeout(() => searchBarRef.current?.focus(), 0);
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [ptyId, isFocusedRef, containerRef, setSearchOpen, searchBarRef]);
}

/**
 * File drag-and-drop: write file paths to PTY.
 */
export function useDragDrop(
  ptyId: string,
  isFocusedRef: React.RefObject<boolean>,
) {
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsDragOver(true);
      } else if (event.payload.type === "leave") {
        setIsDragOver(false);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        if (!isFocusedRef.current) return;
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;
        const quoted = paths.map((p: string) =>
          p.includes(" ") ? `'${p}'` : p
        );
        const text = quoted.join(" ");
        const encoder = new TextEncoder();
        const bytes = Array.from(encoder.encode(text));
        invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(console.error);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [ptyId, isFocusedRef]);

  return isDragOver;
}

/**
 * Context menu close on any click.
 */
export function useContextMenuClose(
  ctxMenu: { x: number; y: number; openUp: boolean } | null,
  setCtxMenu: (menu: null) => void,
) {
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, { capture: true });
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, { capture: true });
    };
  }, [ctxMenu, setCtxMenu]);
}

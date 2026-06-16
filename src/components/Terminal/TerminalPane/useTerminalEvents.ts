import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../../lib/bridge";
import { useAutocompleteStore } from "../../../stores/autocompleteStore";
import { isMac } from "../../../lib/osUtils";
import { logger } from "../../../lib/logger";
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
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".avif"]);
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTS.has(path.slice(dot).toLowerCase());
}

export function useDragDrop(
  ptyId: string,
  isFocusedRef: React.RefObject<boolean>,
  inputBarOpenRef?: React.RefObject<boolean>,
  containerRef?: React.RefObject<HTMLElement | null>,
  onImageDrop?: (paths: string[]) => void,
) {
  const [isDragOver, setIsDragOver] = useState(false);

  // Stable reference so callers can pass an inline callback without forcing
  // the drag-drop listener to re-register on every render. Re-registration is
  // dangerous here because Tauri's `unlisten` resolves asynchronously — during
  // the gap the new listener and the still-attached old listener both fire,
  // doubling each drop (e.g. a screenshot path written to the PTY twice as
  // `'P''P'`).
  const onImageDropRef = useRef(onImageDrop);
  useEffect(() => {
    onImageDropRef.current = onImageDrop;
  });

  useEffect(() => {
    if (!isTauri()) return;
    // Race guard: Tauri's `unlisten` resolves asynchronously, so when the
    // effect re-runs (HMR, pane remount, strict-mode double-invoke) the old
    // listener can still fire one or more times between "cleanup requested"
    // and "unregistered". Without this flag those late fires duplicate every
    // drop — exactly what produced the intermittent `'P''P'` paste.
    let active = true;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (!active) return;
      const hitTest = (pos: { x: number; y: number }) => {
        const el = containerRef?.current;
        // Don't fall back to isFocusedRef: in multi-pane layouts the focused pane
        // would silently claim every drop while its containerRef briefly is null.
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;
        // Tauri may provide physical or logical pixels depending on platform/version.
        // If pos exceeds the CSS viewport, treat as physical and divide by DPR.
        const isPhysical = pos.x > window.innerWidth || pos.y > window.innerHeight;
        const lx = isPhysical ? pos.x / scale : pos.x;
        const ly = isPhysical ? pos.y / scale : pos.y;
        return lx >= r.left && lx < r.right && ly >= r.top && ly < r.bottom;
      };

      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsDragOver(hitTest(event.payload.position));
      } else if (event.payload.type === "leave") {
        setIsDragOver(false);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        if (!hitTest(event.payload.position)) return;
        // If input bar is open, check if drop landed on it — if so, skip (input bar handles it)
        if (inputBarOpenRef?.current) {
          const pos = event.payload.position;
          const scale = window.devicePixelRatio || 1;
          // Scope to this pane's container to avoid hitting another pane's input bar.
          const barEl = containerRef?.current?.querySelector("[data-input-bar-container]");
          if (barEl) {
            const r = barEl.getBoundingClientRect();
            const isPhysical = pos.x > window.innerWidth || pos.y > window.innerHeight;
            const lx = isPhysical ? pos.x / scale : pos.x;
            const ly = isPhysical ? pos.y / scale : pos.y;
            if (lx >= r.left && lx < r.right && ly >= r.top && ly < r.bottom) return;
          }
        }
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;

        // Image files: route to input bar only when it's already visible.
        // If the input bar is closed, treat images like any other file path (write to PTY).
        if (onImageDropRef.current && inputBarOpenRef?.current) {
          const images = paths.filter(isImagePath);
          const others = paths.filter((p) => !isImagePath(p));
          if (images.length > 0) onImageDropRef.current(images);
          if (others.length === 0) return;
          const quoted = others.map((p: string) => p.includes(" ") ? `'${p}'` : p);
          const encoder = new TextEncoder();
          invoke("write_to_pty", { paneId: ptyId, data: Array.from(encoder.encode(quoted.join(" "))) }).catch(logger.error);
          return;
        }

        const quoted = paths.map((p: string) =>
          p.includes(" ") ? `'${p}'` : p
        );
        const text = quoted.join(" ");
        const encoder = new TextEncoder();
        const bytes = Array.from(encoder.encode(text));
        invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(logger.error);
      }
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [ptyId, isFocusedRef, inputBarOpenRef, containerRef]);

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

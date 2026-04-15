import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { useAutocompleteStore } from "../../../stores/autocompleteStore";
import { getCompletions } from "../../../lib/completionEngine";
import { isTauri } from "../../../lib/bridge";
import { getBrowserRemoteClient } from "../../../lib/webrtcClient";
import { getRemoteCursorPos } from "./helpers";
import { logger } from "../../../lib/logger";

export function useRemoteAutocomplete(
  remotePaneId: string,
  termRef: React.RefObject<Terminal | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  cwdRef: React.MutableRefObject<string>,
) {
  const inputLineRef = useRef("");
  const acTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isExecutingRef = useRef(false);

  // Accept autocomplete: replace partial token with selected completion
  const acceptCompletion = useCallback((insertText: string, kind?: string) => {
    const store = useAutocompleteStore.getState();
    if (!store.isOpen) return;

    const inputLine = inputLineRef.current;
    const hasTrailingSpace = inputLine.endsWith(" ");

    // History completions: insertText is the remaining suffix, just append
    if (kind === "history") {
      const encoder = new TextEncoder();
      const bytes = Array.from(encoder.encode(insertText));
      if (!isTauri()) {
        getBrowserRemoteClient().sendInput(remotePaneId, new Uint8Array(bytes));
      } else {
        invoke("write_to_remote_pty", { paneId: remotePaneId, data: bytes }).catch(logger.error);
      }
      inputLineRef.current = inputLine + insertText;
      store.dismiss();
      return;
    }

    let replacement = insertText;
    if (!hasTrailingSpace && inputLine.length > 0) {
      const lastSpaceIdx = inputLine.lastIndexOf(" ");
      const token = inputLine.slice(lastSpaceIdx + 1);
      const lastSlashIdx = token.lastIndexOf("/");
      const erasePartial = lastSlashIdx >= 0 ? token.slice(lastSlashIdx + 1) : token;
      if (erasePartial.length > 0) {
        replacement = "\x7f".repeat(erasePartial.length) + insertText;
      }
    }

    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(replacement));
    if (!isTauri()) {
      getBrowserRemoteClient().sendInput(remotePaneId, new Uint8Array(bytes));
    } else {
      invoke("write_to_remote_pty", { paneId: remotePaneId, data: bytes }).catch(logger.error);
    }

    if (!hasTrailingSpace && inputLine.length > 0) {
      const lastSpaceIdx = inputLine.lastIndexOf(" ");
      const token = inputLine.slice(lastSpaceIdx + 1);
      const lastSlashIdx = token.lastIndexOf("/");
      const prefix = lastSlashIdx >= 0
        ? inputLine.slice(0, lastSpaceIdx + 1) + token.slice(0, lastSlashIdx + 1)
        : inputLine.slice(0, lastSpaceIdx + 1);
      inputLineRef.current = prefix + insertText;
    } else {
      inputLineRef.current = inputLine + insertText;
    }

    store.dismiss();
  }, [remotePaneId]);

  // Debounced autocomplete trigger
  const triggerAutocomplete = useCallback(() => {
    if (acTimerRef.current) clearTimeout(acTimerRef.current);
    acTimerRef.current = setTimeout(async () => {
      const input = inputLineRef.current;
      if (!input || input.length < 1) {
        useAutocompleteStore.getState().dismiss();
        return;
      }
      try {
        const cwd = cwdRef.current || "~";
        const items = await getCompletions(input, cwd);
        if (items.length > 0 && inputLineRef.current === input) {
          const term = termRef.current;
          const container = containerRef.current;
          if (term && container) {
            const pos = getRemoteCursorPos(term, container);
            if (pos) {
              useAutocompleteStore.getState().show(items, pos.x, pos.y + pos.lineHeight, pos.lineHeight, remotePaneId);
            }
          }
        } else {
          useAutocompleteStore.getState().dismiss();
        }
      } catch {
        useAutocompleteStore.getState().dismiss();
      }
    }, 60);
  }, [remotePaneId, termRef, containerRef, cwdRef]);

  // Cleanup autocomplete timer on unmount
  useEffect(() => {
    return () => {
      if (acTimerRef.current) clearTimeout(acTimerRef.current);
      const acStore = useAutocompleteStore.getState();
      if (acStore.activePtyId === remotePaneId) acStore.dismiss();
    };
  }, [remotePaneId]);

  // Listen for click-based accept from AutocompletePopup
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.ptyId === remotePaneId) {
        acceptCompletion(detail.insertText, detail.kind);
      }
    };
    window.addEventListener("racemo-autocomplete-accept", handler);
    return () => window.removeEventListener("racemo-autocomplete-accept", handler);
  }, [remotePaneId, acceptCompletion]);

  // Intercept arrow keys / Escape / Tab at keydown level when autocomplete popup is open.
  const useAutocompleteKeydownInterceptor = (isFocused: boolean, acIsOpenForPane: boolean) => {
    useEffect(() => {
      if (!isFocused || !acIsOpenForPane) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          useAutocompleteStore.getState().moveDown();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          useAutocompleteStore.getState().moveUp();
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
    }, [isFocused, acIsOpenForPane]);
  };

  return {
    inputLineRef,
    isExecutingRef,
    acceptCompletion,
    triggerAutocomplete,
    useAutocompleteKeydownInterceptor,
  };
}

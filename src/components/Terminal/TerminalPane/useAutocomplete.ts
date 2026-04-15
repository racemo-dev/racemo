import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAutocompleteStore } from "../../../stores/autocompleteStore";
import { getCompletions } from "../../../lib/completionEngine";
import { getCursorPixelPosition } from "../../../lib/terminalRegistry";

/**
 * Autocomplete state refs and handlers for a single terminal pane.
 */
export function useAutocomplete(ptyId: string, cwdRef: React.RefObject<string>) {
  const inputLineRef = useRef("");
  const acTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isExecutingRef = useRef(false);
  const isComposingRef = useRef(false);
  // True only when user has navigated the popup with arrow keys — Enter accepts only then
  const acNavigatedRef = useRef(false);

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
      invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(console.error);
      inputLineRef.current = inputLine + insertText;
      store.dismiss();
      return;
    }

    // Build replacement: erase partial, type full completion
    let replacement = insertText;
    if (!hasTrailingSpace && inputLine.length > 0) {
      const lastSpaceIdx = inputLine.lastIndexOf(" ");
      const token = inputLine.slice(lastSpaceIdx + 1);
      // For path tokens (containing /), only erase the segment after the last /
      const lastSlashIdx = token.lastIndexOf("/");
      const erasePartial = lastSlashIdx >= 0 ? token.slice(lastSlashIdx + 1) : token;
      if (erasePartial.length > 0) {
        const eraseSeq = "\x7f".repeat(erasePartial.length);
        replacement = eraseSeq + insertText;
      }
    }

    // Send directly to PTY (bypass onData to avoid re-triggering autocomplete)
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(replacement));
    invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(console.error);

    // Update local input line
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
  }, [ptyId]);

  // Debounced autocomplete trigger
  const triggerAutocomplete = useCallback(() => {
    // Skip during IME composition to prevent IME anchor displacement on Windows
    if (isComposingRef.current) return;

    if (acTimerRef.current) clearTimeout(acTimerRef.current);
    acTimerRef.current = setTimeout(async () => {
      // Re-check after debounce delay in case composition started during the wait
      if (isComposingRef.current) return;
      const input = inputLineRef.current;
      if (!input || input.length < 1) {
        useAutocompleteStore.getState().dismiss();
        return;
      }
      try {
        const cwd = cwdRef.current || "~";
        const items = await getCompletions(input, cwd);
        if (items.length > 0 && inputLineRef.current === input) {
          const pos = getCursorPixelPosition(ptyId);
          if (pos) {
            acNavigatedRef.current = false;
            useAutocompleteStore.getState().show(items, pos.x, pos.y + pos.lineHeight, pos.lineHeight, ptyId);
          }
        } else {
          useAutocompleteStore.getState().dismiss();
        }
      } catch {
        useAutocompleteStore.getState().dismiss();
      }
    }, 60);
  }, [ptyId, cwdRef]);

  // Cleanup autocomplete timer on unmount
  useEffect(() => {
    return () => {
      if (acTimerRef.current) clearTimeout(acTimerRef.current);
      const acStore = useAutocompleteStore.getState();
      if (acStore.activePtyId === ptyId) acStore.dismiss();
    };
  }, [ptyId]);

  // Listen for click-based accept from AutocompletePopup
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.ptyId === ptyId) {
        acceptCompletion(detail.insertText, detail.kind);
      }
    };
    window.addEventListener("racemo-autocomplete-accept", handler);
    return () => window.removeEventListener("racemo-autocomplete-accept", handler);
  }, [ptyId, acceptCompletion]);

  // Sync inputLineRef when this pane receives broadcast input from another pane
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ ptyId: string; data: string }>).detail;
      if (detail?.ptyId !== ptyId) return;
      const data = detail.data;
      if (data === "\r" || data === "\n") {
        inputLineRef.current = "";
      } else if (data === "\x7f") {
        inputLineRef.current = inputLineRef.current.slice(0, -1);
      } else if (data === "\x03" || data === "\x04") {
        inputLineRef.current = "";
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputLineRef.current += data;
      }
    };
    window.addEventListener("racemo-broadcast-data", handler);
    return () => window.removeEventListener("racemo-broadcast-data", handler);
  }, [ptyId]);

  return {
    inputLineRef,
    acTimerRef,
    isExecutingRef,
    isComposingRef,
    acNavigatedRef,
    acceptCompletion,
    triggerAutocomplete,
  };
}

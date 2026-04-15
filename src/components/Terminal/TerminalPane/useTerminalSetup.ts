import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../../lib/bridge";
import { useSessionStore } from "../../../stores/sessionStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useBroadcastStore } from "../../../stores/broadcastStore";
import { getOrCreateTerminal, getTerminal, disposeTerminal } from "../../../lib/terminalRegistry";
import { flushPtyOutputBuffer, clearPtyOutputBuffer, suppressActivity } from "../../../lib/ptyOutputBuffer";
import { onPromptStart, onCommandStart, onCommandEnd, onCommandText, getPendingCommandText, isCommandRunning, removeCommandState } from "../../../lib/commandTracker";
import { useHistoryStore } from "../../../stores/historyStore";
import { removeSilenceDetector } from "../../../lib/silenceDetector";
import { useCommandErrorStore } from "../../../stores/commandErrorStore";
import { firstLeafId, findPtyId } from "../../../lib/paneTreeUtils";
import { useAutocompleteStore } from "../../../stores/autocompleteStore";
import { useRestoreStore } from "../../../stores/restoreStore";
import { EXPLORER_REFRESH_EVENT, dirCacheInvalidateAll } from "../../Sidebar/SidebarPanel/constants";
import { logger } from "../../../lib/logger";
import type { PtyExitPayload } from "./types";
import type { Session } from "../../../types/session";

interface UseTerminalSetupOptions {
  ptyId: string;
  paneId: string;
  paneShellType: string;
  lastCommand?: string;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  cwdRef: React.RefObject<string>;
  initialCwdRef: React.RefObject<string>;
  setTitle: (title: string) => void;
  // Autocomplete refs and callbacks
  inputLineRef: React.MutableRefObject<string>;
  acTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  isExecutingRef: React.MutableRefObject<boolean>;
  isComposingRef: React.MutableRefObject<boolean>;
  acNavigatedRef: React.MutableRefObject<boolean>;
  acceptCompletion: (insertText: string, kind?: string) => void;
  triggerAutocomplete: () => void;
}

export function useTerminalSetup({
  ptyId,
  paneId,
  paneShellType,
  lastCommand,
  wrapperRef,
  cwdRef,
  initialCwdRef,
  setTitle,
  inputLineRef,
  acTimerRef,
  isExecutingRef,
  isComposingRef,
  acNavigatedRef,
  acceptCompletion,
  triggerAutocomplete,
}: UseTerminalSetupOptions) {
  const setSession = useSessionStore((s) => s.setSession);
  const setFocusedPane = useSessionStore((s) => s.setFocusedPane);

  const getSessionId = useCallback(() => {
    return useSessionStore.getState().activeSessionId ?? "";
  }, []);

  // Session restore: write last command on first prompt
  const firstPromptRef = useRef(true);
  // Capture command at Enter time (before inputLineRef is cleared)
  const lastEnteredCmdRef = useRef("");
  // Tracks command across 133;C → 133;A for fallback error detection
  const lastCmdForErrorRef = useRef("");
  // Position of prompt end (133;B) → start of user input area for buffer reads
  const promptEndRef = useRef<{ row: number; col: number } | null>(null);

  // Terminal setup — create/attach terminal, wire up I/O.
  useEffect(() => {
    if (!isTauri()) return;
    if (!wrapperRef.current) return;

    const { terminal: term, fitAddon, container, ime, isNew: isNewTerminal } = getOrCreateTerminal(ptyId);

    // 쉘 타입을 IME 인터셉터에 전달
    ime.setShellType(paneShellType);

    // Wire up IME composition state and input to handle PTY writes and local UI sync
    ime.setHandlers({
      onStart: () => {
        isComposingRef.current = true;
        if (acTimerRef.current) {
          clearTimeout(acTimerRef.current);
          acTimerRef.current = null;
        }
        useAutocompleteStore.getState().dismiss();
      },
      onEnd: () => {
        isComposingRef.current = false;
      },
      onInput: (text) => {
        if (!isExecutingRef.current && useAutocompleteStore.getState().enabled) {
          inputLineRef.current += text;
          triggerAutocomplete();
        }

        const encoder = new TextEncoder();
        const bytes = Array.from(encoder.encode(text));
        const { enabled, selectedPtyIds } = useBroadcastStore.getState();
        if (enabled && selectedPtyIds.length > 0) {
          for (const targetPtyId of selectedPtyIds) {
            invoke("write_to_pty", { paneId: targetPtyId, data: bytes }).catch(console.error);
            if (targetPtyId !== ptyId) {
              window.dispatchEvent(new CustomEvent("racemo-broadcast-data", { detail: { ptyId: targetPtyId, data: text } }));
            }
          }
        } else {
          invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(console.error);
        }
      }
    });

    const wrapper = wrapperRef.current;
    wrapper.appendChild(container);

    const titleDisposable = term.onTitleChange((t) => {
      if (cwdRef.current) {
        setTitle(cwdRef.current);
      } else if (initialCwdRef.current) {
        setTitle(initialCwdRef.current);
      } else {
        setTitle(t);
      }
    });

    const osc7Disposable = term.parser.registerOscHandler(7, (data) => {
      let path = data;
      try {
        if (data.startsWith("file://")) {
          const filePrefix = "file://";
          const hostEndIdx = data.indexOf("/", filePrefix.length);
          if (hostEndIdx !== -1) {
            path = data.slice(hostEndIdx);
          } else {
            const url = new URL(data);
            path = decodeURIComponent(url.pathname);
          }
          if (path.startsWith("/") && path.length > 2 && path[1].match(/[a-zA-Z]/) && path[2] === ":") {
            path = path.slice(1);
          }
        }
      } catch {
        // Fallback to raw data if parsing fails
      }
      path = path.replace(/\\/g, "/");
      cwdRef.current = path;
      setTitle(path);
      useSessionStore.getState().setPaneCwd(ptyId, path);
      return false;
    });

    // OSC 133 handler for command tracking (prompt/command lifecycle)
    const osc133Disposable = term.parser.registerOscHandler(133, (data) => {
      const marker = data.trim();

      if (marker.startsWith("A")) {
        // Fallback error detection
        const cmdToCheck = lastCmdForErrorRef.current;
        lastCmdForErrorRef.current = "";
        if (cmdToCheck && !useCommandErrorStore.getState().errors[ptyId]) {
          const buf = term.buffer.active;
          const lines: string[] = [];
          const start = Math.max(0, buf.baseY + buf.cursorY - 50);
          const end = buf.baseY + buf.cursorY;
          for (let i = start; i <= end; i++) {
            const line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
          const output = lines.join("\n");
          const isErrorOutput =
            /인식되지 않습니다/.test(output) ||
            /is not recognized as the name of a cmdlet/i.test(output) ||
            /wird nicht als Name eines Cmdlet/i.test(output) ||
            /no se reconoce como nombre de un cmdlet/i.test(output) ||
            /n'est pas reconnu en tant que nom d'applet/i.test(output) ||
            /FullyQualifiedErrorId\s*:/i.test(output) ||
            /\+\s*CategoryInfo\s*:/i.test(output) ||
            /command not found/i.test(output) ||
            /Unknown command:/i.test(output);
          if (isErrorOutput) {
            if (isCommandRunning(ptyId)) {
              onCommandEnd(ptyId, 1);
            } else {
              useHistoryStore.getState().deleteEntry(cmdToCheck);
              useCommandErrorStore.getState().setError(ptyId, {
                command: cmdToCheck,
                exitCode: 1,
                timestamp: Date.now(),
              });
            }
            const err = useCommandErrorStore.getState().errors[ptyId];
            if (err && !err.terminalOutput) {
              useCommandErrorStore.getState().setError(ptyId, { ...err, terminalOutput: output.trimEnd() });
            }
          }
        }

        onPromptStart(ptyId);
        inputLineRef.current = "";

        // 명령 완료 후 탐색기 트리 새로고침 (파일 변경 반영)
        if (!firstPromptRef.current) {
          dirCacheInvalidateAll();
          window.dispatchEvent(new Event(EXPLORER_REFRESH_EVENT));
        }
        isExecutingRef.current = false;

        if (firstPromptRef.current) {
          firstPromptRef.current = false;
          if (lastCommand) {
            const sessionId = useSessionStore.getState().activeSessionId ?? "";
            useRestoreStore.getState().register(sessionId, ptyId, paneId, lastCommand);
          }
        }

        const settings = useSettingsStore.getState();
        if (settings.smartImeEnabled) {
          const type = ime.getCursorSyntaxType();
          ime.setInterceptEnabled(type === "command" ? false : settings.imeInterceptEnabled);
        } else {
          ime.setInterceptEnabled(settings.imeInterceptEnabled);
        }

        ime.notifyPromptStart();
        useAutocompleteStore.getState().dismiss();
      } else if (marker.startsWith("B")) {
        onCommandText(ptyId, marker.slice(1).trim());
        ime.setPromptY(term.buffer.active.cursorY);
        promptEndRef.current = {
          row: term.buffer.active.baseY + term.buffer.active.cursorY,
          col: term.buffer.active.cursorX,
        };
      } else if (marker.startsWith("C")) {
        if (lastEnteredCmdRef.current) {
          const cmd = lastEnteredCmdRef.current;
          lastEnteredCmdRef.current = "";
          if (!getPendingCommandText(ptyId)) {
            onCommandText(ptyId, cmd);
          }
          lastCmdForErrorRef.current = cmd;
          const sid = getSessionId();
          invoke("set_pane_last_command", { sessionId: sid, paneId, command: cmd })
            .catch((e) => logger.warn("[last-cmd] save failed:", e));
        }
        onCommandStart(ptyId);
        isExecutingRef.current = true;
        ime.clearPromptY();
        ime.setInterceptEnabled(useSettingsStore.getState().imeInterceptEnabled);
        useAutocompleteStore.getState().dismiss();
      } else if (marker.startsWith("D")) {
        const exitCode = parseInt(marker.slice(2), 10);
        if (!isNaN(exitCode) && exitCode !== 0) {
          const buf = term.buffer.active;
          const lines: string[] = [];
          const start = Math.max(0, buf.baseY + buf.cursorY - 50);
          const end = buf.baseY + buf.cursorY;
          for (let i = start; i <= end; i++) {
            const line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
          const output = lines.join("\n").trimEnd();
          const afterEnd = () => {
            const err = useCommandErrorStore.getState().errors[ptyId];
            if (err && !err.terminalOutput) {
              useCommandErrorStore.getState().setError(ptyId, { ...err, terminalOutput: output });
            }
          };
          onCommandEnd(ptyId, exitCode);
          afterEnd();
        } else {
          onCommandEnd(ptyId, isNaN(exitCode) ? undefined : exitCode);
        }
        isExecutingRef.current = false;
        ime.setInterceptEnabled(useSettingsStore.getState().imeInterceptEnabled);
      }
      return false;
    });

    const onDataDisposable = term.onData((data) => {
      if (ime.imeActive) return;

      // Track input line
      if (!isExecutingRef.current) {
        if (data === "\r" || data === "\n") {
          const termInst = getTerminal(ptyId);
          if (termInst && promptEndRef.current) {
            const buf = termInst.terminal.buffer.active;
            const { row: startRow, col: startCol } = promptEndRef.current;
            const endRow = buf.baseY + buf.cursorY;
            let cmd = "";
            if (startCol > 0) {
              const parts: string[] = [];
              for (let r = startRow; r <= endRow; r++) {
                const line = buf.getLine(r);
                if (!line) continue;
                const sc = r === startRow ? startCol : 0;
                parts.push(line.translateToString(r !== endRow, sc));
              }
              // eslint-disable-next-line no-control-regex -- PTY output commonly contains NUL bytes
              cmd = parts.join("").replace(/\x00/g, "").trimEnd();
            } else {
              const line = buf.getLine(endRow);
              if (line) {
                // eslint-disable-next-line no-control-regex -- PTY output commonly contains NUL bytes
                const raw = line.translateToString(true).replace(/\x00/g, "").trimEnd();
                cmd = raw.replace(/^PS\s+\S[^>]*>\s*/, "");
                if (cmd === raw) cmd = raw.replace(/^.*?[$%#]\s+/, "");
                if (cmd === raw) cmd = "";
              }
            }
            if (cmd) lastEnteredCmdRef.current = cmd;
            else if (inputLineRef.current) lastEnteredCmdRef.current = inputLineRef.current;
          } else if (inputLineRef.current) {
            lastEnteredCmdRef.current = inputLineRef.current;
          }
          inputLineRef.current = "";
        } else if (data === "\x7f") {
          inputLineRef.current = inputLineRef.current.slice(0, -1);
        } else if (data === "\x03" || data === "\x04") {
          inputLineRef.current = "";
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          inputLineRef.current += data;
        }
      }

      // Autocomplete-specific handling
      if (!isExecutingRef.current && useAutocompleteStore.getState().enabled) {
        if (data === "\r" || data === "\n") {
          const acStore = useAutocompleteStore.getState();
          if (acStore.isOpen && acStore.items.length > 0 && acStore.activePtyId === ptyId && acNavigatedRef.current) {
            const item = acStore.items[acStore.selectedIndex];
            acNavigatedRef.current = false;
            inputLineRef.current = lastEnteredCmdRef.current;
            acceptCompletion(item.insertText, item.kind);
            lastEnteredCmdRef.current = inputLineRef.current;
            inputLineRef.current = "";
          } else {
            acStore.dismiss();
            acNavigatedRef.current = false;
          }
        } else if (data === "\x7f") {
          triggerAutocomplete();
        } else if (data === "\x03" || data === "\x04") {
          useAutocompleteStore.getState().dismiss();
        } else if (data === "\t") {
          const acStore = useAutocompleteStore.getState();
          if (acStore.isOpen && acStore.items.length > 0 && acStore.activePtyId === ptyId) {
            const item = acStore.items[acStore.selectedIndex];
            acceptCompletion(item.insertText, item.kind);
            return;
          }
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          triggerAutocomplete();
        } else if (data === "\x1b[A" || data === "\x1b[B" || data === "\x1bOA" || data === "\x1bOB") {
          const acStore = useAutocompleteStore.getState();
          if (acStore.isOpen && acStore.activePtyId === ptyId) {
            if (data === "\x1b[A" || data === "\x1bOA") acStore.moveUp();
            else acStore.moveDown();
            acNavigatedRef.current = true;
            return;
          }
        } else if (data === "\x1b") {
          const acStore = useAutocompleteStore.getState();
          if (acStore.isOpen && acStore.activePtyId === ptyId) {
            acStore.dismiss();
            return;
          }
        }
      }

      // Filter out focus events
      if (data === "\x1b[I" || data === "\x1b[O") {
        return;
      }

      const encoder = new TextEncoder();
      const bytes = Array.from(encoder.encode(data));
      const { enabled, selectedPtyIds } = useBroadcastStore.getState();
      if (enabled && selectedPtyIds.length > 0) {
        for (const targetPtyId of selectedPtyIds) {
          invoke("write_to_pty", { paneId: targetPtyId, data: bytes }).catch(console.error);
          if (targetPtyId !== ptyId) {
            window.dispatchEvent(new CustomEvent("racemo-broadcast-data", { detail: { ptyId: targetPtyId, data } }));
          }
        }
      } else {
        invoke("write_to_pty", { paneId: ptyId, data: bytes }).catch(console.error);
      }
      ime.checkSmartToggle();
    });

    let smartImeDebounce: ReturnType<typeof setTimeout> | null = null;
    const cursorMoveDisposable = term.onCursorMove(() => {
      const settings = useSettingsStore.getState();
      if (settings.smartImeEnabled) {
        if (ime.imeActive) return;
        if (smartImeDebounce) clearTimeout(smartImeDebounce);
        smartImeDebounce = setTimeout(() => {
          const type = ime.getCursorSyntaxType();
          const shouldIntercept = type === "command" ? false : settings.imeInterceptEnabled;
          if (ime.interceptEnabled !== shouldIntercept) {
            ime.setInterceptEnabled(shouldIntercept);
          }
        }, 80);
      }
    });

    // Flush any PTY output that arrived before this terminal was ready.
    flushPtyOutputBuffer(ptyId);

    // Fit terminal and sync PTY dimensions
    let lastRows = isNewTerminal ? 0 : term.rows;
    let lastCols = isNewTerminal ? 0 : term.cols;
    const syncSize = () => {
      fitAddon.fit();
      if (term.rows === lastRows && term.cols === lastCols) return;
      const isInitial = lastRows === 0 && lastCols === 0;
      lastRows = term.rows;
      lastCols = term.cols;
      suppressActivity(ptyId);
      invoke("resize_pty", { paneId: ptyId, rows: term.rows, cols: term.cols })
        .then(() => {
          if (isInitial && !lastCommand) {
            setTimeout(() => term.clear(), 80);
          }
        })
        .catch(console.error);
    };

    let fitAttempts = 0;
    const tryFit = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        syncSize();
      } else if (fitAttempts < 30) {
        fitAttempts++;
        requestAnimationFrame(tryFit);
      }
    };
    tryFit();

    // Keep PTY dimensions in sync when container resizes.
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          syncSize();
        }
      }, 16);
    });
    resizeObserver.observe(container);

    // Recover rendering when the app regains visibility
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      requestAnimationFrame(() => {
        if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
        const canvases = container.querySelectorAll("canvas");
        canvases.forEach((canvas) => {
          (canvas as HTMLElement).style.transform = "translateZ(0)";
        });
        requestAnimationFrame(() => {
          canvases.forEach((canvas) => {
            (canvas as HTMLElement).style.transform = "";
          });
        });
        term.refresh(0, term.rows - 1);
      });
    };
    document.addEventListener("visibilitychange", handleVisibility);

    let disposed = false;

    const unlistenExitPromise = listen<PtyExitPayload>("pty-exit", (event) => {
      if (disposed || event.payload.pane_id !== ptyId) return;
      clearPtyOutputBuffer(ptyId);
      disposeTerminal(ptyId);
      removeSilenceDetector(ptyId);
      const { sessions, activeSessionId } = useSessionStore.getState();
      const sessionId = activeSessionId ?? "";
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      if (!findPtyId(session.rootPane, paneId)) return;
      invoke<Session>("close_pane", { sessionId, paneId })
        .then((session) => {
          if (disposed) return;
          const { setSession, setFocusedPane } = useSessionStore.getState();
          setSession(session);
          setFocusedPane(firstLeafId(session.rootPane));
        })
        .catch(() => {
          if (disposed) return;
          const { sessions: current, removeSession, setFocusedPane: setFocus } = useSessionStore.getState();
          if (!current.some((s) => s.id === sessionId)) return;
          removeSession(sessionId);
          invoke<Session | null>("close_session", { sessionId })
            .then((nextSession) => {
              if (disposed) return;
              if (nextSession) {
                setFocus(firstLeafId(nextSession.rootPane));
              }
            })
            .catch(console.error);
        });
    });

    return () => {
      disposed = true;
      if (resizeTimeout) clearTimeout(resizeTimeout);
      if (smartImeDebounce) clearTimeout(smartImeDebounce);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      titleDisposable.dispose();
      osc7Disposable.dispose();
      osc133Disposable.dispose();
      removeCommandState(ptyId);
      onDataDisposable.dispose();
      cursorMoveDisposable.dispose();
      unlistenExitPromise.then((unlisten) => unlisten());
      if (container.parentElement) {
        container.parentElement.removeChild(container);
      }
    };
  }, [ptyId, paneId, paneShellType, lastCommand, wrapperRef, cwdRef, initialCwdRef, setTitle, setSession, setFocusedPane, getSessionId, triggerAutocomplete, acceptCompletion, inputLineRef, acTimerRef, isExecutingRef, isComposingRef, acNavigatedRef]);

  return { getSessionId };
}

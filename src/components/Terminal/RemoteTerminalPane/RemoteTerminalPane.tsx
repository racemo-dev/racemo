import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useSessionStore } from "../../../stores/sessionStore";
import { useRemoteStore } from "../../../stores/remoteStore";
import { useAutocompleteStore } from "../../../stores/autocompleteStore";
import { isTauri } from "../../../lib/bridge";
import { getBrowserRemoteClient } from "../../../lib/webrtcClient";
import { getOrCreateRemoteTerminal } from "../../../lib/remoteTerminalRegistry";
import { flushRemotePtyOutputBuffer } from "../../../lib/remotePtyOutputBuffer";
import AutocompletePopup from "../AutocompletePopup";
import { logger } from "../../../lib/logger";
import { getExplorerDrag, onExplorerDragChange } from "../../Sidebar/SidebarPanel/constants";
import { useRemoteAutocomplete } from "./useRemoteAutocomplete";
import RemoteTerminalTitleBar from "./RemoteTerminalTitleBar";
import RemoteTerminalContextMenu from "./RemoteTerminalContextMenu";
import type { RemoteTerminalPaneProps } from "./types";

import "@xterm/xterm/css/xterm.css";

export default function RemoteTerminalPane({ paneId, remotePaneId, shell }: RemoteTerminalPaneProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const setFocusedPane = useSessionStore((s) => s.setFocusedPane);
  const isFocused = useSessionStore((s) => s.focusedPaneId === paneId);
  const acIsOpenForPane = useAutocompleteStore((s) => s.isOpen && s.activePtyId === remotePaneId);

  const [title, setTitle] = useState("");
  const cwdRef = useRef("");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const {
    inputLineRef,
    isExecutingRef,
    acceptCompletion,
    triggerAutocomplete,
    useAutocompleteKeydownInterceptor,
  } = useRemoteAutocomplete(remotePaneId, termRef, containerRef, cwdRef);

  // Close context menu on any click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, { capture: true });
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, { capture: true });
    };
  }, [ctxMenu]);

  const handleDisconnect = () => {
    // Find which device this pane belongs to and disconnect only that device
    const { paneToDevice } = useRemoteStore.getState();
    const deviceId = paneToDevice[remotePaneId];
    useRemoteStore.getState().disconnect(deviceId);
  };

  /** Resolve the remote session that owns this pane via paneToDevice + connections lookup. */
  const findSessionForPane = () => {
    const { paneToDevice, connections } = useRemoteStore.getState();
    const deviceId = paneToDevice[remotePaneId];
    if (!deviceId) return null;
    const conn = connections[deviceId];
    if (!conn) return null;
    return conn.sessions.find((s) => s.pane_ids.includes(remotePaneId)) ?? null;
  };

  const handleSplit = (direction: "Horizontal" | "Vertical", before: boolean) => {
    const session = findSessionForPane();
    if (!session) return;
    if (!isTauri()) {
      getBrowserRemoteClient().sendSplitPane(session.id, paneId, direction, before);
      return;
    }
    invoke("split_remote_pane", {
      sessionId: session.id,
      paneId: paneId,
      direction,
      before,
    }).catch((err) => logger.error("[remote] split_remote_pane failed:", err));
  };

  const handleClose = () => {
    const session = findSessionForPane();
    if (!session) return;
    if (session.pane_count <= 1) {
      handleDisconnect();
      return;
    }
    if (!isTauri()) {
      getBrowserRemoteClient().sendClosePane(session.id, paneId);
      return;
    }
    invoke("close_remote_pane", {
      sessionId: session.id,
      paneId: paneId,
    }).catch((err) => logger.error("[remote] close_remote_pane failed:", err));
  };

  useEffect(() => {
    if (!wrapperRef.current) return;

    const { terminal: term, fitAddon, container, isNew } = getOrCreateRemoteTerminal(remotePaneId);

    wrapperRef.current.appendChild(container);

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    containerRef.current = container;

    if (!isNew) {
      flushRemotePtyOutputBuffer(remotePaneId);
    }

    // OSC 133 handler for command tracking (prompt/command lifecycle)
    const osc133Disposable = term.parser.registerOscHandler(133, (data) => {
      const marker = data.trim();
      if (marker.startsWith("A")) {
        inputLineRef.current = "";
        isExecutingRef.current = false;
        useAutocompleteStore.getState().dismiss();
      } else if (marker.startsWith("C")) {
        isExecutingRef.current = true;
        useAutocompleteStore.getState().dismiss();
      } else if (marker.startsWith("D")) {
        isExecutingRef.current = false;
      }
      return false;
    });

    // OSC 7 (cwd tracking)
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
        // fallback
      }
      path = path.replace(/\\/g, "/");
      cwdRef.current = path;
      setTitle(path);
      useSessionStore.getState().setPaneCwd(remotePaneId, path);
      return false;
    });

    const titleDisposable = term.onTitleChange((t) => {
      if (cwdRef.current) {
        setTitle(cwdRef.current);
      } else {
        setTitle(t);
      }
    });

    // IME (Korean/CJK) composition handling
    let imeComposing = false;
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
    const imeCleanups: Array<() => void> = [];

    if (textarea) {
      const onCompStart = () => { imeComposing = true; };
      const onCompEnd = () => { imeComposing = false; };
      textarea.addEventListener("compositionstart", onCompStart);
      textarea.addEventListener("compositionend", onCompEnd);
      imeCleanups.push(
        () => textarea.removeEventListener("compositionstart", onCompStart),
        () => textarea.removeEventListener("compositionend", onCompEnd),
      );
    }

    // Send keyboard input to remote host (with autocomplete tracking)
    const onDataDisposable = term.onData((data) => {
      if (imeComposing) return;
      if (data === "\x1b[I" || data === "\x1b[O") return;

      if (!isExecutingRef.current && useAutocompleteStore.getState().enabled) {
        if (data === "\r" || data === "\n") {
          inputLineRef.current = "";
          useAutocompleteStore.getState().dismiss();
        } else if (data === "\x7f") {
          inputLineRef.current = inputLineRef.current.slice(0, -1);
          triggerAutocomplete();
        } else if (data === "\x03" || data === "\x04") {
          inputLineRef.current = "";
          useAutocompleteStore.getState().dismiss();
        } else if (data === "\t") {
          const acStore = useAutocompleteStore.getState();
          if (acStore.isOpen && acStore.items.length > 0 && acStore.activePtyId === remotePaneId) {
            const item = acStore.items[acStore.selectedIndex];
            acceptCompletion(item.insertText, item.kind);
            return;
          }
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          inputLineRef.current += data;
          triggerAutocomplete();
        } else if (data === "\x1b[A" || data === "\x1b[B" || data === "\x1bOA" || data === "\x1bOB") {
          const acStore = useAutocompleteStore.getState();
          if (acStore.isOpen && acStore.activePtyId === remotePaneId) {
            if (data === "\x1b[A" || data === "\x1bOA") acStore.moveUp();
            else acStore.moveDown();
            return;
          }
        } else if (data === "\x1b") {
          const acStore = useAutocompleteStore.getState();
          if (acStore.isOpen && acStore.activePtyId === remotePaneId) {
            acStore.dismiss();
            return;
          }
        }
      }

      const encoder = new TextEncoder();
      const encoded = encoder.encode(data);
      if (!isTauri()) {
        getBrowserRemoteClient().sendInput(remotePaneId, encoded);
      } else {
        const bytes = Array.from(encoded);
        invoke("write_to_remote_pty", { paneId: remotePaneId, data: bytes }).catch(
          (err) => logger.error("[remote] Failed to send input:", err)
        );
      }
    });

    // Fit & sync remote PTY dimensions — 호스트에서 min(호스트, 원격)으로 PTY 적용
    const syncSize = () => {
      fitAddon.fit();
      if (!isTauri()) {
        getBrowserRemoteClient().sendResize(remotePaneId, term.cols, term.rows);
      } else {
        invoke("resize_remote_pty", {
          paneId: remotePaneId,
          rows: term.rows,
          cols: term.cols,
        }).catch((err) => logger.error("[remote] Failed to send resize:", err));
      }
    };

    let fitAttempts = 0;
    const tryFit = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        syncSize();
        term.refresh(0, term.rows - 1);
      } else if (fitAttempts < 30) {
        fitAttempts++;
        requestAnimationFrame(tryFit);
      }
    };
    tryFit();

    if (isNew) {
      flushRemotePtyOutputBuffer(remotePaneId);
    }

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

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      titleDisposable.dispose();
      osc7Disposable.dispose();
      osc133Disposable.dispose();
      onDataDisposable.dispose();
      imeCleanups.forEach((fn) => fn());
      termRef.current = null;
      fitAddonRef.current = null;
      containerRef.current = null;
      if (container.parentElement) {
        container.parentElement.removeChild(container);
      }
    };
  }, [remotePaneId, triggerAutocomplete, acceptCompletion, inputLineRef, isExecutingRef]);

  // Sync focus
  useEffect(() => {
    if (!termRef.current) return;
    if (isFocused) termRef.current.focus();
    else termRef.current.blur();
  }, [isFocused]);

  // Autocomplete keydown interceptor
  useAutocompleteKeydownInterceptor(isFocused, acIsOpenForPane);

  // Internal drag-and-drop from explorer (pointer-based)
  const [internalDragOver, setInternalDragOver] = useState(false);
  useEffect(() => {
    return onExplorerDragChange(() => {
      const el = wrapperRef.current;
      const drag = getExplorerDrag();
      if (!drag || !el) { setInternalDragOver(false); return; }
      const rect = el.getBoundingClientRect();
      const over = drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom;
      setInternalDragOver(over);
    });
  }, []);

  return (
    <div
      className="w-full h-full relative flex flex-col"
      onClick={() => setFocusedPane(paneId)}
    >
      <RemoteTerminalTitleBar
        paneId={paneId}
        remotePaneId={remotePaneId}
        shell={shell}
        title={title}
        isFocused={isFocused}
        onFocus={() => setFocusedPane(paneId)}
        onSplit={handleSplit}
        onClose={handleClose}
      />

      {/* Terminal */}
      <div
        ref={wrapperRef}
        data-pty-id={remotePaneId}
        data-remote="1"
        className="flex-1 min-h-0 overflow-hidden relative"
        style={{ padding: 4 }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {internalDragOver && (
          <div
            className="absolute inset-0 z-30 pointer-events-none"
            style={{
              background: "color-mix(in srgb, var(--accent-blue) 8%, transparent)",
              borderRadius: 4,
            }}
          >
            <style>{`@keyframes pty-drop-march { to { stroke-dashoffset: -20; } }`}</style>
            <div
              style={{
                position: "absolute", inset: 0,
                border: "1px dashed var(--text-tertiary)",
                borderRadius: 4,
                animation: "pty-drop-march 2s linear infinite",
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)", fontWeight: 400 }}>
                Drop files here
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <RemoteTerminalContextMenu
          position={ctxMenu}
          onSplit={handleSplit}
          onClose={handleClose}
          onDisconnect={handleDisconnect}
          onDismiss={() => setCtxMenu(null)}
        />
      )}

      {/* Autocomplete popup */}
      <AutocompletePopup ptyId={remotePaneId} />

      {/* Unfocused overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-20 transition-opacity duration-200"
        style={{
          top: 'calc(24px * var(--ui-scale))',
          background: "var(--bg-overlay)",
          opacity: isFocused ? 0 : 0.4,
        }}
      />
    </div>
  );
}

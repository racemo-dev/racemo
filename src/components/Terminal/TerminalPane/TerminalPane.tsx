import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../../lib/bridge";

import { useSessionStore } from "../../../stores/sessionStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useBroadcastStore } from "../../../stores/broadcastStore";
import { getTerminal, disposeTerminal } from "../../../lib/terminalRegistry";
import { clearPtyOutputBuffer } from "../../../lib/ptyOutputBuffer";
import { useCommandErrorStore } from "../../../stores/commandErrorStore";
import ErrorAiPopup from "../ErrorAiPopup";
import { firstLeafId } from "../../../lib/paneTreeUtils";
import { useAutocompleteStore } from "../../../stores/autocompleteStore";
import { useToastStore } from "../../../stores/toastStore";
import { getExplorerDrag, onExplorerDragChange } from "../../Sidebar/SidebarPanel/constants";
import { getModLabel } from "../../../lib/osUtils";
import SearchBar, { type SearchBarHandle } from "../../SearchBar";
import AutocompletePopup from "../AutocompletePopup";
import { Sparkle } from "@phosphor-icons/react";
import type { Session } from "../../../types/session";

import { SHELL_LABELS } from "./types";
import type { TerminalPaneProps } from "./types";
import { useAutocomplete } from "./useAutocomplete";
import { useTerminalSetup } from "./useTerminalSetup";
import { useAutocompleteKeyHandler, useSearchShortcut, useDragDrop, useContextMenuClose } from "./useTerminalEvents";

import "@xterm/xterm/css/xterm.css";

export default function TerminalPane({ paneId, ptyId, initialCwd, lastCommand }: TerminalPaneProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const setFocusedPane = useSessionStore((s) => s.setFocusedPane);
  const setSession = useSessionStore((s) => s.setSession);
  // isFocused as ref — avoids re-render on focus change, CSS handles visual updates
  const isFocusedRef = useRef(useSessionStore.getState().focusedPaneId === paneId);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    return useSessionStore.subscribe((s) => {
      const focused = s.focusedPaneId === paneId;
      if (focused === isFocusedRef.current) return;
      isFocusedRef.current = focused;
      containerRef.current?.classList.toggle("pane-focused", focused);
      containerRef.current?.classList.toggle("pane-blurred", !focused);
      const entry = getTerminal(ptyId);
      if (entry) {
        if (focused) entry.terminal.focus();
        else entry.terminal.blur();
      }
    });
  }, [paneId, ptyId]);

  // 마운트 시점의 shell 타입을 고정
  const shellFallback = useRef(useSettingsStore.getState().defaultShell);
  const paneShellType = useSessionStore((s) => s.paneShellTypes[ptyId]) ?? shellFallback.current;
  const [title, setTitle] = useState(initialCwd || "");
  const cwdRef = useRef(initialCwd || "");
  const initialCwdRef = useRef(initialCwd || "");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; openUp: boolean } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBarRef = useRef<SearchBarHandle>(null);
  const broadcastEnabled = useBroadcastStore((s) => s.enabled);
  const broadcastSelected = useBroadcastStore((s) => s.selectedPtyIds.includes(ptyId));
  const togglePaneBroadcast = useBroadcastStore((s) => s.selectPane);
  const acIsOpenForPane = useAutocompleteStore((s) => s.isOpen && s.activePtyId === ptyId);
  const commandError = useCommandErrorStore((s) => s.errors[ptyId]);
  const [showErrorPopup, setShowErrorPopup] = useState(false);
  const pasteProgress = useToastStore((s) => s.progress?.ptyId === ptyId ? s.progress : null);

  // Context menu close handler
  useContextMenuClose(ctxMenu, setCtxMenu);

  // paneShellType 변경 시 IME 인터셉터에 전달
  useEffect(() => {
    const entry = getTerminal(ptyId);
    if (entry) entry.ime.setShellType(paneShellType);
  }, [ptyId, paneShellType]);

  // Ensure title is set from initialCwd on mount and when it changes
  useEffect(() => {
    if (initialCwd) {
      cwdRef.current = initialCwd;
      initialCwdRef.current = initialCwd;
      setTitle(initialCwd);
      useSessionStore.getState().setPaneCwd(ptyId, initialCwd);
    }
  }, [initialCwd, ptyId]);

  const getSessionId = useCallback(() => {
    return useSessionStore.getState().activeSessionId ?? "";
  }, []);

  const handleSplit = useCallback(
    (direction: "horizontal" | "vertical", before: boolean) => {
      const entry = getTerminal(ptyId);
      const currentRows = entry?.terminal.rows ?? 24;
      const currentCols = entry?.terminal.cols ?? 80;
      const rows = direction === "vertical" ? Math.max(1, Math.floor(currentRows / 2)) : currentRows;
      const cols = direction === "horizontal" ? Math.max(1, Math.floor(currentCols / 2)) : currentCols;
      const shell = useSettingsStore.getState().defaultShell;
      invoke<Session>("split_pane", {
        sessionId: getSessionId(),
        paneId,
        direction,
        shell,
        rows,
        cols,
        before,
      })
        .then((session) => {
          setSession(session);
        })
        .catch(console.error);
    },
    [paneId, ptyId, setSession, getSessionId],
  );

  const handleClose = useCallback(() => {
    invoke<Session>("close_pane", { sessionId: getSessionId(), paneId })
      .then((session) => {
        clearPtyOutputBuffer(ptyId);
        disposeTerminal(ptyId);
        setSession(session);
        setFocusedPane(firstLeafId(session.rootPane));
      })
      .catch(console.error);
  }, [paneId, ptyId, setSession, setFocusedPane, getSessionId]);

  // Autocomplete
  const {
    inputLineRef,
    acTimerRef,
    isExecutingRef,
    isComposingRef,
    acNavigatedRef,
    acceptCompletion,
    triggerAutocomplete,
  } = useAutocomplete(ptyId, cwdRef);

  // Terminal setup
  useTerminalSetup({
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
  });

  // Autocomplete key handler
  useAutocompleteKeyHandler(acIsOpenForPane, ptyId, isFocusedRef, acNavigatedRef, acceptCompletion);

  // Search shortcut
  useSearchShortcut(ptyId, isFocusedRef, containerRef, setSearchOpen, searchBarRef);

  // Drag and drop (native file drop from OS)
  const isDragOver = useDragDrop(ptyId, isFocusedRef);

  // Internal drag-and-drop from explorer (pointer-based, detect hover via drag state)
  const [internalDragOver, setInternalDragOver] = useState(false);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    return onExplorerDragChange(() => {
      const drag = getExplorerDrag();
      if (!drag) { setInternalDragOver(false); return; }
      const rect = el.getBoundingClientRect();
      const over = drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom;
      setInternalDragOver(over);
    });
  }, [wrapperRef]);

  if (!isTauri()) {
    return (
      <div className="w-full h-full relative flex flex-col">
        <div
          className="flex items-center px-2 shrink-0 select-none"
          style={{
            height: 'calc(24px * var(--ui-scale))',
            fontSize: 'var(--fs-10)',
            letterSpacing: "0.05em",
            background: "var(--bg-elevated)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <span className="inline-block rounded-full mr-2 shrink-0" style={{ width: 'calc(6px * var(--ui-scale))', height: 'calc(6px * var(--ui-scale))', background: "var(--status-inactive)" }} />
          <span className="truncate flex-1" style={{ color: "var(--text-muted)" }}>{title || "~"}</span>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
          <span style={{ fontSize: 'var(--fs-12)' }}>Browser Mode — Terminal unavailable</span>
        </div>
      </div>
    );
  }

  const initialFocused = isFocusedRef.current;
  return (
    <div
      ref={containerRef}
      data-terminal-pane
      className={`w-full h-full relative flex flex-col ${initialFocused ? "pane-focused" : "pane-blurred"}`}
      style={{
        outline: broadcastEnabled && broadcastSelected ? "1px solid color-mix(in srgb, var(--accent-cyan, #22d3ee) 40%, transparent)" : "none",
        outlineOffset: "-1px",
      }}
      onClick={() => setFocusedPane(paneId)}
    >
      {/* Title bar */}
      <div
        className="flex items-center px-2 shrink-0 select-none transition-opacity duration-200"
        style={{
          height: 'calc(24px * var(--ui-scale))',
          fontSize: 'var(--fs-10)',
          letterSpacing: "0.05em",
          background: "var(--bg-overlay)",
          borderBottom: "1px solid var(--border-subtle)",
          opacity: "var(--pane-header-opacity)",
        }}
      >
        {/* Broadcast checkbox */}
        {broadcastEnabled && (
          <input
            type="checkbox"
            checked={broadcastSelected}
            onChange={(e) => { e.stopPropagation(); togglePaneBroadcast(ptyId); }}
            className="shrink-0 cursor-pointer"
            style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))', accentColor: "var(--accent-cyan, #22d3ee)", marginRight: 'calc(4px * var(--ui-scale))' }}
            title="Include in broadcast"
          />
        )}

        {/* Status dot */}
        {!broadcastEnabled && (
          <span
            className="inline-block rounded-full mr-2 shrink-0"
            style={{
              width: 'calc(6px * var(--ui-scale))',
              height: 'calc(6px * var(--ui-scale))',
              background: "var(--pane-status-dot)",
            }}
          />
        )}

        {/* Title */}
        <span
          className="truncate flex-1"
          style={{ color: "var(--pane-title-color)" }}
        >
          {title || "~"}
        </span>

        {/* AI Error icon */}
        {commandError && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowErrorPopup(true); }}
            className="shrink-0 flex items-center gap-1 px-1 py-0.5 rounded transition-colors cursor-pointer"
            style={{
              color: "var(--accent-yellow)",
              background: "transparent",
              border: "none",
              fontSize: 'var(--fs-9)',
              fontWeight: 600,
            }}
            title={`Command failed (exit ${commandError.exitCode}) — click for AI help`}
          >
            <Sparkle
              size={12}
              weight="bold"
              style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))' }}
            />
            <span>AI</span>
          </button>
        )}

        {/* Shell type label */}
        <div className="relative shrink-0 mr-2">
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded"
            style={{
              fontSize: 'var(--fs-9)',
              color: "var(--text-muted)",
            }}
          >
            {SHELL_LABELS[paneShellType] || paneShellType}
          </span>
        </div>

        {/* Split & close buttons */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); handleSplit("horizontal", true); }}
            className="p-0.5 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            title={`Split left (${getModLabel()}+A)`}
          >
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
              <polyline points="6,2 2,5 6,8" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleSplit("vertical", true); }}
            className="p-0.5 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            title={`Split up (${getModLabel()}+W)`}
          >
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
              <polyline points="2,6 5,2 8,6" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleSplit("vertical", false); }}
            className="p-0.5 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            title={`Split down (${getModLabel()}+S)`}
          >
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
              <polyline points="2,4 5,8 8,4" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleSplit("horizontal", false); }}
            className="p-0.5 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            title={`Split right (${getModLabel()}+D)`}
          >
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
              <polyline points="4,2 8,5 4,8" />
            </svg>
          </button>

          {/* Close */}
          <button
            onClick={(e) => { e.stopPropagation(); handleClose(); }}
            className="p-0.5 rounded ml-1 transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent-red)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            title="Close pane"
          >
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
              <line x1="2" y1="2" x2="8" y2="8" />
              <line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Paste progress indicator */}
      {pasteProgress && (
        <div style={{ height: 1, background: "var(--bg-overlay)", overflow: "hidden", flexShrink: 0 }}>
          <div style={{
            height: "100%",
            background: pasteProgress.state === "loading"
              ? "var(--accent-cyan, #22d3ee)"
              : pasteProgress.state === "success"
              ? "var(--status-active, #4ade80)"
              : "var(--accent-red, #f87171)",
            width: pasteProgress.state === "loading" ? "50%" : "100%",
            transition: pasteProgress.state !== "loading" ? "width 0.15s ease" : "none",
            animation: pasteProgress.state === "loading" ? "pasteProgressSlide 1s ease-in-out infinite" : "none",
          }} />
          <style>{`@keyframes pasteProgressSlide { 0%{transform:translateX(-100%)} 100%{transform:translateX(300%)} }`}</style>
        </div>
      )}

      {/* Terminal */}
      <div
        ref={wrapperRef}
        data-pty-id={ptyId}
        className="flex-1 min-h-0 overflow-hidden relative transition-opacity duration-200"
        style={{ padding: 4, opacity: "var(--pane-terminal-opacity)" }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, openUp: e.clientY + 200 > window.innerHeight });
        }}
      >
        <AutocompletePopup ptyId={ptyId} />
        {showErrorPopup && commandError && (
          <ErrorAiPopup
            ptyId={ptyId}
            error={commandError}
            cwd={cwdRef.current}
            onClose={() => setShowErrorPopup(false)}
          />
        )}
        {((isDragOver && isFocusedRef.current) || internalDragOver) && (
          <div
            className="absolute inset-0 z-30 pointer-events-none"
            style={{
              background: "color-mix(in srgb, var(--bg-base) 60%, transparent)",
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

      {/* Dimming overlay for inactive terminal */}
      <div
        className="absolute inset-0 pointer-events-none z-20 transition-opacity duration-200"
        style={{
          top: 'calc(24px * var(--ui-scale))',
          background: "var(--bg-overlay)",
          opacity: "var(--pane-dim-opacity)",
        }}
      />

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[9999] py-1 rounded shadow-lg flex flex-col"
          style={{
            left: ctxMenu.x,
            ...(ctxMenu.openUp
              ? { bottom: window.innerHeight - ctxMenu.y }
              : { top: ctxMenu.y }),
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            minWidth: 240,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {([
            { label: "Split Right", action: () => handleSplit("horizontal", false), shortcut: `${getModLabel()}+D` },
            { label: "Split Down", action: () => handleSplit("vertical", false), shortcut: `${getModLabel()}+S` },
            { label: "Split Left", action: () => handleSplit("horizontal", true), shortcut: `${getModLabel()}+A` },
            { label: "Split Up", action: () => handleSplit("vertical", true), shortcut: `${getModLabel()}+W` },
          ]).map((item) => (
            <button
              key={item.label}
              className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
              onClick={() => { item.action(); setCtxMenu(null); }}
            >
              <span>{item.label}</span>
              <span className="sb-ctx-shortcut">{item.shortcut}</span>
            </button>
          ))}
          <div style={{ height: 1, background: "var(--border-subtle)", margin: "4px 0" }} />
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            style={{ color: "var(--accent-red)" }}
            onClick={() => { handleClose(); setCtxMenu(null); }}
          >
            Close Pane
          </button>
        </div>
      )}

      {/* Search bar */}
      {searchOpen && (
        <SearchBar
          ref={searchBarRef}
          onSearch={(q) => {
            const entry = getTerminal(ptyId);
            if (entry && q) entry.searchAddon.findNext(q);
            else entry?.searchAddon.clearDecorations();
          }}
          onNext={(q) => { getTerminal(ptyId)?.searchAddon.findNext(q); }}
          onPrev={(q) => { getTerminal(ptyId)?.searchAddon.findPrevious(q); }}
          onClose={() => {
            const entry = getTerminal(ptyId);
            entry?.searchAddon.clearDecorations();
            setSearchOpen(false);
            entry?.terminal.focus();
          }}
        />
      )}

      <div className="pane-inactive-overlay absolute inset-0 bg-black/5 pointer-events-none" style={{ top: 'calc(24px * var(--ui-scale))' }} />
    </div>
  );
}

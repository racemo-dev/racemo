import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "../stores/settingsStore";
import { usePanelEditorStore, type PanelTab } from "../stores/panelEditorStore";
import { useGitStore } from "../stores/gitStore";
import { setupPtyOutputListener, setupPtyResizedListener } from "../lib/ptyOutputBuffer";
import { setupRemotePtyOutputListener, setupRemotePtyResizedListener } from "../lib/remotePtyOutputBuffer";
import { openEditorPanel } from "../lib/editorWindow";
import { getDefaultTerminalSize } from "../lib/terminalUtils";
import { isTauri } from "../lib/bridge";
import { dirCacheInvalidateAll, EXPLORER_REFRESH_EVENT } from "../components/Sidebar/SidebarPanel/constants";
import { logger } from "../lib/logger";

/**
 * Global event listeners: context menu, PTY output, focus, editor persistence, resize.
 */
export function useGlobalListeners() {
  // 시스템 컨텍스트 메뉴 차단 (터미널/input 제외)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".xterm")) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  // 한/영 키 차단 설정 복원
  useEffect(() => {
    const { blockHangulKey } = useSettingsStore.getState();
    if (blockHangulKey) {
      invoke("set_block_hangul_key", { enabled: true }).catch(logger.error);
    }
  }, []);

  // Global PTY output listener
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    setupPtyOutputListener().then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Global PTY resized listener — sync local xterm when PTY is resized by remote client
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    setupPtyResizedListener().then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Global remote PTY output listener
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    setupRemotePtyOutputListener().then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Global remote PTY resized listener — sync remote xterm.js to host PTY size
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    setupRemotePtyResizedListener().then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Diff 외부창에서 discard/hunk 작업 시 git 상태 갱신
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ cwd: string }>("git:refresh", (e) => {
      useGitStore.getState().refresh(e.payload.cwd);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // 에디터 외부창 → 패널로 이동
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ path: string }>("editor:embed-to-panel", (e) => {
      openEditorPanel(e.payload.path);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // 원격 클라이언트가 파일을 열었을 때 호스트에서도 에디터 열기
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ path: string }>("remote:editor-open", (e) => {
      openEditorPanel(e.payload.path);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // 원격 클라이언트가 에디터 탭을 닫았을 때 호스트에서도 닫기
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ path: string }>("remote:editor-close", (e) => {
      const store = usePanelEditorStore.getState();
      const idx = store.tabs.findIndex((t: PanelTab) => t.path === e.payload.path);
      if (idx >= 0) {
        store.closeTab(idx);
        if (store.tabs.length <= 1) store.setPanelOpen(false);
      }
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // 에디터 패널 상태 변경 시 저장 (디바운스)
  useEffect(() => {
    if (!isTauri()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = usePanelEditorStore.subscribe((state) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const tabs = state.tabs
          .filter((t) => { const tp = (t as { type?: string }).type; return tp !== "diff"; })
          .map((t) => {
            if ((t as { type?: string }).type === "browser") {
              const bt = t as import("../stores/panelEditorStore").BrowserPanelTab;
              return { type: "browser" as const, url: bt.url, name: bt.name };
            }
            return { type: "editor" as const, path: t.path };
          });
        invoke("save_editor_state", {
          panelOpen: state.panelOpen,
          activeIndex: state.activeIndex,
          tabs,
        }).catch(() => {/* ignore */});
      }, 500);
    });
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, []);

  // 원격 클라이언트가 파일을 저장했을 때 호스트 에디터 갱신
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ path: string }>("remote-file-changed", (event) => {
      usePanelEditorStore.getState().reloadTabByPath(event.payload.path);
      dirCacheInvalidateAll();
      window.dispatchEvent(new Event(EXPLORER_REFRESH_EVENT));
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // 앱 포커스 복귀 시 패널 에디터 + 탐색기 자동 갱신
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        usePanelEditorStore.getState().reloadAllNonDirtyTabs();
        dirCacheInvalidateAll();
        window.dispatchEvent(new Event(EXPLORER_REFRESH_EVENT));
      }
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Debug: Log terminal size on resize
  useEffect(() => {
    const handleResize = () => {
      const { rows, cols } = getDefaultTerminalSize();
      logger.debug(`[terminalSize] Window resize detected. Appears as: ${rows}x${cols}`);
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);
}

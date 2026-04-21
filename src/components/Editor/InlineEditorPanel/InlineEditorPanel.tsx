import { useRef, useState, useCallback, useEffect } from "react";
import { apiWriteTextFile } from "../../../lib/bridge";
import { X, ArrowLeft, ArrowRight, ArrowSquareOut, Code, Eye, Globe } from "@phosphor-icons/react";
import { usePanelEditorStore, type BrowserPanelTab } from "../../../stores/panelEditorStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { hideAllBrowserWebviews, destroyBrowserWebview, destroyAllBrowserWebviews } from "../BrowserViewer";
import { openEditorExternalWindow, notifyRemoteEditorClose } from "../../../lib/editorWindow";
import { useGitStore } from "../../../stores/gitStore";
import { useGitT } from "../../../lib/i18n/git";
import { logger } from "../../../lib/logger";
import { useToastStore } from "../../../stores/toastStore";
import { MIN_WIDTH, getDisplayNames, type CtxMenuState } from "./helpers";
import TabContextMenu from "./TabContextMenu";
import EditorContent from "./EditorContent";

export default function InlineEditorPanel({ fullWidth = false }: { fullWidth?: boolean }) {
  const tabs = usePanelEditorStore((s) => s.tabs);
  const activeIndex = usePanelEditorStore((s) => s.activeIndex);
  const setActiveIndex = usePanelEditorStore((s) => s.setActiveIndex);
  const closeTab = usePanelEditorStore((s) => s.closeTab);
  const closeOthers = usePanelEditorStore((s) => s.closeOthers);
  const closeToRight = usePanelEditorStore((s) => s.closeToRight);
  const closeAll = usePanelEditorStore((s) => s.closeAll);
  const moveTab = usePanelEditorStore((s) => s.moveTab);
  const updateContent = usePanelEditorStore((s) => s.updateContent);
  const markSaved = usePanelEditorStore((s) => s.markSaved);
  const setPanelOpen = usePanelEditorStore((s) => s.setPanelOpen);
  const statusMap = useGitStore((s) => s.statusMap);

  const t = useGitT();
  const activeTab = tabs[activeIndex] ?? null;
  const [width, setWidth] = useState(480);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 최초 마운트 시 부모 너비의 절반으로 초기화 + 리사이즈 시 비율 유지
  const ratioRef = useRef(0.5);
  useEffect(() => {
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    const parentW = parent.offsetWidth;
    if (parentW) setWidth(Math.max(MIN_WIDTH, Math.floor(parentW * ratioRef.current)));

    const ro = new ResizeObserver((entries) => {
      if (dragging.current) return;
      for (const entry of entries) {
        const newParentW = entry.contentRect.width;
        if (newParentW > 0) {
          setWidth((prev) => {
            const newW = Math.max(MIN_WIDTH, Math.floor(newParentW * ratioRef.current));
            return newW !== prev ? newW : prev;
          });
        }
      }
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const tabScrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  // Hide all browser webviews when active tab is not a browser tab
  useEffect(() => {
    if (!activeTab || activeTab.type !== "browser") hideAllBrowserWebviews();
  }, [activeTab]);

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [dragSrc, setDragSrc] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const markdownSourceMode = useSettingsStore((s) => s.markdownSourceMode);
  const isSourceMode = activeTab && activeTab.type !== "diff" && activeTab.type !== "browser" && activeTab.language === "markdown" && markdownSourceMode;
  const toggleSourceMode = useCallback(() => {
    if (!activeTab || activeTab.type === "diff" || activeTab.type === "browser" || activeTab.language !== "markdown") return;
    useSettingsStore.getState().setMarkdownSourceMode(!markdownSourceMode);
  }, [activeTab, markdownSourceMode]);

  const displayNames = getDisplayNames(tabs.map((t) => ({ name: t.name, path: t.path })));

  // ─── context menu dismiss ─────────────────────────────────────────────────
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: PointerEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
  }, [ctxMenu]);

  // ─── Ctrl+W ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "w" && tabs.length > 0) {
        e.preventDefault();
        handleCloseTab(activeIndex);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, tabs.length]);

  // ─── non-passive wheel scroll ─────────────────────────────────────────────
  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      el.scrollBy({ left: e.deltaY || e.deltaX, behavior: "auto" });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ─── tab overflow arrows ──────────────────────────────────────────────────
  const updateArrows = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 0);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    updateArrows();
    el.addEventListener("scroll", updateArrows);
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", updateArrows); ro.disconnect(); };
  }, [updateArrows]);

  useEffect(() => { updateArrows(); }, [tabs, updateArrows]);

  /* Scroll active tab into view */
  useEffect(() => {
    const el = tabScrollRef.current;
    const tab = tabRefs.current[activeIndex];
    if (!el || !tab) return;
    const tabLeft = tab.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;
    if (tabLeft < el.scrollLeft) el.scrollLeft = tabLeft;
    else if (tabRight > el.scrollLeft + el.clientWidth) el.scrollLeft = tabRight - el.clientWidth;
  }, [activeIndex]);

  const scrollTabs = (dir: "left" | "right") => {
    const el = tabScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === "left" ? -120 : 120, behavior: "smooth" });
  };

  // ─── panel resize ─────────────────────────────────────────────────────────
  const onResizeStart = (e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    const onMove = (me: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - me.clientX;
      const parentW = containerRef.current?.parentElement?.offsetWidth ?? Infinity;
      const maxW = Math.max(MIN_WIDTH, parentW - 200);
      const newW = Math.min(maxW, Math.max(MIN_WIDTH, startW.current + delta));
      ratioRef.current = parentW > 0 ? newW / parentW : 0.5;
      setWidth(newW);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ─── save ─────────────────────────────────────────────────────────────────
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSave = useCallback(async () => {
    if (!activeTab || activeTab.type === "diff" || activeTab.type === "browser") return;
    try {
      await apiWriteTextFile(activeTab.path, activeTab.content);
      markSaved(activeIndex);
    } catch (e) {
      logger.error("Failed to save file:", e);
      useToastStore.getState().show(`저장 실패: ${e}`, "error", 4000);
    }
  }, [activeTab, activeIndex, markSaved]);

  const handleChange = useCallback(
    (content: string) => {
      updateContent(activeIndex, content);
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      const savePath = activeTab?.path;
      autoSaveTimer.current = setTimeout(() => {
        if (!savePath) return;
        const state = usePanelEditorStore.getState();
        const idx = state.tabs.findIndex((t) => t.path === savePath);
        if (idx < 0) return;
        const tab = state.tabs[idx];
        if (tab && tab.type !== "diff" && tab.type !== "browser" && tab.isDirty) {
          apiWriteTextFile(tab.path, tab.content)
            .then(() => usePanelEditorStore.getState().markSaved(idx))
            .catch((e) => { logger.error(e); useToastStore.getState().show(`저장 실패: ${e}`, "error", 4000); });
        }
      }, 1000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeTab?.path read via fresh tabs ref inside callback
    [activeIndex, updateContent],
  );

  // ─── close helpers ────────────────────────────────────────────────────────
  const handleClose = () => { destroyAllBrowserWebviews(); setPanelOpen(false); };

  const handleCloseTab = (i: number) => {
    const tab = tabs[i];
    if (tab?.type === "browser") destroyBrowserWebview(tab.path);
    if (tab) notifyRemoteEditorClose(tab.path);
    closeTab(i);
    if (tabs.length <= 1) setPanelOpen(false);
  };

  const handleCloseAll = () => {
    for (const tab of tabs) {
      if (tab.type === "browser") destroyBrowserWebview(tab.path);
    }
    closeAll();
    setPanelOpen(false);
  };

  return (
    <div
      ref={containerRef}
      className={fullWidth ? "flex flex-1 min-w-0" : "flex shrink-0"}
      style={{
        ...(fullWidth ? {} : { width, minWidth: MIN_WIDTH }),
        borderLeft: fullWidth ? "none" : "1px solid var(--border-default)",
        background: "var(--bg-base)",
        position: "relative",
      }}
    >
      {/* 드래그 핸들 */}
      <div
        onMouseDown={onResizeStart}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          cursor: "col-resize",
          zIndex: 10,
        }}
      />

      <div className="flex flex-col h-full w-full min-w-0">
        {/* 탭 바 */}
        <div
          className="flex items-center shrink-0"
          style={{
            height: "calc(24px * var(--ui-scale))",
            background: "var(--bg-overlay)",
          }}
        >
          {/* scrollable tab list */}
          <div
            ref={tabScrollRef}
            className="flex items-center h-full min-w-0 overflow-hidden"
            style={{ flex: "1 1 0" }}
          >
            {tabs.map((tab, i) => {
              const isActive = i === activeIndex;
              const isDragTarget = dragOver === i && dragSrc !== i;
              return (
                <div
                  key={tab.path}
                  ref={(el) => { tabRefs.current[i] = el; }}
                  draggable
                  onDragStart={() => setDragSrc(i)}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(i); }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={() => {
                    if (dragSrc !== null && dragSrc !== i) moveTab(dragSrc, i);
                    setDragSrc(null); setDragOver(null);
                  }}
                  onDragEnd={() => { setDragSrc(null); setDragOver(null); }}
                  onClick={() => setActiveIndex(i)}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); handleCloseTab(i); } }}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, index: i }); }}
                  className="group flex items-center gap-1.5 px-3 h-full cursor-pointer shrink-0 select-none"
                  style={{
                    fontSize: "var(--fs-11)",
                    color: isActive ? "var(--text-primary)" : "var(--text-tertiary)",
                    background: isActive ? "var(--bg-base)" : "transparent",
                    borderRight: "1px solid var(--border-subtle)",
                    borderTop: "2px solid transparent",
                    borderLeft: isDragTarget ? "2px solid var(--accent-blue)" : "none",
                  }}
                >
                  {tab.type === "browser" && (
                    (tab as BrowserPanelTab).favicon
                      ? <img src={(tab as BrowserPanelTab).favicon} alt="" style={{ width: 14, height: 14, flexShrink: 0, borderRadius: 2 }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      : <Globe style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))', flexShrink: 0, color: "var(--accent-blue)" }} />
                  )}
                  {tab.type !== "diff" && tab.type !== "browser" && tab.isDirty && (
                    <span
                      className="inline-block rounded-full shrink-0"
                      style={{ width: 6, height: 6, background: "var(--accent-blue)" }}
                    />
                  )}
                  <span className="truncate max-w-[120px]">{displayNames[i]}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleCloseTab(i); }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="shrink-0 p-0.5 rounded cursor-pointer transition-opacity"
                    style={{
                      color: "var(--text-muted)",
                      opacity: isActive ? 0.6 : 0,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = isActive ? "0.6" : "0")}
                  >
                    <X style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }} />
                  </button>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => canLeft && scrollTabs("left")}
            className="shrink-0 flex items-center justify-center h-full"
            style={{
              width: "calc(20px * var(--ui-scale))",
              color: canLeft ? "var(--text-muted)" : "var(--text-disabled)",
              cursor: canLeft ? "pointer" : "default",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = canLeft ? "var(--text-primary)" : "var(--text-muted)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = canLeft ? "var(--text-muted)" : "var(--text-disabled)"; }}
          >
            <ArrowLeft style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
          </button>
          <button
            type="button"
            onClick={() => canRight && scrollTabs("right")}
            className="shrink-0 flex items-center justify-center h-full"
            style={{
              width: "calc(20px * var(--ui-scale))",
              color: canRight ? "var(--text-muted)" : "var(--text-disabled)",
              cursor: canRight ? "pointer" : "default",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = canRight ? "var(--text-primary)" : "var(--text-muted)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = canRight ? "var(--text-muted)" : "var(--text-disabled)"; }}
          >
            <ArrowRight style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
          </button>

          {/* 브라우저 탭 열기 */}
          <button
            type="button"
            onClick={() => usePanelEditorStore.getState().openBrowserTab("", "New Tab")}
            className="shrink-0 flex items-center justify-center cursor-pointer"
            style={{
              width: "calc(24px * var(--ui-scale))",
              height: "100%",
              color: "var(--text-muted)",
            }}
            title={t("editor.openBrowser")}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <Globe style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
          </button>

          {/* 외부 창으로 열기 */}
          {activeTab && activeTab.type !== "diff" && activeTab.type !== "browser" && (
            <button
              type="button"
              onClick={() => { openEditorExternalWindow(activeTab.path); handleCloseTab(activeIndex); }}
              className="shrink-0 flex items-center justify-center cursor-pointer"
              style={{
                width: "calc(24px * var(--ui-scale))",
                height: "100%",
                color: "var(--text-muted)",
                }}
              title="Open in external window"
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <ArrowSquareOut style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
            </button>
          )}

          {/* 패널 닫기 */}
          <button
            onClick={handleClose}
            className="shrink-0 flex items-center justify-center cursor-pointer"
            style={{
              width: "calc(24px * var(--ui-scale))",
              height: "100%",
              color: "var(--text-muted)",
              transition: "color 0.15s",
            }}
            title={t("editor.closePanel")}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <X style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
          </button>
        </div>

        {/* 상태 바 — 에디터 탭만 */}
        {activeTab && activeTab.type !== "diff" && activeTab.type !== "browser" && (
          <div
            className="flex items-center justify-between px-3 shrink-0"
            style={{
              height: "calc(22px * var(--ui-scale))",
              fontSize: "var(--fs-10)",
              color: "var(--text-muted)",
              background: "var(--bg-base)",
              borderBottom: "1px solid var(--border-default)",
            }}
          >
            <span className="truncate">{activeTab.path.replace(/[\\/][^\\/]+$/, "")}</span>
            <div className="flex items-center gap-2 shrink-0 ml-4">
              {activeTab.language === "markdown" && (
                <button
                  type="button"
                  onClick={toggleSourceMode}
                  className="flex items-center gap-1 rounded cursor-pointer transition-colors"
                  style={{
                    fontSize: "var(--fs-10)",
                    color: "var(--text-muted)",
                    background: "var(--bg-overlay)",
                    border: "1px solid var(--border-subtle)",
                    lineHeight: 1,
                    padding: "1px 6px",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                  title={isSourceMode ? t("editor.toWysiwyg") : t("editor.toSource")}
                >
                  {isSourceMode ? <Eye size={11} /> : <Code size={11} />}
                  <span>{isSourceMode ? "WYSIWYG" : "Source"}</span>
                </button>
              )}
              <span>{activeTab.language}</span>
            </div>
          </div>
        )}

        {/* 콘텐츠 */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <EditorContent
            activeTab={activeTab}
            activeIndex={activeIndex}
            isSourceMode={isSourceMode}
            statusMap={statusMap}
            handleChange={handleChange}
            handleSave={handleSave}
            handleCloseTab={handleCloseTab}
          />
        </div>
      </div>

      {/* 탭 컨텍스트 메뉴 */}
      {ctxMenu && (
        <TabContextMenu
          ctxMenu={ctxMenu}
          ctxMenuRef={ctxMenuRef}
          tabs={tabs}
          closeOthers={closeOthers}
          closeToRight={closeToRight}
          onCloseTab={handleCloseTab}
          onCloseAll={handleCloseAll}
          onDismiss={() => setCtxMenu(null)}
          t={t}
        />
      )}
    </div>
  );
}

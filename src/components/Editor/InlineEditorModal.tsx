import { useRef, useState, useCallback, lazy, Suspense } from "react";
import { apiWriteTextFile } from "../../lib/bridge";
import { useToastStore } from "../../stores/toastStore";
import { X, Code, Eye } from "@phosphor-icons/react";
import { useEditorStore } from "../../stores/editorStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useGitT } from "../../lib/i18n/git";
import { BrowserHideGuard } from "./BrowserViewer";
import { logger } from "../../lib/logger";

const CodeEditor = lazy(() => import("./CodeEditor"));
const MarkdownEditor = lazy(() => import("./MarkdownEditor"));

export default function InlineEditorModal() {
  const t = useGitT();
  const tabs = useEditorStore((s) => s.tabs);
  const activeIndex = useEditorStore((s) => s.activeIndex);
  const setActiveIndex = useEditorStore((s) => s.setActiveIndex);
  const closeTab = useEditorStore((s) => s.closeTab);
  const updateContent = useEditorStore((s) => s.updateContent);
  const markSaved = useEditorStore((s) => s.markSaved);
  const setModalOpen = useEditorStore((s) => s.setModalOpen);

  const activeTab = tabs[activeIndex] ?? null;
  const markdownSourceMode = useSettingsStore((s) => s.markdownSourceMode);
  const isSourceMode = activeTab?.language === "markdown" && markdownSourceMode;
  const toggleSourceMode = useCallback(() => {
    if (!activeTab || activeTab.language !== "markdown") return;
    useSettingsStore.getState().setMarkdownSourceMode(!markdownSourceMode);
  }, [activeTab, markdownSourceMode]);
  const [width, setWidth] = useState(900);
  const [height, setHeight] = useState(680);
  const resizing = useRef<{ edge: "left" | "bottom" | "corner"; startX: number; startY: number; startW: number; startH: number } | null>(null);

  const onResizeStart = (edge: "left" | "bottom" | "corner") => (e: React.MouseEvent) => {
    resizing.current = { edge, startX: e.clientX, startY: e.clientY, startW: width, startH: height };
    const onMove = (me: MouseEvent) => {
      if (!resizing.current) return;
      const { edge: ed, startX, startY, startW, startH } = resizing.current;
      if (ed === "left" || ed === "corner") setWidth(Math.max(500, startW - (me.clientX - startX)));
      if (ed === "bottom" || ed === "corner") setHeight(Math.max(300, startH + (me.clientY - startY)));
    };
    const onUp = () => {
      resizing.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSave = useCallback(async () => {
    if (!activeTab) return;
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
      autoSaveTimer.current = setTimeout(() => {
        const tab = useEditorStore.getState().tabs[activeIndex];
        if (tab && tab.isDirty) {
          apiWriteTextFile(tab.path, tab.content)
            .then(() => useEditorStore.getState().markSaved(activeIndex))
            .catch((e) => { logger.error(e); useToastStore.getState().show(`저장 실패: ${e}`, "error", 4000); });
        }
      }, 1000);
    },
    [activeIndex, updateContent],
  );

  const handleClose = () => setModalOpen(false);

  const handleCloseTab = (i: number) => {
    closeTab(i);
    if (tabs.length <= 1) setModalOpen(false);
  };

  return (
    <>
    <BrowserHideGuard />
    <div

      className="fixed inset-0 z-[90] flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width,
          height,
          minWidth: 500,
          minHeight: 300,
          borderRadius: 8,
          border: "1px solid var(--border-default)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          background: "var(--bg-base)",
          position: "relative",
        }}
      >
        {/* 왼쪽 리사이즈 핸들 */}
        <div onMouseDown={onResizeStart("left")} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, cursor: "ew-resize", zIndex: 10 }} />
        {/* 하단 리사이즈 핸들 */}
        <div onMouseDown={onResizeStart("bottom")} style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 4, cursor: "ns-resize", zIndex: 10 }} />
        {/* 우하단 코너 */}
        <div onMouseDown={onResizeStart("corner")} style={{ position: "absolute", right: 0, bottom: 0, width: 12, height: 12, cursor: "nwse-resize", zIndex: 11 }} />

        {/* 탭 바 */}
        <div
          className="flex items-center shrink-0"
          style={{
            height: "calc(32px * var(--ui-scale))",
            background: "var(--bg-overlay)",
            borderBottom: "1px solid var(--border-default)",
          }}
        >
          <div className="flex items-center h-full shrink min-w-0 overflow-x-auto flex-1">
            {tabs.map((tab, i) => (
              <div
                key={tab.path}
                onClick={() => setActiveIndex(i)}
                className="group flex items-center gap-1.5 px-3 h-full cursor-pointer shrink-0 select-none"
                style={{
                  fontSize: "var(--fs-11)",
                  color: i === activeIndex ? "var(--text-primary)" : "var(--text-tertiary)",
                  background: i === activeIndex ? "var(--bg-base)" : "transparent",
                  borderRight: "1px solid var(--border-subtle)",
                }}
              >
                {tab.isDirty && (
                  <span className="inline-block rounded-full shrink-0" style={{ width: 6, height: 6, background: "var(--accent-blue)" }} />
                )}
                <span className="truncate max-w-[140px]">{tab.name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleCloseTab(i); }}
                  className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity cursor-pointer"
                  style={{ color: "var(--text-muted)" }}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 flex items-center justify-center cursor-pointer"
            style={{
              width: "calc(32px * var(--ui-scale))",
              height: "100%",
              color: "var(--text-muted)",
              borderLeft: "1px solid var(--border-subtle)",
            }}
            title={t("editor.closeEditor")}
          >
            <X size={14} />
          </button>
        </div>

        {/* 상태 바 */}
        {activeTab && (
          <div
            className="flex items-center justify-between px-3 shrink-0"
            style={{
              height: "calc(22px * var(--ui-scale))",
              fontSize: "var(--fs-10)",
              color: "var(--text-muted)",
              background: "var(--bg-surface)",
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

        {/* 에디터 */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab ? (
            <Suspense fallback={<div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)" }}>Loading...</div>}>
              {activeTab.language === "markdown" && !isSourceMode ? (
                <MarkdownEditor key={activeTab.path} content={activeTab.content} onChange={handleChange} onSave={handleSave} />
              ) : (
                <CodeEditor key={`${activeTab.path}:${isSourceMode ? "src" : "code"}`} content={activeTab.content} language={activeTab.language} onChange={handleChange} onSave={handleSave} />
              )}
            </Suspense>
          ) : (
            <div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)" }}>
              No file open
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}

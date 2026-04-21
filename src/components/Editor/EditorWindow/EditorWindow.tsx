import { useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { apiWriteTextFile } from "../../../lib/bridge";
import { useToastStore } from "../../../stores/toastStore";
import { listen } from "@tauri-apps/api/event";
import { useEditorStore } from "../../../stores/editorStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { Code, Eye } from "@phosphor-icons/react";
import { useGitT } from "../../../lib/i18n/git";
import { logger } from "../../../lib/logger";
import { apiReadTextFile } from "../../../lib/bridge";
import { TabBar } from "./TabBar";

const CodeEditor = lazy(() => import("../CodeEditor"));
const MarkdownEditor = lazy(() => import("../MarkdownEditor"));

function Loading() {
  return (
    <div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)" }}>
      Loading editor...
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)" }}>
      No file open
    </div>
  );
}

/* ─── Main ─── */
export default function EditorWindow() {
  const t = useGitT();
  const tabs = useEditorStore((s) => s.tabs);
  const activeIndex = useEditorStore((s) => s.activeIndex);
  const updateContent = useEditorStore((s) => s.updateContent);
  const markSaved = useEditorStore((s) => s.markSaved);
  const openTab = useEditorStore((s) => s.openTab);
  const reloadAllNonDirtyTabs = useEditorStore((s) => s.reloadAllNonDirtyTabs);

  const activeTab = tabs[activeIndex] ?? null;
  const markdownSourceMode = useSettingsStore((s) => s.markdownSourceMode);
  const isSourceMode = activeTab?.language === "markdown" && markdownSourceMode;
  const toggleSourceMode = useCallback(() => {
    if (!activeTab || activeTab.language !== "markdown") return;
    useSettingsStore.getState().setMarkdownSourceMode(!markdownSourceMode);
  }, [activeTab, markdownSourceMode]);

  const loadAndOpenFile = useCallback(async (filePath: string) => {
    try {
      const content = await apiReadTextFile(filePath);
      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      openTab(filePath, name, content);
    } catch (e) {
      logger.error("Failed to open file:", e);
    }
  }, [openTab]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const file = params.get("file");
    if (file) loadAndOpenFile(file);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "racemo-settings") useSettingsStore.persist.rehydrate();
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const editorMode = useSettingsStore((s) => s.editorMode);
  const isExplicit = new URLSearchParams(window.location.search).get("explicit") === "1";
  useEffect(() => {
    if (!isExplicit && editorMode === "internal") {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
    }
  }, [editorMode, isExplicit]);

  useEffect(() => {
    const unlisten = listen<{ path: string }>("editor:open-file", (event) => {
      loadAndOpenFile(event.payload.path);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [loadAndOpenFile]);

  // 외부 에디터 창 포커스 복귀 시 non-dirty 탭 자동 갱신
  useEffect(() => {
    const unlistenPromise = import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) reloadAllNonDirtyTabs();
      })
    );
    return () => { unlistenPromise.then((fn) => fn()); };
  }, [reloadAllNonDirtyTabs]);

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

  return (
    <div className="flex flex-col h-full w-full" style={{ background: "var(--bg-base)" }}>
      <TabBar />
      {activeTab && (
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
                className="flex items-center gap-1 px-1.5 rounded cursor-pointer transition-colors"
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
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab ? (
          <Suspense fallback={<Loading />}>
            {activeTab.language === "markdown" && !isSourceMode ? (
              <MarkdownEditor key={activeTab.path} content={activeTab.content} onChange={handleChange} onSave={handleSave} />
            ) : (
              <CodeEditor key={`${activeTab.path}:${isSourceMode ? "src" : "code"}`} content={activeTab.content} language={activeTab.language} onChange={handleChange} onSave={handleSave} />
            )}
          </Suspense>
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

import { lazy, Suspense } from "react";
import BrowserViewer from "../BrowserViewer";
import DiffViewer from "../../Sidebar/DiffViewer";
import MergeEditor from "../../Sidebar/MergeEditor";
import { usePanelEditorStore, type DiffPanelTab, type BrowserPanelTab, type PanelTab } from "../../../stores/panelEditorStore";
import { useGitStore } from "../../../stores/gitStore";

const CodeEditor = lazy(() => import("../CodeEditor"));
const MarkdownEditor = lazy(() => import("../MarkdownEditor"));

interface EditorContentProps {
  activeTab: PanelTab | null;
  activeIndex: number;
  isSourceMode: boolean | null | PanelTab;
  statusMap: Record<string, string>;
  handleChange: (content: string) => void;
  handleSave: () => Promise<void>;
  handleCloseTab: (i: number) => void;
}

export default function EditorContent({
  activeTab,
  activeIndex,
  isSourceMode,
  statusMap,
  handleChange,
  handleSave,
  handleCloseTab,
}: EditorContentProps) {
  if (!activeTab) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)" }}>
        No file open
      </div>
    );
  }

  if (activeTab.type === "browser") {
    return (
      <BrowserViewer
        key={activeTab.path}
        id={activeTab.path}
        url={(activeTab as BrowserPanelTab).url}
        onUrlChange={(newUrl, title) => {
          const store = usePanelEditorStore.getState();
          const tabs = [...store.tabs];
          const tab = tabs[activeIndex];
          if (tab && tab.type === "browser") {
            let faviconUrl: string | undefined;
            try {
              faviconUrl = `https://www.google.com/s2/favicons?domain=${new URL(newUrl).hostname}&sz=32`;
            } catch {
              // ignore invalid URL
            }
            tabs[activeIndex] = { ...tab, url: newUrl, name: title || (tab as BrowserPanelTab).name, favicon: faviconUrl };
            usePanelEditorStore.setState({ tabs });
          }
        }}
      />
    );
  }

  if (activeTab.type === "diff") {
    if (statusMap[(activeTab as DiffPanelTab).filePath] === "conflicted") {
      return (
        <MergeEditor
          key={activeTab.path}
          standalone
          cwd={(activeTab as DiffPanelTab).cwd}
          filePath={(activeTab as DiffPanelTab).filePath}
          onClose={() => handleCloseTab(activeIndex)}
          onResolved={() => {
            const dt = activeTab as DiffPanelTab;
            useGitStore.getState().refresh(dt.cwd);
          }}
        />
      );
    }
    return (
      <DiffViewer
        key={activeTab.path}
        standalone
        cwd={(activeTab as DiffPanelTab).cwd}
        filePath={(activeTab as DiffPanelTab).filePath}
        staged={(activeTab as DiffPanelTab).staged}
        onClose={() => handleCloseTab(activeIndex)}
        onHunkDiscarded={() => {
          const dt = activeTab as DiffPanelTab;
          useGitStore.getState().refresh(dt.cwd);
        }}
      />
    );
  }

  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)" }}>Loading...</div>}>
      {activeTab.language === "markdown" && !isSourceMode ? (
        <MarkdownEditor
          key={activeTab.path}
          content={activeTab.content}
          onChange={handleChange}
          onSave={handleSave}
        />
      ) : (
        <CodeEditor
          key={`${activeTab.path}:${isSourceMode ? "src" : "code"}`}
          content={activeTab.content}
          language={activeTab.language}
          onChange={handleChange}
          onSave={handleSave}
        />
      )}
    </Suspense>
  );
}

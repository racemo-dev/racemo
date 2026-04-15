import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { isMac } from "../../lib/osUtils";
import DiffViewer from "../Sidebar/DiffViewer";
import MergeEditor from "../Sidebar/MergeEditor";
import { useGitStore } from "../../stores/gitStore";

function WindowControls({ onClose }: { onClose: () => void }) {
  const handleAction = (action: "minimize" | "maximize" | "close") => {
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      if (action === "minimize") win.minimize().catch(console.error);
      else if (action === "maximize") win.toggleMaximize().catch(console.error);
      else onClose();
    });
  };

  return (
    <div className="flex items-center h-full" style={{ borderLeft: "1px solid var(--border-subtle)" }}>
      <button type="button" className="window-control" onClick={() => handleAction("minimize")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="currentColor" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <rect y="5" width="10" height="1" />
        </svg>
      </button>
      <button type="button" className="window-control" onClick={() => handleAction("maximize")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <rect x="1" y="1" width="8" height="8" />
        </svg>
      </button>
      <button type="button" className="window-control close" onClick={() => handleAction("close")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <line x1="1" y1="1" x2="9" y2="9" />
          <line x1="9" y1="1" x2="1" y2="9" />
        </svg>
      </button>
    </div>
  );
}

export default function DiffWindow() {
  const params = new URLSearchParams(window.location.search);
  const [cwd, setCwd] = useState(decodeURIComponent(params.get("cwd") ?? ""));
  const [filePath, setFilePath] = useState(decodeURIComponent(params.get("file") ?? ""));
  const [staged, setStaged] = useState(params.get("staged") === "1");

  useEffect(() => {
    const unlisten = listen<{ cwd: string; filePath: string; staged: boolean }>("diff:view-file", (e) => {
      setCwd(e.payload.cwd);
      setFilePath(e.payload.filePath);
      setStaged(e.payload.staged);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleClose = useCallback(() => {
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().close();
    });
  }, []);


  const handleHunkDiscarded = useCallback(async () => {
    await emit("git:refresh", { cwd });
  }, [cwd]);

  const statusMap = useGitStore((s) => s.statusMap);
  const isConflicted = statusMap[filePath] === "conflicted";

  if (!cwd || !filePath) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)" }}>
        No diff to display.
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full" style={{ background: "var(--bg-surface)" }}>
      {isConflicted ? (
        <MergeEditor
          key={`${cwd}:${filePath}`}
          cwd={cwd}
          filePath={filePath}
          onClose={handleClose}
          standalone
          headerExtra={!isMac() ? <WindowControls onClose={handleClose} /> : undefined}
        />
      ) : (
        <DiffViewer
          key={`${cwd}:${filePath}:${staged}`}
          cwd={cwd}
          filePath={filePath}
          staged={staged}
          onHunkDiscarded={handleHunkDiscarded}
          standalone
          headerExtra={!isMac() ? <WindowControls onClose={handleClose} /> : undefined}
        />
      )}
    </div>
  );
}

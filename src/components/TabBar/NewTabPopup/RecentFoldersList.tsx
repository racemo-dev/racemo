import { apiDeleteRecentDir } from "../../../lib/bridge";
import { RECENT_FOLDERS_KEY } from "./types";
import { getRecentFolders } from "./helpers";

interface RecentFoldersListProps {
  folders: string[];
  workingDir: string;
  homeDir: string;
  onSelectFolder: (folder: string) => void;
  onFoldersChange: (folders: string[]) => void;
}

export default function RecentFoldersList({
  folders,
  workingDir,
  homeDir,
  onSelectFolder,
  onFoldersChange,
}: RecentFoldersListProps) {
  if (folders.length === 0) return null;

  const handleDelete = (folder: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = folders.filter((f) => f !== folder);
    onFoldersChange(updated);
    if (workingDir === folder) onSelectFolder(updated[0] ?? homeDir);
    // localStorage 제거
    try {
      localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(
        getRecentFolders().filter((f) => f !== folder)
      ));
    } catch { /* ignore */ }
    apiDeleteRecentDir(folder).catch(() => {});
  };

  return (
    <div className="mb-4">
      <label
        className="block mb-1.5 uppercase"
        style={{ fontSize: 'var(--fs-9)', letterSpacing: "0.08em", color: "var(--text-muted)" }}
      >
        Recent
      </label>
      <div className="flex flex-col gap-0.5">
        {folders.map((folder) => {
          const displayName = folder.split(/[\\/]/).pop() || folder;
          return (
            <div
              key={folder}
              className="group flex items-center rounded"
              style={{
                background: workingDir === folder ? "var(--bg-overlay)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (workingDir !== folder) {
                  (e.currentTarget as HTMLElement).style.background = "var(--bg-subtle)";
                }
              }}
              onMouseLeave={(e) => {
                if (workingDir !== folder) {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }
              }}
            >
              <button
                onClick={() => onSelectFolder(folder)}
                className="flex items-center gap-2 flex-1 px-2 py-1 text-left"
                style={{
                  fontSize: 'var(--fs-11)',
                  color: workingDir === folder ? "var(--text-primary)" : "var(--text-secondary)",
                  border: "none",
                  background: "transparent",
                  minWidth: 0,
                }}
                title={folder}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0, opacity: 0.6 }}>
                  <path d="M2 4h4l2 2h6v8H2z" />
                </svg>
                <span className="truncate">{displayName}</span>
              </button>
              <button
                onClick={(e) => handleDelete(folder, e)}
                className="flex-shrink-0 px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.color = "var(--accent-red)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
                }}
                title="Remove from recent"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="1" y1="1" x2="9" y2="9" />
                  <line x1="9" y1="1" x2="1" y2="9" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

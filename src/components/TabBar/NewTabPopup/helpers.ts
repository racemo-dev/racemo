import { apiSaveRecentDir } from "../../../lib/bridge";
import { RECENT_FOLDERS_KEY, MAX_RECENT_FOLDERS } from "./types";

export function getRecentFolders(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed.slice(0, MAX_RECENT_FOLDERS);
      }
    }
  } catch {
    // ignore
  }
  return [];
}

export function saveRecentFolder(folder: string): void {
  if (!folder.trim()) return;
  // localStorage (Tauri/browser 공통)
  try {
    const existing = getRecentFolders();
    const filtered = existing.filter((f) => f.toLowerCase() !== folder.toLowerCase());
    const updated = [folder, ...filtered].slice(0, MAX_RECENT_FOLDERS);
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
  // 서버 사이드 저장 (Tauri/browser 공통 — 브라우저에서 서버 목록 공유용)
  apiSaveRecentDir(folder).catch(() => {});
}

// Helper to extract folder name from path
export function getFolderName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

// Helper to check if tab name exists and generate unique name
export function getUniqueTabName(baseName: string, sessions: { name: string }[]): { exists: boolean; uniqueName: string } {
  const exists = sessions.some((s) => s.name === baseName);
  if (!exists) {
    return { exists: false, uniqueName: baseName };
  }

  // Find next available number
  let num = 1;
  while (sessions.some((s) => s.name === `${baseName}-${String(num).padStart(2, "0")}`)) {
    num++;
  }
  return { exists: true, uniqueName: `${baseName}-${String(num).padStart(2, "0")}` };
}

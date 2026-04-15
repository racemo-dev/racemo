import type { CodexHistoryEntry } from "../../../types/codexlog";
import type { ProjectGroup } from "./types";

const MODEL_COLORS: Record<string, { bg: string; fg: string }> = {
  "gpt-5":    { bg: "var(--accent-green)", fg: "var(--bg-base)" },
  "gpt-4":    { bg: "var(--accent-blue)",            fg: "var(--bg-base)" },
  "o3":       { bg: "var(--accent-purple)",           fg: "var(--bg-base)" },
  "o4":       { bg: "var(--accent-purple)",           fg: "var(--bg-base)" },
};

export function getModelColor(model: string): { bg: string; fg: string } {
  const lower = model.toLowerCase();
  for (const [key, val] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return val;
  }
  return { bg: "var(--accent-green)", fg: "var(--bg-base)" };
}

export function buildProjectGroups(entries: CodexHistoryEntry[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const entry of entries) {
    const key = entry.cwd;
    const existing = map.get(key);
    if (existing) {
      existing.entries.push(entry);
      if (entry.timestamp > existing.latestTimestamp) {
        existing.latestTimestamp = entry.timestamp;
      }
    } else {
      map.set(key, {
        cwd: key,
        label: entry.cwd_label || key,
        entries: [entry],
        latestTimestamp: entry.timestamp,
      });
    }
  }
  const groups = Array.from(map.values());
  groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  return groups;
}

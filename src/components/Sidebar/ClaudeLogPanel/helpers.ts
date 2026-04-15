import type { ClaudeHistoryEntry } from "../../../types/claudelog";
import { MODEL_COLORS } from "./types";
import type { ProjectGroup } from "./types";

export function getModelColor(model: string): { bg: string; fg: string } {
  const lower = model.toLowerCase();
  for (const [key, val] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return val;
  }
  return { bg: "var(--accent-purple)", fg: "var(--bg-base)" };
}

export function formatResetTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " +
      d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return isoStr;
  }
}

export function buildProjectGroups(entries: ClaudeHistoryEntry[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const entry of entries) {
    const key = entry.project;
    const existing = map.get(key);
    if (existing) {
      existing.entries.push(entry);
      if (entry.timestamp > existing.latestTimestamp) {
        existing.latestTimestamp = entry.timestamp;
      }
    } else {
      map.set(key, {
        project: key,
        label: entry.project_label || key,
        entries: [entry],
        latestTimestamp: entry.timestamp,
      });
    }
  }
  const groups = Array.from(map.values());
  groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  return groups;
}

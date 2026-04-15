import type { ClaudeHistoryEntry, ClaudeSessionMessage } from "../../../types/claudelog";

/* ─── Constants ─── */

export const MODEL_COLORS: Record<string, { bg: string; fg: string }> = {
  opus:    { bg: "var(--accent-purple)", fg: "var(--bg-base)" },
  sonnet:  { bg: "var(--accent-blue)",   fg: "var(--bg-base)" },
  haiku:   { bg: "var(--accent-cyan)",   fg: "var(--bg-base)" },
};

export const CONTEXT_WINDOW = 200_000;
export const USAGE_POLL_INTERVAL = 5 * 60 * 1000;

export const sessionCache = new Map<string, ClaudeSessionMessage[]>();

/* ─── Types ─── */

export interface ClaudeUsagePeriod { utilization: number; resets_at: string; }
export interface ClaudeUsageResult {
  five_hour?: ClaudeUsagePeriod;
  seven_day?: ClaudeUsagePeriod;
  seven_day_sonnet?: ClaudeUsagePeriod;
}

export interface ProjectGroup {
  project: string;
  label: string;
  entries: ClaudeHistoryEntry[];
  latestTimestamp: number;
}

export type ViewMode = "flat" | "grouped";

export interface TooltipState {
  entry: ClaudeHistoryEntry;
  anchorRect: DOMRect;
}

export type FilterState = { type: "project"; value: string } | { type: "session"; value: string } | null;

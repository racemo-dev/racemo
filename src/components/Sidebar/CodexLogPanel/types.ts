import type { CodexHistoryEntry, CodexSessionMessage, CodexSessionMeta } from "../../../types/codexlog";

export interface ProjectGroup {
  cwd: string;
  label: string;
  entries: CodexHistoryEntry[];
  latestTimestamp: number;
}

export type ViewMode = "flat" | "grouped";

export interface TooltipState {
  entry: CodexHistoryEntry;
  anchorRect: DOMRect;
}

export const sessionCache = new Map<string, { meta: CodexSessionMeta | null; messages: CodexSessionMessage[] }>();

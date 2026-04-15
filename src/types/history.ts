export interface HistoryEntry {
  command: string;
  timestamp?: number;
  source: "file" | "live";
  sessionId?: string;
  cwd?: string;
  favorite?: boolean;
}

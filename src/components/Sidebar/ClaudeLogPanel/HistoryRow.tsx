import type { ClaudeHistoryEntry } from "../../../types/claudelog";
import type { TranslationKey } from "../../../lib/i18n/git";
import { relativeTime, truncateDisplay } from "../logUtils";
import { ProjectLabel, IdBadge, HistoryRowShell } from "../LogShared";
import { ClaudeIcon } from "../AiLogPanel/ProviderIcons";
import type { FilterState } from "./types";

export default function HistoryRow({
  entry,
  onClick,
  onFilter,
  activeFilter,
  activeSessionId,
  indent,
  t,
}: {
  entry: ClaudeHistoryEntry;
  onClick: (entry: ClaudeHistoryEntry, rect: DOMRect) => void;
  onFilter?: (type: "project" | "session", value: string) => void;
  activeFilter?: FilterState;
  activeSessionId?: string | null;
  indent?: boolean;
  t: (key: TranslationKey) => string;
}) {
  const isActive = activeSessionId === entry.session_id;
  return (
    <HistoryRowShell isActive={isActive} indent={indent} icon={<ClaudeIcon />} onClick={(rect) => onClick(entry, rect)}>
      <div className="truncate" style={{ lineHeight: 1.3 }}>
        {truncateDisplay(entry.display, 60)}
      </div>
      <div
        className="flex items-center gap-1"
        style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", marginTop: 1 }}
      >
        <span>{relativeTime(entry.timestamp, t)}</span>
        <span
          onClick={(e) => { e.stopPropagation(); onFilter?.("session", entry.session_id); }}
          className="cursor-pointer"
          style={{ marginLeft: "auto", opacity: activeFilter?.type === "session" && activeFilter.value === entry.session_id ? 1 : undefined }}
        >
          <IdBadge id={entry.session_id} />
        </span>
        {!indent && entry.project_label && (
          <span
            onClick={(e) => { e.stopPropagation(); onFilter?.("project", entry.project_label); }}
            className="cursor-pointer"
          >
            <ProjectLabel label={entry.project_label} />
          </span>
        )}
      </div>
    </HistoryRowShell>
  );
}
